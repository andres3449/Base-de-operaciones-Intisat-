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
