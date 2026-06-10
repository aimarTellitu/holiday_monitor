# Monitor de disponibilidad — Camping Alba (Capfun)

Hace **un chequeo** de la web de Camping Alba y avisa por **log** si la semana
configurada tiene algún alojamiento que **no** esté marcado como `COMPLETO`,
probando primero la llegada en **sábado** y luego en **domingo**.

## Requisitos

- Node.js 18+
- Conexión a Internet

## Instalación

```powershell
npm install
npx playwright install chromium
```

## Uso

```powershell
npm start
# o:
node check-camping.js
```

Salida de ejemplo cuando hay hueco:

```
✅ [SÁBADO] DISPONIBLE Del 22/08 al 29/08:
     • 4 HABANA TOP PRESTA 4 PERSONAS 2 Habitaciones — 1337 € Última disponibilidad
```

## Modo de ejecución: un solo chequeo

El script hace **un único chequeo y termina** (no hay bucle: de repetirlo se
encarga el programador externo, ver _GitHub Actions_ más abajo). Comprueba la
semana configurada, avisa por Telegram si hay hueco y sale con el código
correspondiente.

### Heartbeat ("sigo vivo")

Si defines la variable de entorno **`HEARTBEAT`** (cualquier valor, p.ej.
`HEARTBEAT=1`), además del aviso por hueco envía un mensaje
`💓 Monitor activo (… UTC). Último chequeo: …` con el resultado del chequeo.
Sirve para confirmar que el monitor sigue funcionando. **Cuándo** mandarlo
(p.ej. cada 3 h entre las 9 y las 23) lo decide el cron que lanza el script, no
el propio código.

```powershell
# Chequeo normal: solo avisa si hay hueco
node check-camping.js

# Chequeo + "sigo vivo"
$env:HEARTBEAT = "1"; node check-camping.js
```

### Códigos de salida

| Código | Significado                                            |
|--------|--------------------------------------------------------|
| `0`    | Hay disponibilidad en al menos uno de los días         |
| `1`    | Todo `COMPLETO` en todos los días probados             |
| `2`    | Error (no carga la página, no aparece la columna, ...) |

Útiles si lo enganchas a un cron, al Programador de tareas de Windows o a
GitHub Actions.

## Despliegue en GitHub Actions

El repo incluye `.github/workflows/check-camping.yml`, que ejecuta el chequeo en
la nube con dos programaciones:

- **Chequeo**: cada 30 min (`*/30 * * * *`).
- **Heartbeat**: 5 veces al día (`0 7,10,13,16,19 * * *`), activando `HEARTBEAT`
  solo en ese disparo.

> ⚠️ **El cron de GitHub usa siempre hora UTC.** En horario de verano España va
> UTC+2, así que `7,10,13,16,19` UTC = **9, 12, 15, 18 y 21 hora española**. En
> invierno (UTC+1) se corren a 8, 11, 14, 17 y 20. Si quieres horas exactas todo
> el año habría que meter lógica de zona horaria en el código.

El script sale con código `1` cuando todo está `COMPLETO`; el workflow lo trata
como ejecución correcta (`node check-camping.js || [ $? -eq 1 ]`), no como fallo.

### Pasos para ponerlo en marcha

El repositorio de GitHub ya está creado y es **público**
(`https://github.com/aimarTellitu/holiday_monitor`). Que sea público da
**minutos de Actions ilimitados** gratis (con cada 30 min, un repo privado se
comería los 2.000 min/mes del plan gratuito). Las credenciales **no** viven en
el código: van en _Secrets_ del repo.

1. **Convertir esta carpeta en repo y subirla** (ahora es una carpeta suelta
   dentro de otro working tree, así que se inicializa como repo propio):

   ```powershell
   git init
   git add .
   git commit -m "Monitor Camping Alba para GitHub Actions"
   git branch -M main
   git remote add origin https://github.com/aimarTellitu/holiday_monitor.git
   git push -u origin main
   ```

   El push pide autenticación. GitHub **no admite contraseña**: usa un
   **Personal Access Token** (GitHub → Settings → Developer settings → Personal
   access tokens) como contraseña, o instala Git Credential Manager / la CLI
   `gh`. El `.gitignore` ya excluye `node_modules/`, `.env` y `.playwright-mcp/`,
   así que tu token de Telegram no se sube.

2. **Configurar los Secrets** en GitHub: repo → _Settings_ → _Secrets and
   variables_ → _Actions_ → _New repository secret_. Crea:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`

   (los mismos valores que tienes en tu `.env` local).

3. **Probarlo**: pestaña _Actions_ → _Monitor Camping Alba_ → _Run workflow_
   (gracias a `workflow_dispatch`). Revisa el log y que llegue el Telegram.

> ℹ️ GitHub **deshabilita los crons tras 60 días sin actividad** en el repo. Si
> el monitor deja de dispararse, basta con hacer un commit cualquiera o
> reactivar el workflow desde la pestaña _Actions_.

## Notificación por Telegram

Si hay disponibilidad, el script envía un aviso por Telegram con el resumen
(día, semana, alojamientos y precios). Es **opcional**: si no configuras las
credenciales, el chequeo funciona igual y solo lo verás por log.

**Pasos para configurarlo:**

1. En Telegram, habla con [@BotFather](https://t.me/BotFather), envía `/newbot`
   y sigue los pasos. Te dará un **token**.
2. Escríbele un mensaje a tu nuevo bot (para que pueda contestarte).
3. Abre en el navegador `https://api.telegram.org/bot<TU_TOKEN>/getUpdates` y
   copia el `chat.id` que aparece.
4. Copia `.env.example` a `.env` y rellena `TELEGRAM_BOT_TOKEN` y
   `TELEGRAM_CHAT_ID`.

```powershell
Copy-Item .env.example .env
# edita .env con tu token y chat_id
```

## Configuración

Al principio de `check-camping.js` está el bloque `CONFIG`. Lo importante:

- `mes`: pestaña de mes a seleccionar (`'AGOSTO'`, `'JULIO'`, ...).
- `diasLlegada[].columna`: cabecera de la semana a comprobar.

> ⚠️ La etiqueta de la semana **depende del día de llegada**: la web muestra
> semanas de sábado-a-sábado o de domingo-a-domingo. Para finales de agosto de
> 2026 son `Del 22/08 al 29/08` (sábado) y `Del 23/08 al 30/08` (domingo).

Para **verificar que el parseo funciona**, apunta `mes` + `columna` a una semana
que sí tenga hueco (p.ej. sábado `Del 15/08 al 22/08`) y comprueba que lista los
alojamientos con su precio.
