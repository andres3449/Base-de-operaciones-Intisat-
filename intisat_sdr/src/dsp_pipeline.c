/*
 * dsp_pipeline.c - Orquestacion del pipeline DSP con Dual Correlator
 *
 * Arquitectura:
 *   Una sola cadena de front-end (NCO -> FIR -> AGC -> FM demod) alimenta
 *   DOS cadenas de recepcion independientes (rx_channel_t ch[0] y ch[1]).
 *
 *   Solo el canal active_rx puede transicionar SQUELCH_OPEN -> PREAMBLE_LOCK.
 *   El otro canal corre burst_detect_feed_power/fm (actualiza ruido y PQI)
 *   pero sus transiciones a PREAMBLE_LOCK estan suprimidas.
 *
 *   Cuando active_rx entra en RECEIVING (sync encontrado):
 *     - active_rx cambia al otro canal
 *     - El otro canal queda inmediatamente en SQUELCH_OPEN listo para
 *       el siguiente preambulo (que llegara en ~95ms)
 *
 *   Resultado: no hay ciclo de reset entre paquetes; el canal standby
 *   SIEMPRE esta listo, eliminando la causa principal de PER.
 */

#include "dsp_pipeline.h"
#include "zmq_transport.h"
#include "platform.h"
#include <stdio.h>
#include <string.h>
#include <math.h>

/* ================================================================
 *  CALLBACK DE PAQUETE
 * ================================================================ */

static void on_packet_decoded(const uint8_t *payload, int payload_len,
                               float rssi_db, float freq_err_hz,
                               int sync_errors, void *user_data) {
    rx_channel_t   *ch  = (rx_channel_t *)user_data;
    dsp_pipeline_t *dsp = ch->dsp;

    int fdev = atomic_load(&dsp->config->freq_deviation_hz);
    float freq_err_real = freq_err_hz * (float)fdev;

    float pwr_ema = ch->pkt_ext.power_ema;

    int is_stream = (sync_errors == 0xFF);
    zmq_publish_packet(dsp->transport, payload, payload_len,
                       rssi_db, freq_err_real,
                       is_stream ? SYNC_FOUND_STREAM : 1,
                       is_stream ? 0 : sync_errors,
                       pwr_ema);

    dsp->total_packets_decoded++;

    printf("[dsp ch%d] Paquete #%u: %d bytes, RSSI=%.1f dB, "
           "freq_err=%.0f Hz, sync_err=%d, pwr_ema=%.2e\n",
           ch->ch_id, dsp->total_packets_decoded, payload_len,
           rssi_db, freq_err_real, sync_errors, pwr_ema);
}

/* ================================================================
 *  INIT DE UN CANAL
 * ================================================================ */

static void init_channel(rx_channel_t *ch, int ch_id, dsp_pipeline_t *dsp,
                          float decimated_rate, float symbol_rate,
                          const runtime_config_t *cfg) {
    ch->ch_id = ch_id;
    ch->dsp   = dsp;

    /* DC Blocker */
    ch->dc_block.prev_in  = 0.0f;
    ch->dc_block.prev_out = 0.0f;
    ch->dc_block.alpha    = DC_BLOCKER_ALPHA;
    ch->use_frozen_dc     = 0;
    ch->frozen_dc_offset  = 0.0f;
    ch->phase_dc_sum      = 0.0f;

    /* Clock recovery */
    clock_recovery_init(&ch->clock_rec, decimated_rate, symbol_rate);

    /* Burst detector */
    burst_detect_init(&ch->burst, decimated_rate, symbol_rate);

    /* Packet extractor */
    int pkt_len  = atomic_load(&cfg->packet_length);
    int gate_t   = atomic_load(&cfg->sync_power_gate_tenths);
    pkt_extract_init(&ch->pkt_ext,
                     cfg->sync_word, cfg->sync_word_len,
                     pkt_len,
                     on_packet_decoded, ch);
    ch->pkt_ext.burst_detect        = &ch->burst;
    ch->pkt_ext.power_gate_threshold = (float)gate_t / 10000.0f;
    ch->pkt_ext.ch_id               = ch_id;

    /* Phase selection */
    ch->phase_selecting  = 0;
    ch->phase_buf_count  = 0;
    ch->phase_buf_target = 0;
    ch->initial_seed_mu  = 0.0f;

    /* Debug */
    ch->debug_bit_count    = 0;
    ch->debug_bits_in_burst = 0;
}

