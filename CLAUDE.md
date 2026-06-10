# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-shot availability scraper for Camping Alba (Capfun). It runs **one check** of the booking page and exits — there is no loop. Repetition is delegated to an external scheduler (GitHub Actions cron). The whole program is `check-camping.js`; everything else is config, docs, and CI.

## Commands

```powershell
npm install
npm start                         # or: node check-camping.js
$env:HEARTBEAT = "1"; node check-camping.js   # also send a "still alive" Telegram
```

There are no tests, linter, or build step. To **verify the parser works**, point `CONFIG.mois`/`annee` + `diasLlegada[].columna` at a week known to have availability and confirm it lists accommodations with prices (see "Editing CONFIG" below).

## Exit codes (load-bearing — the CI relies on them)

| Code | Meaning |
|------|---------|
| `0` | Availability found on at least one arrival day |
| `1` | Everything `COMPLETO` on all tried days — **not an error** |
| `2` | Real error (page didn't load, column missing, layout changed) |

The GitHub workflow runs `node check-camping.js || [ $? -eq 1 ]` so exit `1` does not fail the job. Preserve this three-way contract when changing control flow in `ejecutarUnaVez()`.

## Architecture / why it's shaped this way

The target page is pure JS, but it renders its price table by calling its own backend endpoint (`tableau_resa2024.php` with `div=mobile`). That endpoint returns the **already-built HTML fragment for one week** per request, so the script hits it directly with a native `fetch` and parses the fragment with `node-html-parser` — no browser, no Playwright. (Earlier versions drove a real Chromium via Playwright; that was dropped because the endpoint serves everything we need as static HTML.)

Flow in `check-camping.js`:
1. `ejecutarUnaVez()` — entry point. Decides exit code, sends Telegram, handles `HEARTBEAT`.
2. `ejecutarChequeo()` — loops over `CONFIG.diasLlegada`, returns findings. Throws on unrecoverable errors. Does **not** notify or exit (caller's job).
3. Per arrival day: `localizarSemana()` requests `num_semaine = 1..maxSemanas` for the configured month/arrival day, parses each fragment, and returns the one whose date label (`Del DD/MM al DD/MM`) matches `dia.columna`. Throws if none match.
4. `parsearSemana(html)` does all the parsing in one pass: date range, the "¡Estamos COMPLETOS!" banner, and the available accommodations.

### Parsing gotchas (the fragile parts)

- One request = one week, fixed by URL params (`mois`/`annee` + `num_semaine` + `sejour_arrivee`). We don't pick the week by parsing column headers — we iterate `num_semaine` and **match the date label**, which self-corrects if the Nth-Saturday offset shifts.
- The week label depends on the arrival day: the site shows Saturday-to-Saturday or Sunday-to-Sunday weeks, so **each entry in `diasLlegada` carries its own `columna`** (e.g. Sat `Del 22/08 al 29/08`, Sun `Del 23/08 al 30/08`).
- A fully-booked week renders a banner (`¡Estamos COMPLETOS para esta semana!`) and **no priced rows** — that's what `completa` detects. Otherwise, only `tr.ligne_tarif` rows are bookable; a row counts as available when its data cell has a price link (`td a` with digits). The name is the first `span.float-left` of the row's `<th>`; the trailing `N Pers - … Habitaciones` descriptor lives in a separate span.
- The page is served as **latin-1**: read the response as `Buffer.from(...).toString('latin1')` before parsing. `node-html-parser`'s `.text` decodes HTML entities (`&euro;`, `&iacute;`…) on its own, so there's no manual entity table.
- The URL carries **stable camp identifiers** (`id_resa_thelis=6777`, `camping=alba`). If Capfun changes those, the fetch returns the wrong/empty fragment — same class of fragility as the old DOM scraping, just relocated to the query string.

### Editing CONFIG

The `CONFIG` block at the top of `check-camping.js` is the only thing you normally change. Change `mois`/`annee` and `diasLlegada[].columna` **together** — they must point at the same calendar week, or `localizarSemana()` never finds a matching label and throws (exit `2`).

## Telegram notifications (optional)

`enviarTelegram()` posts to the Bot API using native `fetch`. Needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from env (loaded from a `.env` file via Node's native `process.loadEnvFile`, no dotenv dependency). If unset, the check still runs and only logs — never make Telegram failures affect the exit code.

## Deployment

`.github/workflows/check-camping.yml` runs the check every 30 min, plus a heartbeat schedule (`0 7,10,13,16,19 * * *`) that sets `HEARTBEAT`. **All crons are UTC** — adjust expectations for Spanish time (UTC+2 summer / UTC+1 winter). Credentials live in repo Secrets, never in code. GitHub disables crons after 60 days of repo inactivity.

## Conventions

- Code, comments, logs, and docs are in **Spanish** — match that when editing.
- The only runtime dependency is `node-html-parser` (HTML parsing — Node has no native HTML parser); the `.env` loader and HTTP client are native Node 18+ (`process.loadEnvFile`, `fetch`). Don't add libraries for things Node already does.
