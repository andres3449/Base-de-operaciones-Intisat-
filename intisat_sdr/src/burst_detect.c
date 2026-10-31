/*
 * burst_detect.c - Burst-Mode Signal Detector with Adaptive Noise Floor
 *
 * State machine for burst packet reception in a satellite ground station.
 * Solves the fundamental problem of Mueller-Muller clock recovery drifting
 * on noise between signal bursts.
 *
 * Processing flow (all at post-decimation sample rate, e.g., 125 ksps):
 *
 *   1. feed_power() - updates noise floor (IDLE only) and signal EMA
 *      (always).  Triggers IDLE -> SQUELCH_OPEN when energy exceeds
 *      the adaptive threshold.
 *
 *   2. feed_fm() - runs the PQI delay-and-multiply correlator and
 *      zero-crossing tracker.  Triggers SQUELCH_OPEN -> PREAMBLE_LOCK
 *      when the preamble pattern is confirmed.
 *
 *   3. notify_sync() - called by packet_extract when sync word found.
 *      Triggers PREAMBLE_LOCK -> RECEIVING.
 *
 *   4. notify_packet_done() - called after packet extraction completes.
 *      Returns to IDLE (if power dropped) or SQUELCH_OPEN (back-to-back).
 *
 * The caller (dsp_pipeline) uses burst_detect_clock_enabled() to gate
 * the M&M clock recovery: samples are only fed to M&M in PREAMBLE_LOCK
 * and RECEIVING states.
 */

#include "burst_detect.h"
#include <string.h>
#include <stdio.h>
#include <math.h>

/* ================================================================
 *  INITIALIZATION
 * ================================================================ */

void burst_detect_init(burst_detect_t *bd, float sample_rate, float symbol_rate) {
    memset(bd, 0, sizeof(*bd));

    bd->state = BURST_IDLE;
    bd->diag_sample_counter = 0;  /* for periodic power diagnostic */
    bd->prev_state = BURST_IDLE;
    bd->samples_per_symbol = sample_rate / symbol_rate;

    /* Noise floor: start at a reasonable estimate for LimeSDR at 433 MHz.
       The measured background at 20 dB gain is ~1.7e-7. Starting close to
       this prevents the warmup period from producing a grossly inflated
       threshold that misses beacons in the first few seconds. */
    bd->noise_floor_ema = 1e-7f;
    bd->noise_floor_primed = 0;
    bd->noise_warmup_count = 0;

    bd->signal_power_ema = 0.0f;

    /* Squelch */
    bd->squelch_margin = BURST_SQUELCH_MARGIN;
    bd->dropout_counter = 0;
    bd->dropout_limit = (int)(sample_rate * BURST_DROPOUT_MS / 1000.0f);

    /* PQI delay-and-multiply.
       Use 2-symbol delay: during 1010 preamble, bit[n] and bit[n-2]
       have the SAME polarity, so the product is positive.
       With 1-symbol delay, consecutive bits have OPPOSITE polarity
       → product is negative → PQI would never lock correctly. */
    bd->pqi_delay_len = (int)(2.0f * bd->samples_per_symbol + 0.5f);
    if (bd->pqi_delay_len >= BURST_PQI_DELAY_BUF_SIZE)
        bd->pqi_delay_len = BURST_PQI_DELAY_BUF_SIZE - 1;
    if (bd->pqi_delay_len < 1)
        bd->pqi_delay_len = 1;
    bd->pqi_write_idx = 0;
    bd->pqi_ema = 0.0f;
    bd->pqi_lock_threshold = BURST_PQI_LOCK_THRESHOLD;
    bd->pqi_hold_counter = 0;
    bd->pqi_min_hold = (int)(BURST_PQI_MIN_SYMBOLS * bd->samples_per_symbol);

    /* Zero-crossing tracker */
    bd->prev_fm_sample = 0.0f;
    bd->last_zc_mu = 0.0f;
    bd->samples_since_zc = 0;

    /* Timeouts: allow 2x preamble length to find preamble + sync */
    bd->samples_in_state = 0;
    bd->preamble_timeout = (int)(256.0f * bd->samples_per_symbol);

    /* Post-burst cooldown: ~5ms at post-decimation rate.
       Prevents phantom burst detections on signal tail energy. */
    bd->cooldown_counter = 0;
    bd->cooldown_limit = (int)(sample_rate * 5.0f / 1000.0f);

    printf("[burst] Init: sps=%.2f, pqi_delay=%d, dropout_limit=%d, preamble_timeout=%d\n",
           bd->samples_per_symbol, bd->pqi_delay_len,
           bd->dropout_limit, bd->preamble_timeout);
}