/* ================================================================
 *  CONFIGURACION DEL PIPELINE
 * ================================================================ */

static void configure_pipeline(dsp_pipeline_t *dsp) {
    runtime_config_t *cfg = dsp->config;

    double sample_rate  = DEFAULT_SAMPLE_RATE_HZ;
    double nco_shift    = (double)atomic_load(&cfg->nco_shift_hz);
    int    symbol_rate  = atomic_load(&cfg->symbol_rate_sps);
    int    fdev         = atomic_load(&cfg->freq_deviation_hz);
    int    mod_type     = atomic_load(&cfg->modulation_type);

    nco_init(&dsp->nco, nco_shift, sample_rate);

    float cutoff = FIR_CUTOFF_HZ;
    fir_design_lpf(&dsp->fir, cutoff, (float)sample_rate, FIR_DECIMATION);

    float decimated_rate = (float)(sample_rate / FIR_DECIMATION);

    dsp->agc.gain     = AGC_INITIAL_GAIN;
    dsp->agc.target   = AGC_TARGET_AMPLITUDE;
    dsp->agc.attack   = AGC_ATTACK_RATE;
    dsp->agc.decay    = AGC_DECAY_RATE;
    dsp->agc.max_gain = AGC_MAX_GAIN;

    fm_demod_init(&dsp->fm, decimated_rate, (float)fdev);

    /* Initialise both receive channels */
    for (int c = 0; c < 2; c++) {
        init_channel(&dsp->ch[c], c, dsp,
                     decimated_rate, (float)symbol_rate, cfg);
    }

    /* Channel 0 starts as active (allowed to acquire preamble) */
    dsp->active_rx = 0;

    dsp->last_config_gen = atomic_load(&cfg->generation);

    printf("[dsp] Pipeline dual-correlator configurado: NCO=%.0f Hz, "
           "FIR cutoff=%.0f Hz, decim=%d, fdev=%d Hz, baud=%d, mod=%d\n",
           nco_shift, cutoff, FIR_DECIMATION, fdev, symbol_rate, mod_type);
    printf("[dsp] ch0=active, ch1=standby\n");
}

/* ================================================================
 *  INICIALIZACION / DESTRUCCION
 * ================================================================ */

void dsp_pipeline_init(dsp_pipeline_t *dsp, ring_buffer_t *ring,
                       runtime_config_t *config,
                       struct zmq_transport *transport) {
    memset(dsp, 0, sizeof(*dsp));
    dsp->ring      = ring;
    dsp->config    = config;
    dsp->transport = (zmq_transport_t *)transport;

    dsp->fft = fft_engine_create(FFT_SIZE);
    if (!dsp->fft) {
        fprintf(stderr, "[dsp] Error: no se pudo crear motor FFT\n");
    }

    configure_pipeline(dsp);
}

void dsp_pipeline_destroy(dsp_pipeline_t *dsp) {
    if (dsp->fft) {
        fft_engine_destroy(dsp->fft);
        dsp->fft = NULL;
    }
}

/* ================================================================
 *  PROCESAMIENTO PER-SAMPLE DE UN CANAL
 *
 *  fm_raw : muestra FM pre-DC-block
 *  power  : IQ mag^2 (pre-AGC, para burst detect y RSSI)
 *  is_active: 1 si este canal puede adquirir preambulo (active_rx)
 *  is_4level: 1 si modulacion 4FSK/4GFSK
 *
 *  Retorna el nuevo active_rx si el canal entro en RECEIVING
 *  (se pasa por referencia via active_rx_out), o deja intacto.
 * ================================================================ */

