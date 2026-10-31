/*
 * sync_detect.h - Correlador de Sync Word por Shift Register
 *
 * Busca el patron de sincronizacion (hasta 32 bits) en el flujo
 * de bits demodulados usando un registro de desplazamiento.
 *
 * En cada bit nuevo:
 *   1) Se desplaza al registro
 *   2) Se hace XOR con el patron conocido
 *   3) Se cuenta bits diferentes (popcount = distancia Hamming)
 *   4) Si hamming <= SYNC_MAX_BIT_ERRORS -> ¡sync encontrado!
 *
 * Esto es O(1) por bit - mucho mas rapido que el bucle iterativo
 * que tenias en Python.
 */

#ifndef INTISAT_SYNC_DETECT_H
#define INTISAT_SYNC_DETECT_H

#include "config.h"

typedef struct {
    uint32_t sync_pattern;    /* patron de sync empaquetado MSB-first     */
    uint32_t sync_mask;       /* mascara de bits validos                  */
    int      sync_len;        /* longitud en bits (32 para 4-byte sync)  */
    uint32_t shift_reg;       /* registro de desplazamiento actual        */
    int      bits_received;   /* total de bits insertados                 */
} sync_detector_t;

/* Inicializa con los bytes del sync word.
   Ej: sync_bytes = {0xBA, 0x67, 0x54, 0x7E}, sync_byte_len = 4 */
void sync_init(sync_detector_t *s, const uint8_t *sync_bytes, int sync_byte_len);

/* Resetea el registro (para buscar un nuevo sync). */
void sync_reset(sync_detector_t *s);

/* Empuja un bit (0 o 1).
   Retorna >= 0 si sync detectado (el valor es la distancia Hamming).
   Retorna -1 si no hay match todavia. */
int sync_push_bit(sync_detector_t *s, int bit);

/* Popcount portable (funciona en GCC, Clang y MSVC). */
static inline int portable_popcount(uint32_t x) {
#if defined(__GNUC__) || defined(__clang__)
    return __builtin_popcount(x);
#elif defined(_MSC_VER)
    /* MSVC intrinsic */
    return (int)__popcnt(x);
#else
    /* Fallback software: Kernighan's bit counting */
    int count = 0;
    while (x) { x &= (x - 1); count++; }
    return count;
#endif
}

#endif /* INTISAT_SYNC_DETECT_H */
