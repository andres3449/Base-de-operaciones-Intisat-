/*
 * limesdr_reader.c - Soporte LimeSDR via LimeSuite API
 *
 * Funciones de apertura, lectura sincrónica y cierre del LimeSDR.
 * Se invoca desde rtlsdr_reader.c cuando device_type == DEVICE_LIMESDR.
 *
 * A diferencia del RTL-SDR (callbacks async), el LimeSDR usa
 * LMS_RecvStream() en modo polling (pull-based).
 * Formato: LMS_FMT_F32 -> float IQ ya normalizados a [-1, +1].
 */

#include "rtlsdr_reader.h"
#include "config.h"
#include "platform.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef HAS_LIMESDR
#include <lime/LimeSuite.h>

int limesdr_open(rtlsdr_reader_t *r) {
    lms_device_t *dev = NULL;

    /* Buscar dispositivos LimeSDR */
    lms_info_str_t dev_list[8];
    int n = LMS_GetDeviceList(dev_list);
    if (n < 1) {
        fprintf(stderr, "[lime] Error: no se encontraron dispositivos LimeSDR\n");
        return -1;
    }
    printf("[lime] Dispositivos encontrados: %d\n", n);
    printf("[lime]   %s\n", dev_list[0]);

    /* Abrir el primer dispositivo */
    if (LMS_Open(&dev, dev_list[0], NULL) != LMS_SUCCESS) {
        fprintf(stderr, "[lime] Error: no se pudo abrir LimeSDR\n");
        return -1;
    }

    /* Inicializar chip */
    if (LMS_Init(dev) != LMS_SUCCESS) {
        fprintf(stderr, "[lime] Error: LMS_Init fallo\n");
        LMS_Close(dev);
        return -1;
    }

    /* Habilitar canal RX 0 */
    if (LMS_EnableChannel(dev, LMS_CH_RX, 0, true) != LMS_SUCCESS) {
        fprintf(stderr, "[lime] Error: no se pudo habilitar RX channel 0\n");
        LMS_Close(dev);
        return -1;
    }

    /* Seleccionar antena RX: LNA_W (wideband, 100kHz-2GHz) para UHF 433 MHz.
       LNA_H es para >2 GHz y tendría pésima sensibilidad aquí. */
    if (LMS_SetAntenna(dev, LMS_CH_RX, 0, LMS_PATH_LNAW) != LMS_SUCCESS) {
        fprintf(stderr, "[lime] Warning: no se pudo setear antena LNA_W\n");
    }
    {
        int ant_idx = LMS_GetAntenna(dev, LMS_CH_RX, 0);
        lms_name_t ant_list[10];
        int n_ant = LMS_GetAntennaList(dev, LMS_CH_RX, 0, ant_list);
        printf("[lime] Antena RX: %s (index %d de %d)\n",
               (ant_idx >= 0 && ant_idx < n_ant) ? ant_list[ant_idx] : "?",
               ant_idx, n_ant);
    }

    /* Sample rate: 250 kHz con oversampling automático */
    double sample_rate = DEFAULT_SAMPLE_RATE_HZ;
    if (LMS_SetSampleRate(dev, sample_rate, 0) != LMS_SUCCESS) {
        fprintf(stderr, "[lime] Error: no se pudo setear sample rate %.0f Hz\n", sample_rate);
        LMS_Close(dev);
        return -1;
    }

    /* Verificar sample rate real */
    double host_hz = 0, rf_hz = 0;
    LMS_GetSampleRate(dev, LMS_CH_RX, 0, &host_hz, &rf_hz);
    printf("[lime] Sample rate: host=%.0f Hz, RF=%.0f Hz\n", host_hz, rf_hz);

    /* Frecuencia: sintonizar directo a la señal (sin NCO offset) */
    double signal_freq = (double)atomic_load(&r->config->tune_freq_hz);
    if (LMS_SetLOFrequency(dev, LMS_CH_RX, 0, signal_freq) != LMS_SUCCESS) {
        fprintf(stderr, "[lime] Error: no se pudo setear frecuencia %.0f Hz\n", signal_freq);
        LMS_Close(dev);
        return -1;
    }

    /* Verificar frecuencia real */
    double actual_freq = 0;
    LMS_GetLOFrequency(dev, LMS_CH_RX, 0, &actual_freq);
    printf("[lime] LO Frequency: %.0f Hz\n", actual_freq);

    /* Ganancia RX (rango 0-73 dB) */
    int gain_tenths = atomic_load(&r->config->rf_gain_tenths);
    unsigned gain_db = (unsigned)(gain_tenths / 10);
    if (gain_db > 73) gain_db = 73;
    if (LMS_SetGaindB(dev, LMS_CH_RX, 0, gain_db) != LMS_SUCCESS) {
        fprintf(stderr, "[lime] Warning: no se pudo setear ganancia %u dB\n", gain_db);
    }

    /* LPF analógico */
    double lpf_bw = DEFAULT_RX_BANDWIDTH_HZ;
    if (lpf_bw < 1.4e6) lpf_bw = 1.4e6;  /* mínimo del LPF analógico del LMS7002M */
    if (LMS_SetLPFBW(dev, LMS_CH_RX, 0, lpf_bw) != LMS_SUCCESS) {
        fprintf(stderr, "[lime] Warning: no se pudo setear LPF BW %.0f Hz\n", lpf_bw);
    }

    /* Calibración automática */
    double cal_bw = 2.5e6;  /* ancho de banda para calibración */
    if (LMS_Calibrate(dev, LMS_CH_RX, 0, cal_bw, 0) != LMS_SUCCESS) {
        fprintf(stderr, "[lime] Warning: calibracion RX fallo (puede funcionar igual)\n");
    }

    /* Configurar stream RX */
    lms_stream_t *stream = (lms_stream_t *)malloc(sizeof(lms_stream_t));
    if (!stream) {
        fprintf(stderr, "[lime] Error: malloc stream fallo\n");
        LMS_Close(dev);
        return -1;
    }
    memset(stream, 0, sizeof(*stream));
    stream->isTx = false;
    stream->channel = 0;
    stream->fifoSize = RING_BUF_SIZE;
    stream->throughputVsLatency = 0.5f;
    stream->dataFmt = LMS_FMT_F32;
    stream->throughputVsLatency = 1.0f;  /* maximize throughput, reduce USB drops */

    if (LMS_SetupStream(dev, stream) != LMS_SUCCESS) {
        fprintf(stderr, "[lime] Error: no se pudo configurar stream RX\n");
        free(stream);
        LMS_Close(dev);
        return -1;
    }

    /* Guardar handles */
    r->lime_dev = dev;
    r->lime_stream = stream;

    /* Info del dispositivo */
    const lms_dev_info_t *info = LMS_GetDeviceInfo(dev);
    if (info) {
        printf("[lime] Device: %s, FW: %s, HW: %s, GW: %s\n",
               info->deviceName, info->firmwareVersion,
               info->hardwareVersion, info->gatewareVersion);
    }

    printf("[lime] LimeSDR abierto: freq=%.0f Hz, gain=%u dB, fs=%.0f sps\n",
           actual_freq, gain_db, host_hz);
    return 0;
}

