/*
 * zmq_transport.c - Transporte ZMQ para comunicacion con Python
 *
 * Dos sockets:
 *   PUB tcp://127.0.0.1:5555 -> Publica FFT, PKT, STATUS, ERROR
 *   REP tcp://127.0.0.1:5556 -> Recibe comandos JSON
 *
 * El PUB usa mensajes multipart: [topic][payload]
 * El REP usa JSON simple para request/response.
 *
 * Thread-safety: el PUB socket se comparte entre DSP y FFT threads.
 * ZMQ sockets NO son thread-safe, asi que usamos un mutex para el PUB.
 * El REP socket solo lo usa el command thread.
 */

#include "zmq_transport.h"
#include "rtlsdr_reader.h"
#include "limesdr_tx.h"
#include "platform.h"
#include "cJSON.h"
#include <zmq.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Mutex para proteger el PUB socket (compartido entre threads) */
static mutex_t pub_mutex;

int zmq_transport_init(zmq_transport_t *t) {
    memset(t, 0, sizeof(*t));

    platform_mutex_init(&pub_mutex);

    /* Crear contexto ZMQ */
    t->zmq_ctx = zmq_ctx_new();
    if (!t->zmq_ctx) {
        fprintf(stderr, "[zmq] Error: no se pudo crear contexto ZMQ\n");
        return -1;
    }

    /* Socket PUB para publicar datos */
    t->pub_socket = zmq_socket(t->zmq_ctx, ZMQ_PUB);
    if (!t->pub_socket) {
        fprintf(stderr, "[zmq] Error: no se pudo crear socket PUB\n");
        return -1;
    }

    /* High water mark: si Python no consume, descartamos frames viejos.
       Aumentamos a 10000 para evitar perder paquetes de datos vitales
       cuando la GUI de Python esta ocupada decodificando y renderizando JPEGs. */
    int hwm = 10000;
    zmq_setsockopt(t->pub_socket, ZMQ_SNDHWM, &hwm, sizeof(hwm));

    if (zmq_bind(t->pub_socket, ZMQ_PUB_ENDPOINT) != 0) {
        fprintf(stderr, "[zmq] Error: no se pudo bindear PUB a %s\n", ZMQ_PUB_ENDPOINT);
        return -1;
    }

    /* Socket REP para recibir comandos */
    t->rep_socket = zmq_socket(t->zmq_ctx, ZMQ_REP);
    if (!t->rep_socket) {
        fprintf(stderr, "[zmq] Error: no se pudo crear socket REP\n");
        return -1;
    }

    if (zmq_bind(t->rep_socket, ZMQ_REP_ENDPOINT) != 0) {
        fprintf(stderr, "[zmq] Error: no se pudo bindear REP a %s\n", ZMQ_REP_ENDPOINT);
        return -1;
    }

    printf("[zmq] PUB en %s, REP en %s\n", ZMQ_PUB_ENDPOINT, ZMQ_REP_ENDPOINT);
    return 0;
}

void zmq_transport_destroy(zmq_transport_t *t) {
    if (t->pub_socket) { zmq_close(t->pub_socket); t->pub_socket = NULL; }
    if (t->rep_socket) { zmq_close(t->rep_socket); t->rep_socket = NULL; }
    if (t->zmq_ctx) {
        zmq_ctx_shutdown(t->zmq_ctx);
        zmq_ctx_term(t->zmq_ctx);
        t->zmq_ctx = NULL;
    }
    platform_mutex_destroy(&pub_mutex);
}

/* ================================================================
 *  PUBLICACION DE DATOS
 * ================================================================ */

int zmq_publish_fft(zmq_transport_t *t,
                    const float *power_dbfs, int fft_size,
                    float center_freq_hz, float sample_rate_hz) {
    if (!t->pub_socket) return -1;

    /* Construir header */
    fft_msg_header_t hdr;
    hdr.fft_size = (uint32_t)fft_size;
    hdr.center_freq_hz = center_freq_hz;
    hdr.sample_rate_hz = sample_rate_hz;
    hdr.timestamp_us = platform_timestamp_us();

    /* Payload: header + floats */
    size_t payload_size = sizeof(hdr) + (size_t)fft_size * sizeof(float);
    uint8_t *payload = (uint8_t *)malloc(payload_size);
    if (!payload) return -1;

    memcpy(payload, &hdr, sizeof(hdr));
    memcpy(payload + sizeof(hdr), power_dbfs, (size_t)fft_size * sizeof(float));

    /* Enviar multipart: [topic][payload] */
    platform_mutex_lock(&pub_mutex);
    zmq_send(t->pub_socket, "FFT", 3, ZMQ_SNDMORE | ZMQ_DONTWAIT);
    zmq_send(t->pub_socket, payload, payload_size, ZMQ_DONTWAIT);
    platform_mutex_unlock(&pub_mutex);

    free(payload);
    return 0;
}