void burst_detect_reset(burst_detect_t *bd) {
    bd->state = BURST_IDLE;
    bd->prev_state = BURST_IDLE;
    bd->signal_power_ema = 0.0f;
    bd->pqi_ema = 0.0f;
    bd->pqi_hold_counter = 0;
    bd->pqi_write_idx = 0;
    bd->dropout_counter = 0;
    bd->samples_in_state = 0;
    bd->prev_fm_sample = 0.0f;
    bd->samples_since_zc = 0;
    bd->cooldown_counter = 0;
    memset(bd->pqi_delay_buf, 0, sizeof(bd->pqi_delay_buf));
}

/* ================================================================
 *  INTERNAL: state name for debug prints
 * ================================================================ */

static const char *state_name(burst_state_t s) {
    switch (s) {
    case BURST_IDLE:          return "IDLE";
    case BURST_SQUELCH_OPEN:  return "SQUELCH_OPEN";
    case BURST_PREAMBLE_LOCK: return "PREAMBLE_LOCK";
    case BURST_RECEIVING:     return "RECEIVING";
    default:                  return "?";
    }
}

/* ================================================================
 *  POWER FEED — noise floor + squelch
 * ================================================================ */

burst_state_t burst_detect_feed_power(burst_detect_t *bd, float iq_mag_sq) {
    /* Always update fast signal power EMA */
    bd->signal_power_ema = BURST_SIGNAL_EMA_ALPHA * iq_mag_sq
                         + (1.0f - BURST_SIGNAL_EMA_ALPHA) * bd->signal_power_ema;

    /* Update noise floor ONLY in IDLE state */
    if (bd->state == BURST_IDLE) {
        if (!bd->noise_floor_primed) {
            /* Warmup: faster alpha for initial convergence (~100ms) */
            float alpha = 0.01f;
            bd->noise_floor_ema = alpha * iq_mag_sq
                                + (1.0f - alpha) * bd->noise_floor_ema;
            bd->noise_warmup_count++;
            if (bd->noise_warmup_count > 12500) {
                bd->noise_floor_primed = 1;
                printf("[burst] Noise floor converged: %.2e\n", bd->noise_floor_ema);
                fflush(stdout);
            }
        } else {
            bd->noise_floor_ema = BURST_NOISE_EMA_ALPHA * iq_mag_sq
                                + (1.0f - BURST_NOISE_EMA_ALPHA) * bd->noise_floor_ema;
        }
    }

    /* Compute adaptive threshold */
    float threshold = bd->noise_floor_ema * bd->squelch_margin;

    /* --- State-dependent squelch logic --- */

    /* ---- PERIODIC DIAGNOSTIC (every ~2s while IDLE) ---- */
    if (bd->state == BURST_IDLE && bd->noise_floor_primed) {
        bd->diag_sample_counter++;
        /* 125000 sps decimated * 2s = 250000 samples */
        if (bd->diag_sample_counter >= 250000) {
            float ratio = (bd->noise_floor_ema > 0.0f)
                          ? (bd->signal_power_ema / bd->noise_floor_ema)
                          : 0.0f;
            printf("[burst] IDLE diag: signal=%.2e, noise=%.2e, threshold=%.2e, ratio=%.1f (need %.1f to open)\n",
                   bd->signal_power_ema, bd->noise_floor_ema, threshold,
                   ratio, bd->squelch_margin);
            fflush(stdout);
            bd->diag_sample_counter = 0;
        }
    } else {
        bd->diag_sample_counter = 0;
    }

    switch (bd->state) {
    case BURST_IDLE:
        /* Decrement cooldown timer (prevents phantom detections after burst) */
        if (bd->cooldown_counter > 0) {
            bd->cooldown_counter--;
            break;
        }
        if (bd->noise_floor_primed && bd->signal_power_ema > threshold) {
            bd->prev_state = bd->state;
            bd->state = BURST_SQUELCH_OPEN;
            bd->samples_in_state = 0;
            bd->pqi_ema = 0.0f;
            bd->pqi_hold_counter = 0;
            bd->dropout_counter = 0;
            /* Clear PQI delay buffer for fresh correlation */
            memset(bd->pqi_delay_buf, 0, sizeof(bd->pqi_delay_buf));
            bd->pqi_write_idx = 0;
            /* Reset ZC tracker so seed_mu uses fresh zero-crossings
               from the actual signal, not stale data from previous burst */
            bd->samples_since_zc = 0;
            bd->last_zc_mu = 0.0f;
            bd->prev_fm_sample = 0.0f;
            printf("[burst] Squelch open: signal=%.2e, noise=%.2e, ratio=%.1fx, threshold=%.2e\n",
                   bd->signal_power_ema, bd->noise_floor_ema,
                   bd->signal_power_ema / (bd->noise_floor_ema + 1e-30f), threshold);
            fflush(stdout);
        }
        break;

    case BURST_SQUELCH_OPEN:
        /* Check for signal dropout */
        if (bd->signal_power_ema < threshold) {
            bd->dropout_counter++;
            if (bd->dropout_counter >= bd->dropout_limit) {
                bd->prev_state = bd->state;
                bd->state = BURST_IDLE;
                bd->samples_in_state = 0;
                printf("[burst] Squelch closed (dropout)\n");
                fflush(stdout);
            }
        } else {
            bd->dropout_counter = 0;
        }
        break;

    case BURST_PREAMBLE_LOCK:
        /* Check for signal loss during preamble/sync search */
        if (bd->signal_power_ema < threshold) {
            bd->dropout_counter++;
            if (bd->dropout_counter >= bd->dropout_limit) {
                bd->prev_state = bd->state;
                bd->state = BURST_IDLE;
                bd->samples_in_state = 0;
                printf("[burst] Signal lost during preamble lock\n");
                fflush(stdout);
            }
        } else {
            bd->dropout_counter = 0;
        }
        break;

    case BURST_RECEIVING:
        /* During reception, don't close squelch — let packet_extract
           handle completion.  Just track power for back-to-back decision. */
        break;
    }

    return bd->state;
}

