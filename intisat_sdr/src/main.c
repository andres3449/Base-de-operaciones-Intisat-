/*
 * main.c - Entry point del backend SDR de IntiSat
 *
 * Este ejecutable es el "worker silencioso" que corre en background.
 * Python lo lanza como subprocess, le envia comandos por ZMQ,
 * y recibe datos procesados (FFT, paquetes) por ZMQ.
 *
 * Threads:
 *   1. Reader   -> Lee RTL-SDR o genera señal simulada
 *   2. DSP      -> NCO -> FIR -> FM -> Clock -> Sync -> Packet
 *   3. Command  -> Escucha comandos JSON de Python (ZMQ REP)
 *   (El FFT se calcula dentro del DSP thread para simplicidad)
 *
 * Uso:
 *   intisat_sdr [--simulated]
 *
 *   --simulated: Usa el generador de señal sintetica (default si no
 *                hay RTL-SDR compilado)
 */

#include "config.h"
#include "platform.h"
#include "ring_buffer.h"
#include "rtlsdr_reader.h"
#include "dsp_pipeline.h"
#include "zmq_transport.h"
#include "limesdr_tx.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>

/* ================================================================
 *  ESTADO GLOBAL
 * ================================================================ */

/* Ring buffer entre reader y DSP (global porque es grande: ~2 MB) */
static ring_buffer_t g_ring_buffer;

/* Configuracion runtime compartida entre todos los threads */
static runtime_config_t g_config;

/* Flag de quit global */
static volatile int g_quit = 0;

/* Handler de Ctrl+C para shutdown graceful */
static void signal_handler(int signum) {
    (void)signum;
    printf("\n[main] Señal de interrupcion recibida, cerrando...\n");
    g_quit = 1;
    atomic_store(&g_config.running, 0);
}

/* ================================================================
 *  INICIALIZACION DE CONFIG POR DEFECTO
 * ================================================================ */

static void init_default_config(runtime_config_t *cfg) {
    atomic_store(&cfg->running, 0);
    atomic_store(&cfg->generation, 0);

    atomic_store(&cfg->tune_freq_hz, (int)DEFAULT_TUNE_FREQ_HZ);
    atomic_store(&cfg->nco_shift_hz, (int)DEFAULT_NCO_SHIFT_HZ);
    atomic_store(&cfg->rf_gain_tenths, (int)(DEFAULT_RF_GAIN_DB * 10));

    atomic_store(&cfg->symbol_rate_sps, DEFAULT_SYMBOL_RATE_SPS);
    atomic_store(&cfg->freq_deviation_hz, DEFAULT_FREQ_DEVIATION_HZ);
    atomic_store(&cfg->rx_bandwidth_hz, DEFAULT_RX_BANDWIDTH_HZ);
    atomic_store(&cfg->packet_length, DEFAULT_PACKET_LENGTH);
    atomic_store(&cfg->modulation_type, MOD_2FSK);
    atomic_store(&cfg->tx_active, 0);

    cfg->sync_word[0] = DEFAULT_SYNC_WORD_0;
    cfg->sync_word[1] = DEFAULT_SYNC_WORD_1;
    cfg->sync_word[2] = DEFAULT_SYNC_WORD_2;
    cfg->sync_word[3] = DEFAULT_SYNC_WORD_3;
    cfg->sync_word_len = DEFAULT_SYNC_WORD_LEN;
}

/* ================================================================
 *  MAIN
 * ================================================================ */

