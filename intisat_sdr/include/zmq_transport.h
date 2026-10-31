/*
 * zmq_transport.h - Transporte ZMQ para comunicacion con Python
 *
 * Dos sockets:
 *   PUB (tcp://127.0.0.1:5555) - Publica datos hacia Python:
 *     Topic "FFT" -> espectro de potencia
 *     Topic "PKT" -> paquetes decodificados
 *     Topic "STS" -> status periodico
 *     Topic "ERR" -> mensajes de error
 *
 *   REP (tcp://127.0.0.1:5556) - Recibe comandos de Python:
 *     START, STOP, SET_FREQ, SET_GAIN, UPDATE_CONFIG, QUIT
 */

#ifndef INTISAT_ZMQ_TRANSPORT_H
#define INTISAT_ZMQ_TRANSPORT_H

#include "config.h"

/* Forward declarations */
struct rtlsdr_reader_t_tag;

typedef struct zmq_transport {
    void *zmq_ctx;        /* contexto ZMQ                        */
    void *pub_socket;     /* PUB para FFT/PKT/STATUS/ERROR       */
    void *rep_socket;     /* REP para comandos                   */
} zmq_transport_t;

/* Crea el transporte ZMQ y bindea los sockets.
   Retorna 0 en exito, -1 si falla. */
int zmq_transport_init(zmq_transport_t *t);

/* Cierra sockets y destruye contexto. */
void zmq_transport_destroy(zmq_transport_t *t);

/* ---- Publicacion de datos (llamadas desde DSP/FFT threads) ---- */

/* Publica un frame FFT. power_dbfs es un array de fft_size floats. */
int zmq_publish_fft(zmq_transport_t *t,
                    const float *power_dbfs, int fft_size,
                    float center_freq_hz, float sample_rate_hz);

/* Publica un paquete decodificado. */
int zmq_publish_packet(zmq_transport_t *t,
                       const uint8_t *payload, int payload_len,
                       float rssi_db, float freq_err_hz,
                       int sync_found, int bit_errors,
                       float power_ema);

/* Publica un mensaje de status (JSON). */
int zmq_publish_status(zmq_transport_t *t, int running,
                       uint32_t packets_decoded, uint32_t overruns,
                       float ring_fill_pct);

/* Publica un error. */
int zmq_publish_error(zmq_transport_t *t, const char *error_msg);

/* ---- Comando handler (corre en su propio thread) ---- */

/* Contexto para el command thread */
typedef struct {
    zmq_transport_t  *transport;
    runtime_config_t *config;
    void             *reader;   /* rtlsdr_reader_t* - para SET_FREQ/GAIN */
    int              *quit_flag;
} cmd_thread_ctx_t;

/* Funcion del thread de comandos (bloquea en zmq_recv). */
void *cmd_thread_func(void *arg);

#endif /* INTISAT_ZMQ_TRANSPORT_H */
