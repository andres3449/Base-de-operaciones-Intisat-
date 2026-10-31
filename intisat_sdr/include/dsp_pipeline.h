/*
 * dsp_pipeline.h - Orquestacion del pipeline DSP completo
 *
 * ARQUITECTURA DUAL CORRELATOR:
 *   Dos cadenas independientes (rx_channel_t) procesan el mismo stream FM.
 *   El canal active_rx busca el siguiente preambulo; el otro puede estar
 *   en RECEIVING colectando el paquete actual.
 *   En cuanto un canal entra en RECEIVING, el otro se activa en SQUELCH_OPEN.
 *   Esto elimina el ciclo de reset post-paquete sin cambiar los tiempos del STM32.
 *
 * Flujo compartido hasta FM demod:
 *   250 ksps IQ -> NCO -> FIR+Decim -> AGC -> FM demod
 *                                               |
 *                                    +----------+----------+
 *                                    |                     |
 *                               rx_channel[0]         rx_channel[1]
 *                             burst+clock_rec         burst+clock_rec
 *                              + pkt_extract           + pkt_extract
 *                                    |                     |
 *                                    +----------+----------+
 *                                               |
 *                                          ZMQ PUB "PKT"
 */

#ifndef INTISAT_DSP_PIPELINE_H
#define INTISAT_DSP_PIPELINE_H

#include "config.h"
#include "ring_buffer.h"
#include "nco.h"
#include "fir_filter.h"
#include "fm_demod.h"
#include "clock_recovery.h"
#include "burst_detect.h"
#include "packet_extract.h"
#include "fft_engine.h"

/* Forward declarations */
struct zmq_transport;
typedef struct dsp_pipeline dsp_pipeline_t;

/* DC Blocker state */
typedef struct {
    float prev_in;
    float prev_out;
    float alpha;
} dc_blocker_t;

/* AGC state */
typedef struct {
    float gain;
    float target;
    float attack;
    float decay;
    float max_gain;
} agc_t;

/* ================================================================
 *  PER-CHANNEL RECEIVE STATE
 *
 *  Phase-selection constants (must match values used in dsp_pipeline.c).
 * ================================================================ */

#define PHASE_SEL_SYMBOLS_CH     16
#define PHASE_SEL_BUF_SIZE_CH   280   /* > 16 * 13.02 + margin */
#define PHASE_SEL_CANDIDATES_CH   4
#define PHASE_SEL_EVAL_BITS_CH   16
#define PHASE_SEL_MAX_HAMMING_CH  3

typedef struct rx_channel {
    /* Independent DSP chain */
    burst_detect_t      burst;
    clock_recovery_t    clock_rec;
    packet_extractor_t  pkt_ext;

    /* Per-channel DC tracking */
    dc_blocker_t  dc_block;
    int           use_frozen_dc;
    float         frozen_dc_offset;
    float         phase_dc_sum;

    /* Phase selection state */
    float  phase_buf[PHASE_SEL_BUF_SIZE_CH];
    int    phase_buf_count;
    int    phase_buf_target;
    int    phase_selecting;
    float  initial_seed_mu;

    /* Debug counters */
    int    debug_bit_count;
    int    debug_bits_in_burst;

    /* Identity + back-pointer */
    int             ch_id;
    dsp_pipeline_t *dsp;
} rx_channel_t;

/* ================================================================
 *  PIPELINE STRUCT
 * ================================================================ */

struct dsp_pipeline {
    /* Shared upstream blocks */
    ring_buffer_t        *ring;
    runtime_config_t     *config;
    struct zmq_transport *transport;
    nco_t                 nco;
    fir_filter_t          fir;
    agc_t                 agc;
    fm_demod_t            fm;
    fft_engine_t         *fft;

    /* Dual receiver channels */
    rx_channel_t  ch[2];

    /* Arbitration: index (0 or 1) of the channel that is allowed to
     * transition from SQUELCH_OPEN to PREAMBLE_LOCK and eventually
     * to RECEIVING.  The other channel runs burst power/PQI but cannot
     * acquire a new preamble lock — it stays on standby until this index
     * is switched to it (when the current active channel enters RECEIVING). */
    int  active_rx;

    /* Control */
    int      last_config_gen;

    /* Stats */
    uint64_t total_samples_processed;
    uint32_t total_packets_decoded;
};

void dsp_pipeline_init(dsp_pipeline_t *dsp, ring_buffer_t *ring,
                       runtime_config_t *config,
                       struct zmq_transport *transport);

void dsp_pipeline_destroy(dsp_pipeline_t *dsp);

void *dsp_thread_func(void *arg);

#endif /* INTISAT_DSP_PIPELINE_H */
