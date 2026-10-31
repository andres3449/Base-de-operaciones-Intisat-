/*
 * packet_extract.c - Maquina de Estados para Extraccion de Paquetes
 *
 * Estados:
 *   HUNTING    -> cada bit se empuja al sync_detector. Al encontrar sync,
 *                 transiciona a COLLECTING.
 *   COLLECTING -> acumula bits MSB-first en payload[]. Al completar
 *                 packet_length bytes, invoca el callback y vuelve a HUNTING.
 *
 * La potencia IQ se acumula durante toda la vida del paquete para
 * calcular el RSSI promedio. El error de frecuencia se estima
 * promediando la salida del FM discriminador.
 */

#include "packet_extract.h"
#include "burst_detect.h"
#include "pn_dewhiten.h"
#include "config.h"
#include <string.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

void pkt_extract_init(packet_extractor_t *pe,
                      const uint8_t *sync_bytes, int sync_len,
                      int packet_length,
                      packet_callback_t cb, void *user_data) {
    sync_init(&pe->sync, sync_bytes, sync_len);
    pe->packet_length = packet_length;
    pe->callback = cb;
    pe->callback_data = user_data;

    pe->stream_buf = (uint8_t *)malloc(STREAM_MAX_BYTES);
    pe->stream_pos = 0;

    pkt_extract_reset(pe);
}

void pkt_extract_reset(packet_extractor_t *pe) {
    /* Flush partial stream if signal was lost mid-dump */
    if (pe->state == PKT_STATE_STREAM_COLLECTING && pe->stream_pos > 0 && pe->callback) {
        printf("[STREAM] Reset con %u bytes parciales — enviando fragmento\n",
               (unsigned)pe->stream_pos);
        fflush(stdout);
        uint32_t wh_bytes = pe->stream_pos < STREAM_PN9_BYTES
                            ? pe->stream_pos : STREAM_PN9_BYTES;
        pn_dewhiten(pe->stream_buf, (int)wh_bytes);
        pe->callback(pe->stream_buf, (int)pe->stream_pos,
                     -100.0f, 0.0f, 0xFF, pe->callback_data);
    }

    pe->state = PKT_STATE_HUNTING;
    sync_reset(&pe->sync);
    memset(pe->payload, 0, sizeof(pe->payload));
    pe->bits_collected = 0;
    pe->bits_needed = pe->packet_length * 8;
    pe->current_byte = 0;
    pe->bit_in_byte = 0;
    pe->last_sync_errors = 0;
    pe->power_acc = 0.0f;
    pe->power_count = 0;
    pe->freq_err_acc = 0.0f;
    pe->freq_err_count = 0;
    pe->power_ema = 0.0f;
    pe->stream_pos = 0;
}