int zmq_publish_packet(zmq_transport_t *t,
                       const uint8_t *payload, int payload_len,
                       float rssi_db, float freq_err_hz,
                       int sync_found, int bit_errors,
                       float power_ema) {
    if (!t->pub_socket) return -1;

    /* Construir header */
    pkt_msg_header_t hdr;
    hdr.rssi_db = rssi_db;
    hdr.freq_error_hz = freq_err_hz;
    hdr.timestamp_us = platform_timestamp_us();
    hdr.payload_len = (uint16_t)payload_len;
    hdr.sync_found = (uint8_t)(sync_found & 0xFF);  /* 0=no sync, 1=packet, 2=stream */
    hdr.bit_errors = (uint8_t)bit_errors;
    hdr.power_ema = power_ema;

    /* Payload del mensaje: header + payload bytes */
    size_t msg_size = sizeof(hdr) + (size_t)payload_len;
    uint8_t *msg = (uint8_t *)malloc(msg_size);
    if (!msg) return -1;

    memcpy(msg, &hdr, sizeof(hdr));
    memcpy(msg + sizeof(hdr), payload, (size_t)payload_len);

    platform_mutex_lock(&pub_mutex);
    zmq_send(t->pub_socket, "PKT", 3, ZMQ_SNDMORE | ZMQ_DONTWAIT);
    zmq_send(t->pub_socket, msg, msg_size, ZMQ_DONTWAIT);
    platform_mutex_unlock(&pub_mutex);

    free(msg);
    return 0;
}

int zmq_publish_status(zmq_transport_t *t, int running,
                       uint32_t packets_decoded, uint32_t overruns,
                       float ring_fill_pct) {
    if (!t->pub_socket) return -1;

    cJSON *json = cJSON_CreateObject();
    cJSON_AddBoolToObject(json, "running", running);
    cJSON_AddNumberToObject(json, "packets_decoded", packets_decoded);
    cJSON_AddNumberToObject(json, "overruns", overruns);
    cJSON_AddNumberToObject(json, "ring_fill_pct", ring_fill_pct);

    char *str = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);

    platform_mutex_lock(&pub_mutex);
    zmq_send(t->pub_socket, "STS", 3, ZMQ_SNDMORE | ZMQ_DONTWAIT);
    zmq_send(t->pub_socket, str, strlen(str), ZMQ_DONTWAIT);
    platform_mutex_unlock(&pub_mutex);

    free(str);
    return 0;
}

int zmq_publish_error(zmq_transport_t *t, const char *error_msg) {
    if (!t->pub_socket) return -1;

    platform_mutex_lock(&pub_mutex);
    zmq_send(t->pub_socket, "ERR", 3, ZMQ_SNDMORE | ZMQ_DONTWAIT);
    zmq_send(t->pub_socket, error_msg, strlen(error_msg), ZMQ_DONTWAIT);
    platform_mutex_unlock(&pub_mutex);
    return 0;
}

/* ================================================================
 *  COMMAND THREAD  (procesa comandos de Python)
 * ================================================================ */

/* Helper: responder al REQ con un JSON */
static void reply_ok(void *rep_socket) {
    const char *resp = "{\"status\":\"ok\"}";
    zmq_send(rep_socket, resp, strlen(resp), 0);
}

static void reply_error(void *rep_socket, const char *msg) {
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "status", "error");
    cJSON_AddStringToObject(json, "msg", msg);
    char *str = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    zmq_send(rep_socket, str, strlen(str), 0);
    free(str);
}