void limesdr_reader_loop(rtlsdr_reader_t *r) {
    lms_stream_t *stream = (lms_stream_t *)r->lime_stream;

    printf("[lime] Iniciando stream RX...\n");
    LMS_StartStream(stream);

    /* Buffer para recibir float IQ: [I0, Q0, I1, Q1, ...] */
    float recv_buf[DSP_CHUNK_SIZE * 2];
    iq_sample_t iq_buf[DSP_CHUNK_SIZE];
    lms_stream_meta_t meta;
    memset(&meta, 0, sizeof(meta));

    uint64_t prev_timestamp = 0;
    int status_counter = 0;
    uint32_t total_drops = 0;
    uint32_t total_late = 0;

    while (!r->should_stop) {
        /* Pause RX reads while TX burst is active (half-duplex).
         * The RX stream stays running — FIFO absorbs samples.
         * During TX on same freq, received data is just our own signal anyway. */
        while (atomic_load(&r->config->tx_active) && !r->should_stop) {
            platform_sleep_ms(5);
        }
        if (r->should_stop) break;

        int samples_read = LMS_RecvStream(stream, recv_buf, DSP_CHUNK_SIZE,
                                          &meta, 1000);  /* 1s timeout */
        if (samples_read <= 0) {
            if (samples_read < 0) {
                fprintf(stderr, "[lime] Error en LMS_RecvStream\n");
            }
            continue;
        }

        /* Detect timestamp gaps (indicates dropped USB packets) */
        if (prev_timestamp > 0 && meta.timestamp > 0) {
            uint64_t expected = prev_timestamp + (uint64_t)samples_read;
            int64_t gap = (int64_t)(meta.timestamp - expected);
            if (gap > 2 || gap < -2) {  /* allow ±2 samples tolerance */
                total_drops++;
                printf("[lime] TIMESTAMP GAP: expected=%llu got=%llu delta=%lld (drop #%u)\n",
                       (unsigned long long)expected,
                       (unsigned long long)meta.timestamp,
                       (long long)gap, total_drops);
                fflush(stdout);
            }
        }
        prev_timestamp = meta.timestamp;

        /* Periodic stream status check (~every 5 seconds) */
        status_counter++;
        if (status_counter >= 150) {  /* 8192 samples/chunk @ 250ksps ≈ 30 chunks/s */
            status_counter = 0;
            lms_stream_status_t st;
            if (LMS_GetStreamStatus(stream, &st) == LMS_SUCCESS) {
                if (st.overrun || st.underrun || st.droppedPackets) {
                    printf("[lime] STREAM STATUS: overrun=%d, underrun=%d, dropped=%d, "
                           "fifo=%d/%d (%.0f%%)\n",
                           st.overrun, st.underrun, st.droppedPackets,
                           st.fifoFilledCount, st.fifoSize,
                           100.0f * st.fifoFilledCount / (st.fifoSize > 0 ? st.fifoSize : 1));
                    fflush(stdout);
                    total_late += st.underrun;
                }
            }
        }

        /* Convertir float[2*N] -> iq_sample_t[N] */
        for (int i = 0; i < samples_read; i++) {
            iq_buf[i].re = recv_buf[i * 2];
            iq_buf[i].im = recv_buf[i * 2 + 1];
        }

        ring_buf_write(r->ring, iq_buf, (uint32_t)samples_read);
        atomic_fetch_add(&r->total_samples, (unsigned)samples_read);
    }

    if (total_drops > 0 || total_late > 0) {
        printf("[lime] Session totals: timestamp_gaps=%u, underruns=%u\n",
               total_drops, total_late);
        fflush(stdout);
    }

    printf("[lime] Deteniendo stream RX...\n");
    LMS_StopStream(stream);
}

