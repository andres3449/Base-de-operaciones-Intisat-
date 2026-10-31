/*
 * limesdr_tx.c - LimeSDR TX burst transmission
 *
 * Uses the same lms_device_t* from limesdr_reader.c.
 * For each burst: start TX stream → warmup → send IQ → drain → stop.
 * The TX stream is NOT kept running idle, because the DAC noise at
 * high gain leaks into RX via internal coupling and kills sensitivity.
 */

#include "limesdr_tx.h"
#include "config.h"
#include "platform.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef HAS_LIMESDR
#include <lime/LimeSuite.h>

#ifdef _WIN32
#include <windows.h>
static void sleep_ms(int ms) { Sleep(ms); }
#else
#include <unistd.h>
static void sleep_ms(int ms) { usleep(ms * 1000); }
#endif

/* TX gain for uplink — 73 dB = máximo LimeSDR-USB a 433 MHz.
 * Si4463 outputs +13 to +20 dBm. Raised from 60 dB to maximize uplink margin. */
#define TX_GAIN_DB  73

int limesdr_tx_init(rtlsdr_reader_t *r) {
    lms_device_t *dev = (lms_device_t *)r->lime_dev;
    if (!dev) {
        fprintf(stderr, "[lime-tx] Error: device not open\n");
        return -1;
    }

    /* Enable TX channel 0 */
    if (LMS_EnableChannel(dev, LMS_CH_TX, 0, true) != LMS_SUCCESS) {
        fprintf(stderr, "[lime-tx] Error: could not enable TX channel 0\n");
        return -1;
    }

    /* Set TX antenna path for 433 MHz: BAND1 (TX1_1 port on LimeSDR-USB) */
    if (LMS_SetAntenna(dev, LMS_CH_TX, 0, LMS_PATH_TX1) != LMS_SUCCESS) {
        fprintf(stderr, "[lime-tx] Warning: could not set TX antenna BAND1\n");
    }

    /* Log actual TX antenna selection */
    {
        int ant_idx = LMS_GetAntenna(dev, LMS_CH_TX, 0);
        lms_name_t ant_list[10];
        int n_ant = LMS_GetAntennaList(dev, LMS_CH_TX, 0, ant_list);
        printf("[lime-tx] Antena TX: %s (index %d de %d)\n",
               (ant_idx >= 0 && ant_idx < n_ant) ? ant_list[ant_idx] : "?",
               ant_idx, n_ant);
        fflush(stdout);
    }

    /* TX frequency — same as RX (433.5 MHz) */
    double signal_freq = (double)atomic_load(&r->config->tune_freq_hz);
    if (r->device_type == DEVICE_LIMESDR) {
        /* LimeSDR tunes directly to signal (no NCO offset) */
    } else {
        signal_freq += (double)atomic_load(&r->config->nco_shift_hz);
    }
    if (LMS_SetLOFrequency(dev, LMS_CH_TX, 0, signal_freq) != LMS_SUCCESS) {
        fprintf(stderr, "[lime-tx] Error: could not set TX frequency %.0f Hz\n",
                signal_freq);
        LMS_EnableChannel(dev, LMS_CH_TX, 0, false);
        return -1;
    }

    /* NOTE: Do NOT call LMS_SetSampleRate here — limesdr_reader.c already set it
     * for the entire device. Calling it again can disrupt FPGA configuration. */

    /* TX gain */
    if (LMS_SetGaindB(dev, LMS_CH_TX, 0, TX_GAIN_DB) != LMS_SUCCESS) {
        fprintf(stderr, "[lime-tx] Warning: could not set TX gain %d dB\n",
                TX_GAIN_DB);
    }

    /* Verify actual gain */
    {
        unsigned actual_gain = 0;
        LMS_GetGaindB(dev, LMS_CH_TX, 0, &actual_gain);
        printf("[lime-tx] TX gain: requested=%d dB, actual=%u dB\n",
               TX_GAIN_DB, actual_gain);
        fflush(stdout);
    }

    /* NOTE: Do NOT set TX LPF here — LMS_SetLPFBW triggers an internal
     * filter calibration that corrupts the RX calibration on LMS7002M.
     * The default TX LPF is wide enough for our narrowband 2FSK signal. */

    /* TX calibration */
    if (LMS_Calibrate(dev, LMS_CH_TX, 0, 2.5e6, 0) != LMS_SUCCESS) {
        fprintf(stderr, "[lime-tx] Warning: TX calibration failed (may still work)\n");
    }

    /* Setup TX stream (NOT started — will be activated per-burst) */
    lms_stream_t *tx_stream = (lms_stream_t *)malloc(sizeof(lms_stream_t));
    if (!tx_stream) {
        fprintf(stderr, "[lime-tx] Error: malloc failed\n");
        LMS_EnableChannel(dev, LMS_CH_TX, 0, false);
        return -1;
    }
    memset(tx_stream, 0, sizeof(*tx_stream));
    tx_stream->isTx = true;
    tx_stream->channel = 0;
    tx_stream->fifoSize = 64 * 1024;
    tx_stream->throughputVsLatency = 0.5f;
    tx_stream->dataFmt = LMS_FMT_F32;

    if (LMS_SetupStream(dev, tx_stream) != LMS_SUCCESS) {
        fprintf(stderr, "[lime-tx] Error: could not setup TX stream\n");
        free(tx_stream);
        LMS_EnableChannel(dev, LMS_CH_TX, 0, false);
        return -1;
    }

    r->lime_tx_stream = tx_stream;
    r->lime_tx_started = 0;

    double actual_freq = 0;
    LMS_GetLOFrequency(dev, LMS_CH_TX, 0, &actual_freq);
    
    /* Disable TX channel immediately after calibration to avoid LO leakage into RX */
    LMS_EnableChannel(dev, LMS_CH_TX, 0, false);

    printf("[lime-tx] TX ready: freq=%.0f Hz, gain=%d dB, fs=%.0f sps\n",
           actual_freq, TX_GAIN_DB, DEFAULT_SAMPLE_RATE_HZ);
    fflush(stdout);
    return 0;
}

