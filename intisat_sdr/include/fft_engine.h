/*
 * fft_engine.h - Motor FFT con ventana Blackman-Harris
 *
 * Toma un snapshot de IQ samples (2048), aplica ventana,
 * calcula FFT via kiss_fft, y produce el espectro de potencia
 * en dBFS listo para enviarse al waterfall de Python.
 *
 * La ventana Blackman-Harris 4-term tiene -92 dB de supresion
 * de lobulos laterales, ideal para visualizacion de espectro.
 */

#ifndef INTISAT_FFT_ENGINE_H
#define INTISAT_FFT_ENGINE_H

#include "config.h"

/* Estructura opaca del motor FFT */
typedef struct fft_engine fft_engine_t;

/* Crea e inicializa el motor FFT. Retorna NULL si falla. */
fft_engine_t *fft_engine_create(int fft_size);

/* Libera recursos. */
void fft_engine_destroy(fft_engine_t *fft);

/* Calcula el espectro de potencia en dBFS.
   iq_in: FFT_SIZE samples IQ
   power_dbfs_out: FFT_SIZE floats de salida (ya con fftshift aplicado)
   Retorna 0 en exito. */
int fft_engine_compute(fft_engine_t *fft, const iq_sample_t *iq_in,
                       float *power_dbfs_out);

#endif /* INTISAT_FFT_ENGINE_H */
