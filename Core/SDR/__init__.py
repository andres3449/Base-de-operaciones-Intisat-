# -*- coding: utf-8 -*-
"""INTISAT — subset of the SDR subsystem used by headless_receiver.py.

This is a trimmed copy: only telemetry_assembler / image_assembler /
burst_image_assembler are included (the UART/MCU decode path). The RF/SDR
receive path (radio_parser, sdr_processor, etc.) lives only in the PyQt5
interface project and isn't needed here.
"""