int limesdr_tx_burst(rtlsdr_reader_t *r,
                     const float *iq_data, int num_samples) {
    lms_stream_t *stream = (lms_stream_t *)r->lime_tx_stream;
    lms_device_t *dev = (lms_device_t *)r->lime_dev;
    if (!stream || !dev) {
        fprintf(stderr, "[lime-tx] Error: TX stream or device not initialized\n");
        return -1;
    }

    /* ── TX ON: Enable RF channel and start stream ────────────────────── */
    LMS_EnableChannel(dev, LMS_CH_TX, 0, true);

    if (LMS_StartStream(stream) != LMS_SUCCESS) {
        fprintf(stderr, "[lime-tx] Error: could not start TX stream\n");
        LMS_EnableChannel(dev, LMS_CH_TX, 0, false);
        return -1;
    }

    lms_stream_meta_t meta;
    memset(&meta, 0, sizeof(meta));
    meta.waitForTimestamp = false;
    meta.flushPartialPacket = false;

    /* Warmup: feed zeros to prime the FPGA TX pipeline (~16ms).
     * Without this, the first real samples may be lost in pipeline latency. */
    {
        float warmup[8192] = {0};
        meta.flushPartialPacket = true;
        LMS_SendStream(stream, warmup, 4096, &meta, 1000);
        meta.flushPartialPacket = false;
    }

    /* Write the IQ burst data in chunks */
    int offset = 0;
    int chunk_size = 4096;

    while (offset < num_samples) {
        int remaining = num_samples - offset;
        int to_send = (remaining < chunk_size) ? remaining : chunk_size;

        /* iq_data is interleaved: [I0,Q0,I1,Q1,...], pointer offset is *2 */
        int sent = LMS_SendStream(stream, iq_data + offset * 2, to_send,
                                  &meta, 1000);
        if (sent < 0) {
            fprintf(stderr, "[lime-tx] SendStream error at offset %d\n", offset);
            LMS_StopStream(stream);
            return -1;
        }
        offset += sent;
    }

    /* Flush: zero tail with flushPartialPacket=true */
    meta.flushPartialPacket = true;
    float zero_tail[4096] = {0};
    LMS_SendStream(stream, zero_tail, 2048, &meta, 1000);

    /* Wait for FPGA to drain the FIFO and actually transmit all samples.
     * Burst duration = num_samples / sample_rate.
     * With warmup (4096 samples = 16ms) + data (~67ms) + tail (2048 = 8ms),
     * total ~91ms. Add generous margin for USB latency. */
    double burst_ms = (double)(num_samples + 4096 + 2048) / DEFAULT_SAMPLE_RATE_HZ * 1000.0;
    int drain_ms = (int)(burst_ms) + 50;  /* +50ms safety margin */
    sleep_ms(drain_ms);

    /* ── TX OFF: stop stream and disable RF channel to avoid DAC/LO noise leaking into RX ─── */
    LMS_StopStream(stream);
    LMS_EnableChannel(dev, LMS_CH_TX, 0, false);

    printf("[lime-tx] Burst: %d samples (~%.0f ms), drain wait %d ms\n",
           num_samples,
           (double)num_samples / DEFAULT_SAMPLE_RATE_HZ * 1000.0,
           drain_ms);
    fflush(stdout);
    return 0;
}

void limesdr_tx_close(rtlsdr_reader_t *r) {
    lms_device_t *dev = (lms_device_t *)r->lime_dev;
    lms_stream_t *stream = (lms_stream_t *)r->lime_tx_stream;

    if (stream) {
        LMS_StopStream(stream);  /* safe even if not started */
        if (dev) {
            LMS_DestroyStream(dev, stream);
        }
        free(stream);
        r->lime_tx_stream = NULL;
    }

    if (dev) {
        LMS_EnableChannel(dev, LMS_CH_TX, 0, false);
    }

    printf("[lime-tx] TX closed\n");
    fflush(stdout);
}

#else /* !HAS_LIMESDR */

int limesdr_tx_init(rtlsdr_reader_t *r) {
    (void)r;
    fprintf(stderr, "[lime-tx] Error: compiled without LimeSDR support\n");
    return -1;
}

int limesdr_tx_burst(rtlsdr_reader_t *r,
                     const float *iq_data, int num_samples) {
    (void)r; (void)iq_data; (void)num_samples;
    return -1;
}

void limesdr_tx_close(rtlsdr_reader_t *r) { (void)r; }

#endif /* HAS_LIMESDR */
