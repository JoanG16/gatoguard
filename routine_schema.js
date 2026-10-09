async function ensureRoutineDetailSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rutina_detalle (
      mac TEXT NOT NULL,
      franja_5min SMALLINT NOT NULL CHECK (franja_5min BETWEEN 0 AND 287),
      nombre_zona TEXT NOT NULL,
      dias_observados SMALLINT NOT NULL DEFAULT 0,
      frecuencia_visitas INTEGER NOT NULL DEFAULT 0,
      visitas_completas INTEGER NOT NULL DEFAULT 0,
      duracion_total_seg NUMERIC(12,2) NOT NULL DEFAULT 0,
      dias_aprendizaje SMALLINT NOT NULL DEFAULT 0,
      aprendizaje_completo BOOLEAN NOT NULL DEFAULT FALSE,
      visitas_aprendizaje INTEGER NOT NULL DEFAULT 0,
      visitas_completas_aprendizaje INTEGER NOT NULL DEFAULT 0,
      duracion_aprendizaje_seg NUMERIC(12,2) NOT NULL DEFAULT 0,
      dias_reconfirmacion SMALLINT NOT NULL DEFAULT 0,
      visitas_reconfirmacion INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (mac, franja_5min, nombre_zona)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rutina_estado (
      mac TEXT PRIMARY KEY,
      inicio_aprendizaje TIMESTAMPTZ NOT NULL,
      fin_aprendizaje TIMESTAMPTZ NOT NULL,
      fin_reconfirmacion TIMESTAMPTZ NOT NULL,
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_rutina_detalle_mac_slot ON rutina_detalle (UPPER(TRIM(mac)), franja_5min)');
}

module.exports = { ensureRoutineDetailSchema };
