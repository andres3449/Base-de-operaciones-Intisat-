# -*- coding: utf-8 -*-
"""
INTISAT — Image Assembler for RF-received photos.

Collects IMG_SIZE (0x10) and IMG_DATA (0x11) AX.25 packets from the
SDR backend via ZMQ, assembles the complete JPEG image, and emits
it for display in the Payload page.

Uses a circular buffer approach (inspired by SAT_image_receiver.py)
for efficient byte management, and emits partial image snapshots
for progressive pixel-by-pixel rendering.
"""

import time as _time

from PyQt5.QtCore import QObject, pyqtSignal, QTimer


class CircularBuffer:
    """Efficient circular buffer for streaming byte data."""

    __slots__ = ('buffer', 'size', 'head', 'tail', 'count')

    def __init__(self, size=262144):  # 256 KB default
        self.buffer = bytearray(size)
        self.size = size
        self.head = 0
        self.tail = 0
        self.count = 0

    def write(self, data):
        n = len(data)
        if n == 0:
            return
        # If data is larger than free space, grow
        if n > self.size - self.count:
            self._grow(self.count + n)
        # Fast path: contiguous write
        end = self.head + n
        if end <= self.size:
            self.buffer[self.head:end] = data
        else:
            first = self.size - self.head
            self.buffer[self.head:self.size] = data[:first]
            self.buffer[0:n - first] = data[first:]
        self.head = (self.head + n) % self.size
        self.count += n

    def read_all(self):
        """Read all data without consuming it (peek everything)."""
        if self.count == 0:
            return bytes()
        if self.tail + self.count <= self.size:
            return bytes(self.buffer[self.tail:self.tail + self.count])
        first = self.size - self.tail
        return bytes(self.buffer[self.tail:self.size]) + bytes(self.buffer[0:self.count - first])

    def consume(self, n):
        """Discard n bytes from the front."""
        if n >= self.count:
            self.head = 0
            self.tail = 0
            self.count = 0
        else:
            self.tail = (self.tail + n) % self.size
            self.count -= n

    def clear(self):
        self.head = 0
        self.tail = 0
        self.count = 0

    def _grow(self, min_size):
        new_size = max(self.size * 2, min_size + 1024)
        new_buf = bytearray(new_size)
        data = self.read_all()
        new_buf[:len(data)] = data
        self.buffer = new_buf
        self.size = new_size
        self.tail = 0
        self.head = len(data)


