/*
 * pn_dewhiten.h - PN Data De-Whitening (Software PN9)
 */

#ifndef INTISAT_PN_DEWHITEN_H
#define INTISAT_PN_DEWHITEN_H

#include <stdint.h>

// Semilla exacta utilizada en el transmisor (RF4463.c)
#define PN9_SEED 0x01FF

/*
 * Desblanquea (o blanquea) un buffer de bytes en el mismo lugar.
 * Utiliza un LFSR PN9: x^9 + x^5 + 1.
 *
 * Parámetros:
 * data - puntero al buffer de datos recibidos.
 * len  - longitud de los datos en bytes.
 */
void pn_dewhiten(uint8_t *data, int len);

#endif /* INTISAT_PN_DEWHITEN_H */