int main(int argc, char *argv[]) {
    printf("===========================================\n");
    printf("  IntiSat SDR Backend v1.0\n");
    printf("  DSP Engine en C para Estacion Terrena\n");
    printf("===========================================\n\n");

    /* ---- Parsear argumentos ---- */
    device_type_t device_type = DEVICE_SIMULATED;  /* default: simulado */

#ifdef HAS_RTLSDR
    device_type = DEVICE_RTLSDR;  /* si tenemos librtlsdr, usar hardware */
#endif

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--simulated") == 0 || strcmp(argv[i], "-s") == 0) {
            device_type = DEVICE_SIMULATED;
        }
        else if (strcmp(argv[i], "--rtlsdr") == 0 || strcmp(argv[i], "-r") == 0) {
            device_type = DEVICE_RTLSDR;
        }
        else if (strcmp(argv[i], "--limesdr") == 0 || strcmp(argv[i], "-l") == 0) {
            device_type = DEVICE_LIMESDR;
        }
        else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            printf("Uso: %s [opciones]\n", argv[0]);
            printf("  --simulated, -s  Usar señal FSK simulada\n");
            printf("  --rtlsdr, -r     Usar hardware RTL-SDR\n");
            printf("  --limesdr, -l    Usar hardware LimeSDR\n");
            printf("  --help, -h       Mostrar esta ayuda\n");
            return 0;
        }
    }

    const char *dev_names[] = { "RTL-SDR", "SIMULADO", "LimeSDR" };
    printf("[main] Dispositivo: %s\n", dev_names[device_type]);

    /* ---- Timer de alta resolucion (Windows: 1ms en vez de 15ms) ---- */
    platform_enable_high_res_timer();

    /* ---- Signal handler ---- */
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    /* ---- Inicializar config ---- */
    init_default_config(&g_config);

    /* LimeSDR: sintonizar directo a la señal (no tiene DC spike como RTL-SDR) */
    if (device_type == DEVICE_LIMESDR) {
        atomic_store(&g_config.tune_freq_hz, (int)DEFAULT_SIGNAL_FREQ_HZ);
        atomic_store(&g_config.nco_shift_hz, 0);
        printf("[main] LimeSDR: tune directo a %.0f Hz, NCO offset = 0\n",
               DEFAULT_SIGNAL_FREQ_HZ);
    }

    /* ---- Inicializar ring buffer ---- */
    ring_buf_init(&g_ring_buffer);
    printf("[main] Ring buffer: %u samples (%.2f MB)\n",
           RING_BUF_SIZE, (float)(RING_BUF_SIZE * sizeof(iq_sample_t)) / (1024.0f * 1024.0f));

    /* ---- Inicializar ZMQ transport ---- */
    zmq_transport_t transport;
    if (zmq_transport_init(&transport) != 0) {
        fprintf(stderr, "[main] Error fatal: no se pudo inicializar ZMQ\n");
        return 1;
    }

    /* ---- Inicializar RTL-SDR reader ---- */
    rtlsdr_reader_t reader;
    reader_init(&reader, &g_ring_buffer, &g_config, device_type);

    if (reader_open(&reader) != 0) {
        fprintf(stderr, "[main] Error fatal: no se pudo abrir dispositivo\n");
        zmq_transport_destroy(&transport);
        return 1;
    }

    /* ---- Inicializar TX (solo LimeSDR) ---- */
    if (device_type == DEVICE_LIMESDR) {
        if (limesdr_tx_init(&reader) != 0) {
            fprintf(stderr, "[main] Warning: TX init fallo (RX seguira funcionando)\n");
        }
    }

    /* ---- Inicializar DSP pipeline ---- */
    dsp_pipeline_t dsp;
    dsp_pipeline_init(&dsp, &g_ring_buffer, &g_config,
                      (struct zmq_transport *)&transport);

    /* ---- Inicializar command thread context ---- */
    cmd_thread_ctx_t cmd_ctx;
    cmd_ctx.transport = &transport;
    cmd_ctx.config = &g_config;
    cmd_ctx.reader = &reader;
    cmd_ctx.quit_flag = (int *)&g_quit;

    /* ---- Lanzar threads ---- */
    thread_t reader_thread, dsp_thread, cmd_thread;

    printf("[main] Lanzando threads...\n");

    /* El command thread empieza de inmediato (para recibir START de Python) */
    if (platform_thread_create(&cmd_thread, cmd_thread_func, &cmd_ctx) != 0) {
        fprintf(stderr, "[main] Error: no se pudo crear command thread\n");
        goto cleanup;
    }

    /* El reader thread empieza a llenar el ring buffer */
    if (platform_thread_create(&reader_thread, reader_thread_func, &reader) != 0) {
        fprintf(stderr, "[main] Error: no se pudo crear reader thread\n");
        goto cleanup;
    }

    /* El DSP thread consume del ring buffer y procesa */
    if (platform_thread_create(&dsp_thread, dsp_thread_func, &dsp) != 0) {
        fprintf(stderr, "[main] Error: no se pudo crear DSP thread\n");
        goto cleanup;
    }

    printf("[main] Todos los threads corriendo. Esperando comandos...\n");
    printf("[main] (Ctrl+C para salir)\n\n");

    /* ---- Main loop: esperar hasta quit ---- */
    while (!g_quit) {
        platform_sleep_ms(100);
    }

    printf("\n[main] Cerrando...\n");

    /* ---- Shutdown ordenado ---- */
    atomic_store(&g_config.running, 0);

    /* Parar el reader primero (para que no siga llenando el ring buffer) */
    reader_request_stop(&reader);

    /* Esperar a que los threads terminen */
    platform_thread_join(reader_thread);
    printf("[main] Reader thread finalizado\n");

    /* El DSP thread saldra del loop cuando running=0 */
    /* Nota: el DSP thread tiene un while(1) que debemos interrumpir.
       Usamos g_quit como señal adicional en una version futura.
       Por ahora, esperamos un timeout razonable. */

    /* El command thread saldra cuando quit_flag=1 */

cleanup:
    limesdr_tx_close(&reader);
    reader_close(&reader);
    dsp_pipeline_destroy(&dsp);
    zmq_transport_destroy(&transport);

    platform_disable_high_res_timer();
    printf("[main] Proceso terminado limpiamente.\n");
    printf("[main] Total samples procesados: %llu\n",
           (unsigned long long)dsp.total_samples_processed);
    printf("[main] Total paquetes decodificados: %u\n",
           dsp.total_packets_decoded);

    return 0;
}
