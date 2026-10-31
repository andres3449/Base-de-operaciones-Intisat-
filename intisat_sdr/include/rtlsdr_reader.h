/*
 * rtlsdr_reader.h - Lectura asincrona de RTL-SDR via librtlsdr
 *
 * Corre en su propio thread de alta prioridad.
 * Usa rtlsdr_read_async() que invoca callbacks por cada transferencia USB.
 * Los callbacks convierten uint8 IQ -> float IQ normalizado y escriben
 * al ring buffer SPSC.
 *
 * Tambien soporta un modo "simulado" que genera señales FSK sinteticas
 * para testing sin hardware.
 */

#ifndef INTISAT_RTLSDR_READER_H
#define INTISAT_RTLSDR_READER_H

#include "config.h"
#include "ring_buffer.h"

/* Tipo de dispositivo */
typedef enum {
    DEVICE_RTLSDR    = 0,
    DEVICE_SIMULATED = 1,
    DEVICE_LIMESDR   = 2,
} device_type_t;

/* Estado del reader */
typedef struct {
    ring_buffer_t    *ring;            /* ring buffer compartido con DSP */
    runtime_config_t *config;          /* config runtime compartida       */
    device_type_t     device_type;
    void             *rtl_dev;         /* handle rtlsdr_dev_t*            */
    void             *lime_dev;        /* handle lms_device_t*            */
    void             *lime_stream;     /* lms_stream_t* RX (heap-alloc)   */
    void             *lime_tx_stream;  /* lms_stream_t* TX (heap-alloc)   */
    int               lime_tx_started; /* TX stream active flag           */
    int               should_stop;     /* flag para parar el thread       */

    /* Estadisticas */
    atomic_uint       total_samples;
    atomic_uint       total_overruns;
} rtlsdr_reader_t;

/* Inicializa el reader (no abre el dispositivo todavia). */
void reader_init(rtlsdr_reader_t *r, ring_buffer_t *ring,
                 runtime_config_t *config, device_type_t dev_type);

/* Abre el dispositivo y configura frecuencia/ganancia/sample_rate.
   Retorna 0 en exito, -1 en error. */
int reader_open(rtlsdr_reader_t *r);

/* Cierra el dispositivo. */
void reader_close(rtlsdr_reader_t *r);

/* Funcion del thread: arranca lectura asincrona (bloquea hasta stop). */
void *reader_thread_func(void *arg);

/* Señaliza al reader que pare (desde otro thread). */
void reader_request_stop(rtlsdr_reader_t *r);

/* Cambia frecuencia del hardware en caliente. Thread-safe. */
int reader_set_frequency(rtlsdr_reader_t *r, uint32_t freq_hz);

/* Cambia ganancia del hardware en caliente. Thread-safe. */
int reader_set_gain(rtlsdr_reader_t *r, int gain_tenths);

#endif /* INTISAT_RTLSDR_READER_H */
