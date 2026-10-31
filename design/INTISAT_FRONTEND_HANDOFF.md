# INTISAT — Traspaso del frontend a Codex en Cursor

Fecha: 28 de octubre de 2026. Referencia visual aprobada: HTML v9.

## Instrucción para el agente

Integra el diseño de `design/INTISAT_Mission_Control.html` en el frontend React existente de INTISAT. Este documento transmite las decisiones de diseño y los límites funcionales de la conversación original. Lee primero las instrucciones del repositorio, inspecciona el código real y presenta un plan breve; luego implementa la integración por etapas dentro del alcance solicitado. No necesitas que se reconstruya toda la conversación.

Conserva la funcionalidad existente, los contratos de datos, la autenticación y los servicios del backend. Sustituye los datos demostrativos por datos reales cuando exista una fuente comprobada. Mantén los estados pendientes o desconectados explícitos donde no exista integración. No conviertas datos simulados en indicadores de estado real.

El usuario trabaja también con Claude en Antigravity sobre la arquitectura. Revisa `git status` antes de editar, respeta cambios ajenos y evita sobrescribir trabajo concurrente. No modifiques el DSP C ni reorganices el backend por conveniencia visual. Resuelve ajustes rutinarios del frontend y verifica el resultado sin pedir aprobación en cada paso; consulta únicamente decisiones que cambien el alcance o requieran información indispensable.

## Archivos y cómo empezar

Colocar en el repositorio:

- `design/INTISAT_Mission_Control.html`: versión final del prototipo visual e interactivo.
- `design/INTISAT_FRONTEND_HANDOFF.md`: este documento.

El HTML se puede abrir directamente en un navegador. Es autónomo y contiene imágenes, estilos, JavaScript y dependencias embebidas. No requiere npm para visualizarlo.

Identificación del HTML entregado:

- Tamaño: 11 233 279 bytes.
- SHA-256: `23cd0caf662dbc8b36ddae11b985c829cbbc5857e879a350cdc03806c19bd06b`.

Es la referencia final de diseño, no un frontend React listo para producción. El HTML usa un shell y páginas internas en `iframe srcdoc`, almacenadas en `const EMBEDDED`. Configuración y Logs también tienen implementación en el documento exterior. Inspecciona ambas partes. Migra el diseño a componentes React reutilizables, siguiendo la arquitectura del repositorio; no incrustes toda la aplicación como un iframe permanente.

Existe un ZIP opcional anterior con el mismo HTML, `server.py`, README y licencias. Su servidor SQLite es una ayuda del prototipo orbital; no reemplaza FastAPI y no es necesario para empezar la integración visual.

## Contexto y autoridad de la información

INTISAT es una estación terrena de monitoreo y control satelital. La aplicación web usa React, FastAPI y ClickHouse y reemplaza una aplicación PyQt5 legacy.

El repositorio de producción NO fue leído ni modificado durante la preparación de este prototipo. Las capacidades reales descritas aquí proceden del brief del usuario y deben contrastarse con el código de su máquina. En caso de diferencia, documenta lo encontrado y conserva el comportamiento real mientras adaptas la interfaz.

Archivos que el usuario señaló como relevantes, sujetos a confirmar en el repositorio:

- `webapp/frontend/src/pages/Config.tsx`
- `webapp/frontend/src/pages/Programacion.tsx`
- `webapp/frontend/src/pages/SdrDiagnostico.tsx`
- `webapp/backend/routers/sdr_scan.py`
- `webapp/backend/config.yaml`
- `satellite_config.yaml`
- `Core/SDR/sdr_backend_client.py`
- `headless_receiver.py`
- `intisat_sdr/include/config.h`

## Decisiones visuales que se deben conservar

- Toda la interfaz del producto en inglés. Este documento está en español para el equipo.
- Tema claro elegante, paneles blancos, fondo suave, tipografía compacta y cifras monoespaciadas. Azul como acento; verde, ámbar y rojo para estados.
- Órbita y espectros pueden usar superficies oscuras para contraste y legibilidad.
- Consola de misión de alta densidad, jerarquía visual clara, un elemento dominante por pantalla. Evitar tarjetas idénticas para todo y decoración genérica.
- Barra lateral plegable, con navegación por iconos al cerrarse y estado conservado.
- En escritorio, las vistas operativas deben entrar en el alto disponible sin scroll de página; tablas y consolas pueden desplazarse internamente. Usar alturas flexibles, `min-height: 0` y límites de panel adecuados. En pantallas pequeñas, preservar accesibilidad sin recortar controles.
- No volver al dashboard inicial ni a versiones previas. El HTML adjunto es la referencia de espaciado, distribución y estilo vigente.
- En ADCS, mantener la vista 3D de actitud contenida para dar espacio suficiente a los paneles de la derecha.

## Navegación final

