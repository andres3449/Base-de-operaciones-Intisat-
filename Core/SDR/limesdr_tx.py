# -*- coding: utf-8 -*-
"""
INTISAT — LimeSDR TX Uplink Module.

Generates 2FSK-modulated IQ baseband from AX.25 frames and sends
the IQ samples to the C backend via ZMQ for transmission through
the LimeSDR TX channel.

The C backend (intisat_sdr) handles the actual hardware — both RX
and TX use the same LimeSDR device handle via LimeSuite.

Over-the-air packet format:
  [12B preamble 0x55] [4B sync word] [1B length (unwhitened)] [payload (PN9 whitened)] [pad to 64B]
"""

import threading
import numpy as np

# CRC-16 CCITT lookup table (same as STM32 firmware)
_CRC16_TABLE = [
    0x0000, 0x1021, 0x2042, 0x3063, 0x4084, 0x50A5, 0x60C6, 0x70E7,
    0x8108, 0x9129, 0xA14A, 0xB16B, 0xC18C, 0xD1AD, 0xE1CE, 0xF1EF,
    0x1231, 0x0210, 0x3273, 0x2252, 0x52B5, 0x4294, 0x72F7, 0x62D6,
    0x9339, 0x8318, 0xB37B, 0xA35A, 0xD3BD, 0xC39C, 0xF3FF, 0xE3DE,
    0x2462, 0x3443, 0x0420, 0x1401, 0x64E6, 0x74C7, 0x44A4, 0x5485,
    0xA56A, 0xB54B, 0x8528, 0x9509, 0xE5EE, 0xF5CF, 0xC5AC, 0xD58D,
    0x3653, 0x2672, 0x1611, 0x0630, 0x76D7, 0x66F6, 0x5695, 0x46B4,
    0xB75B, 0xA77A, 0x9719, 0x8738, 0xF7DF, 0xE7FE, 0xD79D, 0xC7BC,
    0x48C4, 0x58E5, 0x6886, 0x78A7, 0x0840, 0x1861, 0x2802, 0x3823,
    0xC9CC, 0xD9ED, 0xE98E, 0xF9AF, 0x8948, 0x9969, 0xA90A, 0xB92B,
    0x5AF5, 0x4AD4, 0x7AB7, 0x6A96, 0x1A71, 0x0A50, 0x3A33, 0x2A12,
    0xDBFD, 0xCBDC, 0xFBBF, 0xEB9E, 0x9B79, 0x8B58, 0xBB3B, 0xAB1A,
    0x6CA6, 0x7C87, 0x4CE4, 0x5CC5, 0x2C22, 0x3C03, 0x0C60, 0x1C41,
    0xEDAE, 0xFD8F, 0xCDEC, 0xDDCD, 0xAD2A, 0xBD0B, 0x8D68, 0x9D49,
    0x7E97, 0x6EB6, 0x5ED5, 0x4EF4, 0x3E13, 0x2E32, 0x1E51, 0x0E70,
    0xFF9F, 0xEFBE, 0xDFDD, 0xCFFC, 0xBF1B, 0xAF3A, 0x9F59, 0x8F78,
    0x9188, 0x81A9, 0xB1CA, 0xA1EB, 0xD10C, 0xC12D, 0xF14E, 0xE16F,
    0x1080, 0x00A1, 0x30C2, 0x20E3, 0x5004, 0x4025, 0x7046, 0x6067,
    0x83B9, 0x9398, 0xA3FB, 0xB3DA, 0xC33D, 0xD31C, 0xE37F, 0xF35E,
    0x02B1, 0x1290, 0x22F3, 0x32D2, 0x4235, 0x5214, 0x6277, 0x7256,
    0xB5EA, 0xA5CB, 0x95A8, 0x8589, 0xF56E, 0xE54F, 0xD52C, 0xC50D,
    0x34E2, 0x24C3, 0x14A0, 0x0481, 0x7466, 0x6447, 0x5424, 0x4405,
    0xA7DB, 0xB7FA, 0x8799, 0x97B8, 0xE75F, 0xF77E, 0xC71D, 0xD73C,
    0x26D3, 0x36F2, 0x0691, 0x16B0, 0x6657, 0x7676, 0x4615, 0x5634,
    0xD94C, 0xC96D, 0xF90E, 0xE92F, 0x99C8, 0x89E9, 0xB98A, 0xA9AB,
    0x5844, 0x4865, 0x7806, 0x6827, 0x18C0, 0x08E1, 0x3882, 0x28A3,
    0xCB7D, 0xDB5C, 0xEB3F, 0xFB1E, 0x8BF9, 0x9BD8, 0xABBB, 0xBB9A,
    0x4A75, 0x5A54, 0x6A37, 0x7A16, 0x0AF1, 0x1AD0, 0x2AB3, 0x3A92,
    0xFD2E, 0xED0F, 0xDD6C, 0xCD4D, 0xBDAA, 0xAD8B, 0x9DE8, 0x8DC9,
    0x7C26, 0x6C07, 0x5C64, 0x4C45, 0x3CA2, 0x2C83, 0x1CE0, 0x0CC1,
    0xEF1F, 0xFF3E, 0xCF5D, 0xDF7C, 0xAF9B, 0xBFBA, 0x8FD9, 0x9FF8,
    0x6E17, 0x7E36, 0x4E55, 0x5E74, 0x2E93, 0x3EB2, 0x0ED1, 0x1EF0,
]

