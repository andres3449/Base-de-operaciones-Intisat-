# -*- coding: utf-8 -*-
"""
INTISAT — Receptor headless (sin GUI, sin render).

Corre la recepción UART/MCU en segundo plano — telemetría, imágenes de
payload y transmisión de comandos programados — y publica la telemetría
decodificada hacia el puente web (Core/telemetry_publisher.py -> backend
FastAPI -> ClickHouse). Pensado para correr en un servidor sin pantalla:
usa QCoreApplication (no QApplication), así que no toca QtWidgets, no
carga pyqtgraph/matplotlib/PyVista, y no necesita entorno gráfico ni
QT_QPA_PLATFORM especial.

Uso:
    python headless_receiver.py --port /dev/ttyUSB0 --baud 115200
    python headless_receiver.py                       # usa headless_receiver.yaml

Qué SÍ hace:
  - Recibe el protocolo UART 0x8A del MCU (main_receiver.c).
  - Telemetría en sub-paquetes (0x40-0x46) vía TelemetryAssembler, publicada
    por el puente ZMQ (Core/telemetry_publisher.py).
  - Imágenes de payload (0x10/0x11 y ráfaga 0x71/0x73/0x74) vía
    ImageAssembler/BurstImageAssembler, guardadas como .jpg en `images_dir`.
  - Comandos hacia el MCU con la misma sintaxis que la consola de la app
    PyQt5 (Core/mcu_commands.py::McuCommandDispatcher — un solo lugar,
    sin duplicar la lógica de parseo/framing).
  - Un scheduler (`schedule:` en headless_receiver.yaml) que dispara esos
    comandos solo o en ventanas recurrentes, sin reiniciar el proceso: el
    YAML se relee cada pocos segundos y es la única fuente de verdad
    (el backend web lo reescribe cuando alguien programa algo desde la
    página de configuración).
  - Reintenta la conexión serie sola si el puerto no está disponible o se cae.

Recepción/transmisión SDR (LimeSDR/RTL-SDR): controlada por `reception.driver`
en satellite_config.yaml (mcu|limesdr|rtlsdr), leído una sola vez al arrancar
(cambiar de driver requiere reiniciar el proceso). Con `mcu` se usa UART como
siempre; con `limesdr`/`rtlsdr` se lanza el backend C (intisat_sdr) vía
Core/SDR/sdr_backend_client.py y los paquetes decodificados (AX.25, vía
Core/SDR/ax25_decode.py) se enrutan al mismo on_packet() que usa UART. TX solo
es real con LimeSDR (RTL-SDR es hardware RX-only); con `mcu` el scheduler
transmite por UART como siempre.

Qué NO hace todavía (fuera de alcance de esta entrega):
  - Telemetría OBC real completa (pkt_type 0xA0/0xA1): su decodificador
    también vive en GUI/pages/comms.py (CommsPage._decode_obc_full_tlm).
  - El scheduler no prende/apaga el puerto serie/SDR en sí (la recepción
    sigue siempre activa) — solo dispara comandos de transmisión.
"""

import argparse
import os
import signal
import sys
import time
from datetime import datetime, timezone

import yaml
from PyQt5.QtCore import QCoreApplication, QTimer

from Core.uart_receiver import UartReceiver
from Core.SDR.telemetry_assembler import TelemetryAssembler
from Core.SDR.image_assembler import ImageAssembler
from Core.SDR.burst_image_assembler import BurstImageAssembler
from Core.SDR.sdr_backend_client import SDRBackendClient, SDRConfig
from Core.SDR.limesdr_tx import LimeSDRTransmitter
from Core.SDR.ax25_decode import decode_ax25_packet, try_bitslip_correction, LOOPBACK_CALLSIGNS
from Core.telemetry_publisher import TelemetryPublisher
from Core.mcu_commands import McuCommandDispatcher

DEFAULT_CONFIG = {
    "port": "/dev/ttyUSB0",
    "baudrate": 115200,
    "reconnect_interval_s": 5,
    "images_dir": "./images",
    "schedule": {"recurring": [], "once": []},
}

DEFAULT_SATELLITE_CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "satellite_config.yaml"
)

# Nombres legibles para la tabla de mensajes -- ver Core/SDR/telemetry_assembler.py
# y Core/SDR/image_assembler.py / burst_image_assembler.py para el significado de cada uno.
PKT_TYPE_NAMES = {
    0x40: "TELEM_OBC", 0x41: "TELEM_EPS_PWR", 0x42: "TELEM_EPS_SOL",
    0x43: "TELEM_ADCS_SENS", 0x44: "TELEM_ADCS_CTRL", 0x45: "TELEM_THERMAL",
    0x46: "TELEM_COMMS",
    0x10: "IMG_SIZE", 0x11: "IMG_DATA",
    0x71: "BURST_START", 0x73: "BURST_DATA", 0x74: "BURST_END",
    0xA0: "OBC_FULL_TLM", 0xA1: "OBC_BEACON",
}


