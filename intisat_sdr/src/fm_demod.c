/*
 * fm_demod.c - Discriminador FM (Delay-and-Conjugate-Multiply)
 *
 * Matematica:
 *   Sea x[n] = A*exp(j*phi[n]) la señal analitica (IQ)
 *
 *   y[n] = x[n] * conj(x[n-1])
 *        = A^2 * exp(j*(phi[n] - phi[n-1]))
 *        = A^2 * exp(j*delta_phi)
 *
 *   freq_inst[n] = atan2(y.im, y.re) = delta_phi
 *
 *   Para FSK, delta_phi es proporcional a la desviacion de frecuencia:
 *   delta_phi = 2*PI*fdev/fs  (por sample)
 *
 *   Normalizamos dividiendo por (2*PI*fdev/fs) = multiplicando por fs/(2*PI*fdev)
 *   Resultado: +1.0 = +fdev (marca), -1.0 = -fdev (espacio)
 *
 * A 62.5 ksps con fdev=5000 Hz:
 *   delta_phi_max = 2*PI*5000/62500 = 0.503 radianes (~29 grados)
 *   gain = 62500 / (2*PI*5000) = 1.989
 */

#include "fm_demod.h"
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

void fm_demod_init(fm_demod_t *d, float sample_rate, float freq_deviation) {
    d->prev.re = 1.0f;
    d->prev.im = 0.0f;
    d->gain = sample_rate / (2.0f * (float)M_PI * freq_deviation);
}

float fm_demod_process(fm_demod_t *d, iq_sample_t sample) {
    /* Producto conjugado: sample * conj(prev) */
    float pr = sample.re * d->prev.re + sample.im * d->prev.im;
    float pi = sample.im * d->prev.re - sample.re * d->prev.im;

    /* Guardar sample actual como el proximo "prev" */
    d->prev = sample;

    /* atan2 da la diferencia de fase instantanea.
       Multiplicamos por gain para normalizar a +/-1.0 para +/-fdev */
    return atan2f(pi, pr) * d->gain;
}

void fm_demod_process_block(fm_demod_t *d, const iq_sample_t *in,
                            float *out, int count) {
    for (int i = 0; i < count; i++) {
        out[i] = fm_demod_process(d, in[i]);
    }
}
