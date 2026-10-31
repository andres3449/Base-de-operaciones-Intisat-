/*
 * fft_engine.c - Motor FFT con ventana Blackman-Harris 4-term
 *
 * Blackman-Harris 4-term:
 *   w[n] = a0 - a1*cos(2*PI*n/(N-1)) + a2*cos(4*PI*n/(N-1)) - a3*cos(6*PI*n/(N-1))
 *   a0=0.35875, a1=0.48829, a2=0.14128, a3=0.01168
 *
 * Sidelobe suppression: -92 dB (excelente para waterfall)
 *
 * Pipeline:
 *   1) Remover DC (restar media del bloque)
 *   2) Aplicar ventana Blackman-Harris
 *   3) FFT via kiss_fft
 *   4) fftshift (mover DC al centro)
 *   5) Calcular potencia en dBFS: 10*log10(|X[k]|^2 / N^2)
 */

#include "fft_engine.h"
#include "kiss_fft.h"
#include <stdlib.h>
#include <string.h>
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

struct fft_engine {
    int             fft_size;
    kiss_fft_cfg    cfg;              /* configuracion de kiss_fft       */
    kiss_fft_cpx   *fft_in;          /* buffer de entrada (windowed)    */
    kiss_fft_cpx   *fft_out;         /* buffer de salida                */
    float          *window;           /* coeficientes de ventana         */
    float           norm_factor;      /* 1.0 / (fft_size^2)             */
};

fft_engine_t *fft_engine_create(int fft_size) {
    fft_engine_t *fft = (fft_engine_t *)calloc(1, sizeof(fft_engine_t));
    if (!fft) return NULL;

    fft->fft_size = fft_size;

    /* Allocar kiss_fft (forward transform, no inverse) */
    fft->cfg = kiss_fft_alloc(fft_size, 0, NULL, NULL);
    if (!fft->cfg) { free(fft); return NULL; }

    fft->fft_in  = (kiss_fft_cpx *)calloc(fft_size, sizeof(kiss_fft_cpx));
    fft->fft_out = (kiss_fft_cpx *)calloc(fft_size, sizeof(kiss_fft_cpx));
    fft->window  = (float *)calloc(fft_size, sizeof(float));

    if (!fft->fft_in || !fft->fft_out || !fft->window) {
        fft_engine_destroy(fft);
        return NULL;
    }

    /* Pre-computar ventana Blackman-Harris 4-term */
    double a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
    for (int n = 0; n < fft_size; n++) {
        double x = 2.0 * M_PI * n / (fft_size - 1);
        fft->window[n] = (float)(a0 - a1 * cos(x) + a2 * cos(2.0 * x) - a3 * cos(3.0 * x));
    }

    fft->norm_factor = 1.0f / ((float)fft_size * (float)fft_size);

    return fft;
}

void fft_engine_destroy(fft_engine_t *fft) {
    if (!fft) return;
    if (fft->cfg)     free(fft->cfg);
    if (fft->fft_in)  free(fft->fft_in);
    if (fft->fft_out) free(fft->fft_out);
    if (fft->window)  free(fft->window);
    free(fft);
}

int fft_engine_compute(fft_engine_t *fft, const iq_sample_t *iq_in,
                       float *power_dbfs_out) {
    if (!fft || !iq_in || !power_dbfs_out) return -1;

    int N = fft->fft_size;

    /* Paso 1: Calcular y remover DC (media del bloque) */
    float mean_re = 0.0f, mean_im = 0.0f;
    for (int i = 0; i < N; i++) {
        mean_re += iq_in[i].re;
        mean_im += iq_in[i].im;
    }
    mean_re /= (float)N;
    mean_im /= (float)N;

    /* Paso 2: Aplicar ventana y remover DC */
    for (int i = 0; i < N; i++) {
        fft->fft_in[i].r = (iq_in[i].re - mean_re) * fft->window[i];
        fft->fft_in[i].i = (iq_in[i].im - mean_im) * fft->window[i];
    }

    /* Paso 3: FFT */
    kiss_fft(fft->cfg, fft->fft_in, fft->fft_out);

    /* Paso 4 + 5: fftshift + potencia en dBFS */
    int half = N / 2;
    for (int i = 0; i < N; i++) {
        /* fftshift: indice k mapea al bin (i+half)%N de la FFT original */
        int k = (i + half) % N;
        float re = fft->fft_out[k].r;
        float im = fft->fft_out[k].i;
        float mag_sq = re * re + im * im;

        /* dBFS = 10*log10(mag_sq / N^2)
           El +1e-12 evita log(0) = -inf */
        power_dbfs_out[i] = 10.0f * log10f(mag_sq * fft->norm_factor + 1e-12f);
    }

    return 0;
}
