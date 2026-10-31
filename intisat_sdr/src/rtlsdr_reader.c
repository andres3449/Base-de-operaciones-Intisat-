/*
 * rtlsdr_reader.c - Lectura asincrona del RTL-SDR y modo simulado
 *
 * Modo RTL-SDR:
 *   Usa rtlsdr_read_async() que lanza callbacks por cada transferencia USB.
 *   Cada callback recibe ~16384 bytes = 8192 IQ samples.
 *   Los samples se convierten de uint8 -> float normalizado [-1,+1]
 *   y se escriben al ring buffer SPSC.
 *
 * Modo Simulado:
 *   Genera una señal FSK sintetica con los parametros del Si4463.
 *   Util para testear todo el pipeline sin hardware.
 */

#include "rtlsdr_reader.h"
#include "limesdr_reader.h"
#include "platform.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* ================================================================
 *  RTL-SDR (hardware real)
 * ================================================================ */

#ifdef HAS_RTLSDR
#include <rtl-sdr.h>

/* Callback de rtlsdr_read_async: se ejecuta en el contexto del reader thread.
   Convierte uint8 IQ -> float IQ normalizado y escribe al ring buffer. */
static void rtlsdr_callback(unsigned char *buf, uint32_t len, void *ctx) {
    rtlsdr_reader_t *r = (rtlsdr_reader_t *)ctx;

    /* Cada par de bytes es un sample IQ: [I, Q, I, Q, ...]
       RTL-SDR produce unsigned 8-bit: 0..255, centro en 127.5 */
    uint32_t num_samples = len / 2;

    /* Buffer temporal para conversion (en stack, rapido) */
    iq_sample_t temp[8192];

    uint32_t processed = 0;
    while (processed < num_samples) {
        uint32_t chunk = num_samples - processed;
        if (chunk > 8192) chunk = 8192;

        for (uint32_t i = 0; i < chunk; i++) {
            temp[i].re = ((float)buf[(processed + i) * 2]     - 127.5f) / 127.5f;
            temp[i].im = ((float)buf[(processed + i) * 2 + 1] - 127.5f) / 127.5f;
        }

        /* Escribir al ring buffer */
        ring_buf_write(r->ring, temp, chunk);
        processed += chunk;
    }

    atomic_fetch_add(&r->total_samples, num_samples);
}

#endif /* HAS_RTLSDR */

/* ================================================================
 *  INICIALIZACION
 * ================================================================ */

void reader_init(rtlsdr_reader_t *r, ring_buffer_t *ring,
                 runtime_config_t *config, device_type_t dev_type) {
    memset(r, 0, sizeof(*r));
    r->ring = ring;
    r->config = config;
    r->device_type = dev_type;
    r->rtl_dev = NULL;
    r->lime_dev = NULL;
    r->lime_stream = NULL;
    r->should_stop = 0;
    atomic_store(&r->total_samples, 0);
    atomic_store(&r->total_overruns, 0);
}

