/*
 * limesdr_reader.h - Declaraciones para soporte LimeSDR
 *
 * Funciones llamadas desde rtlsdr_reader.c cuando
 * device_type == DEVICE_LIMESDR.
 */

#ifndef INTISAT_LIMESDR_READER_H
#define INTISAT_LIMESDR_READER_H

#include "rtlsdr_reader.h"

int  limesdr_open(rtlsdr_reader_t *r);
void limesdr_reader_loop(rtlsdr_reader_t *r);
void limesdr_close(rtlsdr_reader_t *r);
int  limesdr_set_frequency(rtlsdr_reader_t *r, uint32_t freq_hz);
int  limesdr_set_gain(rtlsdr_reader_t *r, int gain_tenths);

#endif /* INTISAT_LIMESDR_READER_H */