| Sección | Pestañas |
|---|---|
| Dashboard | General, EPS / Thermal, ADCS, Communications, Payload |
| Orbit | General, Passes, Calendar, Free View |
| Settings | SDR & Reception, Scheduling, SDR Diagnostics |
| Logs | Messages, Decoded Variables |

Las tres pestañas de Settings requieren autorización real de administrador. El acceso demo del HTML no es autenticación de producción. Reutiliza la sesión y validación del servidor existente; no traslades credenciales demo al código productivo.

### Dashboard

- General: diseño operativo de la versión final, con EPS y comunicaciones a la izquierda, actitud/ADCS al centro, payload y terminal a la derecha; soporte de paneles solares, térmico y altitud abajo. Ajustar al viewport.
- EPS / Thermal: batería, buses, SOC, heaters, recursos OBC, históricos y paneles solares.
- ADCS: sensores, actuadores, actitud 3D con HUD y altitud.
- Communications: RSSI, SNR, downlink, BER, RF, histórico, espectro, paquetes y decodificación.
- Payload: imagen con pan/zoom y acciones reales disponibles. Una acción primaria; restantes discretas. Conservar confirmaciones y permisos del proyecto para comandos.

Reutilizar las fuentes reales de telemetría del frontend existente. No inventar payloads ni asumir que todos los datos de una página llegan por el mismo canal.

### Orbit

Referencia de organización visual: Hypersphere. Se adoptó la idea de escena dominante con objetos, inspector y timeline; no se integró su motor ni se copiaron sus assets de interfaz.

**General:** vista cercana del horizonte, centrada en un satélite activo y siguiéndolo. Debe diferenciarse claramente del globo completo de Passes.

**Passes:** globo completo para varios satélites y estaciones, selección de objetos visibles, catálogo, inspector, capas, accesos y timeline por pareja satélite/estación. Seleccionar un pase mueve el reloj al máximo de elevación estimado. Modo Scene only para ocultar paneles.

**Calendar:** calendario mensual grande como elemento principal, con globo lateral y controles UTC para fecha/hora y avance intradía. Permite ver dónde estará el satélite y si supera la máscara de elevación de una estación. No duplicar el diseño de Passes. No confundir con Scheduling de Settings.

**Free View:** constructor de paneles exclusivamente orbitales, movibles y redimensionables. Elegir tipo, satélite, estación, variable o fórmula nueva, nombre, unidad, límites, intervalo, paso temporal y agregación. Guardar posición y tamaño. Tipos actuales: globo, métrica, gauge, estado, gráfica y tabla.

Catálogo previsto:

- Satélite TLE: identidad/nombre, color y dos líneas TLE validadas; contrastar el formulario real del HTML al migrarlo.
- Satélite kepleriano de demostración: época UTC, semieje mayor km, excentricidad, inclinación, RAAN, argumento de periapsis y anomalía media en grados.
- Estación: identidad/nombre, color, latitud/longitud, altura sobre el elipsoide WGS84 en metros y máscara de elevación.
- El catálogo de producción deberá contemplar además frecuencias/modulación por satélite según el modelo acordado; no asumir que el helper del prototipo ya cubre toda la configuración RF.

El usuario quiere catálogo persistido en servidor y layouts por usuario. Es trabajo pendiente del backend de producción; el HTML ofrece almacenamiento local y un servidor de demostración opcional. Diseña una capa de acceso reemplazable y no anuncies persistencia remota si solo existe localStorage.

#### Cálculo orbital implementado en el prototipo

- Satellite.js 7.1.0 para TLE/SGP4, ejecutado en navegador. TLE con 69 caracteres por línea, checksum y NORAD coincidente. Advertencia de antigüedad respecto al tiempo de escena.
- Alternativa kepleriana de dos cuerpos, sin J2 ni arrastre. Objetos iniciales son ejemplos.
- Accesos geométricos sobre máscara de elevación, ventana de 24 h, muestreo de 30 s y refinamiento de cruces aproximado a 1 s; máximo estimado en muestras. Puede perder pases muy breves.
- Visibilidad geométrica no garantiza enlace RF. No hay terreno, refracción, presupuesto de enlace, eclipses ni disponibilidad de antena.
- Textura NASA Blue Marble histórica, sin clima en vivo; iluminación ilustrativa.
- El prototipo sí calcula posiciones en el navegador. Esto no significa que el backend orbital de producción ya exista o esté validado operacionalmente.

Free View usa variables `altitude`, `latitude`, `longitude`, `elevation`, `azimuth`, `range`, `visible` y `elapsed`. Unidades respectivas: km, grados, grados, grados, grados, km, 0/1 y segundos. Parser acotado sin `eval`: operadores `+ - * / ^`; funciones `abs`, `sqrt`, `sin`, `cos`, `tan`, `log`, `exp`, `min`, `max`, constante `pi`. Trigonometría en radianes. Agregaciones: instantáneo, media, mínimo, máximo, delta e integral trapezoidal. Unidades manuales; no hay análisis dimensional ni referencias entre paneles. Límites actuales: 12 paneles, un globo y 1500 pasos por panel.

