/*
 * config.h - Constantes de compilacion y configuracion runtime del backend SDR
 *
 * IntiSat Ground Station - C DSP Backend
 * Todos los parametros del Si4463 y del pipeline DSP se definen aqui.
 */

#ifndef INTISAT_CONFIG_H
#define INTISAT_CONFIG_H

#include <stdint.h>
#include <stdatomic.h>

/* ================================================================
 *  RADIO DEFAULTS  (coinciden con radio_config_Si4463.h)
 * ================================================================ */

/* LimeSDR no tiene espiga DC significativa — sintonizamos directo a la señal.
   NCO shift = 0: el hardware LO ya apunta a la frecuencia exacta de la señal. */
#define DEFAULT_TUNE_FREQ_HZ      433500000.0   /* frecuencia del hardware SDR */
#define DEFAULT_SIGNAL_FREQ_HZ    433500000.0   /* frecuencia real de la señal */
#define DEFAULT_NCO_SHIFT_HZ      0.0           /* sin offset NCO necesario    */

#define DEFAULT_SAMPLE_RATE_HZ    250000.0
#define DEFAULT_RF_GAIN_DB        20.0

/* Parametros de modulacion Si4463 */
#define DEFAULT_SYMBOL_RATE_SPS   9600
#define DEFAULT_FREQ_DEVIATION_HZ 5000
#define DEFAULT_RX_BANDWIDTH_HZ   30000
#define DEFAULT_PACKET_LENGTH     255  /* max Si4463; longitud real se lee del byte[0] */

/* TELEM_DUMP stream support
 * STM32 transmits 326 snapshots x 184 bytes = 59984 bytes as one continuous
 * RF4463 infinite-length stream.  Only the first 255 bytes are PN9-whitened.
 * Detection: first byte after sync = 0x01 (OBC id) XOR PN9[0] = 0x01 XOR 0xFF = 0xFE */
#define STREAM_MAX_BYTES       65536   /* receive buffer (power-of-2 margin)    */
#define STREAM_EXPECTED_BYTES  59984   /* 326 x 184 — exact STM32 dump size     */
#define STREAM_PN9_BYTES         255   /* STM32 only whitens first 255 bytes     */
#define STREAM_FIRST_BYTE       0xFE   /* 0x01 XOR pn9_byte[0](=0xFF) = 0xFE   */
#define SYNC_FOUND_STREAM          2   /* sync_found marker for stream packets  */

/* Sync word: ON-AIR format (bit-reversed per byte from Si4463 API).
 * Si4463 API value: BA 67 54 7E  (what RF4463.c writes to chip registers)
 * On-air (LSB-first per byte): 5D E6 2A 7E  (what the SDR actually receives)
 * The sync detector correlates against raw over-the-air bits, so we MUST
 * use on-air format here. */
#define DEFAULT_SYNC_WORD_0       0x5D
#define DEFAULT_SYNC_WORD_1       0xE6
#define DEFAULT_SYNC_WORD_2       0x2A
#define DEFAULT_SYNC_WORD_3       0x7E
#define DEFAULT_SYNC_WORD_LEN     4

/* PN9 Whitening: x^9 + x^5 + 1, seed 0x01FF.
 * RF4463_TxPacket() aplica PN9 al payload en software ANTES de escribir al FIFO.
 * El byte de longitud (payload[0]) NO se whitenea.
 * El receptor de-whitenea payload[1..N] con la misma secuencia PN9. */
#define DEFAULT_WHT_ENABLE        1        /* 1=de-whiten payload, 0=skip */
#define DEFAULT_WHT_SEED          0x01FF   /* 9-bit seed, all ones */

/* ================================================================
 *  FFT
 * ================================================================ */
#define FFT_SIZE                  2048
#define FFT_TARGET_FPS            30   /* 30 fps = 1 FFT/chunk @ 250k sps, igual a SDR# */
#define FFT_FRAME_INTERVAL_MS     (1000 / FFT_TARGET_FPS)  /* 33 ms */

/* ================================================================
 *  FIR  (filtro pasabajos + decimacion)
 * ================================================================ */
#define FIR_NUM_TAPS              63
#define FIR_DECIMATION            2
#define FIR_CUTOFF_HZ             20000.0f

/* Tasa de muestreo post-decimacion */
#define DECIMATED_SAMPLE_RATE     (DEFAULT_SAMPLE_RATE_HZ / FIR_DECIMATION)
/* = 125000.0 sps => ~13.02 muestras/simbolo a 9600 baud
 * Con decimation=4 (6.5 sps/sym) habia bit-slips sistematicos.
 * Duplicar la resolucion temporal elimina esos slips. */

