# -*- coding: utf-8 -*-
"""
INTISAT — AX.25 frame decoder (SDR receive path).

Extracted from GUI/pages/comms.py's decode_ax25_packet / try_bitslip_correction
— the parsing-only "jugo": turns raw over-the-air bytes handed back by the
SDR backend (Core/SDR/sdr_backend_client.py's DecodedPacket.raw_bytes) into
(pkt_type, data), the same shape UartReceiver produces for the UART path, so
both can feed the same on_packet() handler in headless_receiver.py.

Console/debug-only features from the PyQt version — BER-test bit tracking,
human-readable packet log formatting, auto BEACON_ACK/KEEPALIVE_ACK — are
GUI concerns and are not ported here.
"""

from Core.SDR.limesdr_tx import crc16_ccitt

AX25_FLAG = 0x7E
AX25_OVERHEAD = 19  # flag + 7B dest + 7B src + 1B type + 2B CRC + flag

# Our own uplink callsigns (see Core/SDR/limesdr_tx.py) — a packet "received"
# from one of these is our own TX burst leaking back into the RX chain.
LOOPBACK_CALLSIGNS = ("INRAS", "RX01")


def decode_ax25_callsign(addr_bytes):
    call = ""
    for i in range(6):
        c = addr_bytes[i] >> 1
        if 32 <= c < 127:
            call += chr(c)
    call = call.rstrip()
    ssid = (addr_bytes[6] >> 1) & 0x0F
    return call, ssid


def decode_ax25_packet(raw_bytes):
    """Parse one AX.25 frame. Returns a dict, or None if no flag byte found."""
    if len(raw_bytes) < AX25_OVERHEAD:
        return None
    flag_offset = -1
    for i in range(min(4, len(raw_bytes))):
        if raw_bytes[i] == AX25_FLAG:
            flag_offset = i
            break
    if flag_offset < 0:
        return None
    frame = raw_bytes[flag_offset:]
    if len(frame) < AX25_OVERHEAD:
        return None

    frame_len = None
    if flag_offset > 0:
        prefix_len = raw_bytes[0]
        if AX25_OVERHEAD <= prefix_len <= 255:  # up to 255-byte frames (e.g. 121-byte IMG_DATA)
            frame_len = min(prefix_len, len(frame))

    dest_call, dest_ssid = decode_ax25_callsign(frame[1:8])
    src_call, src_ssid = decode_ax25_callsign(frame[8:15])
    pkt_type = frame[15]

    if frame_len is not None:
        data_len = frame_len - AX25_OVERHEAD
    else:
        data_len = 0
        for end_pos in range(16, len(frame)):
            if frame[end_pos] == AX25_FLAG and end_pos >= 18:
                data_len = end_pos - 18
                break
        if data_len == 0:
            data_len = min(236, len(frame) - AX25_OVERHEAD)  # 255 - 19 overhead

    if data_len < 0 or data_len > 236:
        data_len = 0
    if 16 + data_len + 2 > len(frame):
        data_len = max(0, len(frame) - 16 - 2)

    data = bytes(frame[16:16 + data_len])
    crc_region = frame[1:16 + data_len]
    crc_pos = 16 + data_len
    if crc_pos + 2 <= len(frame):
        crc_received = frame[crc_pos] | (frame[crc_pos + 1] << 8)
        crc_calculated = crc16_ccitt(crc_region)
        crc_valid = (crc_received == crc_calculated)
    else:
        crc_valid = False
        crc_received = 0
        crc_calculated = 0

    end_flag_pos = crc_pos + 2
    has_end_flag = (end_flag_pos < len(frame) and frame[end_flag_pos] == AX25_FLAG)

    return {
        'flag_offset': flag_offset,
        'dest_call': dest_call,
        'dest_ssid': dest_ssid,
        'src_call': src_call,
        'src_ssid': src_ssid,
        'pkt_type': pkt_type,
        'data': data,
        'data_len': data_len,
        'crc_received': crc_received,
        'crc_calculated': crc_calculated,
        'crc_valid': crc_valid,
        'has_end_flag': has_end_flag,
        'frame_len': frame_len or (AX25_OVERHEAD + data_len),
    }


def _bytes_to_bits(data: bytes):
    bits = []
    for b in data:
        for i in range(7, -1, -1):
            bits.append((b >> i) & 1)
    return bits


def _bits_to_bytes(bits):
    out = bytearray()
    for i in range(0, len(bits) - 7, 8):
        byte = 0
        for j in range(8):
            byte = (byte << 1) | bits[i + j]
        out.append(byte)
    return bytes(out)


def try_bitslip_correction(raw_bytes):
    """Try to recover a CRC-failed packet caused by a mid-stream bit-slip.

    A bit-slip inserts or deletes 1 bit at some position in the bitstream.
    Bytes before the slip point are correct; bytes after are shifted by 1.

    Returns (decoded_dict, slip_info_str) or (None, 0) if no correction works.
    """
    flag_pos = -1
    for i in range(min(4, len(raw_bytes))):
        if raw_bytes[i] == AX25_FLAG:
            flag_pos = i
            break
    if flag_pos < 0:
        return None, 0

    bits = _bytes_to_bits(raw_bytes)
    frame_bit_start = flag_pos * 8

    num_frame_bytes = len(raw_bytes) - flag_pos
    for byte_off in range(1, min(num_frame_bytes - 2, 20)):
        slip_bit = frame_bit_start + byte_off * 8

        corrected = bits[:slip_bit] + bits[slip_bit + 1:]
        candidate = _bits_to_bytes(corrected)
        decoded = decode_ax25_packet(candidate)
        if decoded and decoded['crc_valid']:
            return decoded, f"del@byte{byte_off}"

        for insert_val in (0, 1):
            corrected = bits[:slip_bit] + [insert_val] + bits[slip_bit:]
            candidate = _bits_to_bytes(corrected)
            decoded = decode_ax25_packet(candidate)
            if decoded and decoded['crc_valid']:
                return decoded, f"ins{insert_val}@byte{byte_off}"

    return None, 0
