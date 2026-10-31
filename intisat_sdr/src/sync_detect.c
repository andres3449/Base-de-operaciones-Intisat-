/*
 * sync_detect.c - Correlador de Sync Word por Shift Register
 *
 * Complejidad: O(1) por bit (una operacion XOR + popcount).
 * Tu implementacion anterior en Python era O(N*sync_len) por buffer.
 *
 * Ejemplo con sync word 0x5DE62A7E (4 bytes, on-air format):
 *
 *   Shift register:     [0101 1101 1110 0110 0010 1010 0111 1110]
 *   XOR con patron:      0000 0000 0000 0000 0000 0000 0000 0000 = 0 errores
 *   => ¡SYNC DETECTADO! (hamming distance = 0)
 *
 * Con SYNC_MAX_BIT_ERRORS=1 toleramos 1 bit corrupto.
 */

#include "sync_detect.h"
#include <string.h>

void sync_init(sync_detector_t *s, const uint8_t *sync_bytes, int sync_byte_len) {
    /* Empaquetar bytes del sync word en un uint32 (MSB first) */
    s->sync_pattern = 0;
    s->sync_len = sync_byte_len * 8;

    for (int i = 0; i < sync_byte_len; i++) {
        s->sync_pattern = (s->sync_pattern << 8) | sync_bytes[i];
    }

    /* Mascara: solo los bits validos del sync word */
    if (s->sync_len >= 32) {
        s->sync_mask = 0xFFFFFFFF;
    } else {
        s->sync_mask = (1u << s->sync_len) - 1u;
    }

    sync_reset(s);
}

void sync_reset(sync_detector_t *s) {
    s->shift_reg = 0;
    s->bits_received = 0;
}

int sync_push_bit(sync_detector_t *s, int bit) {
    /* Desplazar un bit a la izquierda, insertar nuevo bit en LSB */
    s->shift_reg = ((s->shift_reg << 1) | (bit & 1)) & s->sync_mask;
    s->bits_received++;

    /* No podemos detectar sync hasta tener suficientes bits */
    if (s->bits_received < s->sync_len) {
        return -1;
    }

    /* XOR: bits diferentes = 1, iguales = 0 */
    uint32_t diff = s->shift_reg ^ s->sync_pattern;

    /* Contar bits diferentes (distancia Hamming) */
    int errors = portable_popcount(diff);

    /* Match si la distancia es menor o igual al umbral */
    if (errors <= SYNC_MAX_BIT_ERRORS) {
        return errors;  /* 0 = match perfecto, 1 = 1 bit de error */
    }

    return -1;  /* no match */
}
