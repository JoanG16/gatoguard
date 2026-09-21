-- Mapea cada gateway a un nombre de zona legible.
-- Ajusta los valores según cómo llamaste deviceID en cada M5Stack.
CREATE TABLE IF NOT EXISTS zonas (
    device_id   TEXT PRIMARY KEY,
    nombre_zona TEXT NOT NULL
);

INSERT INTO zonas (device_id, nombre_zona) VALUES
    ('M5_PISO_1_ESCRITORIO', 'Escritorio'),
    ('M5_PISO_1_COCINA', 'Cocina'),
    ('M5_PISO_1_COMEDOR', 'Comedor'),
    ('M5_PISO_1_SALA', 'Sala'),
    ('M5_PISO_1_DORMITORIO', 'Dormitorio'),
    ('M5_PISO_1_ARENA', 'Arenero')
ON CONFLICT (device_id) DO UPDATE SET nombre_zona = EXCLUDED.nombre_zona;

-- Guarda la última zona decidida por el algoritmo (una fila, se actualiza siempre).
CREATE TABLE IF NOT EXISTS estado_actual (
    mac             TEXT PRIMARY KEY,
    device_id       TEXT NOT NULL,
    nombre_zona     TEXT NOT NULL,
    rssi_promedio   NUMERIC(6,2) NOT NULL,
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Historial de cambios de zona (para revisar después qué tan seguido "saltó").
CREATE TABLE IF NOT EXISTS historial_zona (
    id              BIGSERIAL PRIMARY KEY,
    mac             TEXT NOT NULL,
    device_id       TEXT NOT NULL,
    nombre_zona     TEXT NOT NULL,
    rssi_promedio   NUMERIC(6,2) NOT NULL,
    cambiado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Patrón aprendido por franjas de 30 minutos.
CREATE TABLE IF NOT EXISTS rutinas_patron (
    mac               TEXT NOT NULL,
    dia_tipo          TEXT NOT NULL,
    franja_horaria    SMALLINT NOT NULL CHECK (franja_horaria BETWEEN 0 AND 47),
    nombre_zona       TEXT NOT NULL,
    tiempo_total_min  NUMERIC(10,2) NOT NULL DEFAULT 0,
    frecuencia_visitas INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (mac, dia_tipo, franja_horaria, nombre_zona)
);

-- Anomalías detectadas y su estado de resolución.
CREATE TABLE IF NOT EXISTS anomalias (
    id             BIGSERIAL PRIMARY KEY,
    mac            TEXT NOT NULL,
    tipo           TEXT NOT NULL,
    descripcion    TEXT NOT NULL,
    capa           SMALLINT NOT NULL DEFAULT 3,
    z_score        NUMERIC(8,3),
    if_score       NUMERIC(8,5),
    detectada_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
    resuelta_en   TIMESTAMPTZ
);

ALTER TABLE anomalias ADD COLUMN IF NOT EXISTS capa SMALLINT NOT NULL DEFAULT 3;
ALTER TABLE anomalias ADD COLUMN IF NOT EXISTS z_score NUMERIC(8,3);
ALTER TABLE anomalias ADD COLUMN IF NOT EXISTS if_score NUMERIC(8,5);
ALTER TABLE anomalias ADD COLUMN IF NOT EXISTS revisada_en TIMESTAMPTZ;
ALTER TABLE anomalias ADD COLUMN IF NOT EXISTS archivada_en TIMESTAMPTZ;
ALTER TABLE anomalias ADD COLUMN IF NOT EXISTS comentario TEXT;
ALTER TABLE anomalias ADD COLUMN IF NOT EXISTS falso_positivo BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS gato_config (
    mac TEXT PRIMARY KEY,
    nombre TEXT NOT NULL DEFAULT 'Michi',
    edad_anios NUMERIC(4,1),
    peso_kg NUMERIC(5,2),
    foto_url TEXT,
    horario_comida TEXT,
    horario_medicacion TEXT,
    zona_comida TEXT,
    zona_agua TEXT,
    zona_arenero TEXT,
    zona_descanso TEXT,
    avisos_alertas BOOLEAN NOT NULL DEFAULT true,
    avisos_sin_lecturas BOOLEAN NOT NULL DEFAULT true,
    umbral_sin_lecturas_segundos INTEGER NOT NULL DEFAULT 60
);

CREATE INDEX IF NOT EXISTS idx_anomalias_mac_estado
    ON anomalias (mac, resuelta_en, detectada_en DESC);

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
