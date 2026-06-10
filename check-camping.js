'use strict';

/**
 * Monitor de disponibilidad — Camping Alba (Capfun)
 *
 * Hace UN chequeo de la web y avisa si la semana indicada (por defecto
 * "Del 23/08 al 30/08") tiene algún alojamiento que NO esté marcado como
 * "COMPLETO", probando primero la llegada en sábado y luego en domingo.
 *
 * En lugar de renderizar la página con un navegador, consulta directamente el
 * endpoint que la propia web usa para pintar la tabla en móvil
 * (tableau_resa2024.php con div=mobile). Ese endpoint devuelve el fragmento
 * HTML de UNA semana ya montado, así que basta un `fetch` nativo + parseo de
 * texto: sin Playwright, sin navegador y sin dependencias de runtime.
 *
 * Exit codes:
 *   0 -> se encontró al menos una disponibilidad
 *   1 -> todo COMPLETO en todos los días probados
 *   2 -> error (no responde el endpoint, no aparece la semana, layout cambiado...)
 */

const { parse } = require('node-html-parser');

// Carga variables desde un fichero .env si existe (token/chat_id de Telegram),
// usando el soporte nativo de Node (sin dependencias). Si no hay .env, seguimos
// con las variables de entorno del sistema.
try {
  process.loadEnvFile('.env');
} catch (_) {
  /* sin fichero .env, usamos las variables de entorno existentes */
}

