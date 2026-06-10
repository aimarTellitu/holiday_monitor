'use strict';

/**
 * Monitor de disponibilidad — Camping Alba (Capfun)
 *
 * Hace UN chequeo de la web y avisa por log si la semana indicada
 * (por defecto "Del 23/08 al 30/08") tiene algún alojamiento que NO esté
 * marcado como "COMPLETO", probando primero la llegada en sábado y luego
 * en domingo.
 *
 * La página es JS pura (la tabla se pagina por meses vía AJAX y el día de
 * llegada recarga mediante un handler de jQuery), por eso se usa Playwright
 * con un navegador real en lugar de un simple fetch.
 *
 * Exit codes:
 *   0 -> se encontró al menos una disponibilidad
 *   1 -> todo COMPLETO en todos los días probados
 *   2 -> error (no carga la página, no aparece la columna, layout cambiado...)
 */

const { chromium } = require('playwright');

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
// Cambia `mes` y `columnaFechas` a la vez (p.ej. 'JULIO' + 'Del 19/07 al 26/07')
// para comprobar contra una semana que sí tenga hueco.
// ---------------------------------------------------------------------------
// OJO: la etiqueta de la columna depende del día de llegada, porque la web
// muestra semanas de sábado-a-sábado o de domingo-a-domingo según corresponda.
// Para finales de agosto de 2026: sábado = "Del 22/08 al 29/08",
// domingo = "Del 23/08 al 30/08". Por eso cada día lleva su propia `columna`.
const CONFIG = {
  url: 'https://www.capfun.es/camping-francia-catalogne-alba-ES.html',
  mes: 'AGOSTO', // pestaña de mes a seleccionar
  diasLlegada: [
    // orden de prueba; `columna` = cabecera (aria-label) de la semana a comprobar
    { valor: 'SAMEDI', etiqueta: 'SÁBADO', columna: 'Del 22/08 al 29/08' },
    { valor: 'DIMANCHE', etiqueta: 'DOMINGO', columna: 'Del 23/08 al 30/08' },
  ],
  headless: true,
  timeoutMs: 45000,
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

const normalizar = (s) => (s || '').replace(/\s+/g, ' ').trim();

/**
 * Lee, en la página ya cargada en el mes correcto, las celdas de la columna
 * cuya cabecera (aria-label) coincide con `columnaFechas` y devuelve la lista
 * de alojamientos disponibles (los que NO están COMPLETO).
 *
 * Se ejecuta dentro del navegador (browser context).
 */
function extraerDisponibilidad(columnaFechas) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // Hay 2 tablas .table-prix: el clon flotante de floatThead (solo cabeceras,
  // lleva las fechas en aria-label/texto) y la tabla real con las filas de
  // datos. Sacamos el índice de columna de la cabecera y los datos de la real.
  // 1) Índice de columna desde la cabecera que contenga el rango de fechas.
  let colIndex = -1;
  for (const tr of document.querySelectorAll('table.table-prix tr')) {
    const celdas = [...tr.children];
    const idx = celdas.findIndex(
      (c) => norm(c.getAttribute('aria-label')) === columnaFechas || norm(c.textContent) === columnaFechas
    );
    if (idx >= 0) {
      colIndex = idx;
      break;
    }
  }
  if (colIndex < 0) return { error: 'NO_COLUMNA' };

  // 2) Tabla real de datos (la que NO es el clon flotante).
  const dataTable = document.querySelector('table.table-prix:not(.floatThead-table)');
  if (!dataTable) return { error: 'NO_TABLA' };

  // 3) Recorrer SOLO las filas de alojamiento reservable (tr.ligne_tarif).
  //    Las filas "Nuestros ... ver mas" son resúmenes de categoría y se
  //    descartan. Para cada fila se mira la celda en `colIndex`:
  //    - COMPLETO             -> lleno
  //    - con precio (dígitos) -> disponible
  //    - "-" / vacío          -> sin oferta, se ignora
  const disponibles = [];
  let comprobadas = 0;
  for (const tr of dataTable.querySelectorAll('tr.ligne_tarif')) {
    const objetivo = [...tr.children][colIndex];
    if (!objetivo || objetivo.tagName !== 'TD') continue;

    const texto = norm(objetivo.textContent);
    const esCompleto = objetivo.classList.contains('tableau-resa-complet') || /COMPLETO/i.test(texto);
    const tienePrecio = /\d/.test(texto);

    if (!esCompleto && !tienePrecio) continue; // separador / celda vacía
    comprobadas++;

    if (!esCompleto && tienePrecio) {
      // Tipo de alojamiento = primera celda (TH) de la fila, a la izquierda.
      const etiquetaCelda = tr.querySelector('th, td');
      const tipo = norm(etiquetaCelda ? etiquetaCelda.textContent : '') || '(sin nombre)';
      disponibles.push({ tipo, precio: texto });
    }
  }

  return { colIndex, comprobadas, disponibles };
}