static void process_channel_sample(dsp_pipeline_t *dsp,
                                    rx_channel_t   *ch,
                                    float fm_raw,
                                    float power,
                                    int   is_active,
                                    int   is_4level) {
    /* Accumulate raw FM for DC estimation during phase selection */
    if (ch->phase_selecting && ch->phase_buf_count < ch->phase_buf_target) {
        ch->phase_dc_sum += fm_raw;
    }

    /* DC Blocker: per-channel IIR or frozen offset */
    float y;
    if (ch->use_frozen_dc) {
        /* Slow AFC: tracks very slow frequency drift during reception */
        ch->frozen_dc_offset = ch->frozen_dc_offset * 0.998f + fm_raw * 0.002f;
        y = fm_raw - ch->frozen_dc_offset;
    } else {
        y = fm_raw - ch->dc_block.prev_in
            + ch->dc_block.alpha * ch->dc_block.prev_out;
        ch->dc_block.prev_in  = fm_raw;
        ch->dc_block.prev_out = y;
    }

    /* 1a. Feed power to burst detector (always — for noise floor + RSSI) */
    burst_detect_feed_power(&ch->burst, power);

    /* 1b. Feed FM to burst detector PQI (always — tracks preamble quality) */
    burst_state_t prev_bstate = ch->burst.state;
    burst_state_t bstate      = burst_detect_feed_fm(&ch->burst, y);

    /* Standby suppression: silently cancel PREAMBLE_LOCK for passive channel.
     * No printf/fflush — this fires ~9x per preamble × hundreds of packets. */
    if (!is_active && bstate == BURST_PREAMBLE_LOCK
                   && prev_bstate == BURST_SQUELCH_OPEN) {
        ch->burst.state            = BURST_SQUELCH_OPEN;
        ch->burst.prev_state       = BURST_SQUELCH_OPEN;
        ch->burst.pqi_ema          = 0.0f;
        ch->burst.pqi_hold_counter = 0;
        ch->burst.samples_in_state = 0;
        return;
    }

    /* --- Transitions that only the active channel executes --- */

    /* 2. SQUELCH_OPEN -> PREAMBLE_LOCK: start phase selection */
    if (bstate == BURST_PREAMBLE_LOCK && prev_bstate == BURST_SQUELCH_OPEN) {
        ch->initial_seed_mu  = burst_detect_get_seed_mu(&ch->burst);
        ch->phase_selecting  = 1;
        ch->phase_buf_count  = 0;
        ch->phase_dc_sum     = 0.0f;
        ch->use_frozen_dc    = 0;
        ch->phase_buf_target = (int)(PHASE_SEL_SYMBOLS_CH * ch->clock_rec.omega_mid);
        if (ch->phase_buf_target > PHASE_SEL_BUF_SIZE_CH)
            ch->phase_buf_target = PHASE_SEL_BUF_SIZE_CH;
        ch->debug_bit_count    = 0;
        ch->debug_bits_in_burst = 0;
        printf("[dsp ch%d] Phase selection: seed_mu=%.3f, buffering %d samples...\n",
               ch->ch_id, ch->initial_seed_mu, ch->phase_buf_target);
        fflush(stdout);
    }

    /* 3. Transition to IDLE: log burst post-mortem */
    if (bstate == BURST_IDLE && prev_bstate != BURST_IDLE) {
        ch->phase_selecting = 0;
        ch->use_frozen_dc   = 0;
        if (ch->debug_bits_in_burst > 0) {
            uint32_t diff   = ch->pkt_ext.sync.shift_reg
                            ^ ch->pkt_ext.sync.sync_pattern;
            int hamming = portable_popcount(diff);
            printf("[dsp ch%d] Burst ended: %d bits, shift_reg=0x%08X, hamming=%d\n",
                   ch->ch_id, ch->debug_bits_in_burst,
                   ch->pkt_ext.sync.shift_reg, hamming);
            fflush(stdout);
        }
        ch->debug_bits_in_burst = 0;
        ch->debug_bit_count     = 0;
    }

    /* 5. Gate: only run M&M when burst detector enables it */
    if (!burst_detect_clock_enabled(&ch->burst)) {
        return;
    }

    /* Capture burst state BEFORE bit processing.
     * burst_detect_notify_sync() fires INSIDE pkt_extract_push_bit when the
     * sync word is found, changing burst.state PREAMBLE_LOCK -> RECEIVING.
     * That transition is NOT visible from burst_detect_feed_fm output. */
    burst_state_t pre_bit_state = ch->burst.state;

    /* 5b. Phase selection: buffer FM samples, then evaluate candidates */
    if (ch->phase_selecting) {
        if (ch->phase_buf_count < ch->phase_buf_target) {
            ch->phase_buf[ch->phase_buf_count++] = y;
            return;
        }

        /* Buffer full — compute exact DC offset from preamble average */
        ch->frozen_dc_offset = ch->phase_dc_sum / (float)ch->phase_buf_count;
        ch->use_frozen_dc    = 1;
        printf("[dc  ch%d] DC from preamble: %.5f\n",
               ch->ch_id, ch->frozen_dc_offset);

        /* Evaluate 4 phase candidates on the same buffered data */
        float best_mu      = ch->initial_seed_mu;
        int   best_hamming = 32;

        for (int c = 0; c < PHASE_SEL_CANDIDATES_CH; c++) {
            float trial_mu = ch->initial_seed_mu + 0.25f * (float)c;
            while (trial_mu >= 1.0f) trial_mu -= 1.0f;

            clock_recovery_t trial;
            trial.omega_mid   = ch->clock_rec.omega_mid;
            trial.omega       = trial.omega_mid;
            trial.omega_gain  = CR_PREAMBLE_OMEGA_GAIN;
            trial.mu          = trial_mu;
            trial.mu_gain     = CR_PREAMBLE_MU_GAIN;
            trial.omega_lim   = CR_OMEGA_LIM;
            trial.prev_sample = 0.0f;
            trial.prev_symbol = 0.0f;
            trial.prev_interp = 0.0f;
            trial.counter     = (int)trial.omega_mid;

            uint32_t sr   = 0;
            int      bits = 0;
            for (int j = 0;
                 j < ch->phase_buf_count && bits < PHASE_SEL_EVAL_BITS_CH;
                 j++) {
                float s;
                if (clock_recovery_push(&trial, ch->phase_buf[j], &s)) {
                    sr = (sr << 1) | ((s > 0.0f) ? 1u : 0u);
                    bits++;
                }
            }

            uint32_t h_aa = portable_popcount((sr & 0xFFFFu) ^ 0xAAAAu);
            uint32_t h_55 = portable_popcount((sr & 0xFFFFu) ^ 0x5555u);
            int      h    = (int)((h_aa < h_55) ? h_aa : h_55);

            printf("[dsp ch%d] Phase candidate %d: mu=%.3f sr=0x%04X hamming=%d\n",
                   ch->ch_id, c, trial_mu, sr & 0xFFFF, h);

            if (h < best_hamming) {
                best_hamming = h;
                best_mu      = trial_mu;
            }
        }

        clock_recovery_reset(&ch->clock_rec);
        ch->clock_rec.mu         = best_mu;
        ch->clock_rec.mu_gain    = CR_PREAMBLE_MU_GAIN;
        ch->clock_rec.omega_gain = CR_PREAMBLE_OMEGA_GAIN;
        sync_reset(&ch->pkt_ext.sync);

        printf("[dsp ch%d] Phase selected: mu=%.3f (hamming=%d)\n",
               ch->ch_id, best_mu, best_hamming);
        fflush(stdout);

        /* Phase rejection: hamming too high = no real preamble in buffer */
        if (best_hamming > PHASE_SEL_MAX_HAMMING_CH) {
            printf("[dsp ch%d] Phase REJECTED (hamming=%d > %d) — false preamble\n",
                   ch->ch_id, best_hamming, PHASE_SEL_MAX_HAMMING_CH);
            fflush(stdout);
            ch->burst.prev_state       = ch->burst.state;
            ch->burst.state            = BURST_IDLE;
            ch->burst.pqi_ema          = 0.0f;
            ch->burst.pqi_hold_counter = 0;
            ch->burst.dropout_counter  = 0;
            ch->burst.samples_in_state = 0;
            ch->burst.cooldown_counter = ch->burst.cooldown_limit * 2;
            ch->phase_selecting        = 0;
            ch->debug_bit_count        = 0;
            ch->debug_bits_in_burst    = 0;
            ch->use_frozen_dc          = 0;
            return;
        }

        /* Replay all buffered samples through the real M&M */
        for (int j = 0; j < ch->phase_buf_count; j++) {
            float s;
            if (clock_recovery_push(&ch->clock_rec, ch->phase_buf[j], &s)) {
                if (is_4level) {
                    int bh, bl;
                    if      (s >  2.0f) { bh = 1; bl = 0; }
                    else if (s >  0.0f) { bh = 1; bl = 1; }
                    else if (s > -2.0f) { bh = 0; bl = 1; }
                    else                { bh = 0; bl = 0; }
                    pkt_extract_push_bit(&ch->pkt_ext, bh, ch->phase_buf[j]);
                    pkt_extract_push_bit(&ch->pkt_ext, bl, ch->phase_buf[j]);
                    ch->debug_bits_in_burst += 2;
                } else {
                    int bit = (s > 0.0f) ? 1 : 0;
                    pkt_extract_push_bit(&ch->pkt_ext, bit, ch->phase_buf[j]);
                    ch->debug_bits_in_burst++;
                }
            }
        }

        ch->phase_selecting = 0;
        ch->debug_bit_count = 0;
        /* Fall through to post-bit handoff check below */
    } else {
        /* 6. Normal clock recovery (one sample at a time) */
        float soft;
        if (clock_recovery_push(&ch->clock_rec, y, &soft)) {
            if (is_4level) {
                int bit_hi, bit_lo;
                if      (soft >  2.0f) { bit_hi = 1; bit_lo = 0; }
                else if (soft >  0.0f) { bit_hi = 1; bit_lo = 1; }
                else if (soft > -2.0f) { bit_hi = 0; bit_lo = 1; }
                else                   { bit_hi = 0; bit_lo = 0; }
                pkt_extract_push_bit(&ch->pkt_ext, bit_hi, y);
                pkt_extract_push_bit(&ch->pkt_ext, bit_lo, y);
                ch->debug_bits_in_burst += 2;
            } else {
                int bit = (soft > 0.0f) ? 1 : 0;
                pkt_extract_push_bit(&ch->pkt_ext, bit, y);
                ch->debug_bits_in_burst++;
            }

            ch->debug_bit_count++;
            if (ch->debug_bit_count >= 32 && bstate == BURST_PREAMBLE_LOCK) {
                uint32_t diff = ch->pkt_ext.sync.shift_reg
                              ^ ch->pkt_ext.sync.sync_pattern;
                int hamming = portable_popcount(diff);
                printf("[CORR ch%d] bits=%d shift_reg=0x%08X hamming=%d omega=%.2f\n",
                       ch->ch_id, ch->debug_bits_in_burst,
                       ch->pkt_ext.sync.shift_reg, hamming, ch->clock_rec.omega);
                fflush(stdout);
                ch->debug_bit_count = 0;
            }
        }
    }

    /* 7. Post-bit handoff: detect PREAMBLE_LOCK -> RECEIVING.
     *    burst_detect_notify_sync() changes burst.state DURING pkt_extract_push_bit,
     *    so we check ch->burst.state AFTER all bit processing above. */
    if (ch->burst.state == BURST_RECEIVING && pre_bit_state == BURST_PREAMBLE_LOCK) {
        /* Tighten M&M to tracking bandwidth now that sync is confirmed */
        ch->clock_rec.mu_gain    = CR_MU_GAIN;
        ch->clock_rec.omega_gain = CR_OMEGA_GAIN;
        printf("[dsp ch%d] SYNC! M&M tightened (mu=%.3f), bits=%d\n",
               ch->ch_id, ch->clock_rec.mu_gain, ch->debug_bits_in_burst);
        printf("[dc  ch%d] Frozen DC at sync: %.5f\n",
               ch->ch_id, ch->frozen_dc_offset);
        fflush(stdout);

        /* Switch active_rx to the other channel (standby) */
        int standby = 1 - ch->ch_id;
        dsp->active_rx = standby;
        rx_channel_t *sbc = &dsp->ch[standby];

        /* Reset standby PQI and cooldown so it can respond immediately to the
         * next preamble.  The standby may have accumulated PQI from the preamble
         * we just decoded (residual that would cause a false PREAMBLE_LOCK on
         * DATA), or may be sitting in IDLE+cooldown from a recent phase rejection
         * (which would block squelch-open when the next preamble arrives). */
        sbc->burst.pqi_ema          = 0.0f;
        sbc->burst.pqi_hold_counter = 0;
        memset(sbc->burst.pqi_delay_buf, 0, sizeof(sbc->burst.pqi_delay_buf));
        sbc->burst.pqi_write_idx    = 0;
        sbc->burst.cooldown_counter = 0;

        /* If standby is in IDLE and signal is still above threshold,
         * force it to SQUELCH_OPEN so it can detect the next preamble. */
        float thr = sbc->burst.noise_floor_ema * sbc->burst.squelch_margin;
        if (sbc->burst.state == BURST_IDLE && sbc->burst.signal_power_ema > thr) {
            sbc->burst.prev_state       = BURST_IDLE;
            sbc->burst.state            = BURST_SQUELCH_OPEN;
            sbc->burst.dropout_counter  = 0;
            sbc->burst.samples_in_state = 0;
            printf("[dsp ch%d] Standby -> SQUELCH_OPEN (pwr=%.2e)\n",
                   standby, sbc->burst.signal_power_ema);
            fflush(stdout);
        } else {
            printf("[dsp ch%d] Standby active (state=%d, pwr=%.2e thr=%.2e)\n",
                   standby, (int)sbc->burst.state,
                   sbc->burst.signal_power_ema, thr);
            fflush(stdout);
        }
    }
}