/* Helper: parsear config JSON y aplicar a runtime_config */
static void apply_config_json(cJSON *cfg, runtime_config_t *config,
                              rtlsdr_reader_t *reader) {
    cJSON *item;

    item = cJSON_GetObjectItem(cfg, "center_freq_hz");
    if (item && cJSON_IsNumber(item)) {
        /* La GUI envia la freq de la señal. Calculamos tune + NCO offset
           segun el tipo de dispositivo. */
        double signal_freq = item->valuedouble;
        double nco_shift;
        if (reader && reader->device_type == DEVICE_LIMESDR) {
            nco_shift = 0.0;  /* LimeSDR: sin offset, sintoniza directo */
        } else {
            nco_shift = DEFAULT_NCO_SHIFT_HZ;  /* RTL-SDR: 75 kHz offset */
        }
        double tune_freq = signal_freq - nco_shift;
        atomic_store(&config->tune_freq_hz, (int)tune_freq);
        atomic_store(&config->nco_shift_hz, (int)nco_shift);
    }

    item = cJSON_GetObjectItem(cfg, "rf_gain_db");
    if (item && cJSON_IsNumber(item)) {
        int gain_tenths = (int)(item->valuedouble * 10.0);
        atomic_store(&config->rf_gain_tenths, gain_tenths);
        /* Apply immediately to hardware — without this the LimeSDR ignores
           the gain sent by Python on START/UPDATE_CONFIG and uses the default. */
        if (reader) {
            reader_set_gain(reader, gain_tenths);
            printf("[cmd] apply_config: ganancia aplicada al hardware: %.1f dB\n",
                   item->valuedouble);
            fflush(stdout);
        }
    }

    item = cJSON_GetObjectItem(cfg, "symbol_rate_sps");
    if (item && cJSON_IsNumber(item))
        atomic_store(&config->symbol_rate_sps, (int)item->valuedouble);

    item = cJSON_GetObjectItem(cfg, "freq_deviation_hz");
    if (item && cJSON_IsNumber(item))
        atomic_store(&config->freq_deviation_hz, (int)item->valuedouble);

    item = cJSON_GetObjectItem(cfg, "rx_bandwidth_hz");
    if (item && cJSON_IsNumber(item))
        atomic_store(&config->rx_bandwidth_hz, (int)item->valuedouble);

    item = cJSON_GetObjectItem(cfg, "packet_length");
    if (item && cJSON_IsNumber(item))
        atomic_store(&config->packet_length, (int)item->valuedouble);

    item = cJSON_GetObjectItem(cfg, "modulation_type");
    if (item && cJSON_IsString(item)) {
        if (strcmp(item->valuestring, "2FSK") == 0)
            atomic_store(&config->modulation_type, MOD_2FSK);
        else if (strcmp(item->valuestring, "2GFSK") == 0)
            atomic_store(&config->modulation_type, MOD_2GFSK);
        else if (strcmp(item->valuestring, "4FSK") == 0)
            atomic_store(&config->modulation_type, MOD_4FSK);
        else if (strcmp(item->valuestring, "4GFSK") == 0)
            atomic_store(&config->modulation_type, MOD_4GFSK);
    }

    item = cJSON_GetObjectItem(cfg, "sync_word");
    if (item && cJSON_IsArray(item)) {
        int len = cJSON_GetArraySize(item);
        if (len > 0 && len <= 4) {
            for (int i = 0; i < len; i++) {
                cJSON *byte_item = cJSON_GetArrayItem(item, i);
                if (byte_item && cJSON_IsNumber(byte_item))
                    config->sync_word[i] = (uint8_t)byte_item->valueint;
            }
            config->sync_word_len = len;
        }
    }

    item = cJSON_GetObjectItem(cfg, "sync_power_gate");
    if (item && cJSON_IsNumber(item)) {
        int tenths = (int)(item->valuedouble * 10000.0);
        atomic_store(&config->sync_power_gate_tenths, tenths);
    }

    /* Incrementar generacion para que el DSP thread detecte el cambio */
    atomic_fetch_add(&config->generation, 1);
}

