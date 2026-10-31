/*
 * fir_filter.c - Filtro FIR Pasabajos con Decimacion
 *
 * Diseño: windowed-sinc con ventana Blackman.
 *
 * La funcion sinc ideal (rect en frecuencia) se trunca y se multiplica
 * por la ventana Blackman para reducir ripple en la banda de paso
 * y mejorar la atenuacion en la banda de rechazo (-58 dB minimo).
 *
 * La decimacion se hace "polyphase-style" implicitamente: solo calculamos
 * la convolucion cada M samples (el filtro anti-aliasing es el mismo FIR).
 *
 * Para 250ksps -> 62.5ksps (M=4), solo hacemos 62500 convoluciones/segundo
 * en vez de 250000, ahorrando ~75% de CPU.
 */

#include "fir_filter.h"
#include <math.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

void fir_design_lpf(fir_filter_t *f, float cutoff_hz, float sample_rate_hz, int decimation) {
    int N = FIR_NUM_TAPS;
    int M = N - 1;
    float fc = cutoff_hz / sample_rate_hz;  /* frecuencia normalizada */
    float sum = 0.0f;

    for (int n = 0; n < N; n++) {
        float h;

        /* Funcion sinc: h[n] = sin(2*PI*fc*(n - M/2)) / (PI*(n - M/2)) */
        if (n == M / 2) {
            h = 2.0f * fc;  /* limite cuando n -> M/2 */
        } else {
            float x = (float)n - (float)M / 2.0f;
            h = sinf(2.0f * (float)M_PI * fc * x) / ((float)M_PI * x);
        }

        /* Ventana Blackman:
           w[n] = 0.42 - 0.50*cos(2*PI*n/M) + 0.08*cos(4*PI*n/M)
           Atenuacion de stopband: ~58 dB (suficiente para nuestro caso) */
        float w = 0.42f - 0.50f * cosf(2.0f * (float)M_PI * (float)n / (float)M)
                        + 0.08f * cosf(4.0f * (float)M_PI * (float)n / (float)M);

        f->coeffs[n] = h * w;
        sum += f->coeffs[n];
    }

    /* Normalizar para ganancia unitaria en DC */
    for (int n = 0; n < N; n++) {
        f->coeffs[n] /= sum;
    }

    f->decimation = decimation;
    fir_reset(f);
}

void fir_reset(fir_filter_t *f) {
    memset(f->delay_line, 0, sizeof(f->delay_line));
    f->delay_idx = 0;
    f->decim_counter = 0;
}

int fir_push_sample(fir_filter_t *f, iq_sample_t in, iq_sample_t *out) {
    /* Insertar sample en la linea de retardo circular */
    f->delay_line[f->delay_idx] = in;
    f->delay_idx = (f->delay_idx + 1) % FIR_NUM_TAPS;

    f->decim_counter++;

    /* Solo calculamos la salida cada M samples (decimacion) */
    if (f->decim_counter >= f->decimation) {
        f->decim_counter = 0;

        /* Convolucion: sum(coeff[k] * delay[n-k]) */
        float acc_re = 0.0f;
        float acc_im = 0.0f;
        int idx = f->delay_idx;

        for (int k = 0; k < FIR_NUM_TAPS; k++) {
            /* Retroceder circularmente en la delay line */
            idx = (idx == 0) ? FIR_NUM_TAPS - 1 : idx - 1;
            acc_re += f->coeffs[k] * f->delay_line[idx].re;
            acc_im += f->coeffs[k] * f->delay_line[idx].im;
        }

        out->re = acc_re;
        out->im = acc_im;
        return 1;  /* sample de salida listo */
    }
    return 0;  /* esperando decimacion */
}

int fir_process_block(fir_filter_t *f, const iq_sample_t *in, int count,
                      iq_sample_t *out) {
    int out_count = 0;

    for (int i = 0; i < count; i++) {
        iq_sample_t result;
        if (fir_push_sample(f, in[i], &result)) {
            out[out_count++] = result;
        }
    }

    return out_count;
}
