/*
 * nco.h - Oscilador Controlado Numericamente (NCO)
 *
 * Genera exp(-j*2*pi*f*n/fs) para trasladar la señal a banda base.
 * Al sintonizar el RTL-SDR 200 kHz debajo de la señal real,
 * la señal aparece a +200 kHz en el espectro digital.
 * El NCO la mezcla de vuelta a DC (banda base).
 *
 * Esto evita el DC spike del RTL-SDR que corrompe la señal.
 */

#ifndef INTISAT_NCO_H
#define INTISAT_NCO_H

#include "config.h"

typedef struct {
    double phase;       /* fase actual en radianes [0, 2*PI) */
    double phase_inc;   /* incremento por sample = -2*PI*f_shift/fs */
} nco_t;

/* Inicializa el NCO.
   freq_shift_hz > 0 significa que la señal está por encima de la
   frecuencia de sintonización (caso normal: +200 kHz).
   El NCO mezcla HACIA ABAJO multiplicando por exp(-j*2*pi*f*n/fs). */
void nco_init(nco_t *nco, double freq_shift_hz, double sample_rate_hz);

/* Cambia la frecuencia del NCO en caliente (cuando el usuario ajusta). */
void nco_set_freq(nco_t *nco, double freq_shift_hz, double sample_rate_hz);

/* Mezcla un sample IQ con el NCO. Retorna el sample trasladado. */
iq_sample_t nco_mix(nco_t *nco, iq_sample_t in);

/* Mezcla un bloque completo de samples (in-place para eficiencia). */
void nco_mix_block(nco_t *nco, iq_sample_t *samples, int count);

#endif /* INTISAT_NCO_H */
