# -*- coding: utf-8 -*-
"""
INTISAT Ground Station — SDR Backend Client (ZMQ)

Drop-in replacement for SDRController from sdr_processor.py.
Este modulo NO hace ningun DSP. Solo se comunica con el ejecutable
intisat_sdr.exe (C) que corre en background y hace todo el trabajo pesado.

Interfaz identica a SDRController:
  - start(device_type)
  - stop()
  - poll_fft()      -> (freq_axis, power_db) or None
  - poll_packets()  -> list[DecodedPacket]
  - poll_error()    -> str or None
  - set_frequency(freq_hz)
  - set_gain(gain_db)
  - update_config(config)
  - is_running (property)

La GUI (comms.py) solo necesita cambiar la linea de import.
"""

import json
import os
import struct
import subprocess
import sys
import time
from collections import deque, namedtuple
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from Core.SDR.dsp_logger import DspLogger

import numpy as np

try:
    import zmq
except ImportError:
    raise ImportError(
        "pyzmq es requerido para el backend C.\n"
        "Instala con: pip install pyzmq"
    )


# ─── Data structures (identicas a sdr_processor.py) ─────────────────────────

SYNC_FOUND_STREAM = 2  # sync_found value for TELEM_DUMP stream packets

DecodedPacket = namedtuple("DecodedPacket", [
    "raw_bytes",         # bytes
    "rssi_estimate_db",  # float
    "timestamp",         # float (time.time())
    "sync_found",        # int: 1=packet, 2=stream (SYNC_FOUND_STREAM)
    "bit_errors",        # int
    "power_ema",         # float - IQ power EMA pre-AGC (for power gate calibration)
    "freq_error_hz",     # float - frequency error estimate from C backend
])

TelemStream = namedtuple("TelemStream", [
    "raw_bytes",         # bytes — full 59984-byte TELEM_DUMP payload (PN9 dewhitened)
    "rssi_estimate_db",  # float
    "timestamp",         # float (time.time())
])


@dataclass
class SDRConfig:
    """Configuracion del SDR — identica a la de sdr_processor.py."""
    center_freq_hz: float = 433_500_000.0
    sample_rate_hz: float = 250_000.0
    rf_gain_db: float = 50.0
    fft_size: int = 2048
    symbol_rate_sps: int = 9600
    freq_deviation_hz: int = 5000
    rx_bandwidth_hz: int = 30_000
    sync_word: bytes = b"\x5D\xE6\x2A\x7E"  # on-air format (Si4463 API BA67547E bit-reversed)
    modulation_type: str = "2FSK"
    waterfall_rows: int = 200
    packet_length: int = 255  # max; C backend adapta al byte de longitud de cada paquete
    sync_power_gate: float = 0.0  # 0 = disabled


# ─── ZMQ Message Parsing ────────────────────────────────────────────────────

# FFT message header (matches fft_msg_header_t in config.h):
#   uint32 fft_size, float center_freq, float sample_rate, uint64 timestamp
_FFT_HDR_FMT = "<IffQ"
_FFT_HDR_SIZE = struct.calcsize(_FFT_HDR_FMT)  # 20 bytes

# Packet message header (matches pkt_msg_header_t in config.h):
#   float rssi, float freq_err, uint64 timestamp, uint16 payload_len,
#   uint8 sync_found, uint8 bit_errors, float power_ema
_PKT_HDR_FMT = "<ffQHBBf"
_PKT_HDR_SIZE = struct.calcsize(_PKT_HDR_FMT)  # 24 bytes


