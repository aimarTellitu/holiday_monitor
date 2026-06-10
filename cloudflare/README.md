# Camping Alba Monitor — Cloudflare Worker

Despliegue alternativo (y más fiable) del monitor usando **Cloudflare Workers**
con **Cron Triggers**, en vez de GitHub Actions. Mismo chequeo y mismos avisos
por Telegram; el cron de Cloudflare sí dispara puntual.

## Requisitos

- Una cuenta gratuita de [Cloudflare](https://dash.cloudflare.com/sign-up).
- Node.js 18+ (para ejecutar `wrangler`, la CLI de Cloudflare).

## Puesta en marcha

Desde esta carpeta (`cloudflare/`):

```powershell
npm install                 # instala wrangler y node-html-parser

npx wrangler login          # abre el navegador para autenticar tu cuenta

# Credenciales de Telegram como SECRETS (no se guardan en el repo):
npx wrangler secret put TELEGRAM_BOT_TOKEN   # pega el token y Enter
npx wrangler secret put TELEGRAM_CHAT_ID     # pega el chat_id y Enter

npx wrangler deploy         # publica el Worker y registra los cron
```

Al desplegar, Cloudflare te da una URL tipo
`https://camping-alba-monitor.<tu-subdominio>.workers.dev`.

## Probar que funciona

- **A mano**: abre la URL del Worker en el navegador. Ejecuta el chequeo y
  devuelve un JSON con el resultado. Añade `?heartbeat=1` para forzar también el
  mensaje "sigo vivo" por Telegram:
  `https://camping-alba-monitor.<tu-subdominio>.workers.dev/?heartbeat=1`
- **Logs en vivo**: `npx wrangler tail` y dispara el Worker (a mano o esperando
  al cron).
- **Cron**: en el dashboard de Cloudflare → Workers & Pages → tu worker →
  *Settings → Triggers* verás los dos cron registrados.

## Cron y heartbeat

Definidos en `wrangler.toml`:

- `*/30 * * * *` — chequeo de disponibilidad cada 30 min.
- `15 7,10,13,16,19 * * *` — heartbeat 5 veces/día (debe coincidir con
  `CONFIG.cronHeartbeat` en `src/worker.js`).

> **Hora UTC**, igual que GitHub: `7,10,13,16,19` UTC = 9,12,15,18,21 en España
> (verano). Cloudflare Workers también usa UTC para los cron.

La variable `HEARTBEAT_SIEMPRE` (en `[vars]` de `wrangler.toml`) viene a `"1"`
para que **cada** ejecución te avise por Telegram mientras validas. Cuando ya
confíes en él, ponla a `"0"` (o bórrala) y `npx wrangler deploy` otra vez.

## Editar las fechas a vigilar

Igual que en la versión Node: el bloque `CONFIG` al principio de
`src/worker.js`. Cambia `mois`/`annee` y `diasLlegada[].columna` a la vez y
vuelve a `npx wrangler deploy`.
