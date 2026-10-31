/*
 * pn_dewhiten.c - PN Data De-Whitening 
 */

#include "pn_dewhiten.h"

void pn_dewhiten(uint8_t *data, int len) {
    uint16_t lfsr = PN9_SEED;

    for (int i = 0; i < len; i++) {
        uint8_t pn_byte = 0;
        
        // Generar 8 bits pseudoaleatorios para este byte
        for (uint8_t bit = 0; bit < 8; bit++) {
            // Tomar el bit de salida (bit 0 del LFSR)
            pn_byte |= (lfsr & 0x01) << bit;
            
            // Calcular el feedback usando el polinomio x^9 + x^5 + 1
            // XOR entre el bit 0 y el bit 5
            uint16_t feedback = ((lfsr >> 0) ^ (lfsr >> 5)) & 0x01;
            
            // Desplazar el registro e insertar el feedback en la posición más alta (bit 8)
            lfsr = (lfsr >> 1) | (feedback << 8);
        }
        
        // Aplicar XOR al byte recibido para recuperar los datos originales
        data[i] ^= pn_byte;
    }
}