/* ================================================================
 *  FM FEED — PQI correlator + zero-crossing tracker
 * ================================================================ */

burst_state_t burst_detect_feed_fm(burst_detect_t *bd, float fm_sample) {
    bd->samples_in_state++;

    /* --- Zero-crossing tracker (runs in all states for phase seeding) --- */
    if (bd->prev_fm_sample * fm_sample < 0.0f && bd->prev_fm_sample != 0.0f) {
        /* Zero crossing detected — interpolate fractional position.
           frac = how far into the current sample interval the ZC occurred. */
        float frac = bd->prev_fm_sample / (bd->prev_fm_sample - fm_sample);
        bd->last_zc_mu = frac;
        bd->samples_since_zc = 0;
    } else {
        bd->samples_since_zc++;
    }
    bd->prev_fm_sample = fm_sample;

    /* --- PQI only active in SQUELCH_OPEN and PREAMBLE_LOCK --- */
    if (bd->state != BURST_SQUELCH_OPEN && bd->state != BURST_PREAMBLE_LOCK) {
        return bd->state;
    }

    /* Delay-and-multiply: read the sample that was sps samples ago */
    int read_idx = (bd->pqi_write_idx - bd->pqi_delay_len
                   + BURST_PQI_DELAY_BUF_SIZE) % BURST_PQI_DELAY_BUF_SIZE;
    float delayed = bd->pqi_delay_buf[read_idx];

    /* Write current sample into circular delay buffer */
    bd->pqi_delay_buf[bd->pqi_write_idx] = fm_sample;
    bd->pqi_write_idx = (bd->pqi_write_idx + 1) % BURST_PQI_DELAY_BUF_SIZE;

    /* Correlation product.
       During 1010 preamble: fm[n] and fm[n-sps] are in phase → positive.
       During noise: random sign → averages to zero. */
    float product = fm_sample * delayed;

    /* Update PQI EMA */
    bd->pqi_ema = BURST_PQI_EMA_ALPHA * product
                + (1.0f - BURST_PQI_EMA_ALPHA) * bd->pqi_ema;

    /* --- State transitions based on PQI --- */

    if (bd->state == BURST_SQUELCH_OPEN) {
        if (bd->pqi_ema > bd->pqi_lock_threshold) {
            bd->pqi_hold_counter++;
            if (bd->pqi_hold_counter >= bd->pqi_min_hold) {
                /* Preamble confirmed! */
                bd->prev_state = bd->state;
                bd->state = BURST_PREAMBLE_LOCK;
                bd->samples_in_state = 0;
                bd->dropout_counter = 0;
                printf("[burst] Preamble locked! pqi=%.3f, hold=%d samples\n",
                       bd->pqi_ema, bd->pqi_hold_counter);
                fflush(stdout);
            }
        } else {
            bd->pqi_hold_counter = 0;
        }

        /* Timeout: no PQI lock within expected preamble duration */
        if (bd->samples_in_state > bd->preamble_timeout) {
            bd->prev_state = bd->state;
            bd->state = BURST_IDLE;
            bd->samples_in_state = 0;
            bd->cooldown_counter = bd->cooldown_limit;
            printf("[burst] Squelch timeout (no preamble found)\n");
            fflush(stdout);
        }
    }
    else if (bd->state == BURST_PREAMBLE_LOCK) {
        /* Timeout: no sync word found after preamble lock */
        if (bd->samples_in_state > bd->preamble_timeout) {
            bd->prev_state = bd->state;
            bd->state = BURST_IDLE;
            bd->samples_in_state = 0;
            bd->cooldown_counter = bd->cooldown_limit;
            printf("[burst] Preamble lock timeout (no sync found)\n");
            fflush(stdout);
        }
    }

    return bd->state;
}