void limesdr_close(rtlsdr_reader_t *r) {
    lms_device_t *dev = (lms_device_t *)r->lime_dev;
    lms_stream_t *stream = (lms_stream_t *)r->lime_stream;

    if (stream) {
        LMS_DestroyStream(dev, stream);
        free(stream);
        r->lime_stream = NULL;
    }

    if (dev) {
        LMS_EnableChannel(dev, LMS_CH_RX, 0, false);
        LMS_Close(dev);
        r->lime_dev = NULL;
        printf("[lime] LimeSDR cerrado\n");
    }
}

int limesdr_set_frequency(rtlsdr_reader_t *r, uint32_t freq_hz) {
    lms_device_t *dev = (lms_device_t *)r->lime_dev;
    if (dev) {
        return LMS_SetLOFrequency(dev, LMS_CH_RX, 0, (double)freq_hz);
    }
    return 0;
}

int limesdr_set_gain(rtlsdr_reader_t *r, int gain_tenths) {
    lms_device_t *dev = (lms_device_t *)r->lime_dev;
    if (dev) {
        unsigned gain_db = (unsigned)(gain_tenths / 10);
        if (gain_db > 73) gain_db = 73;
        return LMS_SetGaindB(dev, LMS_CH_RX, 0, gain_db);
    }
    return 0;
}

#else /* !HAS_LIMESDR */

int limesdr_open(rtlsdr_reader_t *r) {
    (void)r;
    fprintf(stderr, "[lime] Error: compilado sin soporte LimeSDR\n");
    return -1;
}

void limesdr_reader_loop(rtlsdr_reader_t *r) { (void)r; }
void limesdr_close(rtlsdr_reader_t *r) { (void)r; }
int limesdr_set_frequency(rtlsdr_reader_t *r, uint32_t freq_hz) {
    (void)r; (void)freq_hz; return -1;
}
int limesdr_set_gain(rtlsdr_reader_t *r, int gain_tenths) {
    (void)r; (void)gain_tenths; return -1;
}

#endif /* HAS_LIMESDR */
