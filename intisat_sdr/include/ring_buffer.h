/*
 * ring_buffer.h - Ring buffer SPSC (Single Producer, Single Consumer) lock-free
 *
 * El reader thread (productor) escribe IQ samples.
 * El DSP thread (consumidor) los lee.
 * No requiere mutex: usa atomicos para los indices.
 *
 * Tamaño: 2^18 = 262144 complex samples = ~1.05 segundos @ 250 ksps
 * Memoria: ~2 MB (262144 * 8 bytes por iq_sample_t)
 */

#ifndef INTISAT_RING_BUFFER_H
#define INTISAT_RING_BUFFER_H

#include "config.h"

typedef struct {
    iq_sample_t   data[RING_BUF_SIZE];   /* buffer circular de IQ          */
    atomic_uint   write_idx;             /* solo escrito por el productor   */
    atomic_uint   read_idx;              /* solo escrito por el consumidor  */
    atomic_uint   overflow_count;        /* contador de overflows           */
} ring_buffer_t;

/* Inicializa el ring buffer (pone indices en 0) */
void ring_buf_init(ring_buffer_t *rb);

/* Cuantos samples se pueden escribir sin pisar datos no leidos */
uint32_t ring_buf_write_available(const ring_buffer_t *rb);

/* Cuantos samples hay disponibles para leer */
uint32_t ring_buf_read_available(const ring_buffer_t *rb);

/* Escribe 'count' samples. Retorna cuantos realmente escribió.
   Si no hay espacio suficiente, descarta los más viejos (overwrite). */
uint32_t ring_buf_write(ring_buffer_t *rb, const iq_sample_t *samples, uint32_t count);

/* Lee hasta 'count' samples en 'out'. Retorna cuantos leyó.
   No bloquea: si no hay datos, retorna 0. */
uint32_t ring_buf_read(ring_buffer_t *rb, iq_sample_t *out, uint32_t count);

/* Peek: copia 'count' samples sin avanzar el read_idx.
   Util para el FFT que necesita una snapshot sin consumir. */
uint32_t ring_buf_peek(const ring_buffer_t *rb, iq_sample_t *out, uint32_t count);

#endif /* INTISAT_RING_BUFFER_H */