int reader_open(rtlsdr_reader_t *r) {
    if (r->device_type == DEVICE_SIMULATED) {
        printf("[reader] Modo simulado activado\n");
        return 0;
    }

    if (r->device_type == DEVICE_LIMESDR) {
        return limesdr_open(r);
    }

#ifdef HAS_RTLSDR
    rtlsdr_dev_t *dev = NULL;
    int ret;

    ret = rtlsdr_open(&dev, 0);  /* dispositivo index 0 */
    if (ret < 0) {
        fprintf(stderr, "[reader] Error: no se pudo abrir RTL-SDR (ret=%d)\n", ret);
        return -1;
    }

    /* Configurar sample rate */
    int sample_rate = (int)DEFAULT_SAMPLE_RATE_HZ;
    ret = rtlsdr_set_sample_rate(dev, (uint32_t)sample_rate);
    if (ret < 0) {
        fprintf(stderr, "[reader] Error: sample rate %d no soportado\n", sample_rate);
        rtlsdr_close(dev);
        return -1;
    }

    /* Configurar frecuencia (tune_freq, NO signal_freq - esquivar DC spike) */
    uint32_t tune_freq = (uint32_t)atomic_load(&r->config->tune_freq_hz);
    ret = rtlsdr_set_center_freq(dev, tune_freq);
    if (ret < 0) {
        fprintf(stderr, "[reader] Error: no se pudo setear freq %u Hz\n", tune_freq);
        rtlsdr_close(dev);
        return -1;
    }

    /* Ganancia manual */
    rtlsdr_set_tuner_gain_mode(dev, 1);  /* 1 = manual */
    int gain_tenths = atomic_load(&r->config->rf_gain_tenths);
    rtlsdr_set_tuner_gain(dev, gain_tenths);

    /* AGC off */
    rtlsdr_set_agc_mode(dev, 0);

    /* Reset buffer */
    rtlsdr_reset_buffer(dev);

    r->rtl_dev = dev;
    printf("[reader] RTL-SDR abierto: freq=%u Hz, gain=%.1f dB, fs=%d sps\n",
           tune_freq, gain_tenths / 10.0f, sample_rate);
    return 0;

#else
    fprintf(stderr, "[reader] Error: compilado sin soporte RTL-SDR\n");
    return -1;
#endif
}

void reader_close(rtlsdr_reader_t *r) {
    if (r->device_type == DEVICE_LIMESDR) {
        limesdr_close(r);
        return;
    }
#ifdef HAS_RTLSDR
    if (r->rtl_dev) {
        rtlsdr_close((rtlsdr_dev_t *)r->rtl_dev);
        r->rtl_dev = NULL;
        printf("[reader] RTL-SDR cerrado\n");
    }
#endif
    (void)r;
}

/* ================================================================
 *  THREAD PRINCIPAL
 * ================================================================ */

/* Generador de señal FSK sintetica (para modo simulado) */
static void simulated_reader_loop(rtlsdr_reader_t *r) {
    printf("[reader] Generador FSK simulado corriendo...\n");

    double fs = DEFAULT_SAMPLE_RATE_HZ;
    double fdev = DEFAULT_FREQ_DEVIATION_HZ;
    double symbol_rate = DEFAULT_SYMBOL_RATE_SPS;
    double nco_offset = DEFAULT_NCO_SHIFT_HZ;

    /* Patron de bits conocido: preambulo + sync + payload repetitivo */
    uint8_t test_payload[] = {
        /* Preambulo: 0xAA alternando */
        0xAA, 0xAA, 0xAA, 0xAA,
        /* Sync word: on-air format (5D E6 2A 7E) matching config.h */
        0x5D, 0xE6, 0x2A, 0x7E,
        /* Payload de 64 bytes (patron de test) */
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
        0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
        0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28,
        0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38,
        0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
        0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
        0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
        0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78,
    };
    int total_bits = (int)sizeof(test_payload) * 8;
    int samples_per_symbol = (int)(fs / symbol_rate);

    /* Generar IQ para toda la trama */
    int total_samples = total_bits * samples_per_symbol;
    iq_sample_t *frame = (iq_sample_t *)malloc(total_samples * sizeof(iq_sample_t));
    if (!frame) return;

    double phase = 0.0;
    int sample_idx = 0;

    for (int bit_idx = 0; bit_idx < total_bits; bit_idx++) {
        int byte_pos = bit_idx / 8;
        int bit_pos = 7 - (bit_idx % 8);  /* MSB first */
        int bit = (test_payload[byte_pos] >> bit_pos) & 1;

        /* FSK: bit=1 -> +fdev, bit=0 -> -fdev */
        double freq = (bit ? +fdev : -fdev) + nco_offset;

        for (int s = 0; s < samples_per_symbol && sample_idx < total_samples; s++) {
            frame[sample_idx].re = (float)(0.8 * cos(phase));
            frame[sample_idx].im = (float)(0.8 * sin(phase));
            phase += 2.0 * M_PI * freq / fs;
            if (phase > M_PI) phase -= 2.0 * M_PI;
            sample_idx++;
        }
    }

    /* Loop: enviar la trama repetidamente con ruido */
    int frame_pos = 0;
    iq_sample_t chunk[DSP_CHUNK_SIZE];

    while (!r->should_stop) {
        for (int i = 0; i < DSP_CHUNK_SIZE; i++) {
            chunk[i] = frame[frame_pos];
            /* Agregar ruido blanco gaussiano (aprox con uniform) */
            float noise_re = ((float)rand() / (float)RAND_MAX - 0.5f) * 0.05f;
            float noise_im = ((float)rand() / (float)RAND_MAX - 0.5f) * 0.05f;
            chunk[i].re += noise_re;
            chunk[i].im += noise_im;

            frame_pos = (frame_pos + 1) % total_samples;
        }

        ring_buf_write(r->ring, chunk, DSP_CHUNK_SIZE);
        atomic_fetch_add(&r->total_samples, DSP_CHUNK_SIZE);

        /* Simular timing real: DSP_CHUNK_SIZE samples a 250 ksps */
        int delay_ms = (int)(1000.0 * DSP_CHUNK_SIZE / fs);
        platform_sleep_ms(delay_ms);
    }

    free(frame);
}