# Protocol constants
AX25_FLAG = 0x7E
PREAMBLE_BYTE = 0x55
PREAMBLE_LEN = 12
SYNC_WORD_OTA = bytes([0x5D, 0xE6, 0x2A, 0x7E])  # on-air format
PACKET_LEN = 64
PN9_SEED = 0x01FF

# Default uplink callsigns (reversed from downlink)
UPLINK_SRC_CALL = "RX01"
UPLINK_DST_CALL = "TX01"

# ZMQ endpoint for C backend commands
ZMQ_CMD_ENDPOINT = "tcp://127.0.0.1:5556"


def crc16_ccitt(data: bytes) -> int:
    """CRC-16 CCITT matching the STM32 firmware (init=0xFFFF, final invert)."""
    crc = 0xFFFF
    for b in data:
        crc = ((crc << 8) & 0xFFFF) ^ _CRC16_TABLE[(crc >> 8) ^ b]
    return crc ^ 0xFFFF


def pn9_whiten(data: bytearray) -> bytearray:
    """PN9 whitening/de-whitening (self-inverse).

    Matches pn_dewhiten.c exactly:
    - LFSR polynomial: x^9 + x^5 + 1
    - Seed: 0x01FF
    - Output: LSB-first per byte
    """
    lfsr = PN9_SEED
    out = bytearray(len(data))

    for i in range(len(data)):
        pn_byte = 0
        for bit in range(8):
            pn_byte |= (lfsr & 0x01) << bit
            feedback = ((lfsr >> 0) ^ (lfsr >> 5)) & 0x01
            lfsr = (lfsr >> 1) | (feedback << 8)
        out[i] = data[i] ^ pn_byte

    return out


def encode_ax25_address(callsign: str, ssid: int, is_last: bool) -> bytes:
    """Encode AX.25 address field (7 bytes)."""
    padded = callsign.ljust(6)[:6]
    addr = bytearray(7)
    for i in range(6):
        addr[i] = ord(padded[i]) << 1
    addr[6] = (ssid << 1) | (0x01 if is_last else 0x00)
    return bytes(addr)


def build_ax25_frame(pkt_type: int, data: bytes = b"",
                     src_call: str = UPLINK_SRC_CALL,
                     dst_call: str = UPLINK_DST_CALL) -> bytes:
    """Build a complete AX.25 frame.

    Returns the raw frame bytes (flag to flag) ready for OTA packaging.
    """
    frame = bytearray()
    frame.append(AX25_FLAG)

    # Addresses (CRC covers from here)
    crc_start = len(frame)
    frame.extend(encode_ax25_address(dst_call, 0, False))
    frame.extend(encode_ax25_address(src_call, 0, True))

    # Packet type (control field)
    frame.append(pkt_type)

    # Data payload (max 100 bytes — burst NACK needs up to 81)
    payload = data[:100]
    frame.extend(payload)

    # CRC-16 over everything between flags
    crc = crc16_ccitt(bytes(frame[crc_start:]))
    frame.append(crc & 0xFF)
    frame.append((crc >> 8) & 0xFF)

    # End flag
    frame.append(AX25_FLAG)

    return bytes(frame)


def build_ota_packet(ax25_frame: bytes) -> bytes:
    """Build complete over-the-air packet with preamble, sync, whitening.

    Returns raw byte sequence ready for 2FSK modulation.

    Structure:
      [12B preamble] [4B sync word] [1B length (unwhitened)] [payload (PN9 whitened)] [padding to 64B]
    """
    # Frame length (the value Si4463 expects as first FIFO byte)
    frame_len = len(ax25_frame)

    # Build FIFO content: [length_byte] [frame_data] [padding]
    fifo = bytearray(PACKET_LEN)
    fifo[0] = frame_len  # Length byte — NOT whitened
    fifo[1:1 + frame_len] = ax25_frame

    # PN9-whiten everything except the length byte (fifo[1:])
    whitened_data = pn9_whiten(bytearray(fifo[1:]))
    fifo[1:] = whitened_data

    # Build complete OTA packet
    preamble = bytes([PREAMBLE_BYTE] * PREAMBLE_LEN)
    return preamble + SYNC_WORD_OTA + bytes(fifo)


def bytes_to_bits(data: bytes) -> list:
    """Convert bytes to bit list (MSB-first per byte)."""
    bits = []
    for byte in data:
        for i in range(7, -1, -1):
            bits.append((byte >> i) & 1)
    return bits


