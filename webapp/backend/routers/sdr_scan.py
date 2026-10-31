# -*- coding: utf-8 -*-
"""Scans for connected SDR/MCU hardware, and can restart the SDR capture
pipeline (headless_receiver.py + its intisat_sdr.exe child) from the web UI.

USB enumeration via pyusb only lists devices (doesn't open/claim one), so
/scan is safe to call even while headless_receiver.py already has a device
open for RX. /restart exists because unplugging/replugging the LimeSDR
leaves the already-running C backend holding a stale device handle that
never recovers on its own — a cold restart of the whole pipeline is the
only fix, and the operator shouldn't need a shell to do that."""

import os
import subprocess
import sys
import time

import psutil
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .. import config
from ..auth import require_auth

router = APIRouter(prefix="/api/sdr", tags=["sdr"], dependencies=[Depends(require_auth)])

REPO_ROOT = os.path.dirname(config.SATELLITE_CONFIG_PATH)

# (vendor id, product id) -> (driver value for satellite_config.yaml, label)
USB_VID_PID = {
    (0x1D50, 0x6108): ("limesdr", "LimeSDR-USB"),
    (0x0BDA, 0x2838): ("rtlsdr", "RTL-SDR (RTL2832U)"),
}


class DetectedDevice(BaseModel):
    driver: str
    label: str
    detail: str


def _scan_usb() -> list[DetectedDevice]:
    found: list[DetectedDevice] = []
    try:
        import usb.backend.libusb1
        import usb.core
        import usb.util

        backend = None
        if os.path.isfile(config.LIBUSB_DLL_PATH):
            backend = usb.backend.libusb1.get_backend(find_library=lambda _x: config.LIBUSB_DLL_PATH)

        for (vid, pid), (driver, label) in USB_VID_PID.items():
            for dev in usb.core.find(find_all=True, idVendor=vid, idProduct=pid, backend=backend):
                serial = None
                try:
                    if dev.iSerialNumber:
                        serial = usb.util.get_string(dev, dev.iSerialNumber)
                except Exception:
                    pass
                detail = f"USB {vid:04x}:{pid:04x}" + (f" · serie {serial}" if serial else "")
                found.append(DetectedDevice(driver=driver, label=label, detail=detail))
    except Exception as e:
        print(f"[sdr_scan] Enumeracion USB no disponible: {e}")
    return found


def _scan_serial() -> list[DetectedDevice]:
    found: list[DetectedDevice] = []
    try:
        from serial.tools import list_ports

        for p in list_ports.comports():
            found.append(DetectedDevice(driver="mcu", label=f"MCU ({p.device})", detail=p.description or p.device))
    except Exception as e:
        print(f"[sdr_scan] Enumeracion serial no disponible: {e}")
    return found


@router.get("/scan")
def scan() -> list[DetectedDevice]:
    return _scan_usb() + _scan_serial()


def _kill_existing() -> list[int]:
    killed = []
    for proc in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            name = (proc.info["name"] or "").lower()
            cmdline = proc.info["cmdline"] or []
            is_headless = name == "python.exe" and any("headless_receiver.py" in c for c in cmdline)
            is_c_backend = name == "intisat_sdr.exe"
            if is_headless or is_c_backend:
                proc.kill()
                killed.append(proc.pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return killed


@router.post("/restart")
def restart():
    """Kill any running headless_receiver.py / intisat_sdr.exe and launch a
    fresh headless_receiver.py, detached. Returns immediately — the actual
    device open + calibration happens in the background and shows up as
    real data a few seconds later (watch the Dispositivo/Espectro panels),
    the same way it would if someone did this by hand in a terminal."""
    killed = _kill_existing()
    if killed:
        time.sleep(1.5)  # let Windows release the ZMQ ports before rebinding

    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"

    out_log = open(os.path.join(REPO_ROOT, "headless_out.log"), "w", encoding="utf-8")
    err_log = open(os.path.join(REPO_ROOT, "headless_err.log"), "w", encoding="utf-8")

    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP

    subprocess.Popen(
        [sys.executable, "headless_receiver.py"],
        cwd=REPO_ROOT,
        env=env,
        stdout=out_log,
        stderr=err_log,
        creationflags=creationflags,
        close_fds=True,
    )

    return {"status": "restarting", "killed_pids": killed}
