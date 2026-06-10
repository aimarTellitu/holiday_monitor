# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-shot availability scraper for Camping Alba (Capfun). It runs **one check** of the booking page and exits — there is no loop. Repetition is delegated to an external scheduler (GitHub Actions cron). The whole program is `check-camping.js`; everything else is config, docs, and CI.

## Commands

```powershell
npm install
npx playwright install chromium   # one-time: download the browser
npm start                         # or: node check-camping.js
$env:HEARTBEAT = "1"; node check-camping.js   # also send a "still alive" Telegram
```

There are no tests, linter, or build step. To **verify the parser works**, point `CONFIG.mes` + `diasLlegada[].columna` at a week known to have availability and confirm it lists accommodations with prices (see "Editing CONFIG" below).

## Exit codes (load-bearing — the CI relies on them)

| Code | Meaning |
|------|---------|
| `0` | Availability found on at least one arrival day |
| `1` | Everything `COMPLETO` on all tried days — **not an error** |
| `2` | Real error (page didn't load, column missing, layout changed) |

The GitHub workflow runs `node check-camping.js || [ $? -eq 1 ]` so exit `1` does not fail the job. Preserve this three-way contract when changing control flow in `ejecutarUnaVez()`.

## Architecture / why it's shaped this way

The target page is pure JS: the price table is paginated by month via AJAX, and changing the arrival day re-renders the table through a jQuery handler. A plain `fetch` can't see the rendered table, so the script drives a **real Chromium via Playwright**.

Flow in `check-camping.js`:
1. `ejecutarUnaVez()` — entry point. Decides exit code, sends Telegram, handles `HEARTBEAT`.
2. `ejecutarChequeo()` — launches the browser, loops over `CONFIG.diasLlegada`, returns findings. Throws on unrecoverable errors. Does **not** notify or exit (caller's job).
3. Per arrival day: `seleccionarDiaLlegada()` (selects `#sejour_arrivee`, waits for AJAX re-render) → `seleccionarMes()` (clicks the month tab, verifies it became active) → `extraerDisponibilidad()`.
4. `extraerDisponibilidad(columnaFechas)` runs **inside the browser** (`page.evaluate`). It must be self-contained — no closures over Node-side variables (note it redefines its own `norm` helper for this reason).

### DOM-scraping gotchas (the fragile parts)

- There are **two** `table.table-prix` elements: a floating header clone from floatThead (carries the date ranges in `aria-label`/text) and the real data table. The code reads the **column index** from the header clone, then reads **data** from `table.table-prix:not(.floatThead-table)`.
- The week label depends on the arrival day: the site shows Saturday-to-Saturday or Sunday-to-Sunday weeks, so **each entry in `diasLlegada` carries its own `columna`** (e.g. Sat `Del 22/08 al 29/08`, Sun `Del 23/08 al 30/08`).
- Only `tr.ligne_tarif` rows are real bookable accommodations; category-summary rows are skipped. A cell is "full" if it has class `tableau-resa-complet` or matches `/COMPLETO/i`; "available" if it contains a digit; `-`/empty is ignored.

### Editing CONFIG

The `CONFIG` block at the top of `check-camping.js` is the only thing you normally change. Change `mes` and `diasLlegada[].columna` **together** — they must point at the same calendar week or the column lookup throws `NO_COLUMNA` (exit `2`).

## Telegram notifications (optional)

`enviarTelegram()` posts to the Bot API using native `fetch`. Needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from env (loaded from a `.env` file via Node's native `process.loadEnvFile`, no dotenv dependency). If unset, the check still runs and only logs — never make Telegram failures affect the exit code.

## Deployment

`.github/workflows/check-camping.yml` runs the check every 30 min, plus a heartbeat schedule (`0 7,10,13,16,19 * * *`) that sets `HEARTBEAT`. **All crons are UTC** — adjust expectations for Spanish time (UTC+2 summer / UTC+1 winter). Credentials live in repo Secrets, never in code. GitHub disables crons after 60 days of repo inactivity.

## Conventions

- Code, comments, logs, and docs are in **Spanish** — match that when editing.
- Zero runtime dependencies beyond Playwright; the `.env` loader and HTTP client are native Node 18+. Don't add libraries for things Node already does.