/* ================================================================
 *  NOTIFICATIONS FROM PACKET EXTRACTOR
 * ================================================================ */

void burst_detect_notify_sync(burst_detect_t *bd) {
    if (bd->state == BURST_PREAMBLE_LOCK) {
        bd->prev_state = bd->state;
        bd->state = BURST_RECEIVING;
        bd->samples_in_state = 0;
        printf("[burst] -> RECEIVING (sync found)\n");
        fflush(stdout);
    }
}

void burst_detect_notify_packet_done(burst_detect_t *bd) {
    /* Check if another signal is already present (back-to-back packets) */
    float threshold = bd->noise_floor_ema * bd->squelch_margin;

    bd->prev_state = bd->state;

    if (bd->signal_power_ema > threshold) {
        /* Power still high — another packet may follow immediately.
           Go to SQUELCH_OPEN so PQI can detect the next preamble. */
        bd->state = BURST_SQUELCH_OPEN;
        bd->pqi_ema = 0.0f;
        bd->pqi_hold_counter = 0;
        bd->dropout_counter = 0;
        printf("[burst] -> SQUELCH_OPEN (back-to-back, power=%.2e)\n",
               bd->signal_power_ema);
    } else {
        bd->state = BURST_IDLE;
        bd->cooldown_counter = bd->cooldown_limit;
        printf("[burst] -> IDLE (packet done, power=%.2e, cooldown=%d)\n",
               bd->signal_power_ema, bd->cooldown_counter);
    }
    bd->samples_in_state = 0;
    fflush(stdout);
}

/* ================================================================
 *  PHASE SEED FOR M&M
 * ================================================================ */

float burst_detect_get_seed_mu(const burst_detect_t *bd) {
    /* The zero-crossing of a preamble sinewave corresponds to the
       symbol transition boundary (FSK switches from +fdev to -fdev).
       The optimal M&M sampling point is at the PEAK of the eye, which
       is half a symbol period after the transition.

       We know:
         - last_zc_mu: fractional position of last ZC within its sample pair
         - samples_since_zc: integer samples since that ZC

       The distance from ZC to now:
         phase = samples_since_zc + (1.0 - last_zc_mu)

       The optimal point is at phase = sps/2 (mod sps).
       We return the fractional offset for M&M initialization. */

    float sps = bd->samples_per_symbol;
    float half_sps = sps * 0.5f;

    float phase = (float)bd->samples_since_zc + (1.0f - bd->last_zc_mu);

    /* Reduce modulo sps */
    while (phase >= sps) phase -= sps;

    /* We want the next sampling point at half_sps from the last ZC.
       The mu offset tells M&M how far into the current sample interval
       the optimal point falls. */
    float target = half_sps;
    float delta = target - phase;

    /* Wrap to [0, sps) */
    while (delta < 0.0f) delta += sps;
    while (delta >= sps) delta -= sps;

    /* Return just the fractional part as mu in [0, 1) */
    return delta - floorf(delta);
}
