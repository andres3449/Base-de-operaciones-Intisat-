# Organización de la interfaz web INTISAT — 4 secciones

Referencia para generar imágenes de cómo debería verse cada vista. Describe
qué contiene cada sección, qué paneles/widgets tiene y de dónde sale el dato
(backend real vs. futuro).

---

## 1. Dashboard

Vista operativa "todo en una pantalla" del satélite activo. Fusiona lo que
hoy son páginas sueltas (General/EPS-Thermal/ADCS/Comms/Payload) en una sola
pantalla con sub-pestañas internas.

**Sub-vista General** (la que abre por defecto):
- Elemento hero: visual orbital (Tierra + anillos + punto del satélite) +
  cuenta grande de "próximo pase" (tiempo, elevación máxima, AOS/LOS).
- Lista compacta de estado por subsistema (EPS / ADCS / Comunicaciones /
  Payload): una fila por subsistema, no tarjetas iguales — nombre, cifra
  clave, estado en texto/pill.
- Gráfica de voltaje de batería 24h + consola de últimos eventos (solo
  lectura).

**Sub-vista EPS/Thermal:** VBATT/IBATT/SOC/VBUS/salud de batería, estado de
heaters, gauges de CPU/RAM/filesystem del OBC, histórico batería+térmico,
tabla de paneles solares.

**Sub-vista ADCS:** sensores (giroscopios/magnetómetros/sol) y actuadores
(ruedas de reacción/magnetorquers) en paneles de 3 columnas, vista 3D del
cubesat (rotable con el mouse) con HUD de orientación, gráfica de altitud.

**Sub-vista Comunicaciones:** KPIs (RSSI/SNR/downlink/BER), parámetros RF
activos, gráfica de SNR, waterfall del espectro, lista de paquetes recibidos,
consola de paquetes decodificados.

**Sub-vista Payload:** visor de imagen (pan/zoom), barra de acciones
(solicitar imagen / calibrar / descargar / reset — un botón primario, el
resto en estilo discreto/outline), consola de terminal del payload.

---

## 2. Órbita

Todo lo relacionado a seguimiento orbital, multi-satélite y multi-estación.

**Sub-vista General:** vista orbital grande (como el hero del Dashboard pero
a pantalla completa), selector de satélite activo si hay varios.

**Sub-vista Pases:** catálogo de satélites y estaciones de seguimiento (lista
con tarjetas), calendario/timeline interactivo de pases (filas por satélite,
bloques de pase clickeables), banner destacado con el "mejor próximo pase"
(mayor elevación).

**Sub-vista Vista libre:** constructor de paneles por arrastrar-y-soltar —
toolbar con "+Métrica / +Gráfica / +Vista 3D", grid donde el usuario agrega y
reordena widgets libremente. Vista personalizada, se guarda por usuario.

**Backend necesario (aún no existe, hoy es un solo satélite fijo en
`satellite_config.yaml`):**
- Catálogo persistido de satélites (TLE, frecuencias, modulación por
  satélite) y de estaciones de seguimiento (lat/lon/alt).
- Motor de predicción de pases real (SGP4 + TLE), no mockeado.
- Persistencia de layouts de la vista libre por usuario.

---

## 3. Configuración

Solo accesible con sesión de administrador (`admin`/`changeme` hoy). Reemplaza
el combo "driver de recepción" por un panel de escaneo de dispositivos:
detecta SDR/MCU conectados por USB/serial, el usuario selecciona el
dispositivo detectado y ahí mismo fija driver+backend a usar.

**Secciones internas:**
- **SDR y recepción:** panel de escaneo con botón "buscar dispositivos",
  lista de equipos detectados (LimeSDR/RTL-SDR/MCU) con botón "usar este",
  parámetros de frecuencia/ganancia/demodulación una vez seleccionado.
- **Backend:** endpoints ZMQ, timeouts, reinicio del backend SDR (botón de
  autoservicio, ya existe vía `/api/sdr/restart`).
- **Calendario:** configuración de la futura integración con el motor de
  pases (TLE source, estaciones habilitadas).

Formulario de una columna, barra de "guardar" fija abajo con indicador de
cambios sin guardar.

---

## 4. Logs

Vista de auditoría completa, sin filtrado por "vista operativa":
- Consola de eventos en vivo (todo el tráfico TLM/MSG/LOG, no solo lo
  relevante a una pantalla).
- Espectro RF en vivo (igual que el componente `SpectrumScope` ya construido
  en el frontend real).
- Última imagen recibida del payload.
- Tabla completa de mensajes/paquetes con filtros.

---

## Qué es real hoy vs. qué falta

| Pieza | Estado |
|---|---|
| Dashboard (todas las sub-vistas, datos reales vía ZMQ) | Existe en el frontend real |
| Espectro RF en vivo (`/ws/spectrum`) | Existe, funcional con hardware real |
| Escaneo + reinicio de SDR (`/api/sdr/scan`, `/api/sdr/restart`) | Existe, funcional |
| Logs (consola + espectro + tabla) | Existe |
| Órbita — vista orbital, calendario de pases, vista libre | Solo mockup visual (Artifact), sin backend |
| Multi-satélite / multi-estación persistido | No existe — hoy es un solo satélite en YAML |
| Motor SGP4/TLE de predicción de pases | No existe |
| Guardado de layouts de la vista libre | No existe |

---

## Para generar imágenes de referencia con IA

Por cada vista de arriba, generar una imagen separada. Mantener consistente
entre todas las imágenes:
- Paleta oscura: fondo casi negro azulado, paneles un tono más claro, un solo
  color de acento (azul), verde/ámbar/rojo solo para estado (ok/warn/crit).
  Ver [[feedback_reference_html_fidelity]] y los tokens de `theme.css`/el
  Artifact actual para los valores exactos de color si se quiere igualar 1:1.
- Densidad alta tipo consola de misión, no tipo app consumer — números en
  monoespaciada, tablas compactas, cero iconos genéricos en círculos de color.
- Un elemento dominante por pantalla (el "hero" de cada vista), el resto en
  soporte — nunca todo del mismo peso visual.