/* ================================================================
 *  DC BLOCKER  (single-pole IIR highpass on FM demod output)
 *
 *  y[n] = x[n] - x[n-1] + alpha * y[n-1]
 *  alpha=0.99 => fc~200 Hz, tau~0.8 ms @ 125 ksps
 *
 *  During BURST_RECEIVING the IIR state is FROZEN: prev_in and
 *  prev_out stop updating.  The DC offset estimate at sync time
 *  (= prev_in - alpha*prev_out) is applied as a fixed subtraction
 *  to every payload sample, preventing baseline wander on long
 *  runs of identical bits in AX.25/NRZI frames.
 * ================================================================ */
#define DC_BLOCKER_ALPHA          0.99f

/* ================================================================
 *  AGC  (Automatic Gain Control on IQ before FM demod)
 *
 *  Normalizes IQ envelope to ~1.0 so the FM discriminator and
 *  slicer thresholds work regardless of signal strength.
 *  Attack is fast (signal appears), decay is slow (signal fades).
 * ================================================================ */
#define AGC_TARGET_AMPLITUDE      1.0f
#define AGC_ATTACK_RATE           0.01f    /* fast convergence */
#define AGC_DECAY_RATE            0.0001f  /* slow release     */
#define AGC_INITIAL_GAIN          1.0f
#define AGC_MAX_GAIN              1e4f     /* prevent runaway  */

/* ================================================================
 *  CLOCK RECOVERY  (Mueller-Muller + phase retry)
 *
 *  MU_GAIN controla que tan rapido el lazo corrige el timing.
 *  CR_MU_GAIN = tracking mode (despues de sync, conservador).
 *  CR_PREAMBLE_MU_GAIN = acquisition mode (durante preambulo, agresivo).
 *  Si despues de 32 bits el preambulo no se ve bien (hamming > 8),
 *  se reintenta con la fase invertida (seed_mu + 0.5 simbolo).
 * ================================================================ */
#define CR_MU_GAIN                0.01f
#define CR_OMEGA_GAIN             (0.25f * CR_MU_GAIN * CR_MU_GAIN)
#define CR_OMEGA_LIM              0.1f

/* ================================================================
 *  RING BUFFER  (SPSC lock-free entre reader y DSP)
 * ================================================================ */
#define RING_BUF_ORDER            18                        /* 2^18 = 262144 */
#define RING_BUF_SIZE             (1u << RING_BUF_ORDER)    /* ~1.05 s @ 250ksps */
#define RING_BUF_MASK             (RING_BUF_SIZE - 1u)

/* ================================================================
 *  SYNC WORD DETECTION
 * ================================================================ */
#define SYNC_MAX_BIT_ERRORS       0     /* tolerancia hamming distance: 0 = match exacto.
                                         * Con 1 se multiplican los falsos positivos x17
                                         * (cada ventana de 16 bits tiene 16 vecinos a dist 1).
                                         * Mejor usar power gate para filtrar ruido. */

/* Power-gate: sync detection is INHIBITED when instantaneous IQ power
 * (EMA filtered) is below this threshold.  This prevents false sync
 * matches on noise.  The threshold is in linear power units (mag²).
 * Typical noise floor mag² ≈ 1e-6 (-60 dB), real signal ≈ 1e-4 (-40 dB).
 * Set to 0 to disable the gate. */
#define SYNC_POWER_GATE_THRESHOLD 0.0f   /* 0 = disabled for now, tuned at runtime */
#define SYNC_POWER_EMA_ALPHA      0.01f  /* EMA smoothing for power tracking */

/* ================================================================
 *  BURST DETECTOR  (adaptive noise floor + PQI preamble detect)
 *
 *  State machine: IDLE → SQUELCH_OPEN → PREAMBLE_LOCK → RECEIVING
 *  M&M clock recovery is FROZEN in IDLE/SQUELCH_OPEN and RUNNING
 *  in PREAMBLE_LOCK/RECEIVING.  The PQI (Preamble Quality Indicator)
 *  uses a delay-and-multiply correlator to detect the 1010 preamble
 *  pattern directly on the FM demod output, WITHOUT needing clock
 *  recovery to be locked.
 * ================================================================ */

/* Noise floor EMA alpha (slow, ~80ms time constant at 125 ksps).
   Only updates in IDLE state — signal bursts don't corrupt it. */
#define BURST_NOISE_EMA_ALPHA      0.0001f

/* Signal power EMA alpha (faster, ~0.5ms time constant at 125 ksps).
   Detects energy onset quickly for squelch triggering. */
#define BURST_SIGNAL_EMA_ALPHA     0.015f

/* Squelch margin: signal must exceed noise_floor * margin.
   2.0 ≈ +3 dB above noise floor.  The PQI preamble correlator acts as the
   real preamble detector; the energy gate just prevents wasting CPU cycles
   and M&M drift on obvious no-signal intervals.
   At 20 dB LimeSDR gain on a 433MHz satellite link at -65 dBm, beacons
   peak at 2-6x noise floor depending on conditions. */
#define BURST_SQUELCH_MARGIN       2.0f

/* Dropout time (ms): how long power must stay below threshold
   to close squelch.  Prevents brief fades from breaking lock. */