void *cmd_thread_func(void *arg) {
    cmd_thread_ctx_t *ctx = (cmd_thread_ctx_t *)arg;
    char buf[4096];

    printf("[cmd] Thread de comandos iniciado\n");

    while (!(*ctx->quit_flag)) {
        /* Recibir comando con timeout para poder checkear quit_flag */
        zmq_pollitem_t poll_item = { ctx->transport->rep_socket, 0, ZMQ_POLLIN, 0 };
        int rc = zmq_poll(&poll_item, 1, 500);  /* 500ms timeout */

        if (rc <= 0) continue;  /* timeout o error */
        if (!(poll_item.revents & ZMQ_POLLIN)) continue;

        int nbytes = zmq_recv(ctx->transport->rep_socket, buf, sizeof(buf) - 1, 0);
        if (nbytes <= 0) continue;
        buf[nbytes] = '\0';

        /* Parsear JSON */
        cJSON *json = cJSON_Parse(buf);
        if (!json) {
            reply_error(ctx->transport->rep_socket, "invalid JSON");
            continue;
        }

        cJSON *cmd = cJSON_GetObjectItem(json, "cmd");
        if (!cmd || !cJSON_IsString(cmd)) {
            reply_error(ctx->transport->rep_socket, "missing 'cmd' field");
            cJSON_Delete(json);
            continue;
        }

        const char *cmd_str = cmd->valuestring;

        if (strcmp(cmd_str, "START") == 0) {
            /* Aplicar config si viene incluida */
            cJSON *cfg = cJSON_GetObjectItem(json, "config");
            if (cfg) apply_config_json(cfg, ctx->config, (rtlsdr_reader_t *)ctx->reader);
            atomic_store(&ctx->config->running, 1);
            printf("[cmd] START recibido\n");
            reply_ok(ctx->transport->rep_socket);
        }
        else if (strcmp(cmd_str, "STOP") == 0) {
            atomic_store(&ctx->config->running, 0);
            printf("[cmd] STOP recibido\n");
            reply_ok(ctx->transport->rep_socket);
        }
        else if (strcmp(cmd_str, "SET_FREQ") == 0) {
            cJSON *val = cJSON_GetObjectItem(json, "value");
            if (val && cJSON_IsNumber(val)) {
                double signal_freq = val->valuedouble;
                rtlsdr_reader_t *reader = (rtlsdr_reader_t *)ctx->reader;

                double tune_freq, nco_shift;
                if (reader && reader->device_type == DEVICE_LIMESDR) {
                    /* LimeSDR: sintonizar directo, sin NCO offset */
                    tune_freq = signal_freq;
                    nco_shift = 0.0;
                } else {
                    /* RTL-SDR: 75 kHz offset (esquivar DC spike del R820T) */
                    nco_shift = DEFAULT_NCO_SHIFT_HZ;
                    tune_freq = signal_freq - nco_shift;
                }

                atomic_store(&ctx->config->tune_freq_hz, (int)tune_freq);
                atomic_store(&ctx->config->nco_shift_hz, (int)nco_shift);
                atomic_fetch_add(&ctx->config->generation, 1);

                if (reader) {
                    reader_set_frequency(reader, (uint32_t)tune_freq);
                }
                printf("[cmd] SET_FREQ a %.0f Hz (tune=%.0f, nco=%.0f)\n",
                       signal_freq, tune_freq, nco_shift);
            }
            reply_ok(ctx->transport->rep_socket);
        }
        else if (strcmp(cmd_str, "SET_GAIN") == 0) {
            cJSON *val = cJSON_GetObjectItem(json, "value");
            if (val && cJSON_IsNumber(val)) {
                int gain_tenths = (int)(val->valuedouble * 10.0);
                atomic_store(&ctx->config->rf_gain_tenths, gain_tenths);
                atomic_fetch_add(&ctx->config->generation, 1);

                /* Cambiar ganancia del hardware directamente */
                rtlsdr_reader_t *reader = (rtlsdr_reader_t *)ctx->reader;
                if (reader) {
                    reader_set_gain(reader, gain_tenths);
                }
                printf("[cmd] SET_GAIN a %.1f dB\n", val->valuedouble);
            }
            reply_ok(ctx->transport->rep_socket);
        }
        else if (strcmp(cmd_str, "SET_POWER_GATE") == 0) {
            cJSON *val = cJSON_GetObjectItem(json, "value");
            if (val && cJSON_IsNumber(val)) {
                int tenths = (int)(val->valuedouble * 10000.0);
                atomic_store(&ctx->config->sync_power_gate_tenths, tenths);
                atomic_fetch_add(&ctx->config->generation, 1);
                printf("[cmd] SET_POWER_GATE a %g\n", val->valuedouble);
            }
            reply_ok(ctx->transport->rep_socket);
        }
        else if (strcmp(cmd_str, "UPDATE_CONFIG") == 0) {
            cJSON *cfg = cJSON_GetObjectItem(json, "config");
            if (cfg) apply_config_json(cfg, ctx->config, (rtlsdr_reader_t *)ctx->reader);
            printf("[cmd] UPDATE_CONFIG recibido\n");
            reply_ok(ctx->transport->rep_socket);
        }
        else if (strcmp(cmd_str, "QUIT") == 0) {
            printf("[cmd] QUIT recibido, cerrando...\n");
            atomic_store(&ctx->config->running, 0);
            *ctx->quit_flag = 1;
            reply_ok(ctx->transport->rep_socket);
        }
        else if (strcmp(cmd_str, "TX_BURST") == 0) {
            /* TX_BURST: multipart message [JSON header] [binary IQ data]
             * Header: {"cmd":"TX_BURST", "samples": N}
             * Frame 2: float32 interleaved IQ, N*2 floats */
            cJSON *samples_item = cJSON_GetObjectItem(json, "samples");
            int num_samples = samples_item ? samples_item->valueint : 0;

            /* Check if there's a second frame (RCVMORE) */
            int more = 0;
            size_t more_size = sizeof(more);
            zmq_getsockopt(ctx->transport->rep_socket, ZMQ_RCVMORE, &more, &more_size);

            if (!more || num_samples <= 0) {
                reply_error(ctx->transport->rep_socket,
                            "TX_BURST: missing IQ data or invalid sample count");
                cJSON_Delete(json);
                continue;
            }

            /* Receive binary IQ data (second ZMQ frame) */
            size_t iq_bytes = (size_t)num_samples * 2 * sizeof(float);
            float *iq_data = (float *)malloc(iq_bytes);
            if (!iq_data) {
                /* Must still recv the frame to keep REQ/REP in sync */
                zmq_msg_t discard;
                zmq_msg_init(&discard);
                zmq_msg_recv(&discard, ctx->transport->rep_socket, 0);
                zmq_msg_close(&discard);
                reply_error(ctx->transport->rep_socket, "TX_BURST: malloc failed");
                cJSON_Delete(json);
                continue;
            }

            int iq_recv = zmq_recv(ctx->transport->rep_socket, iq_data,
                                   iq_bytes, 0);
            if (iq_recv <= 0) {
                free(iq_data);
                reply_error(ctx->transport->rep_socket, "TX_BURST: failed to recv IQ data");
                cJSON_Delete(json);
                continue;
            }

            /* Verify received size matches expected */
            if ((size_t)iq_recv != iq_bytes) {
                printf("[cmd] TX_BURST: expected %zu bytes, got %d\n", iq_bytes, iq_recv);
            }

            rtlsdr_reader_t *reader = (rtlsdr_reader_t *)ctx->reader;
            if (!reader || reader->device_type != DEVICE_LIMESDR) {
                free(iq_data);
                reply_error(ctx->transport->rep_socket,
                            "TX_BURST: only supported on LimeSDR");
                cJSON_Delete(json);
                continue;
            }

            /* Signal RX to pause, transmit, then resume */
            atomic_store(&ctx->config->tx_active, 1);
            platform_sleep_ms(10);  /* give RX loop time to see the flag */

            int tx_rc = limesdr_tx_burst(reader, iq_data, num_samples);

            atomic_store(&ctx->config->tx_active, 0);
            free(iq_data);

            if (tx_rc == 0) {
                printf("[cmd] TX_BURST: %d samples transmitted OK\n", num_samples);
                reply_ok(ctx->transport->rep_socket);
            } else {
                reply_error(ctx->transport->rep_socket, "TX_BURST: transmission failed");
            }
        }
        else {
            char err[128];
            snprintf(err, sizeof(err), "unknown command: %s", cmd_str);
            reply_error(ctx->transport->rep_socket, err);
        }

        cJSON_Delete(json);
    }

    printf("[cmd] Thread de comandos finalizado\n");
    return NULL;
}
