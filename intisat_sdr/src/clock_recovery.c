/*
 * clock_recovery.c - Recuperacion de Reloj Mueller-Muller
 *
 * Mueller-Muller TED funciona asi:
 *   1) Interpolamos linealmente entre samples para estimar el valor
 *      en el instante optimo de muestreo del simbolo.
 *   2) Calculamos el error de timing:
 *      e[n] = prev_decision * current_interp - current_decision * prev_interp
 *      (esto es cero cuando muestreamos en el pico del ojo)
 *   3) El error alimenta un lazo PI que ajusta:
 *      - omega: samples por simbolo (se adapta lentamente)
 *      - mu: offset fraccional dentro del sample (se adapta rapido)
 *
 * Parametros para 125 ksps / 9600 baud:
 *   omega_nominal = 13.02 samples/simbolo
 *   mu_gain = 0.01 (ancho de banda del lazo, tracking)
 *   mu_gain = 0.03 (ancho de banda del lazo, preamble/adquisicion)
 *
 * El lazo converge en ~20-50 simbolos tipicamente.
 */

#include "clock_recovery.h"
#include <math.h>

void clock_recovery_init(clock_recovery_t *cr, float sample_rate, float symbol_rate) {
    cr->omega_mid = sample_rate / symbol_rate;
    cr->omega = cr->omega_mid;
    cr->mu = 0.0f;
    cr->mu_gain = CR_MU_GAIN;
    cr->omega_gain = CR_OMEGA_GAIN;
    cr->omega_lim = CR_OMEGA_LIM;

    cr->prev_sample = 0.0f;
    cr->prev_symbol = 0.0f;
    cr->prev_interp = 0.0f;

    cr->counter = (int)cr->omega_mid;
}

void clock_recovery_reset(clock_recovery_t *cr) {
    float omega_mid = cr->omega_mid;  /* preservar nominal */
    cr->omega = omega_mid;
    cr->mu = 0.0f;
    cr->prev_sample = 0.0f;
    cr->prev_symbol = 0.0f;
    cr->prev_interp = 0.0f;
    cr->counter = (int)omega_mid;
}

int clock_recovery_push(clock_recovery_t *cr, float sample, float *soft_out) {
    cr->counter--;

    if (cr->counter > 0) {
        /* Todavia no es momento de decidir un simbolo */
        cr->prev_sample = sample;
        return 0;
    }

    /* ---- Instante de decision del simbolo ---- */

    /* Interpolacion lineal entre prev_sample y sample.
       mu = 0 -> usamos prev_sample, mu = 1 -> usamos sample */
    float interp = cr->prev_sample + cr->mu * (sample - cr->prev_sample);

    /* Decision dura (slicer) */
    float decision = (interp > 0.0f) ? 1.0f : -1.0f;

    /* Mueller-Muller Timing Error Detector:
       e = prev_sym * interp - sym * prev_interp
       Cuando estamos en el punto optimo, e tiende a cero */
    float error = (cr->prev_symbol * interp) - (decision * cr->prev_interp);

    /* Actualizar historia */
    cr->prev_symbol = decision;
    cr->prev_interp = interp;
    cr->prev_sample = sample;

    /* ---- Actualizar lazo PI ---- */

    /* Componente integral: ajusta omega (tracking lento de drift) */
    cr->omega += cr->omega_gain * error;

    /* Clamping de omega para estabilidad */
    if (cr->omega > cr->omega_mid + cr->omega_lim)
        cr->omega = cr->omega_mid + cr->omega_lim;
    if (cr->omega < cr->omega_mid - cr->omega_lim)
        cr->omega = cr->omega_mid - cr->omega_lim;

    /* Componente proporcional: ajusta mu (correccion rapida) */
    cr->mu += cr->mu_gain * error;

    /* Calcular cuantos samples esperar hasta el proximo simbolo */
    float next_advance = cr->omega + cr->mu;
    int advance = (int)floorf(next_advance);

    /* Mantener mu como la parte fraccional */
    cr->mu = next_advance - (float)advance;

    /* Asegurar que advance sea al menos 1 (evitar loop infinito) */
    if (advance < 1) advance = 1;
    cr->counter = advance;

    /* Salida */
    *soft_out = interp;
    return 1;  /* ¡simbolo listo! */
}
