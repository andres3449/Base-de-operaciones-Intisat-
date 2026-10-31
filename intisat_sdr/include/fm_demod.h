/*
 * fm_demod.h - Discriminador FM (Delay-and-Conjugate-Multiply)
 *
 * Para FSK, la informacion esta en la frecuencia instantanea.
 * La tecnica clasica:
 *   1) Multiplica sample actual por conjugado del anterior: y[n] = x[n] * conj(x[n-1])
 *   2) Extrae la fase: atan2(y.im, y.re)
 *   3) Normaliza por la desviacion de frecuencia
 *
 * Salida: valor flotante donde +1.0 = +fdev y -1.0 = -fdev
 * Para 2FSK: la salida oscila entre +1 y -1 (bit 1 y bit 0).
 *
 * Opera a la tasa post-decimacion (62.5 ksps).
 */

#ifndef INTISAT_FM_DEMOD_H
#define INTISAT_FM_DEMOD_H

#include "config.h"

typedef struct {
    iq_sample_t prev;    /* sample anterior z^{-1} */
    float       gain;    /* factor de normalizacion: fs / (2*PI*fdev) */
} fm_demod_t;

/* Inicializa el demodulador FM.
   sample_rate: tasa post-decimacion (62500)
   freq_deviation: desviacion FSK en Hz (5000) */
void fm_demod_init(fm_demod_t *d, float sample_rate, float freq_deviation);

/* Procesa un sample IQ. Retorna la frecuencia instantanea normalizada. */
float fm_demod_process(fm_demod_t *d, iq_sample_t sample);

/* Procesa un bloque completo. IQ in -> floats out.
   Retorna count valores en 'out'. */
void fm_demod_process_block(fm_demod_t *d, const iq_sample_t *in,
                            float *out, int count);

#endif /* INTISAT_FM_DEMOD_H */