void pkt_extract_push_bit(packet_extractor_t *pe, int bit, float fm_value) {
    switch (pe->state) {
    case PKT_STATE_HUNTING: {
        /* Empujar bit al detector de sync word */
        int result = sync_push_bit(&pe->sync, bit);

        if (result >= 0) {
            /* ¡Sync word encontrado! */
            printf("[SYNC OK ch%d] Sync detectado! hamming=%d, power=%.2e, shift_reg=0x%08X\n",
                   pe->ch_id, result, pe->power_ema, pe->sync.shift_reg);
            fflush(stdout);

            pe->last_sync_errors = result;
            pe->state = PKT_STATE_COLLECTING;
            pe->bits_collected = 0;
            pe->current_byte = 0;
            pe->bit_in_byte = 0;
            memset(pe->payload, 0, sizeof(pe->payload));

            /* Resetear acumuladores de RSSI y freq error para el paquete */
            pe->power_acc = 0.0f;
            pe->power_count = 0;
            pe->freq_err_acc = 0.0f;
            pe->freq_err_count = 0;

            /* Notify burst detector: sync found → RECEIVING */
            if (pe->burst_detect) {
                burst_detect_notify_sync((burst_detect_t *)pe->burst_detect);
            }
        }
        break;
    }

    case PKT_STATE_COLLECTING: {
        /* Acumular bits MSB-first en el buffer de payload */
        pe->current_byte = (pe->current_byte << 1) | (bit & 1);
        pe->bit_in_byte++;

        /* Acumular error de frecuencia (para estadisticas) */
        pe->freq_err_acc += fm_value;
        pe->freq_err_count++;

        if (pe->bit_in_byte >= 8) {
            /* Byte completo */
            int byte_idx = pe->bits_collected / 8;
            if (byte_idx < (int)sizeof(pe->payload)) {
                pe->payload[byte_idx] = (uint8_t)pe->current_byte;
            }
            pe->current_byte = 0;
            pe->bit_in_byte = 0;

            /* Longitud adaptativa: tras recibir el byte de longitud (byte 0),
             * ajustamos bits_needed al tamano real del paquete.
             * Esto permite recibir beacons de 20 bytes e imagenes de 120 bytes
             * sin reconfigurar nada — cada paquete es autodescrptivo. */
            if (byte_idx == 0) {
                int dyn_len = (int)pe->payload[0] + 1;  /* +1 incluye el propio length byte */
                if (dyn_len >= 2 && dyn_len < (int)sizeof(pe->payload)) {
                    pe->bits_needed = dyn_len * 8;
                }
            }
        }

        pe->bits_collected++;

        /* After first byte: detect TELEM_DUMP stream (0xFE = 0x01 OBC id whitened) */
        if (pe->bits_collected == 8 && pe->payload[0] == STREAM_FIRST_BYTE
            && pe->stream_buf != NULL) {
            printf("[STREAM] Stream TELEM_DUMP detectado (byte[0]=0x%02X) — cambiando a modo stream\n",
                   pe->payload[0]);
            fflush(stdout);
            pe->state = PKT_STATE_STREAM_COLLECTING;
            pe->stream_buf[0] = pe->payload[0];
            pe->stream_pos = 1;
            break;
        }

        if (pe->bits_collected >= pe->bits_needed) {
            /* ¡Paquete completo! Calcular RSSI y freq error */
            float rssi_db = -100.0f;  /* default si no hay datos de potencia */
            if (pe->power_count > 0) {
                float avg_power = pe->power_acc / (float)pe->power_count;
                rssi_db = 10.0f * log10f(avg_power + 1e-12f);
            }

            float freq_err_hz = 0.0f;
            if (pe->freq_err_count > 0) {
                /* El promedio del FM demod output da el offset de frecuencia
                   normalizado. Multiplicamos por fdev para obtener Hz. */
                freq_err_hz = pe->freq_err_acc / (float)pe->freq_err_count;
                /* Nota: freq_err_hz aqui esta normalizado a +/-1.0 = +/-fdev.
                   El caller puede multiplicar por fdev si necesita Hz reales. */
            }

            /* Calculo de longitud real: payload[0] es el length byte
               que el Si4463 WriteTxFifo prepone SIN whitenar.
               actual_length incluye el propio byte de longitud. */
            int actual_length = pe->payload[0] + 1;
            if (actual_length > (int)sizeof(pe->payload)) {
                actual_length = (int)sizeof(pe->payload);
            } else if (actual_length < 2) {
                actual_length = pe->bits_needed / 8;
            }

            /* De-whiten: payload[0] = length (NO whiteneado),
               payload[1..N] = datos (whiteneados con PN9).
               Solo de-whiteneamos los datos, NO el length byte. */
#if DEFAULT_WHT_ENABLE
            {
                int data_bytes = actual_length - 1;  /* bytes de datos sin el length */
                if (data_bytes > 0 && data_bytes < (int)sizeof(pe->payload)) {
                    pn_dewhiten(&pe->payload[1], data_bytes);
                }
            }
#endif

            /* Debug: mostrar paquete completo */
            {
                int collected_bytes = pe->bits_needed / 8;
                printf("[PKT] len_byte=%d  actual_send=%d  collected_in_buf=%d  pkt_length_cfg=%d  RSSI=%.1f dB\n",
                       pe->payload[0], actual_length, collected_bytes, pe->packet_length, rssi_db);
                printf("[PKT] FULL BUFFER (%d bytes collected):\n", collected_bytes);
                for (int k = 0; k < collected_bytes; k++) {
                    if (k % 16 == 0) printf("  [%03d] ", k);
                    printf("%02X ", pe->payload[k]);
                    if ((k + 1) % 16 == 0) printf("\n");
                }
                if (collected_bytes % 16 != 0) printf("\n");
                if (collected_bytes != actual_length) {
                    printf("[PKT] WARN: collected=%d pero se envia actual_length=%d (cap por pkt_length_cfg=%d)\n",
                           collected_bytes, actual_length, pe->packet_length);
                }
                fflush(stdout);
            }

            /* Invocar callback con el paquete completo */
            if (pe->callback) {
                pe->callback(
                    pe->payload,
                    actual_length,
                    rssi_db,
                    freq_err_hz,
                    pe->last_sync_errors,
                    pe->callback_data
                );
            }

            /* Notify burst detector: packet done → IDLE or SQUELCH_OPEN */
            if (pe->burst_detect) {
                burst_detect_notify_packet_done((burst_detect_t *)pe->burst_detect);
            }

            /* Volver a buscar el proximo sync word */
            pe->state = PKT_STATE_HUNTING;
            sync_reset(&pe->sync);
        }
        break;
    }

    case PKT_STATE_STREAM_COLLECTING: {
        /* Accumulate bits into stream_buf (large buffer for TELEM_DUMP) */
        pe->current_byte = (pe->current_byte << 1) | (bit & 1);
        pe->bit_in_byte++;

        pe->freq_err_acc += fm_value;
        pe->freq_err_count++;

        if (pe->bit_in_byte >= 8) {
            if (pe->stream_pos < STREAM_MAX_BYTES) {
                pe->stream_buf[pe->stream_pos++] = (uint8_t)pe->current_byte;
            }
            pe->current_byte = 0;
            pe->bit_in_byte  = 0;
        }

        pe->bits_collected++;

        if (pe->stream_pos >= STREAM_EXPECTED_BYTES) {
            /* Full TELEM_DUMP received */
            printf("[STREAM] Stream completo: %u bytes recibidos\n",
                   (unsigned)pe->stream_pos);
            fflush(stdout);

            /* PN9 de-whiten: STM32 only whitened first 255 bytes */
            pn_dewhiten(pe->stream_buf, STREAM_PN9_BYTES);

            float rssi_db = -100.0f;
            if (pe->power_count > 0)
                rssi_db = 10.0f * log10f(pe->power_acc / (float)pe->power_count + 1e-12f);

            if (pe->callback) {
                pe->callback(pe->stream_buf, (int)pe->stream_pos,
                             rssi_db, 0.0f,
                             0xFF,  /* magic marker → dsp_pipeline maps to SYNC_FOUND_STREAM */
                             pe->callback_data);
            }

            if (pe->burst_detect)
                burst_detect_notify_packet_done((burst_detect_t *)pe->burst_detect);

            pe->state    = PKT_STATE_HUNTING;
            pe->stream_pos = 0;
            sync_reset(&pe->sync);
        }
        break;
    }
    }
}

void pkt_extract_feed_power(packet_extractor_t *pe, float iq_power) {
    /* Update EMA for power gating (runs in ALL states) */
    pe->power_ema = SYNC_POWER_EMA_ALPHA * iq_power
                  + (1.0f - SYNC_POWER_EMA_ALPHA) * pe->power_ema;

    /* Accumulate power during packet reception for RSSI calculation */
    if (pe->state == PKT_STATE_COLLECTING ||
        pe->state == PKT_STATE_STREAM_COLLECTING) {
        pe->power_acc += iq_power;
        pe->power_count++;
    }
}
