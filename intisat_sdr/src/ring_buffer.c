/*
 * ring_buffer.c - Ring buffer SPSC lock-free
 *
 * Principio: usa indices atomicos de 32 bits que NUNCA se resetean.
 * El indice real en el array se obtiene con (idx & RING_BUF_MASK).
 * La diferencia write_idx - read_idx da la cantidad de datos disponibles.
 *
 * Como RING_BUF_SIZE es potencia de 2, la aritmetica modular funciona
 * correctamente incluso con overflow de uint32 (2^32 = 16384 vueltas
 * completas del buffer de 2^18 => 18 horas continuas a 250 ksps).
 */

#include "ring_buffer.h"
#include <string.h>

void ring_buf_init(ring_buffer_t *rb) {
    memset(rb->data, 0, sizeof(rb->data));
    atomic_store(&rb->write_idx, 0);
    atomic_store(&rb->read_idx, 0);
    atomic_store(&rb->overflow_count, 0);
}

uint32_t ring_buf_write_available(const ring_buffer_t *rb) {
    uint32_t w = atomic_load(&rb->write_idx);
    uint32_t r = atomic_load(&rb->read_idx);
    return RING_BUF_SIZE - (w - r);
}

uint32_t ring_buf_read_available(const ring_buffer_t *rb) {
    uint32_t w = atomic_load(&rb->write_idx);
    uint32_t r = atomic_load(&rb->read_idx);
    return w - r;
}

uint32_t ring_buf_write(ring_buffer_t *rb, const iq_sample_t *samples, uint32_t count) {
    uint32_t w = atomic_load_explicit(&rb->write_idx, memory_order_relaxed);
    uint32_t r = atomic_load_explicit(&rb->read_idx, memory_order_acquire);
    uint32_t available = RING_BUF_SIZE - (w - r);

    /* Si no hay espacio suficiente, avanzamos read (overwrite datos viejos) */
    if (count > available) {
        uint32_t overflow = count - available;
        atomic_fetch_add_explicit(&rb->read_idx, overflow, memory_order_release);
        atomic_fetch_add_explicit(&rb->overflow_count, 1, memory_order_relaxed);
    }

    /* Escribir samples al buffer circular */
    for (uint32_t i = 0; i < count; i++) {
        rb->data[(w + i) & RING_BUF_MASK] = samples[i];
    }

    /* Publicar la escritura (el consumidor vera los datos) */
    atomic_store_explicit(&rb->write_idx, w + count, memory_order_release);
    return count;
}

uint32_t ring_buf_read(ring_buffer_t *rb, iq_sample_t *out, uint32_t count) {
    uint32_t r = atomic_load_explicit(&rb->read_idx, memory_order_relaxed);
    uint32_t w = atomic_load_explicit(&rb->write_idx, memory_order_acquire);
    uint32_t available = w - r;

    if (count > available) {
        count = available;
    }
    if (count == 0) return 0;

    /* Leer samples del buffer circular */
    for (uint32_t i = 0; i < count; i++) {
        out[i] = rb->data[(r + i) & RING_BUF_MASK];
    }

    /* Publicar la lectura (el productor sabe que hay espacio) */
    atomic_store_explicit(&rb->read_idx, r + count, memory_order_release);
    return count;
}

uint32_t ring_buf_peek(const ring_buffer_t *rb, iq_sample_t *out, uint32_t count) {
    uint32_t r = atomic_load_explicit(&rb->read_idx, memory_order_relaxed);
    uint32_t w = atomic_load_explicit(&rb->write_idx, memory_order_acquire);
    uint32_t available = w - r;

    if (count > available) {
        count = available;
    }
    if (count == 0) return 0;

    for (uint32_t i = 0; i < count; i++) {
        out[i] = rb->data[(r + i) & RING_BUF_MASK];
    }

    /* NO avanzamos read_idx - es peek */
    return count;
}
