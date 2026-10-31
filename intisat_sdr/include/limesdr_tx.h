/*
 * limesdr_tx.h - LimeSDR TX burst for uplink commands
 *
 * Uses the same lms_device_t* from limesdr_reader.c (shared device handle).
 * The TX channel is configured once during init, then activated briefly
 * for each burst transmission (half-duplex protocol).
 */

#ifndef INTISAT_LIMESDR_TX_H
#define INTISAT_LIMESDR_TX_H

#include "rtlsdr_reader.h"

/*
 * Initialize TX channel on the already-open LimeSDR device.
 * Enables TX channel 0, sets frequency/gain/sample rate, creates TX stream.
 * Must be called AFTER limesdr_open() (which sets up r->lime_dev).
 * Returns 0 on success, -1 on error.
 */
int limesdr_tx_init(rtlsdr_reader_t *r);

/*
 * Burst-transmit pre-modulated IQ samples.
 * Activates the TX stream, writes all samples, then deactivates.
 *
 * iq_data: interleaved float IQ pairs [I0, Q0, I1, Q1, ...]
 * num_samples: number of IQ samples (NOT floats — floats = num_samples * 2)
 *
 * Returns 0 on success, -1 on error.
 */
int limesdr_tx_burst(rtlsdr_reader_t *r,
                     const float *iq_data, int num_samples);

/*
 * Destroy TX stream and disable TX channel.
 * Must be called BEFORE limesdr_close().
 */
void limesdr_tx_close(rtlsdr_reader_t *r);

#endif /* INTISAT_LIMESDR_TX_H */
