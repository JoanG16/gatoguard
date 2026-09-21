-- Ejecutar una vez en tu base de datos Postgres.
-- Si tienes TimescaleDB instalado, descomenta las líneas de hypertable (mejora rendimiento
-- a futuro, pero no es indispensable para el volumen de datos de esta prueba).

CREATE TABLE IF NOT EXISTS telemetria_raw (
    id          BIGSERIAL PRIMARY KEY,
    time        TIMESTAMPTZ NOT NULL DEFAULT now(),
    cliente_id  TEXT NOT NULL,
    device_id   TEXT NOT NULL,
    mac         TEXT NOT NULL,
    rssi        SMALLINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetria_mac_time ON telemetria_raw (mac, time DESC);
CREATE INDEX IF NOT EXISTS idx_telemetria_device_time ON telemetria_raw (device_id, time DESC);

CREATE TABLE IF NOT EXISTS gateways (
    id                  BIGSERIAL PRIMARY KEY,
    cliente_id          TEXT NOT NULL,
    device_id           TEXT NOT NULL UNIQUE,
    nombre              TEXT,
    nombre_zona         TEXT,
    icono               TEXT,
    wifi_ssid           TEXT,
    wifi_password       TEXT,
    mqtt_host           TEXT NOT NULL DEFAULT 'broker.hivemq.com',
    mqtt_port           INTEGER NOT NULL DEFAULT 1883,
    mqtt_user           TEXT,
    mqtt_password       TEXT,
    online              BOOLEAN NOT NULL DEFAULT false,
    ultimo_heartbeat    TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS beacons (
    mac                 TEXT PRIMARY KEY,
    nombre              TEXT,
    nombre_mascota      TEXT,
    icono               TEXT,
    mascota_id          TEXT,
    asignado            BOOLEAN NOT NULL DEFAULT false,
    ultimo_visto        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gateways_cliente ON gateways (cliente_id);
CREATE INDEX IF NOT EXISTS idx_beacons_asignado ON beacons (asignado, ultimo_visto DESC);

-- Si tienes la extensión timescaledb:
-- CREATE EXTENSION IF NOT EXISTS timescaledb;
-- SELECT create_hypertable('telemetria_raw', 'time', if_not_exists => TRUE, migrate_data => TRUE);
