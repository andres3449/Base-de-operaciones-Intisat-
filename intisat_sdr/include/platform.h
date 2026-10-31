/*
 * platform.h - Abstraccion Windows/Linux para threads, timing, prioridad
 *
 * Provee una API unificada para:
 *   - Crear/join threads
 *   - Dormir con precision de milisegundos
 *   - Elevar prioridad de thread
 *   - Timestamps de alta resolucion (microsegundos)
 */

#ifndef INTISAT_PLATFORM_H
#define INTISAT_PLATFORM_H

#include <stdint.h>

/* ---- Tipos de thread ---- */
#ifdef _WIN32
    #include <windows.h>
    typedef HANDLE           thread_t;
    typedef CRITICAL_SECTION mutex_t;
#else
    #include <pthread.h>
    typedef pthread_t        thread_t;
    typedef pthread_mutex_t  mutex_t;
#endif

/* Tipo de funcion para threads: recibe void*, retorna void* (POSIX-style) */
typedef void* (*thread_func_t)(void *arg);

/* ---- API ---- */

/* Activar timer de alta resolucion (Windows: 1ms en vez de 15ms).
   Llamar una vez al inicio del programa. Sin esto, Sleep(1) duerme ~15ms. */
void platform_enable_high_res_timer(void);
void platform_disable_high_res_timer(void);

/* Crea un thread. Retorna 0 en exito, -1 en error. */
int  platform_thread_create(thread_t *t, thread_func_t func, void *arg);

/* Espera a que el thread termine. */
void platform_thread_join(thread_t t);

/* Dormir milisegundos. */
void platform_sleep_ms(int ms);

/* Elevar prioridad del thread actual (para el reader de RTL-SDR). */
void platform_set_high_priority(void);

/* Timestamp en microsegundos desde epoch (o monotónico). */
uint64_t platform_timestamp_us(void);

/* Mutex basico */
void platform_mutex_init(mutex_t *m);
void platform_mutex_lock(mutex_t *m);
void platform_mutex_unlock(mutex_t *m);
void platform_mutex_destroy(mutex_t *m);

#endif /* INTISAT_PLATFORM_H */
