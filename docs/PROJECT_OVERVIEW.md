# INTISAT — Sala de Monitoreo Web — Visión general del proyecto

> Escrito para que otra IA/chat entienda el proyecto completo y sepa dónde y cómo
> integrar una pieza de frontend nueva, sin contexto previo de esta conversación.

## Qué es esto

INTISAT es un cubesat universitario. Esta carpeta (`Base-de-operaciones-Intisat`)
contiene la **sala de monitoreo web**: una app que recibe telemetría real del
satélite (vía SDR o un MCU por UART), la guarda, y la muestra en un dashboard
en el navegador. Coexiste con una app de escritorio PyQt5 más vieja (en una
carpeta **distinta**, `D:\D&S\Desktop\Interfaz_prueba`, que sí es un repo git —
esta carpeta web NO está en git). Ambas apps comparten el mismo pipeline de
recepción de radio (`Core/`), pero la web es la que se está desarrollando ahora.

Ubicación: `D:\D&S\Desktop\Base-de-operaciones-Intisat`

## Stack

- **Backend**: Python / FastAPI, nativo en Windows (no Docker) — corre en
  `127.0.0.1:8000`. Se conecta por ZMQ al proceso que decodifica la radio.
- **Storage de telemetría histórica**: ClickHouse, en Docker (`docker-compose.web.yml`).
  El backend se conecta por HTTP a `127.0.0.1:8123`.
- **Frontend**: React 19 + TypeScript + Vite 8 + react-router-dom (HashRouter).
  Sin librería de componentes UI ni Tailwind — CSS a mano en un solo archivo
  (`theme.css`), sin CSS modules ni styled-components.
- **Recepción de radio**: un backend en C (`intisat_sdr/`, LimeSDR/RTL-SDR) o
  un MCU por UART, orquestado por `headless_receiver.py` (proceso Python aparte
  del backend FastAPI).

## Cómo arrancar todo (orden importa)

1. Docker Desktop corriendo, luego `docker compose -f docker-compose.web.yml up -d`
   (levanta ClickHouse). Sin esto, `/api/telemetry/*` devuelve 500.
2. Backend: `INTISAT_CH_PASSWORD=<password de .env> python -m uvicorn webapp.backend.main:app --host 0.0.0.0 --port 8000`
   (el password tiene que coincidir con el `.env` que usó docker-compose; no se
   carga solo, hay que exportarlo).
3. Frontend (dev): dentro de `webapp/frontend`, `node ./node_modules/vite/bin/vite.js`
   (no usar `npx vite` — la ruta del proyecto tiene un `&` y rompe npx en Windows).
   Sirve en `127.0.0.1:5173`, con proxy a `/api` y `/ws` hacia el backend en :8000.
4. (Opcional, para telemetría real) `headless_receiver.py` — lee
   `satellite_config.yaml`, abre el SDR o el puerto serie, publica telemetría
   por ZMQ. **No puede correr al mismo tiempo que la app PyQt5** (ambos bindean
   el mismo socket ZMQ).

## Arquitectura de datos (de la antena al navegador)

```
LimeSDR/RTL-SDR ──> intisat_sdr.exe (C, DSP)  ──ZMQ PUB :5555 (FFT/paquetes)──┐
     o MCU UART ──> headless_receiver.py (Python, orquesta) ─ZMQ PUB :5560 (TLM/MSG/LOG)─┤
                                                                                 │
                                          ┌──────────────────────────────────────┘
                                          ▼
                        webapp/backend (FastAPI)
                        - zmq_ingest.py: SUB a :5560, inserta en ClickHouse,
                          reenvía por WebSocket a los clientes conectados
                        - spectrum_stream.py: SUB a :5555 (topic FFT) opt-in,
                          reenvía por WebSocket solo si hay clientes viendo espectro
                                          │
                          REST /api/*  +  WS /ws/live, /ws/spectrum
                                          ▼
                              webapp/frontend (React, puerto 5173 en dev)
```

Canales de telemetría: nombres planos tipo `sim.eps_batt_voltage`,
`sim.adcs_quat_w`, etc. (el prefijo `sim.` es histórico — viene del decoder de
subpaquetes, no significa "datos simulados/falsos", es telemetría real decodificada).
Ver `Core/telemetry_publisher.py` (diccionario `SIM_CHANNEL_NAMES`) para la
lista completa de canales disponibles.