#define BURST_DROPOUT_MS           2.0f

/* PQI (Preamble Quality Indicator) EMA alpha.
   ~200 sample time constant = ~1.6ms = ~15 symbols.
   Balances responsiveness vs noise rejection. */
#define BURST_PQI_EMA_ALPHA        0.005f

/* PQI lock threshold: minimum EMA value to declare preamble found.
   After AGC, preamble delay-multiply product averages ~0.5.
   Set conservatively below that to work at lower SNR. */
#define BURST_PQI_LOCK_THRESHOLD   0.15f

/* PQI minimum hold: require PQI above threshold for this many
   symbol periods before declaring lock.  Eliminates interference
   spikes that briefly resemble preamble. */
#define BURST_PQI_MIN_SYMBOLS      4

/* M&M bandwidth during preamble convergence (fast).
   Tightens to CR_MU_GAIN once sync is found. */
#define CR_PREAMBLE_MU_GAIN        0.03f
#define CR_PREAMBLE_OMEGA_GAIN     (0.25f * CR_PREAMBLE_MU_GAIN * CR_PREAMBLE_MU_GAIN)

/* ================================================================
 *  ZMQ ENDPOINTS
 * ================================================================ */
#define ZMQ_PUB_ENDPOINT          "tcp://127.0.0.1:5555"
#define ZMQ_REP_ENDPOINT          "tcp://127.0.0.1:5556"

/* ================================================================
 *  TIPOS DE MODULACION
 * ================================================================ */
typedef enum {
    MOD_2FSK  = 0,
    MOD_2GFSK = 1,
    MOD_4FSK  = 2,
    MOD_4GFSK = 3,
} modulation_t;

/* ================================================================
 *  IQ SAMPLE  (complejo float, normalizado a [-1, +1])
 * ================================================================ */
typedef struct {
    float re;
    float im;
} iq_sample_t;

/* ================================================================
 *  RUNTIME CONFIG  (modificable en caliente via comandos ZMQ)
 *
 *  El command thread escribe atomicamente estos campos.
 *  El DSP thread los lee cada chunk de procesamiento.
 *  El campo 'generation' se incrementa en cada cambio para que
 *  el DSP detecte actualizaciones y reconfigure sus bloques.
 * ================================================================ */
typedef struct {
    atomic_int    running;             /* 0=parado, 1=corriendo           */
    atomic_int    generation;          /* se incrementa en cada cambio    */

    /* Frecuencias */
    atomic_int    tune_freq_hz;        /* freq del hardware SDR (int Hz)  */
    atomic_int    nco_shift_hz;        /* desplazamiento NCO digital      */

    /* Ganancia */
    atomic_int    rf_gain_tenths;      /* ganancia * 10 (para atomico)    */

    /* Demodulacion */
    atomic_int    symbol_rate_sps;
    atomic_int    freq_deviation_hz;
    atomic_int    rx_bandwidth_hz;
    atomic_int    packet_length;
    atomic_int    modulation_type;     /* modulation_t                    */

    /* Sync power gate: threshold * 10000 (int for atomic).
       0 = disabled.  Typical: 100 = 0.01 linear power. */
    atomic_int    sync_power_gate_tenths;

    /* TX burst flag: 1 durante transmision, 0 en idle */
    atomic_int    tx_active;

    /* Sync word (no es atomico - protegido por generation) */
    uint8_t       sync_word[4];
    int           sync_word_len;
} runtime_config_t;

/* ================================================================
 *  MENSAJES ZMQ  (estructuras empaquetadas para transmision)
 * ================================================================ */

/* Mensaje FFT: header + fft_size floats */
#pragma pack(push, 1)
typedef struct {
    uint32_t fft_size;
    float    center_freq_hz;    /* tune_freq + nco_shift (freq real) */
    float    sample_rate_hz;
    uint64_t timestamp_us;
    /* seguido por fft_size floats de potencia en dBFS */
} fft_msg_header_t;
#pragma pack(pop)

/* Mensaje de paquete decodificado */
#pragma pack(push, 1)
typedef struct {
    float    rssi_db;
    float    freq_error_hz;     /* error de frecuencia estimado */
    uint64_t timestamp_us;
    uint16_t payload_len;
    uint8_t  sync_found;
    uint8_t  bit_errors;        /* hamming distance al sync word */
    float    power_ema;         /* potencia IQ pre-AGC (EMA) al momento del sync */
    /* seguido por payload_len bytes del payload */
} pkt_msg_header_t;
#pragma pack(pop)

/* ================================================================
 *  DSP PROCESSING CHUNK SIZE
 *  Cuantos IQ samples procesa el DSP thread por iteracion.
 *  8192 samples = 32.77 ms @ 250 ksps (buen balance latencia/eficiencia)
 * ================================================================ */
#define DSP_CHUNK_SIZE            8192

#endif /* INTISAT_CONFIG_H */