// ---------------------------------------------------------------------------
// CONFIG — edítalo para verificar el parseo con otras fechas.
// Cambia `mois`/`annee` y `diasLlegada[].columna` a la vez (p.ej. mois 9 +
// 'Del 05/09 al 12/09') para comprobar contra una semana que sí tenga hueco.
// ---------------------------------------------------------------------------
// OJO: la etiqueta de la columna depende del día de llegada, porque la web
// muestra semanas de sábado-a-sábado o de domingo-a-domingo según corresponda.
// Para finales de agosto de 2026: sábado = "Del 22/08 al 29/08",
// domingo = "Del 23/08 al 30/08". Por eso cada día lleva su propia `columna`.
const CONFIG = {
  endpoint: 'https://www.capfun.es/php/tableau_resa2024.php',
  // Parámetros fijos del camping (identificadores estables de Capfun).
  baseParams: {
    camping: 'alba',
    lang: 'ES',
    id_resa_thelis: '6777',
    div: 'mobile',
    sejour_type: 'LOCATION',
    sejour_duree: '8',
    sejour_nb_pers: '0',
    sejour_option: '0',
  },
  mois: 8, // mes a consultar (8 = agosto)
  annee: 2026,
  // Cuántas semanas (num_semaine) probar al buscar la columna por etiqueta.
  // Un mes tiene como mucho 5 sábados/domingos; 6 da margen de sobra.
  maxSemanas: 6,
  diasLlegada: [
    // orden de prueba; `columna` = etiqueta de la semana a comprobar.
    { valor: 'SAMEDI', etiqueta: 'SÁBADO', columna: 'Del 22/08 al 29/08' },
    { valor: 'DIMANCHE', etiqueta: 'DOMINGO', columna: 'Del 23/08 al 30/08' },
  ],
  timeoutMs: 30000,
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

/** Construye la URL del endpoint para una semana/día concretos. */
function construirUrl({ num_semaine, sejour_arrivee }) {
  const params = new URLSearchParams({
    ...CONFIG.baseParams,
    bouton: `mois-${CONFIG.mois}-${CONFIG.annee}`,
    mois: String(CONFIG.mois),
    annee: String(CONFIG.annee),
    num_semaine: String(num_semaine),
    sejour_arrivee,
  });
  return `${CONFIG.endpoint}?${params.toString()}`;
}

/** Descarga el fragmento HTML, decodificado como latin-1. Aborta por timeout. */
async function descargar(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CONFIG.timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} al pedir el endpoint`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString('latin1');
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Parseo del fragmento HTML (con node-html-parser; las entidades como &euro;
// o los acentos se decodifican solos al leer `.text`).
// ---------------------------------------------------------------------------

/**
 * Parsea el fragmento de una semana y devuelve:
 *   - rango: etiqueta servida, p.ej. "Del 05/09 al 12/09" (o null)
 *   - completa: true si muestra "¡Estamos COMPLETOS para esta semana!"
 *   - disponibles: alojamientos reservables con precio
 *
 * Solo las filas `tr.ligne_tarif` son alojamientos reservables. Una fila
 * cuenta como disponible si su celda de la semana trae un precio (un enlace
 * a la reserva con cifras); las celdas "-" (sin oferta) no traen precio.
 */
function parsearSemana(html) {
  const root = parse(html);

  const celdaFecha = root.querySelector('th.tableau-resa-date');
  const rango = celdaFecha ? norm(celdaFecha.text) : null;

  const completa = /COMPLETOS?\s+para esta semana/i.test(root.text);

  const disponibles = [];
  let comprobadas = 0;
  for (const fila of root.querySelectorAll('tr.ligne_tarif')) {
    comprobadas++;
    const enlacePrecio = fila.querySelector('td a');
    if (!enlacePrecio || !/\d/.test(enlacePrecio.text)) continue; // sin precio

    // Nombre del alojamiento: primer <span class="float-left"> del <th>
    // (el descriptor "N Pers - ... Habitaciones" va en otro span aparte).
    const nombre = fila.querySelector('span.float-left');
    disponibles.push({
      tipo: norm(nombre ? nombre.text : '') || '(sin nombre)',
      precio: norm(enlacePrecio.text),
    });
  }

  return { rango, completa, comprobadas, disponibles };
}

/**
 * Busca, para un día de llegada, la semana cuya etiqueta coincide con
 * `dia.columna`, probando num_semaine = 1..maxSemanas. Devuelve la semana ya
 * parseada. Lanza si no aparece (la fecha objetivo no está en este mes).
 */
async function localizarSemana(dia) {
  for (let semana = 1; semana <= CONFIG.maxSemanas; semana++) {
    const html = await descargar(construirUrl({ num_semaine: semana, sejour_arrivee: dia.valor }));
    const parsed = parsearSemana(html);
    if (!parsed.rango) continue; // fragmento inesperado para esta semana
    if (parsed.rango === dia.columna) return parsed;
  }
  throw new Error(`No se encontró la columna "${dia.columna}" en el mes ${CONFIG.mois}/${CONFIG.annee}`);
}

// ---------------------------------------------------------------------------
// Telegram
/**
 * Envía un mensaje por Telegram usando la Bot API.
 * Requiere las variables de entorno TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID
 * (puedes ponerlas en un fichero .env). Si no están configuradas, avisa por
 * log y no envía nada (el chequeo sigue funcionando igual).
 */
async function enviarTelegram(texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    log('⚠️ Telegram no configurado (define TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID). Aviso omitido.');
    return false;
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, disable_web_page_preview: true }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      log(`⚠️ Error enviando Telegram (HTTP ${resp.status}): ${body.slice(0, 200)}`);
      return false;
    }
    log('📨 Notificación enviada por Telegram');
    return true;
  } catch (err) {
    log(`⚠️ Error enviando Telegram: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Programa principal
// ---------------------------------------------------------------------------

/**
 * Comprueba todos los días configurados y devuelve los hallazgos. No envía
 * notificaciones ni termina el proceso: eso lo decide quien lo llama. Lanza
 * excepción si hay un error irrecuperable (endpoint caído, semana ausente,
 * layout cambiado...).
 *
 * @returns {Promise<Array<{etiqueta, columna, disponibles: Array<{tipo, precio}>}>>}
 */
async function ejecutarChequeo() {
  const hallazgos = [];

  for (const dia of CONFIG.diasLlegada) {
    log(`--- Probando llegada en ${dia.etiqueta} ---`);

    const { completa, comprobadas, disponibles } = await localizarSemana(dia);
    log(`[${dia.etiqueta}] Semana "${dia.columna}" localizada`);

    if (completa) {
      log(`❌ [${dia.etiqueta}] Todo COMPLETO para ${dia.columna}`);
      continue;
    }

    log(`[${dia.etiqueta}] ${comprobadas} alojamientos revisados`);

    if (disponibles.length > 0) {
      hallazgos.push({ etiqueta: dia.etiqueta, columna: dia.columna, disponibles });
      log(`✅ [${dia.etiqueta}] DISPONIBLE ${dia.columna}:`);
      for (const d of disponibles) {
        log(`     • ${d.tipo} — ${d.precio}`);
      }
    } else {
      log(`❌ [${dia.etiqueta}] Sin alojamientos disponibles para ${dia.columna}`);
    }
  }

  return hallazgos;
}

/** Compone el mensaje de Telegram a partir de una lista de hallazgos. */
function componerMensaje(hallazgos) {
  const lineas = ['🏕️ ¡Disponibilidad en Camping Alba!', ''];
  for (const h of hallazgos) {
    lineas.push(`✅ ${h.etiqueta} — ${h.columna}:`);
    for (const d of h.disponibles) lineas.push(`• ${d.tipo} — ${d.precio}`);
    lineas.push('');
  }
  lineas.push('https://www.capfun.es/camping-francia-catalogne-alba-ES.html');
  return lineas.join('\n');
}

/**
 * Un único chequeo y salir. Mantiene los códigos de salida (0/1/2).
 *
 * Si la variable de entorno HEARTBEAT está definida (p.ej. HEARTBEAT=1), además
 * del aviso por hueco envía un "💓 sigo vivo" con el resultado del chequeo. Así
 * el "cada 3 h entre las 9 y las 23" lo decide el cron que lanza el script
 * (GitHub Actions), no el propio código.
 */
async function ejecutarUnaVez() {
  const heartbeat = !!process.env.HEARTBEAT;
  const resumenFechas = CONFIG.diasLlegada.map((d) => `${d.etiqueta}=${d.columna}`).join(', ');
  log(`Iniciando chequeo en Camping Alba (mes ${CONFIG.mois}/${CONFIG.annee}) — ${resumenFechas}`);
  try {
    const hallazgos = await ejecutarChequeo();
    const hayHueco = hallazgos.length > 0;
    if (hayHueco) {
      log('Resultado: hay disponibilidad en al menos un día.');
      await enviarTelegram(componerMensaje(hallazgos));
    } else {
      log('Resultado: sin disponibilidad en ninguno de los días probados.');
    }
    if (heartbeat) {
      const hora = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const estado = hayHueco
        ? `con hueco en ${hallazgos.map((h) => h.columna).join(', ')}`
        : 'todo COMPLETO';
      await enviarTelegram(`💓 Monitor activo (${hora} UTC). Último chequeo: ${estado}.`);
    }
    process.exit(hayHueco ? 0 : 1);
  } catch (err) {
    log(`⛔ ERROR: ${err.message}`);
    if (heartbeat) {
      await enviarTelegram(`💓 Monitor activo, pero el chequeo falló: ${err.message}`);
    }
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
ejecutarUnaVez();