// ---------------------------------------------------------------------------
// Pasos de navegación
// ---------------------------------------------------------------------------

/** Selecciona el día de llegada y espera a que la tabla se recargue. */
async function seleccionarDiaLlegada(page, valor) {
  await page.selectOption('#sejour_arrivee', valor);
  // El handler jQuery recarga la tabla vía AJAX; damos margen a que repinte.
  await page.waitForTimeout(2500);
  await page.waitForSelector('table.table-prix', { timeout: CONFIG.timeoutMs });
}

/** Hace clic en la pestaña del mes indicado y verifica que queda activa. */
async function seleccionarMes(page, mes) {
  const clicado = await page.evaluate((mesObjetivo) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toUpperCase();
    const tabs = [...document.querySelectorAll('.action-onglet-mois')];
    const tab = tabs.find((t) => norm(t.textContent) === mesObjetivo);
    if (!tab) return false;
    tab.click();
    return true;
  }, mes.toUpperCase());

  if (!clicado) throw new Error(`No se encontró la pestaña de mes "${mes}"`);

  await page.waitForTimeout(2000);

  // Verificar que la pestaña activa es la del mes pedido.
  const activo = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toUpperCase();
    const act = document.querySelector('.onglet-mois-actif');
    return act ? norm(act.textContent) : null;
  });
  if (activo !== mes.toUpperCase()) {
    throw new Error(`No se pudo activar el mes "${mes}" (activo: "${activo}")`);
  }
}

// ---------------------------------------------------------------------------
// Programa principal
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

/**
 * Lanza un navegador, comprueba todos los días configurados y devuelve los
 * hallazgos. No envía notificaciones ni termina el proceso: eso lo decide
 * quien lo llama. Lanza excepción si hay un error
 * irrecuperable (página no carga, columna ausente, layout cambiado...).
 *
 * @returns {Promise<Array<{etiqueta, columna, disponibles: Array<{tipo, precio}>}>>}
 */
async function ejecutarChequeo() {
  const browser = await chromium.launch({ headless: CONFIG.headless });
  const page = await browser.newPage();
  page.setDefaultTimeout(CONFIG.timeoutMs);

  const hallazgos = [];
  try {
    log(`Navegando a ${CONFIG.url}`);
    await page.goto(CONFIG.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('table.table-prix', { timeout: CONFIG.timeoutMs });

    // Aceptar cookies si aparece el banner (no bloquea si no existe).
    try {
      await page.click('#tarteaucitronPersonalize2, .tarteaucitronCTAButton, #cookie-accept', { timeout: 3000 });
    } catch (_) {
      /* sin banner de cookies, seguimos */
    }

    for (const dia of CONFIG.diasLlegada) {
      log(`--- Probando llegada en ${dia.etiqueta} ---`);

      await seleccionarDiaLlegada(page, dia.valor);
      log(`[${dia.etiqueta}] Día de llegada seleccionado`);

      await seleccionarMes(page, CONFIG.mes);
      log(`[${dia.etiqueta}] Mes ${CONFIG.mes} seleccionado`);

      const res = await page.evaluate(extraerDisponibilidad, dia.columna);

      if (res.error === 'NO_TABLA') throw new Error('No se encontró la tabla de precios');
      if (res.error === 'NO_COLUMNA') {
        throw new Error(`No se encontró la columna "${dia.columna}" en el mes ${CONFIG.mes}`);
      }

      log(`[${dia.etiqueta}] Columna encontrada (índice ${res.colIndex}); ${res.comprobadas} alojamientos revisados`);

      if (res.disponibles.length > 0) {
        hallazgos.push({ etiqueta: dia.etiqueta, columna: dia.columna, disponibles: res.disponibles });
        log(`✅ [${dia.etiqueta}] DISPONIBLE ${dia.columna}:`);
        for (const d of res.disponibles) {
          log(`     • ${d.tipo} — ${d.precio}`);
        }
      } else {
        log(`❌ [${dia.etiqueta}] Todo COMPLETO para ${dia.columna}`);
      }
    }
  } finally {
    await browser.close();
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
  lineas.push(CONFIG.url);
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
  log(`Iniciando chequeo en Camping Alba (mes ${CONFIG.mes}) — ${resumenFechas}`);
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