/* ================================================================
 *  THREAD DSP PRINCIPAL
 * ================================================================ */

void *dsp_thread_func(void *arg) {
    dsp_pipeline_t *dsp = (dsp_pipeline_t *)arg;

    printf("[dsp] Thread DSP iniciado (dual correlator: ch0=active, ch1=standby)\n");

    iq_sample_t iq_chunk[DSP_CHUNK_SIZE];
    iq_sample_t fir_out[DSP_CHUNK_SIZE / FIR_DECIMATION + 16];
    float       fm_out[DSP_CHUNK_SIZE / FIR_DECIMATION + 16];
    float       power_buf[DSP_CHUNK_SIZE / FIR_DECIMATION + 16];
    float       fft_power[FFT_SIZE];

    uint64_t last_fft_sample  = 0;
    uint64_t fft_interval_samples = DSP_CHUNK_SIZE;
    uint64_t last_status_time = 0;

    while (1) {
        if (!atomic_load(&dsp->config->running)) {
            platform_sleep_ms(50);
            continue;
        }

        int current_gen = atomic_load(&dsp->config->generation);
        if (current_gen != dsp->last_config_gen) {
            printf("[dsp] Reconfigurando pipeline (gen %d -> %d)\n",
                   dsp->last_config_gen, current_gen);
            configure_pipeline(dsp);
        }

        uint32_t n_read = ring_buf_read(dsp->ring, iq_chunk, DSP_CHUNK_SIZE);
        if (n_read == 0) {
            platform_sleep_ms(1);
            continue;
        }

        dsp->total_samples_processed += n_read;

        /* NCO mixdown */
        nco_mix_block(&dsp->nco, iq_chunk, (int)n_read);

        /* FFT (post-NCO, ~30 FPS) */
        if (dsp->fft &&
            (dsp->total_samples_processed - last_fft_sample) >= fft_interval_samples) {
            iq_sample_t fft_in[FFT_SIZE];
            int to_copy = (n_read > FFT_SIZE) ? FFT_SIZE : n_read;
            memset(fft_in, 0, sizeof(fft_in));
            memcpy(fft_in, iq_chunk, to_copy * sizeof(iq_sample_t));
            fft_engine_compute(dsp->fft, fft_in, fft_power);
            float center_freq = (float)(
                atomic_load(&dsp->config->tune_freq_hz) +
                atomic_load(&dsp->config->nco_shift_hz)
            );
            zmq_publish_fft(dsp->transport, fft_power, FFT_SIZE,
                            center_freq, (float)DEFAULT_SAMPLE_RATE_HZ);
            last_fft_sample = dsp->total_samples_processed;
        }

        /* FIR LPF + decimacion */
        int n_filtered = fir_process_block(&dsp->fir, iq_chunk, (int)n_read, fir_out);

        /* AGC + power buffer */
        for (int i = 0; i < n_filtered; i++) {
            float mag_sq = fir_out[i].re * fir_out[i].re +
                           fir_out[i].im * fir_out[i].im;
            float mag = sqrtf(mag_sq + 1e-12f);

            power_buf[i] = mag_sq;

            /* Feed power to both packet extractors for RSSI tracking */
            pkt_extract_feed_power(&dsp->ch[0].pkt_ext, mag_sq);
            pkt_extract_feed_power(&dsp->ch[1].pkt_ext, mag_sq);

            float err = dsp->agc.target - mag * dsp->agc.gain;
            if (err < 0.0f)
                dsp->agc.gain += dsp->agc.attack * err;
            else
                dsp->agc.gain += dsp->agc.decay * err;

            if (dsp->agc.gain > dsp->agc.max_gain)
                dsp->agc.gain = dsp->agc.max_gain;
            if (dsp->agc.gain < 1e-6f)
                dsp->agc.gain = 1e-6f;

            fir_out[i].re *= dsp->agc.gain;
            fir_out[i].im *= dsp->agc.gain;
        }

        /* FM discriminador */
        fm_demod_process_block(&dsp->fm, fir_out, fm_out, n_filtered);

        /* Per-sample dual correlator processing */
        int mod_type  = atomic_load(&dsp->config->modulation_type);
        int is_4level = (mod_type == MOD_4FSK || mod_type == MOD_4GFSK);

        for (int i = 0; i < n_filtered; i++) {
            float x  = fm_out[i];
            float pw = power_buf[i];
            int   ar = dsp->active_rx;   /* snapshot: may change inside */

            /* Process both channels; active_rx determines who can lock */
            process_channel_sample(dsp, &dsp->ch[0], x, pw, (ar == 0), is_4level);
            process_channel_sample(dsp, &dsp->ch[1], x, pw, (ar == 1), is_4level);
        }

        /* STATUS PERIODICO (1 Hz) */
        uint64_t now = platform_timestamp_us();
        if ((now - last_status_time) >= 1000000) {
            uint32_t ring_avail = ring_buf_read_available(dsp->ring);
            float    fill_pct   = 100.0f * (float)ring_avail / (float)RING_BUF_SIZE;
            zmq_publish_status(dsp->transport,
                               atomic_load(&dsp->config->running),
                               dsp->total_packets_decoded,
                               0,
                               fill_pct);
            last_status_time = now;
        }
    }

    printf("[dsp] Thread DSP finalizado\n");
    return NULL;
}