void *reader_thread_func(void *arg) {
    rtlsdr_reader_t *r = (rtlsdr_reader_t *)arg;

    /* Elevar prioridad para minimizar latencia USB */
    platform_set_high_priority();

    if (r->device_type == DEVICE_SIMULATED) {
        simulated_reader_loop(r);
        return NULL;
    }

    if (r->device_type == DEVICE_LIMESDR) {
        limesdr_reader_loop(r);
        return NULL;
    }

#ifdef HAS_RTLSDR
    if (!r->rtl_dev) {
        fprintf(stderr, "[reader] Error: dispositivo no abierto\n");
        return NULL;
    }

    printf("[reader] Iniciando lectura asincrona RTL-SDR...\n");

    /* rtlsdr_read_async bloquea hasta que se cancela.
       buf_num=0 = default (15 buffers), buf_len=0 = default (16384 bytes) */
    int ret = rtlsdr_read_async((rtlsdr_dev_t *)r->rtl_dev,
                                 rtlsdr_callback, r,
                                 0, 0);
    if (ret != 0) {
        fprintf(stderr, "[reader] rtlsdr_read_async retorno %d\n", ret);
    }

    printf("[reader] Lectura asincrona finalizada\n");
#endif

    return NULL;
}

void reader_request_stop(rtlsdr_reader_t *r) {
    r->should_stop = 1;

#ifdef HAS_RTLSDR
    if (r->rtl_dev) {
        /* Cancelar la lectura asincrona (safe desde otro thread) */
        rtlsdr_cancel_async((rtlsdr_dev_t *)r->rtl_dev);
    }
#endif
    /* LimeSDR: el loop sale solo cuando should_stop=1, no necesita cancel */
}

int reader_set_frequency(rtlsdr_reader_t *r, uint32_t freq_hz) {
    if (r->lime_dev) {
        return limesdr_set_frequency(r, freq_hz);
    }
#ifdef HAS_RTLSDR
    if (r->rtl_dev) {
        return rtlsdr_set_center_freq((rtlsdr_dev_t *)r->rtl_dev, freq_hz);
    }
#endif
    (void)r; (void)freq_hz;
    return 0;
}

int reader_set_gain(rtlsdr_reader_t *r, int gain_tenths) {
    if (r->lime_dev) {
        return limesdr_set_gain(r, gain_tenths);
    }
#ifdef HAS_RTLSDR
    if (r->rtl_dev) {
        return rtlsdr_set_tuner_gain((rtlsdr_dev_t *)r->rtl_dev, gain_tenths);
    }
#endif
    (void)r; (void)gain_tenths;
    return 0;
}