def _parse_fft_msg(payload: bytes) -> Optional[tuple]:
    """Parsea un mensaje FFT binario del backend C."""
    if len(payload) < _FFT_HDR_SIZE:
        return None

    fft_size, center_freq, sample_rate, timestamp_us = struct.unpack_from(
        _FFT_HDR_FMT, payload, 0
    )

    expected_size = _FFT_HDR_SIZE + fft_size * 4
    if len(payload) < expected_size:
        return None

    # The C backend already sends power_db with DC in the center (fftshifted).
    # Do NOT apply fftshift again here — that would double-shift and wrap
    # the signal to the edges.
    power_db = np.frombuffer(
        payload, dtype=np.float32, offset=_FFT_HDR_SIZE, count=fft_size
    ).copy()

    # Generar freq_axis desde los parametros del header.
    # Both arrays are DC-centered: the C backend fftshifts the power data,
    # and we fftshift the freq_axis here to match.
    freq_axis = np.fft.fftshift(
        np.fft.fftfreq(fft_size, d=1.0 / sample_rate)
    ).astype(np.float32)

    return freq_axis, power_db


def _parse_pkt_msg(payload: bytes) -> Optional[DecodedPacket]:
    """Parsea un mensaje de paquete binario del backend C."""
    if len(payload) < _PKT_HDR_SIZE:
        return None

    rssi_db, freq_err, timestamp_us, payload_len, sync_found, bit_errors, power_ema = \
        struct.unpack_from(_PKT_HDR_FMT, payload, 0)

    if len(payload) < _PKT_HDR_SIZE + payload_len:
        return None

    raw_bytes = bytes(payload[_PKT_HDR_SIZE:_PKT_HDR_SIZE + payload_len])

    # Convertir timestamp microsegundos a epoch float (como time.time())
    timestamp = timestamp_us / 1_000_000.0
    # Si el backend usa monotonic clock, usamos time.time() actual
    if timestamp < 1_000_000_000:  # antes del año 2001 = monotonic
        timestamp = time.time()

    return DecodedPacket(
        raw_bytes=raw_bytes,
        rssi_estimate_db=round(rssi_db, 1),
        timestamp=timestamp,
        sync_found=int(sync_found),
        bit_errors=int(bit_errors),
        power_ema=float(power_ema),
        freq_error_hz=float(freq_err),
    )


# ─── SDR Backend Client ─────────────────────────────────────────────────────

