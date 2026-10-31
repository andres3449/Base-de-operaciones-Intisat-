/*
 * burst_detect.h - Burst-Mode Signal Detector with Adaptive Noise Floor
 *
 * Implements a 4-state machine for burst packet reception:
 *
 *   IDLE          -> Only noise present.  M&M clock recovery is FROZEN.
 *                    Noise floor EMA updates slowly as reference.
 *   SQUELCH_OPEN  -> Energy detected above noise floor.  PQI correlator
 *                    evaluates whether the signal contains a valid 1010
 *                    preamble pattern.  M&M still frozen.
 *   PREAMBLE_LOCK -> PQI confirmed a preamble.  M&M is RESET and RUNNING
 *                    with high bandwidth for fast convergence.
 *   RECEIVING     -> Sync word found by packet_extract.  M&M tightened
 *                    to low bandwidth for stable payload tracking.
 *
 * The PQI (Preamble Quality Indicator) uses a delay-and-multiply
 * correlator: fm[n] * fm[n - sps].  During 1010 preamble, the FM
 * demod output is a sinewave at symbol_rate/2.  A one-symbol delay
 * aligns the signal with itself, producing a positive product.
 * During noise, the product averages to zero.
 *
 * Zero-crossing tracking provides an initial phase seed for M&M,
 * so it starts near the optimal sampling point from the first symbol.
 */

#ifndef INTISAT_BURST_DETECT_H
#define INTISAT_BURST_DETECT_H

#include "config.h"
#include <math.h>

/* ================================================================
 *  BURST DETECTOR STATES
 * ================================================================ */

typedef enum {
    BURST_IDLE,            /* Noise only, M&M frozen                    */
    BURST_SQUELCH_OPEN,    /* Energy detected, evaluating PQI           */
    BURST_PREAMBLE_LOCK,   /* Preamble confirmed, M&M reset + running   */
    BURST_RECEIVING,       /* Sync found, collecting packet payload     */
} burst_state_t;

/* ================================================================
 *  BURST DETECTOR STATE
 * ================================================================ */

/* Maximum PQI delay buffer size.  Must be > 2 * max(samples_per_symbol).
   The correlator uses a 2-symbol delay so that during 1010 preamble,
   bit[n] and bit[n-2] have the same polarity → positive product.
   For 125 ksps / 9600 baud, 2*sps = 26.04, so 32 is plenty. */
#define BURST_PQI_DELAY_BUF_SIZE  32

typedef struct {
    burst_state_t state;
    burst_state_t prev_state;          /* for transition detection       */

    /* --- Noise floor estimation (SLOW EMA, updates only in IDLE) --- */
    float noise_floor_ema;             /* slow EMA of IQ mag^2           */
    int   noise_floor_primed;          /* 1 after initial convergence    */
    int   noise_warmup_count;          /* samples fed during warmup      */

    /* --- Signal power detection (FAST EMA, updates always) --- */
    float signal_power_ema;            /* fast EMA of IQ mag^2           */

    /* --- Squelch parameters --- */
    float squelch_margin;              /* linear multiplier above noise  */
    int   dropout_counter;             /* consecutive below-threshold    */
    int   dropout_limit;               /* samples to close squelch       */

    /* --- PQI: delay-and-multiply preamble correlator --- */
    float pqi_delay_buf[BURST_PQI_DELAY_BUF_SIZE];
    int   pqi_delay_len;               /* = round(samples_per_symbol)    */
    int   pqi_write_idx;               /* circular buffer write position */
    float pqi_ema;                     /* EMA of correlation product     */
    float pqi_lock_threshold;          /* threshold to declare lock      */
    int   pqi_hold_counter;            /* consecutive above threshold    */
    int   pqi_min_hold;                /* minimum hold (samples)         */

    /* --- Zero-crossing tracker for M&M phase seeding --- */
    float last_zc_mu;                  /* fractional position of last ZC */
    int   samples_since_zc;            /* samples since last ZC          */
    float prev_fm_sample;              /* previous FM sample for ZC det  */

    /* --- Timeouts --- */
    int   samples_in_state;            /* duration in current state      */
    int   preamble_timeout;            /* max samples to find preamble   */

    /* --- Post-burst cooldown (prevents phantom detections) --- */
    int   cooldown_counter;            /* samples remaining in cooldown  */
    int   cooldown_limit;              /* total cooldown duration        */

    /* --- Cached parameters --- */
    float samples_per_symbol;          /* = sample_rate / symbol_rate    */

    /* --- Periodic diagnostic counter --- */
    int   diag_sample_counter;         /* for periodic IDLE power print  */
} burst_detect_t;

/* ================================================================
 *  API
 * ================================================================ */

/* Initialize burst detector with system parameters.
   sample_rate: post-decimation rate (e.g., 125000 Hz)
   symbol_rate: baud rate (e.g., 9600) */
void burst_detect_init(burst_detect_t *bd, float sample_rate, float symbol_rate);

/* Reset burst detector to IDLE state. */
void burst_detect_reset(burst_detect_t *bd);

/* Feed one IQ power sample (mag^2, pre-AGC).
   Called at the post-decimation sample rate.
   Updates noise floor and signal power EMAs.
   Returns the current burst state. */
burst_state_t burst_detect_feed_power(burst_detect_t *bd, float iq_mag_sq);

/* Feed one FM demod sample for PQI evaluation.
   Called at the post-decimation sample rate.
   Performs PQI correlation and zero-crossing tracking.
   Returns the current burst state after possible transitions. */
burst_state_t burst_detect_feed_fm(burst_detect_t *bd, float fm_sample);

/* Notify burst detector that sync word was found.
   Transitions PREAMBLE_LOCK -> RECEIVING. */
void burst_detect_notify_sync(burst_detect_t *bd);

/* Notify burst detector that packet reception is complete.
   Transitions to IDLE or SQUELCH_OPEN (back-to-back). */
void burst_detect_notify_packet_done(burst_detect_t *bd);

/* Query: should clock recovery process this sample?
   Returns 1 if M&M should update, 0 if frozen. */
static inline int burst_detect_clock_enabled(const burst_detect_t *bd) {
    return (bd->state == BURST_PREAMBLE_LOCK || bd->state == BURST_RECEIVING);
}

/* Get the estimated initial phase (mu) for M&M seeding.
   Based on the last zero-crossing position from the preamble.
   Returns a value in [0, 1) suitable for setting clock_rec.mu. */
float burst_detect_get_seed_mu(const burst_detect_t *bd);

#endif /* INTISAT_BURST_DETECT_H */
