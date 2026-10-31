/*
 * clock_recovery.h - Recuperacion de Reloj Mueller-Muller
 *
 * Despues del discriminador FM, tenemos ~13 muestras por simbolo.
 * Necesitamos encontrar el instante OPTIMO para muestrear cada simbolo.
 *
 * Mueller-Muller TED (Timing Error Detector):
 *   e[n] = prev_decision * current_interp - current_decision * prev_interp
 *
 * Este error alimenta un lazo PI (Proporcional-Integral) que ajusta
 * un NCO de timing para interpolar en el instante correcto.
 *
 * Salida: un valor "soft" por simbolo (pre-decision) y una decision
 *         binaria (+1/-1).
 */

#ifndef INTISAT_CLOCK_RECOVERY_H
#define INTISAT_CLOCK_RECOVERY_H

#include "config.h"

typedef struct {
    float mu;             /* offset fraccional del sample [0, 1)         */
    float omega;          /* samples por simbolo actual (se adapta)      */
    float omega_mid;      /* valor central de omega (nominal)            */
    float omega_gain;     /* ganancia del lazo para omega                */
    float mu_gain;        /* ganancia del lazo para mu                   */
    float omega_lim;      /* desviacion maxima permitida de omega_mid    */

    float prev_sample;    /* sample FM anterior (para interpolacion)     */
    float prev_symbol;    /* decision anterior (para M&M TED)            */
    float prev_interp;    /* valor interpolado anterior                  */

    int   counter;        /* countdown de samples hasta proximo simbolo  */
} clock_recovery_t;

/* Inicializa con la tasa de muestreo post-decimacion y el symbol rate.
   Ej: sample_rate=125000, symbol_rate=9600 -> omega_nom = 13.02 */
void clock_recovery_init(clock_recovery_t *cr, float sample_rate, float symbol_rate);

/* Resetea el estado interno (para cambio de configuracion). */
void clock_recovery_reset(clock_recovery_t *cr);

/* Alimenta un sample FM demodulado.
   Retorna 1 cuando se decide un simbolo.
   *soft_out = valor interpolado (pre-decision, util para SNR)
   El bit decidido es: soft_out > 0 ? 1 : 0 */
int clock_recovery_push(clock_recovery_t *cr, float sample, float *soft_out);

#endif /* INTISAT_CLOCK_RECOVERY_H */