class ImageAssembler(QObject):
    """Assembles image data from RF packets with progressive rendering."""

    image_ready = pyqtSignal(bytes)          # complete image
    image_partial = pyqtSignal(bytes, int)   # (raw_bytes_so_far, expected_size)
    image_progress = pyqtSignal(int, int)    # (received_bytes, total_bytes)
    image_error = pyqtSignal(str)            # error message
    ack_requested = pyqtSignal()             # Request an ACK transmission

    TIMEOUT_BASE_MS = 30000     # minimum 30 s for small transfers
    TIMEOUT_PER_CHUNK_MS = 4000  # ~4 s per 42-byte chunk (worst case: 2s ACK + 1s retry + margin)
    PARTIAL_INTERVAL_MS = 250    # emit partial image snapshot every 250ms

    def __init__(self, parent=None):
        super().__init__(parent)
        self._expected_size = 0
        self._buffer = CircularBuffer()
        self._active = False
        self._last_partial_time = 0.0

        # Chunk-level debug tracking
        self._chunk_count = 0
        self._chunk_times = []  # (chunk_idx, timestamp) for gap analysis
        self._transfer_start = 0.0

        self._timeout = QTimer(self)
        self._timeout.setSingleShot(True)
        self._timeout.setInterval(self.TIMEOUT_BASE_MS)
        self._timeout.timeout.connect(self._on_timeout)

    @property
    def is_active(self) -> bool:
        return self._active

    def reset(self):
        """Reset assembler state."""
        self._expected_size = 0
        self._buffer.clear()
        self._active = False
        self._last_partial_time = 0.0
        self._timeout.stop()

    def process_packet(self, pkt_type: int, data: bytes):
        """Process an incoming image-related packet.

        Parameters
        ----------
        pkt_type : int
            0x10 (IMG_SIZE) or 0x11 (IMG_DATA).
        data : bytes
            Packet payload.
        """
        if pkt_type in (0x10, 0x11):
            self.ack_requested.emit()

        if pkt_type == 0x10:  # IMG_SIZE
            if len(data) >= 4:
                self._expected_size = (
                    (data[0] << 24) | (data[1] << 16) |
                    (data[2] << 8) | data[3]
                )
                self._buffer.clear()
                self._active = True
                self._last_partial_time = 0.0
                self._chunk_count = 0
                self._chunk_times = []
                self._transfer_start = _time.perf_counter()
                # Adaptive timeout: base + per-chunk allowance
                n_chunks = (self._expected_size + 41) // 42
                adaptive_ms = max(
                    self.TIMEOUT_BASE_MS,
                    n_chunks * self.TIMEOUT_PER_CHUNK_MS
                )
                self._timeout.setInterval(adaptive_ms)
                self._timeout.start()
                print(f"[ImageAssembler] IMG_SIZE: {self._expected_size} bytes "
                      f"({self._expected_size / 1024:.1f} KB), "
                      f"timeout={adaptive_ms / 1000:.0f}s ({n_chunks} chunks)")
                self.image_progress.emit(0, self._expected_size)

        elif pkt_type == 0x11:  # IMG_DATA
            if not self._active:
                # Got data without size — start anyway
                self._active = True
                self._timeout.start()
            else:
                # Reset timeout on every data packet (transfer still alive)
                self._timeout.start()

            self._buffer.write(data)
            received = self._buffer.count
            self._chunk_count += 1
            now_abs = _time.perf_counter()
            self._chunk_times.append((self._chunk_count, now_abs))
            self.image_progress.emit(received, self._expected_size)

            # Emit partial snapshot (throttled) for progressive rendering
            now = _time.perf_counter()
            if (now - self._last_partial_time) * 1000 >= self.PARTIAL_INTERVAL_MS:
                self._last_partial_time = now
                self.image_partial.emit(
                    self._buffer.read_all(), self._expected_size)

            if self._expected_size > 0 and received >= self._expected_size:
                self._complete()

    def abort_transfer(self, reason: str = ""):
        """Satellite signalled transfer abort — emit partial data if available."""
        if not self._active:
            return
        self._timeout.stop()
        self._active = False
        self._print_transfer_summary(f"ABORT ({reason})")
        received = self._buffer.count
        if received > 0:
            # Emit as partial (not image_ready) to avoid slow JPEG decode attempt
            self.image_partial.emit(self._buffer.read_all(), self._expected_size)
        self.image_error.emit(reason or "Transfer aborted by satellite")
        self._buffer.clear()

    def _print_transfer_summary(self, status: str):
        """Print chunk timing analysis for debugging packet loss."""
        elapsed = _time.perf_counter() - self._transfer_start if self._transfer_start else 0
        expected_chunks = (self._expected_size + 41) // 42 if self._expected_size > 0 else 0
        print(f"[ImageAssembler] === TRANSFER {status} ===")
        print(f"  Received: {self._buffer.count}/{self._expected_size} bytes "
              f"({self._chunk_count}/{expected_chunks} chunks) in {elapsed:.1f}s")
        if self._chunk_count > 0:
            rate = self._buffer.count / elapsed if elapsed > 0 else 0
            print(f"  Throughput: {rate:.0f} bytes/s ({rate * 8 / 1000:.1f} kbps)")
        # Show inter-chunk gaps (detect where retransmissions happened)
        if len(self._chunk_times) >= 2:
            gaps = []
            for i in range(1, len(self._chunk_times)):
                dt = self._chunk_times[i][1] - self._chunk_times[i - 1][1]
                gaps.append((self._chunk_times[i][0], dt))
            big_gaps = [(idx, dt) for idx, dt in gaps if dt > 1.5]
            if big_gaps:
                print(f"  Large gaps (>1.5s, likely retransmissions): {len(big_gaps)}")
                for idx, dt in big_gaps[:10]:  # show first 10
                    print(f"    Chunk #{idx}: gap={dt:.2f}s")
            avg_gap = sum(dt for _, dt in gaps) / len(gaps)
            print(f"  Avg inter-chunk: {avg_gap:.3f}s, "
                  f"min={min(dt for _, dt in gaps):.3f}s, "
                  f"max={max(dt for _, dt in gaps):.3f}s")
        print(f"[ImageAssembler] === END SUMMARY ===")

    def _complete(self):
        """Image fully received."""
        self._timeout.stop()
        self._active = False
        self._print_transfer_summary("COMPLETE")
        all_data = self._buffer.read_all()
        img_data = bytes(all_data[:self._expected_size])
        print(f"[ImageAssembler] Image complete: {len(img_data)} bytes")
        self.image_ready.emit(img_data)
        self._buffer.clear()

    def _on_timeout(self):
        """Transfer timed out."""
        if self._active:
            self._print_transfer_summary("TIMEOUT")
            received = self._buffer.count
            if received > 0:
                # Emit as partial to avoid slow JPEG decode on incomplete data
                self.image_partial.emit(self._buffer.read_all(), self._expected_size)
                self.image_error.emit(
                    f"Image transfer timed out ({received}/{self._expected_size} bytes)")
            else:
                self.image_error.emit("Image transfer timed out with no data")
            self.reset()