class SDRBackendClient:
    """
    Cliente ZMQ que se comunica con el proceso C intisat_sdr.

    Drop-in replacement para SDRController. La GUI no nota la diferencia.
    Python no toca un solo sample IQ — solo recibe datos ya procesados.
    """

    ZMQ_PUB_ENDPOINT = "tcp://127.0.0.1:5555"
    ZMQ_REP_ENDPOINT = "tcp://127.0.0.1:5556"

    def __init__(self, config: Optional[SDRConfig] = None):
        self._config = config or SDRConfig()
        self._process: Optional[subprocess.Popen] = None
        self._ctx: Optional[zmq.Context] = None
        self._sub: Optional[zmq.Socket] = None
        self._req: Optional[zmq.Socket] = None
        self._running = False

        # Buffers internos
        # IMPORTANTE: _fft_buf SIN maxlen — con maxlen=4 se pierden FFTs cuando
        # el RTL-SDR real entrega datos en rafagas USB (varios FFTs en ~5ms).
        # poll_ffts_nodrain() hace clear() despues de leer, asi que no crece indefinidamente.
        self._fft_buf: deque = deque()
        self._pkt_buf: deque = deque()  # SIN maxlen para evitar perder paquetes en rafagas largas
        self._stream_buf: deque = deque(maxlen=4)   # TELEM_DUMP stream frames
        self._err_buf: deque = deque(maxlen=8)

        # Cache del freq_axis (se envia siempre con cada FFT frame)
        self._cached_freq_axis: Optional[np.ndarray] = None

        # DSP diagnostic log — captures C backend stdout + per-packet RF metrics
        _log_dir = str(Path(__file__).resolve().parents[2] / "logs")
        self._dsp_log = DspLogger(_log_dir)

    def start(self, device_type: str = "simulated") -> None:
        """Lanza el backend C y conecta los sockets ZMQ."""
        if self._running:
            self.stop()

        # ── Buscar el ejecutable ──────────────────────────────────────
        exe_name = "intisat_sdr.exe" if sys.platform == "win32" else "intisat_sdr"

        # Buscar en varias ubicaciones posibles
        project_root = Path(__file__).resolve().parents[2]
        search_paths = [
            project_root / "intisat_sdr" / "build" / exe_name,
            project_root / "intisat_sdr" / "build" / "Release" / exe_name,
            project_root / "intisat_sdr" / "build" / "Debug" / exe_name,
            project_root / "build" / exe_name,
            Path("C:/intisat_build/Release") / exe_name,
            Path("C:/intisat_build") / exe_name,
        ]

        exe_path = None
        for p in search_paths:
            if p.exists():
                exe_path = p
                break

        if exe_path is None:
            raise RuntimeError(
                f"Backend C no encontrado. Buscado en:\n"
                + "\n".join(f"  - {p}" for p in search_paths)
                + "\nCompila con: cd intisat_sdr && mkdir build && cd build && cmake .. && cmake --build . --config Release"
            )

        # Log: mostrar que exe se esta usando y cuando fue compilado
        import datetime
        exe_mtime = datetime.datetime.fromtimestamp(exe_path.stat().st_mtime)
        print(f"[SDRController] Usando backend: {exe_path}")
        print(f"[SDRController] Compilado: {exe_mtime:%Y-%m-%d %H:%M:%S}")
        if "Debug" in str(exe_path):
            print("[SDRController] ADVERTENCIA: Usando build Debug - el rendimiento sera bajo!")
            print("[SDRController]   Recompila con: cmake --build . --config Release")

        # ── Mapear device_type al argumento de linea de comandos ──────
        device_flag_map = {
            "simulated": "--simulated",
            "rtlsdr":    "--rtlsdr",
            "limesdr":   "--limesdr",
        }
        args = [str(exe_path)]
        args.append(device_flag_map.get(device_type, "--simulated"))

        # ── Lanzar el proceso C ───────────────────────────────────────
        creation_flags = 0
        if sys.platform == "win32":
            creation_flags = subprocess.CREATE_NO_WINDOW

        self._process = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            creationflags=creation_flags,
            text=True,
            bufsize=1
        )
        
        # Iniciar thread para capturar stdout del proceso C
        def _read_stdout():
            try:
                for line in iter(self._process.stdout.readline, ''):
                    line = line.strip()
                    if line:
                        print(f"[C-Back] {line}")
                        self._dsp_log.log_c(line)
            except Exception:
                pass
        
        import threading
        t = threading.Thread(target=_read_stdout, daemon=True)
        t.start()

        # Dar tiempo al proceso para bindear los sockets ZMQ
        time.sleep(0.5)

        # Verificar que el proceso no murio inmediatamente
        if self._process.poll() is not None:
            raise RuntimeError(
                f"El backend C murio inmediatamente (exit code: {self._process.returncode})"
            )

        # ── Conectar sockets ZMQ ──────────────────────────────────────
        self._ctx = zmq.Context()

        # SUB: recibir FFT, PKT, STATUS, ERROR
        self._sub = self._ctx.socket(zmq.SUB)
        self._sub.connect(self.ZMQ_PUB_ENDPOINT)
        self._sub.setsockopt(zmq.SUBSCRIBE, b"FFT")
        self._sub.setsockopt(zmq.SUBSCRIBE, b"PKT")
        self._sub.setsockopt(zmq.SUBSCRIBE, b"STS")
        self._sub.setsockopt(zmq.SUBSCRIBE, b"ERR")
        self._sub.setsockopt(zmq.RCVTIMEO, 100)
        self._sub.setsockopt(zmq.RCVHWM, 10000)

        # REQ: enviar comandos
        self._req = self._ctx.socket(zmq.REQ)
        self._req.connect(self.ZMQ_REP_ENDPOINT)
        self._req.setsockopt(zmq.RCVTIMEO, 15000)  # 15s: la calibracion en frio del LimeSDR puede tardar varios segundos

        # ── Enviar comando START con la config ────────────────────────
        cfg = self._config
        print(f"[SDRController] Config enviada al backend C:")
        print(f"[SDRController]   freq     = {cfg.center_freq_hz/1e6:.4f} MHz")
        print(f"[SDRController]   gain     = {cfg.rf_gain_db} dB  ← ESTE VALOR DEBE APARECER en [C-Back]")
        print(f"[SDRController]   SR       = {cfg.symbol_rate_sps} bps")
        print(f"[SDRController]   fdev     = {cfg.freq_deviation_hz} Hz")
        print(f"[SDRController]   pkt_len  = {cfg.packet_length} bytes")
        print(f"[SDRController]   sync     = {cfg.sync_word.hex().upper()}")
        print(f"[SDRController]   mod      = {cfg.modulation_type}")
        start_cmd = {
            "cmd": "START",
            "device": device_type,
            "config": {
                "center_freq_hz": cfg.center_freq_hz,
                "sample_rate_hz": cfg.sample_rate_hz,
                "rf_gain_db": cfg.rf_gain_db,
                "fft_size": cfg.fft_size,
                "symbol_rate_sps": cfg.symbol_rate_sps,
                "freq_deviation_hz": cfg.freq_deviation_hz,
                "rx_bandwidth_hz": cfg.rx_bandwidth_hz,
                "sync_word": list(cfg.sync_word),
                "packet_length": cfg.packet_length,
                "modulation_type": cfg.modulation_type,
                "sync_power_gate": cfg.sync_power_gate,
            },
        }

        try:
            self._req.send_string(json.dumps(start_cmd))
            reply = json.loads(self._req.recv_string())
            if reply.get("status") != "ok":
                raise RuntimeError(f"Backend respondio error: {reply}")
        except zmq.ZMQError as e:
            raise RuntimeError(f"No se pudo comunicar con el backend: {e}")

        self._running = True
        self._cached_freq_axis = None

    def stop(self) -> None:
        """Detiene el backend C y cierra ZMQ."""
        # Enviar STOP y luego QUIT
        if self._req and self._running:
            for cmd in [{"cmd": "STOP"}, {"cmd": "QUIT"}]:
                try:
                    self._req.send_string(json.dumps(cmd))
                    self._req.recv_string()
                except zmq.ZMQError:
                    pass

        self._running = False

        # Cerrar sockets
        if self._sub:
            self._sub.close()
            self._sub = None
        if self._req:
            self._req.close()
            self._req = None
        if self._ctx:
            self._ctx.term()
            self._ctx = None

        # Terminar proceso
        if self._process:
            try:
                self._process.terminate()
                self._process.wait(timeout=3)
            except Exception:
                try:
                    self._process.kill()
                except Exception:
                    pass
            self._process = None

        # Limpiar buffers
        self._fft_buf.clear()
        self._pkt_buf.clear()
        self._stream_buf.clear()
        self._err_buf.clear()

        self._dsp_log.close()

    def _drain_sub(self) -> None:
        """Lee todos los mensajes disponibles del SUB y los clasifica."""
        if not self._sub:
            return

        # Debug counters (initialized once)
        if not hasattr(self, '_dbg_zmq_fft_recv'):
            self._dbg_zmq_fft_recv = 0
            self._dbg_zmq_fft_parse_fail = 0
            self._dbg_zmq_pkt_recv = 0
            self._dbg_zmq_short_frames = 0
            self._dbg_zmq_total = 0
            self._dbg_zmq_last_report = time.time()

        while True:
            try:
                frames = self._sub.recv_multipart(zmq.NOBLOCK)
            except zmq.Again:
                break
            except zmq.ZMQError:
                break

            self._dbg_zmq_total += 1

            if len(frames) < 2:
                self._dbg_zmq_short_frames += 1
                continue

            topic = frames[0]
            payload = frames[1]

            if topic == b"FFT":
                self._dbg_zmq_fft_recv += 1
                result = _parse_fft_msg(payload)
                if result:
                    self._fft_buf.append(result)
                else:
                    self._dbg_zmq_fft_parse_fail += 1
            elif topic == b"PKT":
                self._dbg_zmq_pkt_recv += 1
                pkt = _parse_pkt_msg(payload)
                if pkt:
                    if pkt.sync_found == SYNC_FOUND_STREAM:
                        self._stream_buf.append(TelemStream(
                            raw_bytes=pkt.raw_bytes,
                            rssi_estimate_db=pkt.rssi_estimate_db,
                            timestamp=pkt.timestamp,
                        ))
                    else:
                        self._dsp_log.log_packet(pkt)
                        self._pkt_buf.append(pkt)
            elif topic == b"ERR":
                self._err_buf.append(payload.decode("utf-8", errors="replace"))

        # Report every second
        now = time.time()
        if (now - self._dbg_zmq_last_report) >= 1.0:
            print(f"[ZMQ] total={self._dbg_zmq_total}/s  "
                  f"fft_recv={self._dbg_zmq_fft_recv}/s  "
                  f"fft_parse_fail={self._dbg_zmq_fft_parse_fail}  "
                  f"pkt_recv={self._dbg_zmq_pkt_recv}/s  "
                  f"short_frames={self._dbg_zmq_short_frames}")
            self._dbg_zmq_total = 0
            self._dbg_zmq_fft_recv = 0
            self._dbg_zmq_fft_parse_fail = 0
            self._dbg_zmq_pkt_recv = 0
            self._dbg_zmq_short_frames = 0
            self._dbg_zmq_last_report = now

    def poll_fft(self) -> Optional[tuple]:
        """Non-blocking: retorna (freq_axis, power_db) o None."""
        self._drain_sub()
        return self.poll_fft_nodrain()

    def poll_fft_nodrain(self) -> Optional[tuple]:
        """Like poll_fft but without draining (caller already drained)."""
        result = None
        while self._fft_buf:
            result = self._fft_buf.popleft()

        if result is None:
            return None

        freq_axis, power_db = result
        if self._cached_freq_axis is None:
            self._cached_freq_axis = freq_axis
            return (freq_axis, power_db)
        else:
            return (None, power_db)

    def poll_ffts(self) -> list:
        """Non-blocking: retorna lista de TODOS los (freq_axis, power_db)."""
        self._drain_sub()
        return self.poll_ffts_nodrain()

    def poll_ffts_nodrain(self) -> list:
        """Like poll_ffts but without draining (caller already drained)."""
        results = list(self._fft_buf)
        self._fft_buf.clear()

        # Optimize redundant freq axis transfers
        optimized = []
        for freq_axis, power_db in results:
            if self._cached_freq_axis is None and freq_axis is not None:
                self._cached_freq_axis = freq_axis
                optimized.append((freq_axis, power_db))
            else:
                optimized.append((None, power_db))

        return optimized

    def poll_one_fft_nodrain(self) -> Optional[tuple]:
        """Return exactly ONE FFT frame from the buffer, or None."""
        if not self._fft_buf:
            return None
        freq_axis, power_db = self._fft_buf.popleft()
        if self._cached_freq_axis is None and freq_axis is not None:
            self._cached_freq_axis = freq_axis
            return (freq_axis, power_db)
        return (None, power_db)

    def has_pending_ffts(self) -> bool:
        """True if there are more FFT frames waiting in the buffer."""
        return len(self._fft_buf) > 0

    def poll_packets(self) -> list:
        """Non-blocking: retorna lista de DecodedPacket."""
        self._drain_sub()
        return self.poll_packets_nodrain()

    def poll_packets_nodrain(self) -> list:
        """Like poll_packets but without draining (caller already drained)."""
        packets = list(self._pkt_buf)
        self._pkt_buf.clear()
        return packets

    def poll_stream(self) -> Optional["TelemStream"]:
        """Non-blocking: returns a TelemStream if a full TELEM_DUMP was received, else None."""
        self._drain_sub()
        if self._stream_buf:
            return self._stream_buf.popleft()
        return None

    def poll_error(self) -> Optional[str]:
        """Non-blocking: retorna string de error o None."""
        self._drain_sub()
        return self.poll_error_nodrain()

    def poll_error_nodrain(self) -> Optional[str]:
        """Like poll_error but without draining (caller already drained)."""
        # Verificar si el proceso C murio inesperadamente
        if self._process and self._process.poll() is not None:
            self._running = False
            return f"Backend C termino inesperadamente (exit code: {self._process.returncode})"

        if self._err_buf:
            return self._err_buf.popleft()
        return None

    def set_frequency(self, freq_hz: float) -> None:
        """Cambia la frecuencia en caliente."""
        self._send_cmd({"cmd": "SET_FREQ", "value": freq_hz})

    def set_gain(self, gain_db: float) -> None:
        """Cambia la ganancia en caliente."""
        self._send_cmd({"cmd": "SET_GAIN", "value": gain_db})

    def set_power_gate(self, threshold: float) -> None:
        """Cambia el umbral del power gate para sync detection.
        0.0 = disabled.  Typical range: 1e-6 to 1e-3 (log scale)."""
        self._send_cmd({"cmd": "SET_POWER_GATE", "value": threshold})

    def update_config(self, config: SDRConfig) -> None:
        """Actualiza toda la configuracion."""
        self._config = config
        self._send_cmd({
            "cmd": "UPDATE_CONFIG",
            "config": {
                "center_freq_hz": config.center_freq_hz,
                "sample_rate_hz": config.sample_rate_hz,
                "rf_gain_db": config.rf_gain_db,
                "symbol_rate_sps": config.symbol_rate_sps,
                "freq_deviation_hz": config.freq_deviation_hz,
                "rx_bandwidth_hz": config.rx_bandwidth_hz,
                "sync_word": list(config.sync_word),
                "packet_length": config.packet_length,
                "modulation_type": config.modulation_type,
                "sync_power_gate": config.sync_power_gate,
            },
        })

    @property
    def is_running(self) -> bool:
        """True si el backend C esta corriendo."""
        if not self._running:
            return False
        if self._process and self._process.poll() is not None:
            self._running = False
            return False
        return True

    def send_tx_burst(self, iq_interleaved: np.ndarray) -> bool:
        """Send pre-modulated IQ samples to C backend for LimeSDR TX burst.

        Parameters
        ----------
        iq_interleaved : np.ndarray
            Float32 array of interleaved IQ: [I0, Q0, I1, Q1, ...].
            Length = num_samples * 2.

        Returns
        -------
        bool
            True if the C backend accepted and transmitted the burst.
        """
        if not self._req or not self._running:
            return False

        num_samples = len(iq_interleaved) // 2
        header = json.dumps({
            "cmd": "TX_BURST",
            "samples": num_samples,
        })

        try:
            self._req.send_string(header, zmq.SNDMORE)
            self._req.send(iq_interleaved.astype(np.float32).tobytes())
            reply = json.loads(self._req.recv_string())
            return reply.get("status") == "ok"
        except zmq.ZMQError as e:
            print(f"[SDRController] TX_BURST error: {e}")
            return False

    def _send_cmd(self, cmd: dict) -> None:
        """Envia un comando al backend C (non-blocking, best-effort)."""
        if not self._req or not self._running:
            return
        try:
            self._req.send_string(json.dumps(cmd))
            self._req.recv_string()  # esperar reply (con timeout)
        except zmq.ZMQError:
            pass


# ─── Alias para compatibilidad ──────────────────────────────────────────────
# comms.py importa SDRController — este alias hace el swap transparente
SDRController = SDRBackendClient