def fsk_modulate(bits: list, sample_rate: float = 250000.0,
                 symbol_rate: float = 9600.0,
                 freq_dev: float = 5000.0) -> np.ndarray:
    """Generate phase-continuous 2FSK IQ baseband samples.

    Parameters
    ----------
    bits : list of int
        Binary bit sequence (0 or 1).
    sample_rate : float
        Output sample rate in Hz.
    symbol_rate : float
        Symbol rate in symbols/second.
    freq_dev : float
        Frequency deviation in Hz (+dev for 1, -dev for 0).

    Returns
    -------
    np.ndarray
        Complex IQ samples (complex64).
    """
    samples_per_symbol = sample_rate / symbol_rate
    total_samples = int(len(bits) * samples_per_symbol) + 1

    # Phase accumulator for continuous-phase FSK
    phase = 0.0
    iq = np.zeros(total_samples, dtype=np.complex64)
    sample_idx = 0

    for bit_idx, bit in enumerate(bits):
        freq = freq_dev if bit == 1 else -freq_dev
        n_samples = int((bit_idx + 1) * samples_per_symbol) - int(bit_idx * samples_per_symbol)

        for _ in range(n_samples):
            if sample_idx >= total_samples:
                break
            iq[sample_idx] = np.exp(1j * phase)
            phase += 2.0 * np.pi * freq / sample_rate
            sample_idx += 1

    # Keep phase bounded
    return iq[:sample_idx]


class LimeSDRTransmitter:
    """Uplink TX via C backend — half-duplex burst mode.

    Instead of accessing LimeSDR hardware directly, this class:
    1. Builds AX.25 frames and modulates them to 2FSK IQ samples (in Python)
    2. Sends the IQ samples to the C backend via SDRBackendClient.send_tx_burst()
    3. The C backend writes them to the LimeSDR TX stream (same device as RX)

    Usage:
        tx = LimeSDRTransmitter()
        tx.open(sdr_controller)    # link to running SDR backend
        tx.send_command(0x50)      # modulate + send via ZMQ → C → LimeSDR TX
        tx.close()
    """

    def __init__(self, sample_rate: float = 250000.0,
                 symbol_rate: float = 9600.0,
                 freq_dev: float = 5000.0):
        self.sample_rate = sample_rate
        self.symbol_rate = symbol_rate
        self.freq_dev = freq_dev

        self._sdr_controller = None
        self._lock = threading.Lock()
        self._is_open = False

    @property
    def is_open(self) -> bool:
        return self._is_open

    def open(self, sdr_controller=None) -> bool:
        """Link to the running SDR backend for TX commands.

        Parameters
        ----------
        sdr_controller : SDRBackendClient
            The active SDR controller (must be running with LimeSDR).
        """
        if sdr_controller is None:
            print("[LimeSDR TX] No SDR controller provided")
            return False

        if not sdr_controller.is_running:
            print("[LimeSDR TX] SDR backend not running — start it first")
            return False

        self._sdr_controller = sdr_controller
        self._is_open = True
        print("[LimeSDR TX] Ready (using C backend for TX)")
        return True

    def close(self):
        """Disconnect from SDR backend."""
        self._sdr_controller = None
        self._is_open = False
        print("[LimeSDR TX] Closed")

    def transmit_frame(self, ax25_frame: bytes) -> bool:
        """Build OTA packet, modulate to IQ, send to C backend for TX.

        Parameters
        ----------
        ax25_frame : bytes
            Complete AX.25 frame (flag to flag).

        Returns
        -------
        bool
            True if transmission succeeded.
        """
        if not self._is_open or not self._sdr_controller:
            print("[LimeSDR TX] Not connected to C backend")
            return False

        # Build OTA packet and modulate to IQ
        ota = build_ota_packet(ax25_frame)
        bits = bytes_to_bits(ota)
        iq = fsk_modulate(bits, self.sample_rate, self.symbol_rate, self.freq_dev)
        iq *= 0.9  # headroom to avoid DAC clipping at max TX gain

        # Convert complex64 to interleaved float32 [I0, Q0, I1, Q1, ...]
        iq_interleaved = np.zeros(len(iq) * 2, dtype=np.float32)
        iq_interleaved[0::2] = iq.real
        iq_interleaved[1::2] = iq.imag

        with self._lock:
            ok = self._sdr_controller.send_tx_burst(iq_interleaved)

        if ok:
            print(f"[LimeSDR TX] Burst: {len(iq)} samples, "
                  f"{len(bits)} bits, "
                  f"~{len(bits)/self.symbol_rate*1000:.0f}ms")
        else:
            print("[LimeSDR TX] Burst failed")
        return ok

    def send_command(self, pkt_type: int, data: bytes = b"") -> bool:
        """Build AX.25 command frame and burst-transmit via C backend.

        Parameters
        ----------
        pkt_type : int
            Command packet type (e.g., 0x50 for TELEM_SINGLE).
        data : bytes
            Optional command payload.

        Returns
        -------
        bool
            True if sent successfully.
        """
        frame = build_ax25_frame(pkt_type, data)
        return self.transmit_frame(frame)

    def send_ack(self) -> bool:
        """Send ACK byte (0xAC) for image data reception."""
        return self.send_command(0x04, b"\xAC")
