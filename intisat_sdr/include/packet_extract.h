/*
 * packet_extract.h - Maquina de Estados para Extraccion de Paquetes
 *
 * Flujo:
 *   HUNTING   -> busca sync word continuamente
 *   COLLECTING -> sync encontrado, recolecta payload bits
 *   (cuando completa, emite paquete y vuelve a HUNTING)
 *
 * Tambien acumula potencia IQ para calcular RSSI del paquete.
 */

#ifndef INTISAT_PACKET_EXTRACT_H
#define INTISAT_PACKET_EXTRACT_H

#include "config.h"
#include "sync_detect.h"

/* Callback que se invoca cuando un paquete completo es extraido */
typedef void (*packet_callback_t)(
    const uint8_t *payload,     /* bytes del payload               */
    int            payload_len, /* longitud en bytes               */
    float          rssi_db,     /* RSSI estimado del paquete       */
    float          freq_err_hz, /* error de frecuencia estimado    */
    int            sync_errors, /* distancia hamming del sync      */
    void          *user_data    /* contexto del usuario            */
);

typedef enum {
    PKT_STATE_HUNTING,           /* buscando sync word */
    PKT_STATE_COLLECTING,        /* sync encontrado, recolectando bits (paquete normal) */
    PKT_STATE_STREAM_COLLECTING, /* stream continuo TELEM_DUMP — buffer grande */
} pkt_state_t;

typedef struct {
    pkt_state_t       state;
    sync_detector_t   sync;

    /* Buffer de payload (paquetes normales) */
    uint8_t           payload[256];
    int               bits_collected;
    int               bits_needed;       /* packet_length * 8 (o STREAM_EXPECTED_BYTES*8) */
    int               current_byte;      /* byte parcial acumulandose */
    int               bit_in_byte;       /* 0..7 */

    /* Buffer para stream continuo TELEM_DUMP (malloc en init) */
    uint8_t          *stream_buf;
    uint32_t          stream_pos;        /* bytes escritos en stream_buf */

    /* Sync word errors del ultimo match */
    int               last_sync_errors;

    /* RSSI: potencia promedio de IQ durante el paquete */
    float             power_acc;
    int               power_count;

    /* Error de frecuencia estimado (promedio del FM demod output) */
    float             freq_err_acc;
    int               freq_err_count;

    /* Power gate: EMA of IQ power used to suppress sync detection in noise */
    float             power_ema;          /* exponential moving average of mag² */
    float             power_gate_threshold; /* configurable at runtime         */

    /* Configuracion */
    int               packet_length;     /* bytes del payload esperado */

    /* Burst detector: pointer to burst_detect_t for sync/packet
       notifications.  Set by dsp_pipeline after init.  NULL = disabled. */
    void             *burst_detect;

    /* Channel identity for logging (set by dsp_pipeline) */
    int               ch_id;

    /* Callback */
    packet_callback_t callback;
    void             *callback_data;
} packet_extractor_t;

/* Inicializa el extractor.
   sync_bytes/sync_len: sync word (ej. {0xBA,0x67,0x54,0x7E}, 4)
   packet_length: bytes del payload esperado (ej. 64)
   cb: funcion llamada al completar un paquete
   user_data: contexto pasado al callback */
void pkt_extract_init(packet_extractor_t *pe,
                      const uint8_t *sync_bytes, int sync_len,
                      int packet_length,
                      packet_callback_t cb, void *user_data);

/* Resetea al estado HUNTING. */
void pkt_extract_reset(packet_extractor_t *pe);

/* Empuja un bit demodulado (0 o 1) y un valor soft (para RSSI/freq_err).
   fm_value: salida del discriminador FM para este simbolo */
void pkt_extract_push_bit(packet_extractor_t *pe, int bit, float fm_value);

/* Alimenta potencia IQ instantanea (re^2 + im^2) para calculo de RSSI.
   Se llama por cada sample IQ del canal filtrado, no por cada bit. */
void pkt_extract_feed_power(packet_extractor_t *pe, float iq_power);

#endif /* INTISAT_PACKET_EXTRACT_H */
