/*
 * nco.c - Oscilador Controlado Numericamente (NCO)
 *
 * Implementacion con fase en double para maxima precision.
 * A 250 ksps, cos()/sin() en double es ~4 ns por sample en un CPU moderno.
 * Para 250k samples/s esto es ~1 ms - totalmente despreciable.
 *
 * El NCO multiplica cada sample IQ por exp(-j*2*pi*f*n/fs), lo que
 * efectivamente traslada la señal de +f_shift a 0 Hz (banda base).
 */

#include "nco.h"
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

void nco_init(nco_t *nco, double freq_shift_hz, double sample_rate_hz) {
    nco->phase = 0.0;
    /* Incremento negativo porque estamos mezclando HACIA ABAJO:
       exp(-j*2*PI*f/fs) traslada una señal a +f hacia DC */
    nco->phase_inc = -2.0 * M_PI * freq_shift_hz / sample_rate_hz;
}

void nco_set_freq(nco_t *nco, double freq_shift_hz, double sample_rate_hz) {
    nco->phase_inc = -2.0 * M_PI * freq_shift_hz / sample_rate_hz;
    /* No reseteamos la fase para continuidad */
}

iq_sample_t nco_mix(nco_t *nco, iq_sample_t in) {
    float cos_p = (float)cos(nco->phase);
    float sin_p = (float)sin(nco->phase);

    iq_sample_t out;
    /* Multiplicacion compleja: (a+jb) * (cos+jsin)
       re = a*cos - b*sin
       im = a*sin + b*cos */
    out.re = in.re * cos_p - in.im * sin_p;
    out.im = in.re * sin_p + in.im * cos_p;

    /* Avanzar fase */
    nco->phase += nco->phase_inc;

    /* Wrapping para evitar perdida de precision en fases grandes */
    if (nco->phase > M_PI)        nco->phase -= 2.0 * M_PI;
    else if (nco->phase < -M_PI)  nco->phase += 2.0 * M_PI;

    return out;
}

void nco_mix_block(nco_t *nco, iq_sample_t *samples, int count) {
    for (int i = 0; i < count; i++) {
        float cos_p = (float)cos(nco->phase);
        float sin_p = (float)sin(nco->phase);

        float re = samples[i].re;
        float im = samples[i].im;
        samples[i].re = re * cos_p - im * sin_p;
        samples[i].im = re * sin_p + im * cos_p;

        nco->phase += nco->phase_inc;
    }

    /* Wrap una sola vez al final del bloque (mas eficiente) */
    nco->phase = fmod(nco->phase, 2.0 * M_PI);
}
