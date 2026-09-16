-- INTISAT web monitoring — ClickHouse schema.
-- Narrow/long table: one row per (timestamp, channel), same pattern as the
-- user's existing padsteam.senales_padsteam_h table (desc_variable/valor) —
-- easy to extend with new telemetry channels without ALTER TABLE.

CREATE DATABASE IF NOT EXISTS intisat;

CREATE TABLE IF NOT EXISTS intisat.telemetry (
    ts       DateTime64(3, 'UTC'),
    source   LowCardinality(String),   -- 'sim' | 'real'
    channel  LowCardinality(String),   -- e.g. 'sim.eps_batt_voltage', 'real.eps.bat_voltage_mv'
    value    Float64
) ENGINE = MergeTree
ORDER BY (channel, ts)
PARTITION BY toYYYYMM(ts);

-- Un satelite a la vez por ahora, pero se deja la columna para no migrar
-- despues si se suma un segundo (ver plan "Etapa 2").
ALTER TABLE intisat.telemetry ADD COLUMN IF NOT EXISTS satellite_id LowCardinality(String) DEFAULT '';

-- Log de mensajes recibidos, a nivel protocolo ya decodificado (no bytes
-- crudos sueltos) -- que tipo de paquete llego, de que satelite, si se
-- pudo decodificar. Se escribe en el mismo momento que llega el paquete.
CREATE TABLE IF NOT EXISTS intisat.messages (
    ts             DateTime64(3, 'UTC'),
    satellite_id   LowCardinality(String),
    source         LowCardinality(String),   -- 'sim' | 'real' | 'mcu' | 'sdr'
    pkt_type       UInt16,
    pkt_type_name  LowCardinality(String),
    decoded        UInt8,                     -- 0/1
    error          String,
    size_bytes     UInt32
) ENGINE = MergeTree
ORDER BY (satellite_id, ts)
PARTITION BY toYYYYMM(ts);
