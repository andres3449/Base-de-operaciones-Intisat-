/*
 * fir_filter.h - Filtro FIR Pasabajos con Decimacion
 *
 * Despues del NCO, la señal de 30 kHz esta centrada en DC pero
 * sigue a 250 ksps con ruido de todo el espectro.
 *
 * Este filtro:
 *  1) Aisla solo el canal de 30 kHz (corta todo lo demas)
 *  2) Decima por 4: 250 ksps -> 62.5 ksps
 *
 * Diseño: Windowed-Sinc con ventana Blackman
 * Taps: 63 (buen balance entre selectividad y carga CPU)
 * Cutoff: 20 kHz (pasabanda de 15 kHz + margen de transicion)
 */

#ifndef INTISAT_FIR_FILTER_H
#define INTISAT_FIR_FILTER_H

#include "config.h"

typedef struct {
    float         coeffs[FIR_NUM_TAPS];           /* coeficientes del filtro       */
    iq_sample_t   delay_line[FIR_NUM_TAPS];       /* linea de retardo circular     */
    int           delay_idx;                       /* indice actual en delay line   */
    int           decim_counter;                   /* contador de decimacion        */
    int           decimation;                      /* factor de decimacion (4)      */
} fir_filter_t;

/* Diseña el filtro LPF. cutoff_hz tipicamente 20000, fs tipicamente 250000. */
void fir_design_lpf(fir_filter_t *f, float cutoff_hz, float sample_rate_hz, int decimation);

/* Resetea la linea de retardo (para cuando cambia la config). */
void fir_reset(fir_filter_t *f);

/* Empuja un sample al filtro.
   Retorna 1 si hay un sample de salida listo (cada M-esimo sample).
   El sample de salida se escribe en *out. */
int fir_push_sample(fir_filter_t *f, iq_sample_t in, iq_sample_t *out);

/* Procesa un bloque completo. Escribe samples decimados en 'out'.
   Retorna la cantidad de samples escritos en 'out'.
   out debe tener espacio para al menos (count / decimation + 1) samples. */
int fir_process_block(fir_filter_t *f, const iq_sample_t *in, int count,
                      iq_sample_t *out);

#endif /* INTISAT_FIR_FILTER_H */
