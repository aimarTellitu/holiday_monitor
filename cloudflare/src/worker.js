/**
 * Monitor de disponibilidad — Camping Alba (Capfun) — Cloudflare Worker
 *
 * Misma lógica que el check-camping.js de Node, adaptada al runtime de
 * Workers: la respuesta latin-1 se decodifica con TextDecoder y el disparo
 * periódico lo da el Cron Trigger de Cloudflare (fiable y puntual, a
 * diferencia del schedule de GitHub Actions).
 *
 * Disparadores (ver wrangler.toml):
 *   - cada 30 min                -> chequeo de disponibilidad
 *   - "15 7,10,13,16,19 * * *"   -> heartbeat "sigo vivo" 5 veces/día
 *
 * Variables (Cloudflare):
 *   - TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  -> secrets (wrangler secret put ...)
 *   - HEARTBEAT_SIEMPRE = "1"               -> fuerza el heartbeat en CADA
 *                                              ejecución (útil al validar)
 */

import { parse } from 'node-html-parser';

const CONFIG = {
  endpoint: 'https://www.capfun.es/php/tableau_resa2024.php',
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
  mois: 8, // 8 = agosto
  annee: 2026,
  maxSemanas: 6,
  diasLlegada: [
    { valor: 'SAMEDI', etiqueta: 'SÁBADO', columna: 'Del 22/08 al 29/08' },
    { valor: 'DIMANCHE', etiqueta: 'DOMINGO', columna: 'Del 23/08 al 30/08' },
  ],
  timeoutMs: 30000,
  // Debe coincidir EXACTAMENTE con el cron de heartbeat de wrangler.toml.
  cronHeartbeat: '15 7,10,13,16,19 * * *',
  urlPublica: 'https://www.capfun.es/camping-francia-catalogne-alba-ES.html',
};

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

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

async function descargar(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CONFIG.timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} al pedir el endpoint`);
    const buf = await res.arrayBuffer();
    return new TextDecoder('latin1').decode(buf);
  } finally {
    clearTimeout(t);
  }
}

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
    if (!enlacePrecio || !/\d/.test(enlacePrecio.text)) continue;
    const nombre = fila.querySelector('span.float-left');
    disponibles.push({
      tipo: norm(nombre ? nombre.text : '') || '(sin nombre)',
      precio: norm(enlacePrecio.text),
    });
  }

  return { rango, completa, comprobadas, disponibles };
}

async function localizarSemana(dia) {
  for (let semana = 1; semana <= CONFIG.maxSemanas; semana++) {
    const html = await descargar(construirUrl({ num_semaine: semana, sejour_arrivee: dia.valor }));
    const parsed = parsearSemana(html);
    if (!parsed.rango) continue;
    if (parsed.rango === dia.columna) return parsed;
  }
  throw new Error(`No se encontró la columna "${dia.columna}" en el mes ${CONFIG.mois}/${CONFIG.annee}`);
}

async function enviarTelegram(env, texto) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('⚠️ Telegram no configurado (define TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID). Aviso omitido.');
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
      console.log(`⚠️ Error enviando Telegram (HTTP ${resp.status}): ${body.slice(0, 200)}`);
      return false;
    }
    console.log('📨 Notificación enviada por Telegram');
    return true;
  } catch (err) {
    console.log(`⚠️ Error enviando Telegram: ${err.message}`);
    return false;
  }
}

async function ejecutarChequeo() {
  const hallazgos = [];
  for (const dia of CONFIG.diasLlegada) {
    const { completa, comprobadas, disponibles } = await localizarSemana(dia);
    if (completa) {
      console.log(`❌ [${dia.etiqueta}] Todo COMPLETO para ${dia.columna}`);
      continue;
    }
    console.log(`[${dia.etiqueta}] ${comprobadas} alojamientos revisados`);
    if (disponibles.length > 0) {
      hallazgos.push({ etiqueta: dia.etiqueta, columna: dia.columna, disponibles });
      console.log(`✅ [${dia.etiqueta}] DISPONIBLE ${dia.columna} (${disponibles.length})`);
    } else {
      console.log(`❌ [${dia.etiqueta}] Sin alojamientos disponibles para ${dia.columna}`);
    }
  }
  return hallazgos;
}

function componerMensaje(hallazgos) {
  const lineas = ['🏕️ ¡Disponibilidad en Camping Alba!', ''];
  for (const h of hallazgos) {
    lineas.push(`✅ ${h.etiqueta} — ${h.columna}:`);
    for (const d of h.disponibles) lineas.push(`• ${d.tipo} — ${d.precio}`);
    lineas.push('');
  }
  lineas.push(CONFIG.urlPublica);
  return lineas.join('\n');
}

async function chequearYNotificar(env, heartbeat) {
  const resumen = CONFIG.diasLlegada.map((d) => `${d.etiqueta}=${d.columna}`).join(', ');
  console.log(`Chequeo Camping Alba (mes ${CONFIG.mois}/${CONFIG.annee}) — ${resumen}`);
  try {
    const hallazgos = await ejecutarChequeo();
    const hayHueco = hallazgos.length > 0;
    if (hayHueco) {
      await enviarTelegram(env, componerMensaje(hallazgos));
    }
    if (heartbeat) {
      const hora = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const estado = hayHueco
        ? `con hueco en ${hallazgos.map((h) => h.columna).join(', ')}`
        : 'todo COMPLETO';
      await enviarTelegram(env, `💓 Monitor activo (${hora} UTC). Último chequeo: ${estado}.`);
    }
    return { hayHueco, hallazgos };
  } catch (err) {
    console.log(`⛔ ERROR: ${err.message}`);
    if (heartbeat) {
      await enviarTelegram(env, `💓 Monitor activo, pero el chequeo falló: ${err.message}`);
    }
    throw err;
  }
}

export default {
  // Disparo por Cron Trigger.
  async scheduled(event, env, ctx) {
    const heartbeat = event.cron === CONFIG.cronHeartbeat || env.HEARTBEAT_SIEMPRE === '1';
    ctx.waitUntil(chequearYNotificar(env, heartbeat).catch(() => {}));
  },

  // Disparo manual para probar: abre la URL del Worker en el navegador.
  // Añade ?heartbeat=1 para forzar también el mensaje "sigo vivo".
  async fetch(request, env) {
    const url = new URL(request.url);
    const heartbeat = url.searchParams.has('heartbeat') || env.HEARTBEAT_SIEMPRE === '1';
    try {
      const { hayHueco, hallazgos } = await chequearYNotificar(env, heartbeat);
      return new Response(JSON.stringify({ hayHueco, hallazgos }, null, 2), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch (err) {
      return new Response(`ERROR: ${err.message}`, { status: 500 });
    }
  },
};