Al integrar, mantener un reloj de escena consistente, distinguir tiempo actual de simulación temporal, y considerar workers/caché para que el cálculo de muchos pares no bloquee la UI.

### Settings — SDR & Reception

Tres áreas: hardware detectado, perfil persistido y ajuste temporal en caliente.

**Hardware:** seleccionar equipos reales del resultado de escaneo, no un dropdown ciego de drivers. Según el brief: LimeSDR USB VID:PID `1D50:6108`, RTL-SDR `0BDA:2838`, pyusb/libusb y puertos serie pyserial para MCU. Conectar `/api/sdr/scan` usando el método HTTP, esquema y permisos que realmente tenga el router.

**Perfil persistido:**

```yaml
satellite:
  id: INTISAT-1
  name: INTISAT-1
reception:
  driver: limesdr
  method: uart8a
  modulation: GFSK
  frequency_mhz: 437.5
  gain_db: 40.0
  sync_word: D391D391
```

Valores de ejemplo, no configuración que deba sobrescribirse. Drivers: `limesdr | rtlsdr | mcu`. Métodos: `uart8a | ax25 | ccsds_spp`. Modulación de texto libre. Sync word de registro Si4463, distinto al formato on-air.

Guardar usa el servicio real que escribe `satellite_config.yaml`; aplicar cambios de ese perfil requiere reiniciar el receptor. Mostrar cambios sin guardar, guardado, error y reinicio pendiente según el resultado real. El botón de reinicio se enlaza a `/api/sdr/restart`, que según el brief relanza `headless_receiver.py` e `intisat_sdr.exe`.

**Ajuste temporal:** frecuencia, ganancia, symbol rate, desviación, RX bandwidth, power gate; opciones avanzadas de modulación, sync on-air y longitud de paquete. No persiste al reiniciar y debe distinguirse del perfil YAML. El backend C admite `SET_FREQ`, `SET_GAIN`, `SET_POWER_GATE` y `UPDATE_CONFIG`, pero hay que verificar el cliente Python y exponer/reutilizar un bridge FastAPI autenticado. El navegador no habla ZMQ directamente. No inventar el esquema de comandos a partir del diálogo ilustrativo del HTML.

Valores avanzados de referencia del brief: 9600 sym/s, 5000 Hz de desviación, 30000 Hz de RX bandwidth, sync on-air `5D E6 2A 7E`, packet length máximo 255 y power gate 0.0 deshabilitado. No etiquetar power gate con una unidad no comprobada.

El orquestador descrito solo sobreescribe `center_freq_hz`, `rf_gain_db`, `modulation_type` y selecciona driver. Guardar `sync_word` en YAML no prueba que llegue al runtime. Verificar ese recorrido y reportar diferencias. La inversión por byte de `D3 91 D3 91` produce `CB 89 CB 89`, no `5D E6 2A 7E`: conservar ambos conceptos y no corregir automáticamente valores sin confirmar el protocolo real.

### Settings — Scheduling

Agenda semanal UTC de comandos únicos y recurrentes, CRUD y toggle `enabled` que conserva la entrada al deshabilitarla. Reutilizar el modelo y servicio existentes; según el usuario el campo enabled ya existe y falta exponerlo.

La agenda del HTML solo guarda ejemplos en el navegador y exporta JSON; no ejecuta comandos. Validar nombres, argumentos y reglas temporales con el esquema real del proyecto. No activar automáticamente ejemplos al migrar ni crear un ejecutor de telemandos en el navegador.

### Settings — SDR Diagnostics

Espectro RF, waterfall, parámetros RF de solo lectura y paquetes decodificados con filtro, pausa, limpieza y auto-scroll. Reutilizar `SpectrumScope` y `/ws/spectrum` existentes, verificando formato, escalas, unidades, timestamps y reconexión. Detener suscripciones y timers al desmontar.

Por defecto el prototipo muestra desconexión. Su stream alternativo es explícitamente simulado; amplitud relativa, no dBm calibrados. En producción, mostrar desconocido/sin datos cuando corresponda, nunca ceros o valores demo como mediciones.

### Parámetros que deben permanecer de solo lectura

No exponer controles operativos para constantes compiladas del DSP: FFT, AGC, clock recovery Mueller–Muller, detector de burst/preámbulo, FIR, DC blocker, ring buffer o whitening PN9.

Referencia de arquitectura suministrada:

- `5555`: PUB del backend C, FFT/PKT/STS/ERR.
- `5556`: REP de comandos SDR.
- `5560`: puente distinto de telemetría.
- `/ws/spectrum`: stream web mediante SUB independiente.
- Puerto web indicado: 8000. ClickHouse configurado mediante entorno.

Mostrar estos datos únicamente como diagnóstico verificado. No cambiar puertos ni exponer secretos de entorno desde la UI.

### Logs

Auditoría global, independiente de la subvista operativa: eventos TLM/MSG/LOG, paquetes y variables decodificadas, filtros, espectro e imagen recibida según los componentes existentes. Mantener las pestañas y la distribución de la referencia final sin perder fuentes reales del frontend actual.

## Matriz de integración

| Pieza | Estado informado de producción | Trabajo de integración |
|---|---|---|
| Dashboard y telemetría | Existentes | Aplicar diseño y conservar conexiones |
| SpectrumScope y /ws/spectrum | Existentes con hardware | Reutilizar y adaptar presentación |
| Escaneo/reinicio SDR | Existentes | Enlazar controles con contratos reales |
| Perfil YAML | Existe | Mapear todos los campos y reinicio pendiente |
| Ajustes SDR en caliente | Comandos C existen, UI/bridge por verificar | Formulario y puente autenticado si falta |
| Programación | Modelo/servicio descritos como existentes | Adaptar calendario y enabled |
| Logs | Existentes | Rediseño sin perder tráfico ni filtros |
| Catálogo multiobjeto | No existe en backend según brief | Implementación separada pendiente |
| Predicción orbital del servidor | No existe según brief | Proponer estrategia; no fingir integración |
| Layouts orbitales por usuario | No existen según brief | Persistencia autenticada pendiente |

## Orden sugerido de implementación

1. Inspeccionar repositorio, AGENTS.md, rutas, estado global, autenticación, API clients, websockets, estilos y tests. Ejecutar comprobaciones de base apropiadas.
2. Presentar un mapa breve de páginas/componentes y contratos encontrados. Identificar discrepancias con este brief.
3. Trasladar tokens, shell, sidebar plegable y navegación; usar el stack y librerías existentes cuando sea razonable.
4. Integrar Dashboard y Logs con datos reales, estados de carga/error/desconexión y limpieza de suscripciones.
5. Adaptar las tres pestañas de Settings, respetando persistencia frente a runtime y autorización del servidor.
6. Migrar vistas orbitales y cálculos aislados de React. Delimitar el backend pendiente y mantener demos claramente identificadas hasta disponer de datos/configuración reales.
7. Verificar visualmente y funcionalmente; entregar resumen de archivos modificados, pruebas y pendientes concretos.

## Criterios de aceptación

- Coincidencia visual con el HTML final y textos del producto en inglés.
- Sidebar abre/cierra; selección y navegación coherentes.
- Desktop operativo sin scroll de página ni elementos superpuestos. Revisar 1366×768, 1536×864 y 1920×1080 como objetivos de integración.
- General orbital cercano y Passes como globo; Calendar con calendario dominante; Free View permite mover, redimensionar y configurar fórmulas e intervalos.
- Datos reales preservados, unidades correctas, timestamps visibles donde sean necesarios, UTC consistente en agenda y órbita.
- Sin valores simulados presentados como reales y sin credenciales demo como protección.
- Guardado del perfil y ajustes temporales separados; errores/ACK reales reflejados en UI. Un fallo no debe mostrarse como aplicación exitosa.
- Toggle enabled persiste mediante el backend real sin eliminar el comando.
- Desmontaje/reconexión sin timers ni sockets duplicados. Rendimiento razonable en órbita y streams.
- Build, lint/typecheck y tests relevantes del proyecto según sus scripts. Pruebas visuales en navegador; verificar con hardware únicamente cuando esté disponible y autorizado para la operación concreta.

El prototipo ya fue revisado en Chromium para navegación, órbita, formularios, persistencia local y ausencia de errores JavaScript, con anchos de 1366, 1536 y 1920 px. No hubo pruebas sobre el repositorio de producción ni hardware. Esa revisión no sustituye las pruebas de integración.

## Referencias y licencias

- Hypersphere: https://hypersphere.systems/guide.html — referencia visual, no dependencia.
- NASA Blue Marble: https://svs.gsfc.nasa.gov/2915/ — NASA/Goddard Space Flight Center Scientific Visualization Studio; datos de Reto Stockli y NASA Earth Observatory.
- Satellite.js: https://github.com/shashwatak/satellite-js — MIT.
- TopoJSON client: https://github.com/topojson/topojson-client — ISC.
- World Atlas: https://github.com/topojson/world-atlas — ISC; Natural Earth de dominio público.

Al extraer dependencias y assets del HTML, conservar atribuciones y avisos de licencia. No tratar los blobs embebidos como código de aplicación a mantener manualmente.