def load_config(path: str) -> dict:
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        cfg.update(data)
    except FileNotFoundError:
        pass
    return cfg


def load_satellite_id(path: str = DEFAULT_SATELLITE_CONFIG_PATH) -> str:
    """Lee solo el ID del satelite de satellite_config.yaml. Se lee una vez
    al arrancar -- cambiarlo requiere reiniciar el proceso (igual que el
    driver/metodo de recepcion, ver plan de la Etapa 2)."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        return data.get("satellite", {}).get("id", "")
    except FileNotFoundError:
        return ""


def load_reception_config(path: str = DEFAULT_SATELLITE_CONFIG_PATH) -> dict:
    """Lee la sección `reception:` de satellite_config.yaml. Se lee una sola
    vez al arrancar -- cambiar el driver requiere reiniciar el proceso."""
    defaults = {
        "driver": "mcu", "method": "uart8a", "modulation": "2FSK",
        "frequency_mhz": 437.5, "gain_db": 40.0,
    }
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        defaults.update(data.get("reception") or {})
    except FileNotFoundError:
        pass
    return defaults


class ScheduleRunner:
    """Relee la sección `schedule:` de un YAML compartido con el backend web
    y dispara comandos (via McuCommandDispatcher) en ventanas recurrentes o
    una sola vez. El YAML es la única fuente de verdad: el estado de qué ya
    se disparó se persiste ahí mismo, así sobrevive un reinicio del proceso.
    """

    def __init__(self, config_path: str, dispatcher: McuCommandDispatcher, log=print):
        self._config_path = config_path
        self._dispatcher = dispatcher
        self._log = log
        self._mtime = None
        self._schedule = {"recurring": [], "once": []}

    def tick(self):
        self._reload_if_changed()
        now = datetime.now(timezone.utc)
        changed = False

        for entry in self._schedule.get("recurring", []):
            if self._due_recurring(entry, now):
                self._fire(entry)
                entry["last_fired_at"] = now.isoformat()
                changed = True

        for entry in self._schedule.get("once", []):
            if self._due_once(entry, now):
                self._fire(entry)
                entry["fired"] = True
                changed = True

        if changed:
            self._persist()

    # ── Internal ─────────────────────────────────────────────────────────

    @staticmethod
    def _parse_dt(value: str):
        dt = datetime.fromisoformat(value)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)

    def _due_recurring(self, entry: dict, now: datetime) -> bool:
        if not entry.get("enabled", True):
            return False
        try:
            start = self._parse_dt(entry["window_start"])
            end = self._parse_dt(entry["window_end"])
        except (KeyError, ValueError):
            return False
        if not (start <= now <= end):
            return False
        interval_s = entry.get("interval_s", 60)
        last = entry.get("last_fired_at")
        if not last:
            return True
        try:
            return (now - self._parse_dt(last)).total_seconds() >= interval_s
        except ValueError:
            return True

    def _due_once(self, entry: dict, now: datetime) -> bool:
        if not entry.get("enabled", True) or entry.get("fired"):
            return False
        try:
            fire_at = self._parse_dt(entry["fire_at"])
        except (KeyError, ValueError):
            return False
        return now >= fire_at

    def _fire(self, entry: dict):
        cmd = entry.get("command", "")
        self._log(f"[schedule] Disparando: {cmd}  (id={entry.get('id', '?')})")
        self._dispatcher.dispatch_text(cmd)

    def _reload_if_changed(self):
        try:
            mtime = os.path.getmtime(self._config_path)
        except OSError:
            return
        if mtime == self._mtime:
            return
        self._mtime = mtime
        cfg = load_config(self._config_path)
        self._schedule = cfg.get("schedule") or {"recurring": [], "once": []}

    def _persist(self):
        try:
            with open(self._config_path, "r", encoding="utf-8") as f:
                full_cfg = yaml.safe_load(f) or {}
        except FileNotFoundError:
            full_cfg = {}
        full_cfg["schedule"] = self._schedule
        with open(self._config_path, "w", encoding="utf-8") as f:
            yaml.safe_dump(full_cfg, f, allow_unicode=True, sort_keys=False)
        # Evita que el proximo tick relea el archivo que acabamos de escribir.
        self._mtime = os.path.getmtime(self._config_path)


def _save_image(images_dir: str, data: bytes, log=print):
    os.makedirs(images_dir, exist_ok=True)
    ts = time.strftime("%Y%m%d_%H%M%S")
    path = os.path.join(images_dir, f"payload_{ts}.jpg")
    with open(path, "wb") as f:
        f.write(data)
    log(f"[headless] Imagen guardada: {path} ({len(data)} bytes)")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default="headless_receiver.yaml", help="Ruta al YAML de config")
    parser.add_argument("--port", default=None, help="Puerto serie (ej. /dev/ttyUSB0, COM5)")
    parser.add_argument("--baud", type=int, default=None, help="Baudrate (default 115200)")
    args = parser.parse_args()

    cfg = load_config(args.config)
    port = args.port or cfg["port"]
    baud = args.baud or cfg["baudrate"]
    reconnect_s = cfg["reconnect_interval_s"]
    images_dir = cfg["images_dir"]
    satellite_id = load_satellite_id()
    reception_cfg = load_reception_config()
    driver = str(reception_cfg.get("driver", "mcu")).lower()
    use_sdr = driver in ("limesdr", "rtlsdr")

    print(f"[headless] Puertos disponibles: {UartReceiver.available_ports() or '(ninguno detectado)'}")
    print(f"[headless] Satelite: {satellite_id or '(sin configurar)'}  driver={driver}")

    app = QCoreApplication(sys.argv)

    telem_assembler = TelemetryAssembler()
    image_assembler = ImageAssembler()
    burst_assembler = BurstImageAssembler()

    try:
        publisher = TelemetryPublisher(satellite_id=satellite_id)
    except Exception as e:
        print(f"[headless] ERROR: no se pudo abrir el puente ZMQ: {e}")
        sys.exit(1)

    def _log(msg: str):
        print(msg)
        publisher.publish_log(msg)

    uart = UartReceiver()
    sdr_controller = None
    limesdr_tx = None

    if use_sdr:
        sdr_config = SDRConfig(
            center_freq_hz=float(reception_cfg.get("frequency_mhz", 437.5)) * 1e6,
            rf_gain_db=float(reception_cfg.get("gain_db", 40.0)),
            modulation_type=str(reception_cfg.get("modulation", "2FSK")),
            # sync_word/symbol_rate/freq_deviation/packet_length: se dejan en
            # los defaults de SDRConfig (mismos valores que Core/SDR/limesdr_tx.py
            # usa para TX) -- reception.sync_word en el YAML es el valor de
            # registro Si4463, no el mismo formato on-air que espera SDRConfig.
        )
        sdr_controller = SDRBackendClient(sdr_config)
        try:
            sdr_controller.start(device_type=driver)
        except Exception as e:
            print(f"[headless] ERROR: no se pudo iniciar el backend SDR ({driver}): {e}")
            sys.exit(1)
        _log(f"[headless] Backend SDR iniciado: {driver} @ {sdr_config.center_freq_hz/1e6:.4f} MHz")

        limesdr_tx = LimeSDRTransmitter()
        if limesdr_tx.open(sdr_controller):
            _log("[headless] LimeSDR TX listo")
        else:
            limesdr_tx = None
            _log("[headless] AVISO: TX no disponible (RTL-SDR es solo RX, o el backend no arrancó)")

    def _tx_unavailable(*_a, **_kw):
        _log("[headless] AVISO: comando ignorado -- no hay transporte TX disponible (driver="
             f"{driver})")

    def _limesdr_send_byte(cmd_byte):
        if not limesdr_tx.send_command(cmd_byte):
            _log(f"[headless] AVISO: fallo el burst TX para comando 0x{cmd_byte:02X}")

    def _limesdr_send_payload(cmd_byte, payload):
        if not limesdr_tx.send_command(cmd_byte, payload):
            _log(f"[headless] AVISO: fallo el burst TX para comando 0x{cmd_byte:02X} ({len(payload)}B payload)")

    if driver == "mcu":
        tx_send_byte = uart.send_command
        tx_send_payload = uart.send_command_with_payload
    elif limesdr_tx is not None:
        tx_send_byte = _limesdr_send_byte
        tx_send_payload = _limesdr_send_payload
    else:
        tx_send_byte = _tx_unavailable
        tx_send_payload = _tx_unavailable

    dispatcher = McuCommandDispatcher(
        send_byte=tx_send_byte,
        send_payload=tx_send_payload,
        log=_log,
    )

    def on_packet(pkt_type: int, data: bytes, source: str = "mcu"):
        name = PKT_TYPE_NAMES.get(pkt_type, f"0x{pkt_type:02X}")
        decoded = True
        error = ""
        if 0x40 <= pkt_type <= 0x46:
            telem_assembler.process_packet(pkt_type, data)
        elif pkt_type in (0x10, 0x11):
            image_assembler.process_packet(pkt_type, data)
        elif pkt_type in (0x71, 0x73, 0x74):
            burst_assembler.process_packet(pkt_type, data)
        else:
            # 0xA0/0xA1 (OBC real) y cualquier otro: no manejado todavia
            # -- ver docstring del modulo. Se loguea igual, sin decodificar.
            decoded = False
            error = "pkt_type sin manejar"
        publisher.publish_message(
            pkt_type=pkt_type, pkt_type_name=name, source=source,
            decoded=decoded, error=error, size_bytes=len(data),
        )

    def on_burst_command_requested(pkt_type: int, payload: bytes):
        # Mismo criterio que main_window.py::_on_burst_command_requested:
        # el MCU/satelite espera el ACK/NACK/COMPLETE de vuelta.
        if payload:
            tx_send_payload(pkt_type, payload)
        else:
            tx_send_byte(pkt_type)

    if not use_sdr:
        uart.packet_received.connect(on_packet)
        uart.connected.connect(lambda p: _log(f"[headless] Conectado a {p} @ {baud} baud"))
        uart.disconnected.connect(lambda: _log("[headless] Puerto desconectado"))
        uart.status_message.connect(lambda msg: _log(f"[MCU] {msg}"))
        uart.log_message.connect(_log)

    telem_assembler.telemetry_ready.connect(lambda v: publisher.publish_sim(v))

    image_assembler.image_ready.connect(lambda data: _save_image(images_dir, data, _log))
    image_assembler.image_error.connect(lambda msg: _log(f"[headless] Error de imagen: {msg}"))
    # ack_requested: el MCU maneja ACK/NACK internamente por UART, sin acción del PC
    # (mismo comportamiento que main_window.py::_send_rf_ack en modo MCU).

    burst_assembler.image_ready.connect(lambda data: _save_image(images_dir, data, _log))
    burst_assembler.image_error.connect(lambda msg: _log(f"[headless] Error de imagen (burst): {msg}"))
    burst_assembler.log_message.connect(_log)
    burst_assembler.command_requested.connect(on_burst_command_requested)

    if not use_sdr:
        # Reconexión automática: revisa cada N segundos y reintenta si hace falta.
        reconnect_timer = QTimer()
        reconnect_timer.setInterval(reconnect_s * 1000)
        reconnect_timer.timeout.connect(lambda: None if uart.is_connected() else uart.connect(port, baud))
        reconnect_timer.start()
        uart.connect(port, baud)  # primer intento inmediato
    else:
        # Polling no-bloqueante de paquetes/errores del backend SDR (mismo
        # patrón que GUI/pages/comms.py::_poll_sdr_frame, sin la parte de
        # consola/FFT/waterfall -- solo lo necesario para alimentar on_packet).
        def on_sdr_poll():
            for pkt in sdr_controller.poll_packets():
                decoded = decode_ax25_packet(pkt.raw_bytes)
                if decoded and decoded['src_call'] in LOOPBACK_CALLSIGNS:
                    continue  # nuestro propio TX burst, no es recepción real
                if decoded and decoded['crc_valid']:
                    on_packet(decoded['pkt_type'], decoded['data'], source="sdr")
                    continue
                if decoded:
                    corrected, _shift = try_bitslip_correction(pkt.raw_bytes)
                    if corrected:
                        on_packet(corrected['pkt_type'], corrected['data'], source="sdr")
                        continue
                publisher.publish_message(
                    pkt_type=0,
                    pkt_type_name="CRC_FAIL" if decoded else "FALSE_SYNC",
                    source="sdr", decoded=False,
                    error="crc_invalid" if decoded else "no_ax25_flag",
                    size_bytes=len(pkt.raw_bytes),
                )
            err = sdr_controller.poll_error()
            if err:
                _log(f"[SDR] {err}")

        sdr_poll_timer = QTimer()
        sdr_poll_timer.setInterval(50)
        sdr_poll_timer.timeout.connect(on_sdr_poll)
        sdr_poll_timer.start()

    # Scheduler: relee headless_receiver.yaml cada 2s y dispara comandos
    # programados desde la pagina de configuracion de la web.
    schedule_runner = ScheduleRunner(args.config, dispatcher, log=_log)
    schedule_timer = QTimer()
    schedule_timer.setInterval(2000)
    schedule_timer.timeout.connect(schedule_runner.tick)
    schedule_timer.start()

    # QCoreApplication.exec_() no deja pasar señales de Python (SIGINT/SIGTERM)
    # hasta que el loop de Qt procese algo — este timer nulo se lo garantiza.
    _signal_pump = QTimer()
    _signal_pump.timeout.connect(lambda: None)
    _signal_pump.start(200)

    def shutdown(*_):
        print("\n[headless] Cerrando...")
        if use_sdr:
            if limesdr_tx is not None:
                limesdr_tx.close()
            if sdr_controller is not None:
                sdr_controller.stop()
        else:
            uart.disconnect()
        publisher.close()
        app.quit()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