## Backend — estructura (`webapp/backend/`)

- `main.py` — app FastAPI, monta los routers, define `/ws/live` y `/ws/spectrum`.
- `config.py` / `config.yaml` — config del backend (endpoints ZMQ, ClickHouse,
  puerto web). Todo override-able por variable de entorno `INTISAT_<NOMBRE>`.
- `auth.py` + `routers/auth.py` — login simple por sesión/cookie, usuario admin
  único (`admin`/`changeme` por default, override por env var). Protege las
  rutas de Configuración.
- `zmq_ingest.py` — SUB al puente de telemetría (:5560), persiste a ClickHouse,
  retransmite por WS.
- `spectrum_stream.py` — SUB al FFT del backend SDR (:5555), solo trabaja si
  hay clientes conectados a `/ws/spectrum` (throttle 8fps, decimado a 512 bins).
- `clickhouse_client.py` / `schema.sql` — conexión y esquema de ClickHouse
  (tablas: telemetría histórica, mensajes/paquetes).
- `routers/telemetry.py` — `GET /api/telemetry/latest`, `GET /api/telemetry/history`,
  `GET /api/channels`.
- `routers/messages.py` — `GET /api/messages` (tabla de paquetes recibidos,
  con filtros).
- `routers/status.py` — `GET /api/status` (conexión ZMQ, frames recibidos, uptime).
- `routers/satellite.py` — `GET/PUT /api/satellite` (lee/escribe
  `satellite_config.yaml`), `GET /api/satellite/decoder-file`.
- `routers/sdr_scan.py` — `GET /api/sdr/scan` (detección USB/serie real),
  `POST /api/sdr/restart` (reinicia el pipeline SDR).
- `routers/schedule.py` — `GET /api/schedule`, `POST /api/schedule/recurring`,
  `POST /api/schedule/once`, `DELETE /api/schedule/{kind}/{id}` — comandos
  programados hacia el satélite.
- `routers/images.py` — `GET /api/images`, `GET /api/images/{filename}` —
  imágenes recibidas del payload.
- `routers/auth.py` — `POST /api/auth/login`, `POST /api/auth/logout`,
  `GET /api/auth/me`.

Todas las rutas admin (`satellite`, `sdr_scan`, `schedule`) requieren sesión
autenticada (`Depends(require_auth)`).

## Frontend — estructura (`webapp/frontend/src/`)

```
App.tsx                 — rutas (HashRouter), shell (Sidebar + Topbar + contenido)
nav.ts                  — define las 4 secciones y sus tabs (fuente única de
                           verdad para Sidebar y Topbar)
api.ts                  — cliente REST tipado (fetch + tipos TS), wsURL()/wsSpectrumURL()
theme.css               — TODO el CSS de la app, tokens en :root, sin libs
components/
  Sidebar.tsx            — nav lateral colapsable (4 secciones)
  Topbar.tsx             — header (título de sección + reloj + login/logout) + tabs
  SpectrumScope.tsx       — espectro+waterfall real, consume /ws/spectrum
  HistoryChart.tsx, GaugeTile.tsx, ValueTile.tsx, StatusPill.tsx, TimeRangePicker.tsx
  RequireAuth.tsx, TransmitWarning.tsx, SplashScreen.tsx
telemetry/
  TelemetryContext.tsx   — WebSocket a /ws/live, expone useChannel()/useTelemetry()
  useHistory.ts
auth/AuthContext.tsx     — estado de sesión, login()/logout()
pages/
  Dashboard.tsx, EpsThermal.tsx, Adcs.tsx, Comms.tsx, Payload.tsx   (sección "Dashboard")
  Orbita.tsx                                                        (sección "Órbita")
  Logs.tsx (exporta LogsMensajes y LogsVariables)                   (sección "Logs")
  Config.tsx, Programacion.tsx, SdrDiagnostico.tsx                  (sección "Configuración", admin)
  Login.tsx
public/
  dashboard-general.html, dashboard-eps.html, dashboard-adcs.html,
  dashboard-payload.html, dashboard-common.js
  attitude-cubesat.html, orbita.html
```

