/*
 * platform.c - Implementacion de abstraccion Windows/Linux
 */

#include "platform.h"
#include <stdio.h>

#ifdef _WIN32
#pragma comment(lib, "winmm.lib")
#endif

/* ================================================================
 *  THREADS
 * ================================================================ */

#ifdef _WIN32

int platform_thread_create(thread_t *t, thread_func_t func, void *arg) {
    *t = CreateThread(NULL, 0, (LPTHREAD_START_ROUTINE)func, arg, 0, NULL);
    return (*t != NULL) ? 0 : -1;
}

void platform_thread_join(thread_t t) {
    WaitForSingleObject(t, INFINITE);
    CloseHandle(t);
}

void platform_sleep_ms(int ms) {
    Sleep((DWORD)ms);
}

void platform_set_high_priority(void) {
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
}

uint64_t platform_timestamp_us(void) {
    LARGE_INTEGER freq, counter;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&counter);
    return (uint64_t)((double)counter.QuadPart / (double)freq.QuadPart * 1000000.0);
}

void platform_enable_high_res_timer(void) {
    /* Fuerza el scheduler de Windows a 1ms de resolucion.
       Sin esto, Sleep(1) duerme ~15.6ms y el DSP pierde data. */
    timeBeginPeriod(1);
}

void platform_disable_high_res_timer(void) {
    timeEndPeriod(1);
}

void platform_mutex_init(mutex_t *m)    { InitializeCriticalSection(m); }
void platform_mutex_lock(mutex_t *m)    { EnterCriticalSection(m); }
void platform_mutex_unlock(mutex_t *m)  { LeaveCriticalSection(m); }
void platform_mutex_destroy(mutex_t *m) { DeleteCriticalSection(m); }

#else /* POSIX (Linux, macOS) */

#include <unistd.h>
#include <time.h>
#include <sched.h>
#include <errno.h>

int platform_thread_create(thread_t *t, thread_func_t func, void *arg) {
    return pthread_create(t, NULL, func, arg) == 0 ? 0 : -1;
}

void platform_thread_join(thread_t t) {
    pthread_join(t, NULL);
}

void platform_sleep_ms(int ms) {
    usleep((useconds_t)ms * 1000);
}

void platform_set_high_priority(void) {
    struct sched_param param;
    param.sched_priority = sched_get_priority_max(SCHED_FIFO);
    if (pthread_setschedparam(pthread_self(), SCHED_FIFO, &param) != 0) {
        /* Si no tenemos permisos, al menos subimos niceness */
        fprintf(stderr, "[platform] Warning: no se pudo elevar prioridad (necesita root)\n");
    }
}

uint64_t platform_timestamp_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000ULL + (uint64_t)ts.tv_nsec / 1000ULL;
}

void platform_enable_high_res_timer(void)  { /* Linux ya tiene 1ms por defecto */ }
void platform_disable_high_res_timer(void) { }

void platform_mutex_init(mutex_t *m)    { pthread_mutex_init(m, NULL); }
void platform_mutex_lock(mutex_t *m)    { pthread_mutex_lock(m); }
void platform_mutex_unlock(mutex_t *m)  { pthread_mutex_unlock(m); }
void platform_mutex_destroy(mutex_t *m) { pthread_mutex_destroy(m); }

#endif