### Rutas (4 secciones, cada una con sub-pestañas)

- `/dashboard/general`, `/dashboard/eps`, `/dashboard/adcs`, `/dashboard/comms`, `/dashboard/payload`
- `/orbita/general`
- `/logs/mensajes`, `/logs/variables`
- `/configuracion/sdr`, `/configuracion/programacion`, `/configuracion/diagnostico` (requieren login)

`nav.ts` es la fuente de verdad de esta estructura — un tab nuevo se agrega ahí
y aparece solo en el Sidebar/Topbar.

### Patrón importante: pestañas del Dashboard como HTML estático embebido

4 de las 5 pestañas del Dashboard (`General`, `EPS/Thermal`, `ADCS`, `Payload`)
**no son componentes React** — son páginas HTML autocontenidas en
`webapp/frontend/public/dashboard-*.html`, montadas vía `<iframe>` desde un
wrapper React trivial (ver `pages/EpsThermal.tsx` como ejemplo: solo renderiza
`<iframe src="/dashboard-eps.html">`). Esto es deliberado: se portó un diseño
de referencia (Mission Control) **tal cual** (mismo CSS/HTML exacto), y cada
página hace su propio `fetch('/api/telemetry/latest')` / `/api/telemetry/history`
contra el mismo backend (mismo origen, funciona en dev vía el proxy de Vite y
en prod porque FastAPI sirve el build). `public/dashboard-common.js` tiene los
helpers compartidos (`IntisatDash.latest()`, `.history()`, `.fmt()`, `.drawChart()`).

La pestaña `Comms` SÍ es un componente React normal (`pages/Comms.tsx`) porque
reutiliza el componente real `<SpectrumScope>` (WebSocket, no se puede replicar
fácil en HTML estático) — su CSS de referencia se portó igual pero scopeado
bajo la clase `.mc-comms` en `theme.css` para no chocar con el resto de la app.

**Si el otro chat va a agregar una pieza de frontend nueva**: decidir primero
si necesita WebSocket/estado React complejo (→ componente React normal, como
Comms.tsx) o si es más una vista de datos simple (→ puede seguir el patrón
HTML-estático-en-iframe + `dashboard-common.js`, más simple de portar un diseño
visual tal cual). Para cualquiera de los dos casos, el dato real sale de los
endpoints REST de arriba o del WebSocket `/ws/live` — **nunca inventar/mockear
números**: donde no hay canal real, mostrar `—`, nunca un valor de ejemplo.

### Convenciones de CSS

- Todo en `theme.css`, tokens en `:root` (`--bg-page`, `--bg-panel`,
  `--accent-cyan`, `--text-primary`, `--border-subtle`, etc.) — reusar estos
  tokens, no inventar colores nuevos sueltos.
- Tema único claro ("panel de instrumentos"), sin dark mode.
- Las páginas HTML estáticas en `public/` tienen su **propio** `<style>`
  inline (no tocan `theme.css`) porque viven en un documento aparte (iframe).

## Autenticación

Login simple de un solo usuario admin, por cookie de sesión. Protege
`/configuracion/*`. Credenciales por defecto `admin`/`changeme`
(`webapp/backend/config.py`, override con `INTISAT_ADMIN_USER`/`INTISAT_ADMIN_PASSWORD`).

## Principio no-negociable del proyecto

**Nunca mostrar datos inventados/fabricados.** Si un canal de telemetría no
existe o no llegó un frame reciente, el campo se muestra como `—` (no un
placeholder con número falso, no una curva sintética). Esto aplica a cualquier
frontend nuevo que se agregue.

## Qué falta / está fuera de alcance por ahora

- Órbita real (SGP4 + catálogo TLE) — hoy es un iframe decorativo
  (`public/orbita.html`), sin backend.
- Multi-satélite / multi-estación — `satellite_config.yaml` es un solo satélite fijo.
- Varios parámetros del SDR que el backend en C ya soporta en caliente
  (symbol rate, freq deviation, bandwidth, power gate) todavía no tienen
  formulario en la UI — ver `docs/` u otras notas de la sesión para el detalle
  completo de qué parámetros son.
