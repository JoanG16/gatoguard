require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const mqtt = require('mqtt');
const {
  DUPLICATE_ZONE,
  DEVICE_CONFLICT,
  DEVICE_DELETED,
  ensureGatewayRegistrySchema,
  validateGatewayZone,
  registerGateway,
  updateGatewayZone,
  deleteGateway
} = require('./gateway_registry');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 10000, query_timeout: 10000 });
pool.on('error', (err) => console.error('[ERROR] Pool de Postgres:', err.message));
const mqttClient = mqtt.connect(process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883');
mqttClient.on('error', err => console.error('[MQTT] Error en canal de configuración:', err.message));
const app = express();
const PORT_CANDIDATES = Array.from(new Set([Number(process.env.PORT || process.env.DASHBOARD_PORT || 3000), 3001, 3002, 3003, 3010]));
app.use(express.json());
app.get('/api/health', (req, res) => res.json({ ok: true }));

async function ensureDeviceSchema() {
  try {
    await ensureGatewayRegistrySchema(pool);
    await pool.query('ALTER TABLE gateways ADD COLUMN IF NOT EXISTS icono TEXT');
    await pool.query('ALTER TABLE gateways ADD COLUMN IF NOT EXISTS nombre TEXT');
    await pool.query('ALTER TABLE beacons ADD COLUMN IF NOT EXISTS nombre_mascota TEXT');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS beacons_bloqueados (
        mac TEXT PRIMARY KEY,
        bloqueado_en TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Calendario/agenda: recordatorios que el usuario activa para un día y hora concretos.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recordatorios (
        id SERIAL PRIMARY KEY,
        mac TEXT NOT NULL,
        fecha DATE NOT NULL,
        hora TIME NOT NULL,
        titulo TEXT NOT NULL,
        notificar BOOLEAN NOT NULL DEFAULT true,
        notificado BOOLEAN NOT NULL DEFAULT false,
        creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query('UPDATE gateways SET nombre = COALESCE(nombre, nombre_zona) WHERE nombre IS NULL AND nombre_zona IS NOT NULL');
    await pool.query('UPDATE beacons SET nombre_mascota = COALESCE(nombre_mascota, nombre) WHERE nombre_mascota IS NULL AND nombre IS NOT NULL');
    // Las primeras lecturas se guardaron con distinta capitalización de MAC.
    // Conservamos el estado más reciente y dejamos todas las tablas con una grafía única.
    await pool.query(`
      DELETE FROM estado_actual antiguo
      USING estado_actual reciente
      WHERE UPPER(antiguo.mac) = UPPER(reciente.mac)
        AND (
          antiguo.actualizado_en < reciente.actualizado_en
          OR (
            antiguo.actualizado_en = reciente.actualizado_en
            AND antiguo.ctid < reciente.ctid
          )
        )
    `);
    await pool.query('UPDATE estado_actual SET mac = UPPER(mac) WHERE mac <> UPPER(mac)');
    await pool.query('UPDATE historial_zona SET mac = UPPER(mac) WHERE mac <> UPPER(mac)');
    await pool.query('UPDATE anomalias SET mac = UPPER(mac) WHERE mac <> UPPER(mac)');
    await pool.query('UPDATE rutinas_patron SET mac = UPPER(mac) WHERE mac <> UPPER(mac)');
  } catch (err) {
    console.error('[ERROR] ensureDeviceSchema:', err.message);
  }
}

ensureDeviceSchema();

// Mantiene la tabla `zonas` (device_id -> nombre_zona) sincronizada con `gateways`.
// zone_detector.js y anomaly_detector.js resuelven el nombre de la zona a partir de esta tabla,
// así que cualquier gateway creado/editado desde la app debe reflejarse aquí para que:
//  - si el nombre coincide (sin distinguir mayúsculas/espacios) con una zona que ya existe o que
//    ya tiene rutina aprendida, el sistema reutilice esa grafía exacta y "reconozca" la zona
//  - si es un nombre nuevo, quede disponible como zona nueva (sin datos de rutina todavía)
async function sincronizarZonaDesdeGateway(device_id, nombre_zona) {
  const nombreEscrito = (nombre_zona || device_id || '').trim();
  if (!nombreEscrito) return;
  try {
    let nombreFinal = nombreEscrito;

    const { rows: zonaExistente } = await pool.query(
      `SELECT nombre_zona FROM zonas
       WHERE device_id <> $1 AND LOWER(TRIM(nombre_zona)) = LOWER($2)
       LIMIT 1`,
      [device_id, nombreEscrito]
    );
    if (zonaExistente[0]) {
      nombreFinal = zonaExistente[0].nombre_zona;
    } else {
      const { rows: rutinaExistente } = await pool.query(
        `SELECT nombre_zona FROM rutinas_patron
         WHERE LOWER(TRIM(nombre_zona)) = LOWER($1)
         LIMIT 1`,
        [nombreEscrito]
      );
      if (rutinaExistente[0]) {
        nombreFinal = rutinaExistente[0].nombre_zona;
      }
    }

    await pool.query(
      `INSERT INTO zonas (device_id, nombre_zona)
       VALUES ($1, $2)
       ON CONFLICT (device_id) DO UPDATE SET nombre_zona = EXCLUDED.nombre_zona`,
      [device_id, nombreFinal]
    );
  } catch (err) {
    console.error('[ERROR] sincronizarZonaDesdeGateway:', err.message);
  }
}

async function obtenerNombreZonaCanonico(executor, nombre_zona) {
  const { rows: zonasExistentes } = await executor.query(
    `SELECT nombre_zona FROM zonas
     WHERE LOWER(TRIM(nombre_zona)) = LOWER(TRIM($1))
     ORDER BY device_id
     LIMIT 1`,
    [nombre_zona]
  );
  if (zonasExistentes[0]) return zonasExistentes[0].nombre_zona;

  const { rows: rutinasExistentes } = await executor.query(
    `SELECT nombre_zona FROM rutinas_patron
     WHERE LOWER(TRIM(nombre_zona)) = LOWER(TRIM($1))
     ORDER BY nombre_zona
     LIMIT 1`,
    [nombre_zona]
  );
  return rutinasExistentes[0]?.nombre_zona || nombre_zona.trim();
}

async function validarZonaGateway(executor, { cliente_id, device_id, nombre_zona }) {
  const nombreIngresado = nombre_zona.trim();
  const nombreNormalizado = nombreIngresado.toLocaleLowerCase('es');

  await executor.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`gateway-zone:${cliente_id}:${nombreNormalizado}`]
  );

  const nombreCanonico = await obtenerNombreZonaCanonico(executor, nombreIngresado);
  const { rows: gatewaysActivos } = await executor.query(
    `SELECT device_id FROM (
       SELECT g.device_id, 1 AS prioridad
       FROM gateways g
       LEFT JOIN (
         SELECT device_id, MAX(time) AS ultimo_dato
         FROM telemetria_raw
         GROUP BY device_id
       ) t ON t.device_id = g.device_id
       WHERE g.cliente_id = $1
         AND g.device_id <> $2
         AND LOWER(TRIM(g.nombre_zona)) = LOWER(TRIM($3))
         AND (
           NULLIF(TRIM(g.wifi_ssid), '') IS NOT NULL
           OR t.ultimo_dato > now() - interval '15 seconds'
         )
       UNION ALL
       SELECT z.device_id, 2 AS prioridad
       FROM zonas z
       JOIN (
         SELECT device_id, MAX(time) AS ultimo_dato
         FROM telemetria_raw
         GROUP BY device_id
       ) t ON t.device_id = z.device_id
       WHERE z.device_id <> $2
         AND LOWER(TRIM(z.nombre_zona)) = LOWER(TRIM($3))
         AND t.ultimo_dato > now() - interval '15 seconds'
     ) ocupacion
     ORDER BY prioridad, device_id
     LIMIT 1`,
    [cliente_id, device_id, nombreCanonico]
  );

  return {
    nombre_zona: nombreCanonico,
    gateway_en_uso: gatewaysActivos[0]?.device_id || null
  };
}

function duracionLegible(segundos) {
  if (segundos < 60) return `${segundos} segundos`;
  const minutos = segundos / 60;
  if (minutos < 60) return `${Math.round(minutos)} minutos`;
  const horas = minutos / 60;
  if (horas < 24) return `${Math.floor(horas)} h ${Math.round(minutos % 60)} min`;
  return `${Math.floor(horas / 24)} días ${Math.floor(horas % 24)} h`;
}

function descripcionHistorica(descripcion) {
  return descripcion
    .replace('Michi está en', 'Michi estuvo en')
    .replace(/Lleva allí ([^.]+)\./, 'Estuvo allí durante $1.');
}

app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

async function obtenerMacAsignada(valor) {
  if (!valor) return null;
  const { rows } = await pool.query(
    'SELECT UPPER(TRIM(mac)) AS mac FROM beacons WHERE asignado = true AND UPPER(TRIM(mac)) = UPPER(TRIM($1)) LIMIT 1',
    [String(valor).trim()]
  );
  return rows[0]?.mac || null;
}

async function obtenerMacFiltroHome(req) {
  const valor = req.query.gato || req.query.mac || req.query.mascota;
  if (!valor || ['all', 'todos', 'todas', 'todo'].includes(String(valor).trim().toLowerCase())) return null;
  return await obtenerMacAsignada(valor) || '__UNREGISTERED_BEACON__';
}

app.get('/api/gatos', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (UPPER(TRIM(mac)))
              UPPER(TRIM(mac)) AS mac,
              COALESCE(nombre_mascota, nombre, 'Mascota') AS nombre,
              COALESCE(icono, 'pets') AS icono
       FROM beacons
       WHERE asignado = true
       ORDER BY UPPER(TRIM(mac)), ultimo_visto DESC NULLS LAST, updated_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[ERROR] /api/gatos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/estado', async (req, res) => {
  try {
    const mac = await obtenerMacFiltroHome(req);
    // Unimos `gateways` (fuente de verdad de la app) con `zonas` (fuente legacy usada por
    // zone_detector.js/anomaly_detector.js) para que el Home muestre TODAS las zonas conocidas,
    // incluidas las que ya tienen rutina aprendida pero todavía no tienen un gateway propio
    // registrado desde la app. Deduplicamos por nombre de zona (sin distinguir mayúsculas)
    // priorizando siempre el gateway real cuando existe, para no mostrar la misma zona dos veces.
    const { rows } = await pool.query(
      `WITH combinado AS (
         SELECT g.device_id, g.nombre_zona, g.icono, 1 AS prioridad
         FROM gateways g
         UNION ALL
         SELECT z.device_id, z.nombre_zona, NULL AS icono, 2 AS prioridad
         FROM zonas z
         WHERE NOT EXISTS (
           SELECT 1 FROM gateways g2
           WHERE LOWER(TRIM(g2.nombre_zona)) = LOWER(TRIM(z.nombre_zona))
         )
       ),
       unico AS (
         SELECT DISTINCT ON (LOWER(TRIM(nombre_zona))) *
         FROM combinado
         ORDER BY LOWER(TRIM(nombre_zona)), prioridad ASC
       )
       SELECT u.device_id,
              u.nombre_zona,
              COALESCE(u.icono, 'location_on') AS icono,
              e.mac,
              e.rssi_promedio,
              e.actualizado_en
       FROM unico u
       LEFT JOIN estado_actual e
         ON e.device_id = u.device_id
        AND EXISTS (
          SELECT 1 FROM beacons b
          WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = UPPER(TRIM(e.mac))
        )
        AND ($1::text IS NULL OR UPPER(TRIM(e.mac)) = UPPER(TRIM($1)))
       ORDER BY u.nombre_zona ASC`,
      [mac]
    );
    res.json(rows);
  } catch (err) {
    console.error('[ERROR] /api/estado:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function publicarConfigGateway(registro) {
  if (!mqttClient.connected || !registro.provisioning_token) return;
  const topic = `telemetria/${registro.cliente_id}/${registro.device_id}/gateway/config`;
  const payload = JSON.stringify({
    provisioning_token: registro.provisioning_token,
    nombre_zona: registro.nombre_zona,
    config_version: registro.config_version,
    deleted: Boolean(registro.deleted)
  });
  mqttClient.publish(topic, payload, { qos: 1, retain: true }, error => {
    if (error) console.error('[MQTT] No se pudo publicar la configuración del gateway:', error.message);
  });
}

mqttClient.on('connect', async () => {
  try {
    await ensureGatewayRegistrySchema(pool);
    const { rows } = await pool.query(
      `SELECT cliente_id, device_id, provisioning_token, nombre_zona, config_version, deleted
       FROM gateway_registry
       WHERE provisioning_token <> ''`
    );
    rows.forEach(publicarConfigGateway);
  } catch (err) {
    console.error('[MQTT] No se pudieron restaurar las configuraciones retenidas de gateways:', err.message);
  }
});

// =========================================================================
// ELIMINAR GATEWAY
// =========================================================================
app.delete('/api/gateways/:device_id', async (req, res) => {
  const { device_id } = req.params;
  try {
    const resultado = await deleteGateway(pool, {
      device_id,
      provisioning_token: req.body?.provisioning_token,
      cliente_id: req.body?.cliente_id,
      nombre_zona: req.body?.nombre_zona
    });
    if (!resultado) {
      return res.status(404).json({ error: 'Gateway no encontrado en la base de datos.' });
    }
    publicarConfigGateway(resultado);
    console.log(`[DELETE] Gateway ${device_id} eliminado con éxito.`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ERROR] DELETE /api/gateways/:device_id:', err.message);
    res.status(err.code === DEVICE_CONFLICT ? 409 : 500).json({ error: err.message });
  }
});

// =========================================================================
// ELIMINAR BEACON / MASCOTA
// =========================================================================
app.delete('/api/beacons/:mac', async (req, res) => {
  const { mac } = req.params;
  try {
    // Simplemente se borra el registro: ya no existe detección ambiental de "collar nuevo"
    // (el alta ahora es siempre por escaneo de QR), así que no hace falta bloquear la MAC.
    // Esto permite borrar un beacon duplicado sin dejar de leer los datos reales del collar físico.
    const { rowCount } = await pool.query('DELETE FROM beacons WHERE UPPER(mac) = UPPER($1)', [mac]);

    if (!rowCount) {
      return res.status(404).json({ error: 'Beacon no encontrado en la base de datos.' });
    }

    console.log(`[DELETE] Beacon ${mac} eliminado de la base de datos.`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ERROR] DELETE /api/beacons/:mac:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Historial de cambios de zona confirmados, más reciente primero.
app.get('/api/historial', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 200);
  try {
    const mac = await obtenerMacFiltroHome(req);
    const { rows } = await pool.query(
      `SELECT mac, nombre_zona, cambiado_en
       FROM historial_zona
       WHERE EXISTS (
         SELECT 1 FROM beacons b
         WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = UPPER(TRIM(historial_zona.mac))
       )
         AND ($1::text IS NULL OR UPPER(TRIM(mac)) = UPPER(TRIM($1)))
       ORDER BY cambiado_en DESC
       LIMIT $2`,
      [mac, limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('[ERROR] /api/historial:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/anomalias', async (req, res) => {
  try {
    const mac = await obtenerMacFiltroHome(req);
    const desde = req.query.desde || null;
    const hasta = req.query.hasta || null;
    const revisada = req.query.revisada;
    const archivada = req.query.archivada === 'true';
    const condiciones = [
      `EXISTS (
         SELECT 1 FROM beacons b
         WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = UPPER(TRIM(anomalias.mac))
       )`,
      '($1::text IS NULL OR UPPER(mac) = UPPER($1))',
      archivada ? 'archivada_en IS NOT NULL' : 'archivada_en IS NULL',
      // Una alerta de pérdida de señal deja de estar activa cuando vuelve a
      // entrar una lectura posterior a su detección, aunque el detector aún
      // no haya alcanzado a escribir resuelta_en.
      `(tipo <> 'sin_senal' OR NOT EXISTS (
         SELECT 1 FROM telemetria_raw t
         WHERE UPPER(t.mac) = UPPER(anomalias.mac) AND t.time > anomalias.detectada_en
       ))`
    ];
    const parametros = [mac];
    if (desde) { parametros.push(desde); condiciones.push(`detectada_en >= $${parametros.length}::date`); }
    if (hasta) { parametros.push(hasta); condiciones.push(`detectada_en < ($${parametros.length}::date + interval '1 day')`); }
    if (revisada === 'true') condiciones.push('revisada_en IS NOT NULL');
    if (revisada === 'false') condiciones.push('revisada_en IS NULL');
    const { rows } = await pool.query(
      `SELECT id, mac, tipo, descripcion, capa, z_score, if_score, detectada_en, resuelta_en,
              revisada_en, archivada_en, comentario, falso_positivo,
              (SELECT z.nombre_zona
               FROM estado_actual e
               JOIN zonas z ON z.device_id = e.device_id
               WHERE UPPER(e.mac) = UPPER(anomalias.mac)
               LIMIT 1) AS zona_actual,
              ROUND(EXTRACT(EPOCH FROM (COALESCE(resuelta_en, now()) - detectada_en)))::int AS duracion_segundos
       FROM anomalias
       WHERE ${condiciones.join(' AND ')}
       ORDER BY detectada_en DESC
       LIMIT 100`,
      parametros
    );
    res.json(rows.map(alerta => {
      const coincidenciaZona = alerta.descripcion.match(/Michi (?:está|estuvo) en "([^"]+)"/);
      const ubicacionActual = !alerta.resuelta_en
        && (!coincidenciaZona || coincidenciaZona[1] === alerta.zona_actual);
      const resultado = {
        ...alerta,
        descripcion: alerta.resuelta_en || !ubicacionActual
          ? descripcionHistorica(alerta.descripcion)
          : alerta.descripcion,
        ubicacion_actual: ubicacionActual,
      };
      delete resultado.zona_actual;
      if (alerta.tipo !== 'sin_senal') return resultado;
      const descripcion = resultado.descripcion.replace(
        /No se reciben lecturas desde hace [\d.]+ segundos\.?/,
        `No se reciben lecturas desde hace ${duracionLegible(alerta.duracion_segundos)}.`
      );
      return { ...resultado, descripcion };
    }));
  } catch (err) {
    console.error('[ERROR] /api/anomalias:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Resumen por día para pintar el calendario: cuántas alertas hubo cada día del mes.
app.get('/api/anomalias-por-dia', async (req, res) => {
  try {
    const mac = await obtenerMacFiltroHome(req);
    const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || '')) ? String(req.query.mes) : null;
    const { rows } = await pool.query(
      `SELECT (detectada_en AT TIME ZONE 'America/Bogota')::date AS fecha,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE falso_positivo IS NOT TRUE)::int AS relevantes
       FROM anomalias
       WHERE EXISTS (
         SELECT 1 FROM beacons b
         WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = UPPER(TRIM(anomalias.mac))
       )
         AND ($1::text IS NULL OR UPPER(TRIM(mac)) = UPPER(TRIM($1)))
         AND archivada_en IS NULL
         AND ($2::date IS NULL OR (detectada_en AT TIME ZONE 'America/Bogota')::date >= $2::date)
         AND ($2::date IS NULL OR (detectada_en AT TIME ZONE 'America/Bogota')::date < ($2::date + interval '1 month'))
       GROUP BY fecha
       ORDER BY fecha`,
      [mac, mes ? `${mes}-01` : null]
    );
    res.json(rows);
  } catch (err) {
    console.error('[ERROR] /api/anomalias-por-dia:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Detalle de un día concreto: alertas de ese día (para el calendario).
app.get('/api/anomalias-dia/:fecha', async (req, res) => {
  try {
    const mac = await obtenerMacFiltroHome(req);
    const fecha = req.params.fecha;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
    const { rows } = await pool.query(
      `SELECT id, mac, tipo, descripcion, capa, z_score, if_score, detectada_en, resuelta_en, revisada_en, comentario, falso_positivo
       FROM anomalias
       WHERE EXISTS (
         SELECT 1 FROM beacons b
         WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = UPPER(TRIM(anomalias.mac))
       )
         AND ($1::text IS NULL OR UPPER(TRIM(mac)) = UPPER(TRIM($1)))
         AND archivada_en IS NULL
         AND (detectada_en AT TIME ZONE 'America/Bogota')::date = $2::date
       ORDER BY detectada_en DESC`,
      [mac, fecha]
    );
    res.json(rows);
  } catch (err) {
    console.error('[ERROR] /api/anomalias-dia:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Recordatorios / agenda ---
app.get('/api/recordatorios', async (req, res) => {
  try {
    const mac = await obtenerMacFiltroHome(req);
    const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || '')) ? String(req.query.mes) : null;
    const { rows } = await pool.query(
      `SELECT id, mac, fecha, hora, titulo, notificar, notificado
       FROM recordatorios
       WHERE EXISTS (
         SELECT 1 FROM beacons b
         WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = UPPER(TRIM(recordatorios.mac))
       )
         AND ($1::text IS NULL OR UPPER(TRIM(mac)) = UPPER(TRIM($1)))
         AND ($2::date IS NULL OR fecha >= $2::date)
         AND ($2::date IS NULL OR fecha < ($2::date + interval '1 month'))
       ORDER BY fecha, hora`,
      [mac, mes ? `${mes}-01` : null]
    );
    res.json(rows);
  } catch (err) {
    console.error('[ERROR] /api/recordatorios:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/recordatorios', async (req, res) => {
  try {
    const { fecha, hora, titulo, notificar } = req.body || {};
    const mac = await obtenerMacAsignada(req.body?.mac || process.env.TARGET_MAC || 'dd:88:00:00:3e:15');
    if (!mac) return res.status(400).json({ error: 'Selecciona un gato con beacon asignado.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) return res.status(400).json({ error: 'Falta la fecha (YYYY-MM-DD).' });
    if (!/^\d{2}:\d{2}$/.test(String(hora || ''))) return res.status(400).json({ error: 'Falta la hora (HH:MM).' });
    if (!String(titulo || '').trim()) return res.status(400).json({ error: 'Falta el título del recordatorio.' });
    const { rows } = await pool.query(
      `INSERT INTO recordatorios (mac, fecha, hora, titulo, notificar)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, fecha, hora, titulo, notificar, notificado`,
      [mac, fecha, hora, String(titulo).trim(), notificar !== false]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[ERROR] POST /api/recordatorios:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/recordatorios/:id', async (req, res) => {
  try {
    const mac = await obtenerMacFiltroHome(req);
    const { notificar } = req.body || {};
    const { rowCount } = await pool.query(
      `UPDATE recordatorios SET notificar = $1
       WHERE id = $2
         AND ($3::text IS NULL OR UPPER(TRIM(mac)) = UPPER(TRIM($3)))
         AND EXISTS (SELECT 1 FROM beacons b WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = UPPER(TRIM(recordatorios.mac)))`,
      [notificar !== false, req.params.id, mac]
    );
    if (!rowCount) return res.status(404).json({ error: 'Recordatorio no encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[ERROR] PATCH /api/recordatorios:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/recordatorios/:id', async (req, res) => {
  try {
    const mac = await obtenerMacFiltroHome(req);
    const { rowCount } = await pool.query(
      `DELETE FROM recordatorios
       WHERE id = $1
         AND ($2::text IS NULL OR UPPER(TRIM(mac)) = UPPER(TRIM($2)))
         AND EXISTS (SELECT 1 FROM beacons b WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = UPPER(TRIM(recordatorios.mac)))`,
      [req.params.id, mac]
    );
    if (!rowCount) return res.status(404).json({ error: 'Recordatorio no encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[ERROR] DELETE /api/recordatorios:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Recordatorios pendientes de notificar cuya hora ya llegó (consultado por polling desde el navegador).
app.get('/api/recordatorios-pendientes', async (req, res) => {
  try {
    const mac = await obtenerMacFiltroHome(req);
    const { rows } = await pool.query(
      `SELECT id, fecha, hora, titulo
       FROM recordatorios
       WHERE EXISTS (
         SELECT 1 FROM beacons b
         WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = UPPER(TRIM(recordatorios.mac))
       )
         AND ($1::text IS NULL OR UPPER(mac) = UPPER($1))
         AND notificar = true
         AND notificado = false
         AND (fecha + hora) <= (now() AT TIME ZONE 'America/Bogota')
       ORDER BY fecha, hora`,
      [mac]
    );
    if (rows.length) {
      await pool.query('UPDATE recordatorios SET notificado = true WHERE id = ANY($1::int[])', [rows.map(r => r.id)]);
    }
    res.json(rows);
  } catch (err) {
    console.error('[ERROR] /api/recordatorios-pendientes:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/anomalias/:id', async (req, res) => {
  const accion = req.body?.accion;
  if (!['revisar', 'archivar', 'desarchivar', 'comentar', 'falso_positivo'].includes(accion)) return res.status(400).json({ error: 'Acción no válida.' });
  try {
    const mac = await obtenerMacFiltroHome(req);
    if (accion === 'comentar') {
      const { rowCount } = await pool.query(
        `UPDATE anomalias SET comentario = $1
         WHERE id = $2
           AND ($3::text IS NULL OR UPPER(TRIM(mac)) = UPPER(TRIM($3)))
           AND EXISTS (SELECT 1 FROM beacons b WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = UPPER(TRIM(anomalias.mac)))`,
        [req.body.comentario || null, req.params.id, mac]
      );
      if (!rowCount) return res.status(404).json({ error: 'Alerta no encontrada.' });
      return res.json({ ok: true });
    }
    if (accion === 'falso_positivo') {
      const { rowCount } = await pool.query(
        `UPDATE anomalias SET falso_positivo = $1
         WHERE id = $2
           AND ($3::text IS NULL OR UPPER(TRIM(mac)) = UPPER(TRIM($3)))
           AND EXISTS (SELECT 1 FROM beacons b WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = UPPER(TRIM(anomalias.mac)))`,
        [Boolean(req.body.valor), req.params.id, mac]
      );
      if (!rowCount) return res.status(404).json({ error: 'Alerta no encontrada.' });
      return res.json({ ok: true });
    }
    const campo = accion === 'revisar' ? 'revisada_en' : 'archivada_en';
    const valor = accion === 'desarchivar' ? null : 'now()';
    const { rowCount } = await pool.query(
      `UPDATE anomalias SET ${campo} = ${valor === null ? 'NULL' : `COALESCE(${campo}, now())`}
       WHERE id = $1
         AND ($2::text IS NULL OR UPPER(TRIM(mac)) = UPPER(TRIM($2)))
         AND EXISTS (SELECT 1 FROM beacons b WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = UPPER(TRIM(anomalias.mac)))`,
      [req.params.id, mac]
    );
    if (!rowCount) return res.status(404).json({ error: 'Alerta no encontrada.' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/gateways', async (req, res) => {
  try {
    // La disponibilidad pertenece a cada gateway: cualquier lectura MQTT reciente
    // cuenta, aunque otro gateway tenga el RSSI más fuerte y sea la zona elegida.
    const ONLINE_WINDOW_SECONDS = 15;
    const { rows } = await pool.query(
      `SELECT g.*,
              (t.ultimo_dato IS NOT NULL AND t.ultimo_dato > now() - ($1 || ' seconds')::interval) AS online,
              t.ultimo_dato AS ultimo_heartbeat,
              r.provisioning_token,
              r.config_version
       FROM gateways g
       LEFT JOIN gateway_registry r ON r.device_id = g.device_id AND r.deleted = false
       LEFT JOIN (
         SELECT device_id, MAX(time) AS ultimo_dato
         FROM telemetria_raw
         GROUP BY device_id
       ) t ON t.device_id = g.device_id
       ORDER BY g.updated_at DESC NULLS LAST`,
      [ONLINE_WINDOW_SECONDS]
    );
    res.json(rows.map(gateway => ({
      ...gateway,
      icono: gateway.icono || 'location_on',
      nombre: gateway.nombre || gateway.nombre_zona || 'Gateway'
    })));
  } catch (err) {
    console.error('[ERROR] /api/gateways:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/gateways/:device_id', async (req, res) => {
  const { device_id } = req.params;
  const { nombre_zona, icono } = req.body || {};
  try {
    let resultado;
    if (typeof nombre_zona === 'string' && nombre_zona.trim()) {
      resultado = await updateGatewayZone(pool, { device_id, nombre_zona, icono });
      if (!resultado) return res.status(404).json({ error: 'Gateway no encontrado.' });
      publicarConfigGateway({
       cliente_id: resultado.cliente_id,
       device_id: resultado.device_id,
       provisioning_token: resultado.registry.provisioning_token,
       nombre_zona: resultado.nombre_zona,
       config_version: resultado.registry.config_version,
       deleted: false
      });
      return res.json({
       ...resultado,
       icono: resultado.icono || 'location_on',
       nombre: resultado.nombre || resultado.nombre_zona || 'Gateway',
       provisioning_token: resultado.registry.provisioning_token,
       config_version: resultado.registry.config_version
      });
    }

    const { rows } = await pool.query(
      `UPDATE gateways SET icono = COALESCE($1, icono), updated_at = now()
       WHERE device_id = $2 RETURNING *`,
      [icono ?? null, device_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Gateway no encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[ERROR] /api/gateways/:device_id:', err.message);
    res.status(err.code === DUPLICATE_ZONE ? 409 : 500).json({ error: err.message });
  }
});

app.put('/api/gateways/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre_zona, icono } = req.body || {};

  try {
    const { rows: gatewayRows } = await pool.query('SELECT device_id FROM gateways WHERE id = $1', [id]);
    if (!gatewayRows[0]) return res.status(404).json({ error: 'Gateway no encontrado.' });
    const resultado = await updateGatewayZone(pool, {
      device_id: gatewayRows[0].device_id,
      nombre_zona,
      icono
    });
    if (!resultado) return res.status(404).json({ error: 'Gateway no encontrado.' });
    const payload = {
      cliente_id: resultado.cliente_id,
      device_id: resultado.device_id,
      provisioning_token: resultado.registry.provisioning_token,
      nombre_zona: resultado.nombre_zona,
      config_version: resultado.registry.config_version,
      deleted: false
    };
    publicarConfigGateway(payload);
    res.json({
      ...resultado,
      icono: resultado.icono || 'location_on',
      provisioning_token: resultado.registry.provisioning_token,
      config_version: resultado.registry.config_version
    });
  } catch (err) {
    console.error('[ERROR] /api/gateways/:id:', err.message);
    res.status(err.code === DUPLICATE_ZONE ? 409 : 500).json({ error: err.message });
  }
});

app.post('/api/gateways/validate-zone', async (req, res) => {
  const { cliente_id, device_id, nombre_zona, provisioning_token } = req.body || {};
  try {
    const resultado = await validateGatewayZone(pool, { cliente_id, device_id, nombre_zona, provisioning_token });
    if (resultado.gateway_en_uso) {
      return res.status(409).json({
       error: `La zona "${resultado.nombre_zona}" ya está asignada al M5Stack ${resultado.gateway_en_uso}. Cambia la zona de ese equipo o elimínalo antes de continuar.`
      });
    }
    res.json({ ok: true, nombre_zona: resultado.nombre_zona });
  } catch (err) {
    console.error('[ERROR] /api/gateways/validate-zone:', err.message);
    res.status(err.code ? 500 : 400).json({ error: err.message });
  }
});

app.post('/api/gateways/provision', async (req, res) => {
  const { cliente_id, device_id, nombre_zona, provisioning_token, icono } = req.body || {};
  try {
    const resultado = await registerGateway(pool, { cliente_id, device_id, nombre_zona, provisioning_token, icono });
    publicarConfigGateway(resultado);
    res.status(200).json(resultado);
  } catch (err) {
    console.error('[ERROR] /api/gateways/provision:', err.message);
    const status = [DUPLICATE_ZONE, DEVICE_CONFLICT, DEVICE_DELETED].includes(err.code) ? 409 : 400;
    res.status(status).json({ error: err.message });
  }
});

app.get('/api/beacons', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM beacons ORDER BY asignado DESC, ultimo_visto DESC NULLS LAST, mac ASC`
    );
    res.json(rows.map(beacon => ({
      ...beacon,
      nombre_mascota: beacon.nombre_mascota || beacon.nombre || null,
      nombre: beacon.nombre || beacon.nombre_mascota || null,
      icono: beacon.icono || 'pets'
    })));
  } catch (err) {
    console.error('[ERROR] /api/beacons:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cuenta', async (req, res) => {
  try {
    const [gateways, beacons, config] = await Promise.all([
      pool.query(
        `SELECT g.id, g.cliente_id, g.device_id, g.nombre, g.nombre_zona, g.icono,
                g.created_at, g.updated_at,
                (t.ultimo_dato IS NOT NULL AND t.ultimo_dato > now() - interval '15 seconds') AS online,
                t.ultimo_dato AS ultimo_heartbeat
         FROM gateways g
         LEFT JOIN (
           SELECT device_id, MAX(time) AS ultimo_dato
           FROM telemetria_raw
           GROUP BY device_id
         ) t ON t.device_id = g.device_id
         ORDER BY g.nombre NULLS LAST, g.device_id`
      ),
      pool.query(
        `SELECT DISTINCT ON (UPPER(TRIM(mac)))
                mac, COALESCE(nombre_mascota, nombre, 'Mascota') AS nombre,
                asignado, created_at, ultimo_visto
         FROM beacons
         WHERE asignado = true
         ORDER BY UPPER(TRIM(mac)), ultimo_visto DESC NULLS LAST, created_at DESC`
      ),
      pool.query(
        `SELECT nombre FROM gato_config
         WHERE UPPER(mac) = UPPER($1)
         LIMIT 1`,
        [process.env.TARGET_MAC || 'dd:88:00:00:3e:15']
      )
    ]);

    const clienteId = gateways.rows[0]?.cliente_id || 'cliente-demo';
    res.json({
      cliente_id: clienteId,
      nombre_cliente: clienteId === 'cliente-demo' ? 'Cliente demo' : clienteId,
      gatos: beacons.rows,
      gateways: gateways.rows.map(gateway => ({
        ...gateway,
        nombre: gateway.nombre || gateway.nombre_zona || 'Gateway',
        bateria: null
      })),
      gato_principal: config.rows[0]?.nombre || process.env.CAT_NAME || 'Michi'
    });
  } catch (err) {
    console.error('[ERROR] /api/cuenta:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/beacons', async (req, res) => {
  const { mac, nombre_mascota, nombre, icono, mascota_id, asignado = true } = req.body || {};
  if (!mac) return res.status(400).json({ error: 'La MAC es obligatoria.' });
  const macNormalizada = String(mac).trim().toUpperCase();
  const nombreFinal = nombre_mascota || nombre || null;

  try {
    // Validación: no permitir dar de alta la misma MAC dos veces (ya existe y está asignada).
    const { rows: existente } = await pool.query('SELECT mac, asignado FROM beacons WHERE UPPER(mac) = $1', [macNormalizada]);
    if (existente[0] && existente[0].asignado) {
      return res.status(409).json({ error: `Este collar (${macNormalizada}) ya está registrado.` });
    }

    // Validación: no permitir dos mascotas activas con el mismo nombre.
    if (nombreFinal) {
      const { rows: duplicadoNombre } = await pool.query(
        `SELECT mac FROM beacons WHERE asignado = true AND UPPER(mac) <> $2 AND LOWER(TRIM(COALESCE(nombre_mascota, nombre))) = LOWER($1)`,
        [nombreFinal.trim(), macNormalizada]
      );
      if (duplicadoNombre.length) {
        return res.status(409).json({ error: `Ya existe una mascota registrada con el nombre "${nombreFinal.trim()}". Elige otro nombre.` });
      }
    }

    // 1. Guardar o actualizar en PostgreSQL
    const { rows } = await pool.query(
      `INSERT INTO beacons (mac, nombre, nombre_mascota, icono, mascota_id, asignado, ultimo_visto, updated_at)
       VALUES ($1, $2, $3, COALESCE($4, 'pets'), $5, $6, now(), now())
       ON CONFLICT (mac) DO UPDATE SET
        nombre = COALESCE(EXCLUDED.nombre, beacons.nombre),
        nombre_mascota = COALESCE(EXCLUDED.nombre_mascota, beacons.nombre_mascota),
        icono = COALESCE(EXCLUDED.icono, beacons.icono),
        mascota_id = COALESCE(EXCLUDED.mascota_id, beacons.mascota_id),
        asignado = EXCLUDED.asignado,
        ultimo_visto = now(),
        updated_at = now()
       RETURNING *`,
      [macNormalizada, nombreFinal, nombreFinal, icono || null, mascota_id || null, Boolean(asignado)]
    );
    const beacon = rows[0];
    await pool.query('DELETE FROM beacons_bloqueados WHERE UPPER(mac) = UPPER($1)', [macNormalizada]);

    // -------------------------------------------------------------
    // NUEVO: 2. NOTIFICAR LA LISTA ACTUALIZADA AL M5STACK VÍA MQTT
    // -------------------------------------------------------------
    try {
      // Obtener todas las MACs que estén asignadas/activas en la BD
      const activeBeaconsRes = await pool.query('SELECT mac FROM beacons WHERE asignado = true');
      const macsPermitidas = activeBeaconsRes.rows.map(r => r.mac.toUpperCase());

      // Publicar el array JSON a la ruta de configuración
      if (mqttClient && mqttClient.connected) {
        mqttClient.publish('telemetria/demo_cliente/config/beacons', JSON.stringify(macsPermitidas));
        console.log('[MQTT CONFIG] Lista de MACs permitidas enviada al M5Stack:', macsPermitidas);
      }
    } catch (mqttErr) {
      console.warn('[WARN MQTT] No se pudo publicar la lista de beacons:', mqttErr.message);
    }
    // -------------------------------------------------------------

    // 3. Responder al cliente en el frontend
    res.status(201).json({
      ...beacon,
      nombre_mascota: beacon.nombre_mascota || beacon.nombre || null,
      icono: beacon.icono || 'pets'
    });

  } catch (err) {
    console.error('[ERROR] /api/beacons:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.put('/api/beacons/:mac', async (req, res) => {
  const { mac } = req.params;
  const { nombre, nombre_mascota, icono, mascota_id, asignado, ultimo_visto } = req.body || {};
  const nombreFinal = nombre_mascota || nombre || null;

  try {
    if (nombreFinal) {
      const { rows: duplicadoNombre } = await pool.query(
        `SELECT mac FROM beacons WHERE asignado = true AND UPPER(mac) <> UPPER($2) AND LOWER(TRIM(COALESCE(nombre_mascota, nombre))) = LOWER($1)`,
        [nombreFinal.trim(), mac]
      );
      if (duplicadoNombre.length) {
        return res.status(409).json({ error: `Ya existe una mascota registrada con el nombre "${nombreFinal.trim()}". Elige otro nombre.` });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO beacons (mac, nombre, nombre_mascota, icono, mascota_id, asignado, ultimo_visto, updated_at)
       VALUES ($1, $2, $3, COALESCE($4, 'pets'), $5, COALESCE($6, true), COALESCE($7, now()), now())
       ON CONFLICT (mac) DO UPDATE SET
        nombre = COALESCE(EXCLUDED.nombre, beacons.nombre),
        nombre_mascota = COALESCE(EXCLUDED.nombre_mascota, beacons.nombre_mascota),
        icono = COALESCE(EXCLUDED.icono, beacons.icono),
        mascota_id = COALESCE(EXCLUDED.mascota_id, beacons.mascota_id),
        asignado = COALESCE(EXCLUDED.asignado, beacons.asignado),
        ultimo_visto = COALESCE(EXCLUDED.ultimo_visto, beacons.ultimo_visto),
        updated_at = now()
       RETURNING *`,
      [mac, nombreFinal, nombreFinal, icono || null, mascota_id || null, typeof asignado === 'boolean' ? asignado : null, ultimo_visto ?? null]
    );
    const beacon = rows[0];
    await pool.query('DELETE FROM beacons_bloqueados WHERE UPPER(mac) = UPPER($1)', [mac]);
    res.json({ ...beacon, nombre_mascota: beacon.nombre_mascota || beacon.nombre || null, icono: beacon.icono || 'pets' });
  } catch (err) {
    console.error('[ERROR] /api/beacons/:mac:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/beacons/:mac', async (req, res) => {
  const { mac } = req.params;
  const { nombre, nombre_mascota, icono, mascota_id, asignado = true } = req.body || {};
  if (!mac) {
    return res.status(400).json({ error: 'La MAC es obligatoria.' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO beacons (mac, nombre, nombre_mascota, icono, mascota_id, asignado, ultimo_visto, updated_at)
       VALUES ($1, $2, $3, COALESCE($4, 'pets'), $5, $6, now(), now())
       ON CONFLICT (mac) DO UPDATE SET
         nombre = COALESCE(EXCLUDED.nombre, beacons.nombre),
         nombre_mascota = COALESCE(EXCLUDED.nombre_mascota, beacons.nombre_mascota),
         icono = COALESCE(EXCLUDED.icono, beacons.icono),
         mascota_id = COALESCE(EXCLUDED.mascota_id, beacons.mascota_id),
         asignado = EXCLUDED.asignado,
         ultimo_visto = now(),
         updated_at = now()
       RETURNING *`,
      [mac, nombre_mascota || nombre || null, nombre_mascota || nombre || null, icono || null, mascota_id || null, Boolean(asignado)]
    );
    const beacon = rows[0];
    await pool.query('DELETE FROM beacons_bloqueados WHERE UPPER(mac) = UPPER($1)', [mac]);
    res.status(201).json({ ...beacon, nombre_mascota: beacon.nombre_mascota || beacon.nombre || null, icono: beacon.icono || 'pets' });
  } catch (err) {
    console.error('[ERROR] /api/beacons/:mac:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/configuracion-gato', async (req, res) => {
  const mac = process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
  try {
    await pool.query('INSERT INTO gato_config (mac) VALUES ($1) ON CONFLICT (mac) DO NOTHING', [mac]);
    const { rows } = await pool.query('SELECT * FROM gato_config WHERE mac = $1', [mac]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/configuracion-gato', async (req, res) => {
  const mac = process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
  const campos = ['nombre', 'edad_anios', 'peso_kg', 'foto_url', 'horario_comida', 'horario_medicacion', 'zona_comida', 'zona_agua', 'zona_arenero', 'zona_descanso', 'avisos_alertas', 'avisos_sin_lecturas', 'umbral_sin_lecturas_segundos'];
  const valores = campos.map(campo => req.body[campo] === '' ? null : req.body[campo]);
  try {
    await pool.query('INSERT INTO gato_config (mac) VALUES ($1) ON CONFLICT (mac) DO NOTHING', [mac]);
    const asignaciones = campos.map((campo, i) => `${campo} = $${i + 2}`).join(', ');
    const { rows } = await pool.query(`UPDATE gato_config SET ${asignaciones} WHERE mac = $1 RETURNING *`, [mac, ...valores]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/anomalias/:id', async (req, res) => {
  if (req.body?.confirmar !== true) return res.status(400).json({ error: 'Confirmación requerida.' });
  try {
    const mac = await obtenerMacFiltroHome(req);
    const { rowCount } = await pool.query(
      `DELETE FROM anomalias
       WHERE id = $1
         AND ($2::text IS NULL OR UPPER(TRIM(mac)) = UPPER(TRIM($2)))
         AND EXISTS (SELECT 1 FROM beacons b WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = UPPER(TRIM(anomalias.mac)))`,
      [req.params.id, mac]
    );
    if (!rowCount) return res.status(404).json({ error: 'Alerta no encontrada.' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/rutina', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const mac = await obtenerMacFiltroHome(req);
    const { rows } = await pool.query(
      `WITH clasificados AS (
         SELECT UPPER(TRIM(mac)) AS mac, franja_horaria, nombre_zona,
                ROW_NUMBER() OVER (
                  PARTITION BY UPPER(TRIM(mac)), franja_horaria
                  ORDER BY tiempo_total_min DESC, frecuencia_visitas DESC, nombre_zona
                ) AS prioridad
         FROM rutinas_patron
         WHERE dia_tipo = 'todos'
           AND ($1::text IS NULL OR UPPER(TRIM(mac)) = UPPER(TRIM($1)))
       ),
       seleccionados AS (
         SELECT mac, franja_horaria, nombre_zona
         FROM clasificados
         WHERE prioridad = 1
       ),
       grupos AS (
         SELECT mac, franja_horaria, nombre_zona,
                franja_horaria - ROW_NUMBER() OVER (
                  PARTITION BY mac, nombre_zona ORDER BY franja_horaria
                ) AS grupo
         FROM seleccionados
       )
       SELECT mac,
              MIN(franja_horaria)::int * 30 AS franja_horaria,
              nombre_zona,
              (COUNT(*) * 30)::int AS duracion_promedio_min,
              COUNT(*)::int AS observaciones
       FROM grupos
       GROUP BY mac, nombre_zona, grupo
       ORDER BY mac, MIN(franja_horaria)`,
      [mac]
    );
    res.json(rows);
  } catch (err) {
    console.error('[ERROR] /api/rutina:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rutina-comparacion', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `WITH eventos AS (
         SELECT nombre_zona, cambiado_en,
                LEAD(cambiado_en) OVER (ORDER BY cambiado_en) AS siguiente
         FROM historial_zona
         WHERE UPPER(mac) = UPPER($1)
           AND (cambiado_en AT TIME ZONE 'America/Bogota')::date =
               (now() AT TIME ZONE 'America/Bogota')::date
       )
       SELECT nombre_zona,
              EXTRACT(HOUR FROM cambiado_en AT TIME ZONE 'America/Bogota')::int * 60 +
                EXTRACT(MINUTE FROM cambiado_en AT TIME ZONE 'America/Bogota')::int AS inicio_min,
              EXTRACT(HOUR FROM COALESCE(siguiente, now()) AT TIME ZONE 'America/Bogota')::int * 60 +
                EXTRACT(MINUTE FROM COALESCE(siguiente, now()) AT TIME ZONE 'America/Bogota')::int AS fin_min
       FROM eventos
       WHERE (siguiente IS NULL OR siguiente > cambiado_en)
         AND (siguiente IS NULL OR (siguiente AT TIME ZONE 'America/Bogota')::date =
              (cambiado_en AT TIME ZONE 'America/Bogota')::date)
       ORDER BY inicio_min`,
      [process.env.TARGET_MAC || 'dd:88:00:00:3e:15']
    );
    res.json(rows);
  } catch (err) {
    console.error('[ERROR] /api/rutina-comparacion:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rutina-periodo', async (req, res) => {
  const dias = Math.min(Math.max(Number(req.query.dias) || 7, 1), 31);
  const inicio = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.inicio || ''))
    ? String(req.query.inicio)
    : null;
  try {
    const mac = await obtenerMacFiltroHome(req);
    const { rows } = await pool.query(
      `WITH eventos AS (
         SELECT mac, nombre_zona, cambiado_en,
               LEAD(cambiado_en) OVER (PARTITION BY mac ORDER BY cambiado_en) AS siguiente
         FROM historial_zona
         WHERE EXISTS (
           SELECT 1 FROM beacons b
           WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = UPPER(TRIM(historial_zona.mac))
         )
           AND ($1::text IS NULL OR UPPER(TRIM(mac)) = UPPER(TRIM($1)))
       )
       SELECT mac, (cambiado_en AT TIME ZONE 'America/Bogota')::date AS fecha,
              nombre_zona,
              EXTRACT(HOUR FROM cambiado_en AT TIME ZONE 'America/Bogota')::int * 60 +
                EXTRACT(MINUTE FROM cambiado_en AT TIME ZONE 'America/Bogota')::int AS inicio_min,
              LEAST(
                1440,
                EXTRACT(HOUR FROM COALESCE(siguiente, now()) AT TIME ZONE 'America/Bogota')::int * 60 +
                  EXTRACT(MINUTE FROM COALESCE(siguiente, now()) AT TIME ZONE 'America/Bogota')::int
              ) AS fin_min
       FROM eventos
       WHERE (cambiado_en AT TIME ZONE 'America/Bogota')::date >=
             COALESCE($3::date, (now() AT TIME ZONE 'America/Bogota')::date - ($2 - 1))
         AND (cambiado_en AT TIME ZONE 'America/Bogota')::date <
             COALESCE($3::date, (now() AT TIME ZONE 'America/Bogota')::date - ($2 - 1)) + $2
         AND (siguiente IS NULL OR siguiente > cambiado_en)
         AND (siguiente IS NULL OR (siguiente AT TIME ZONE 'America/Bogota')::date =
             (cambiado_en AT TIME ZONE 'America/Bogota')::date)`,
      [mac, dias, inicio]
    );
    res.json(rows);
  } catch (err) {
    console.error('[ERROR] /api/rutina-periodo:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Historial detallado de una hora concreta de un día (para el detalle al hacer click en la tabla de rutina por hora).
app.get('/api/historial-hora/:fecha/:hora', async (req, res) => {
  try {
    const mac = await obtenerMacFiltroHome(req);
    const fecha = req.params.fecha;
    const hora = Number(req.params.hora);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
    if (!Number.isInteger(hora) || hora < 0 || hora > 23) return res.status(400).json({ error: 'Hora inválida.' });
    const { rows } = await pool.query(
      `WITH eventos AS (
         SELECT mac, nombre_zona, cambiado_en,
                LEAD(cambiado_en) OVER (PARTITION BY mac ORDER BY cambiado_en) AS siguiente
         FROM historial_zona
         WHERE EXISTS (
           SELECT 1 FROM beacons b
           WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = UPPER(TRIM(historial_zona.mac))
         )
           AND ($1::text IS NULL OR UPPER(TRIM(mac)) = UPPER(TRIM($1)))
       )
       SELECT mac, nombre_zona, cambiado_en,
              LEAST(COALESCE(siguiente, now()), (($2::date + (($3 + 1) || ' hours')::interval) AT TIME ZONE 'America/Bogota')) AS fin
       FROM eventos
       WHERE cambiado_en < (($2::date + (($3 + 1) || ' hours')::interval) AT TIME ZONE 'America/Bogota')
         AND COALESCE(siguiente, now()) > (($2::date + ($3 || ' hours')::interval) AT TIME ZONE 'America/Bogota')
       ORDER BY cambiado_en`,
      [mac, fecha, hora]
    );
    res.json(rows);
  } catch (err) {
    console.error('[ERROR] /api/historial-hora:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Historial de movimientos de un día completo (para la Agenda).
app.get('/api/historial-dia/:fecha', async (req, res) => {
  try {
    const mac = await obtenerMacFiltroHome(req);
    const fecha = req.params.fecha;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
    const { rows } = await pool.query(
      `WITH eventos AS (
         SELECT mac, nombre_zona, cambiado_en,
                LEAD(cambiado_en) OVER (PARTITION BY mac ORDER BY cambiado_en) AS siguiente
         FROM historial_zona
         WHERE EXISTS (
           SELECT 1 FROM beacons b
           WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = UPPER(TRIM(historial_zona.mac))
         )
           AND ($1::text IS NULL OR UPPER(TRIM(mac)) = UPPER(TRIM($1)))
       )
       SELECT mac, nombre_zona, cambiado_en,
              LEAST(COALESCE(siguiente, now()), (($2::date + interval '1 day') AT TIME ZONE 'America/Bogota')) AS fin
       FROM eventos
       WHERE cambiado_en < (($2::date + interval '1 day') AT TIME ZONE 'America/Bogota')
         AND COALESCE(siguiente, now()) > ($2::date AT TIME ZONE 'America/Bogota')
       ORDER BY cambiado_en DESC`,
      [mac, fecha]
    );
    res.json(rows);
  } catch (err) {
    console.error('[ERROR] /api/historial-dia:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/estadisticas', async (req, res) => {
  const modo = req.query.modo === 'month' ? 'month' : 'week';
  const desplazamiento = Number.isInteger(Number(req.query.desplazamiento))
    ? Number(req.query.desplazamiento)
    : 0;
  const zona = 'America/Bogota';
  try {
    const mac = await obtenerMacFiltroHome(req);
    const { rows } = await pool.query(
      `WITH limites AS (
         SELECT
           CASE WHEN $2 = 'month'
             THEN date_trunc('month', now() AT TIME ZONE $3) + ($4 * interval '1 month')
             ELSE date_trunc('week', now() AT TIME ZONE $3) + ($4 * interval '1 week')
           END AS inicio_local
       ),
       eventos AS (
         SELECT mac, nombre_zona, cambiado_en,
               LEAD(cambiado_en) OVER (PARTITION BY mac ORDER BY cambiado_en) AS siguiente
         FROM historial_zona
         WHERE EXISTS (
           SELECT 1 FROM beacons b
           WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = UPPER(TRIM(historial_zona.mac))
         )
           AND ($1::text IS NULL OR UPPER(TRIM(mac)) = UPPER(TRIM($1)))
       ),
       segmentos AS (
         SELECT mac, nombre_zona,
                (cambiado_en AT TIME ZONE $3)::date AS fecha,
                GREATEST(cambiado_en, inicio_local AT TIME ZONE $3) AS inicio,
                LEAST(COALESCE(siguiente, now()), (inicio_local + CASE WHEN $2 = 'month' THEN interval '1 month' ELSE interval '7 days' END) AT TIME ZONE $3) AS fin
         FROM eventos, limites
         WHERE cambiado_en < ((inicio_local + CASE WHEN $2 = 'month' THEN interval '1 month' ELSE interval '7 days' END) AT TIME ZONE $3)
           AND COALESCE(siguiente, now()) > (inicio_local AT TIME ZONE $3)
       )
       SELECT mac, nombre_zona,
              ROUND(SUM(EXTRACT(EPOCH FROM (fin - inicio)) / 60))::int AS minutos,
              COUNT(DISTINCT fecha)::int AS dias,
              MIN(fecha) AS primera_fecha,
              MAX(fecha) AS ultima_fecha
       FROM segmentos
       WHERE fin > inicio
       GROUP BY mac, nombre_zona
       ORDER BY minutos DESC`,
      [mac, modo, zona, desplazamiento]
    );
    const nombre = mac
      ? await pool.query(
       `SELECT COALESCE(nombre_mascota, nombre, 'Mascota') AS nombre
        FROM beacons WHERE asignado = true AND UPPER(TRIM(mac)) = UPPER(TRIM($1))
        ORDER BY ultimo_visto DESC NULLS LAST, updated_at DESC LIMIT 1`,
       [mac]
      )
      : { rows: [] };
    const { rows: periodo } = await pool.query(
      `SELECT CASE WHEN $1 = 'month'
        THEN date_trunc('month', now() AT TIME ZONE $2) + ($3 * interval '1 month')
        ELSE date_trunc('week', now() AT TIME ZONE $2) + ($3 * interval '1 week')
       END AS inicio,
       CASE WHEN $1 = 'month'
        THEN date_trunc('month', now() AT TIME ZONE $2) + (($3 + 1) * interval '1 month') - interval '1 day'
        ELSE date_trunc('week', now() AT TIME ZONE $2) + (($3 * 7 + 6) * interval '1 day')
       END AS fin`,
      [modo, zona, desplazamiento]
    );
    res.json({
      nombre: mac ? nombre.rows[0]?.nombre || 'Mascota' : 'Todos los gatos',
      modo,
      inicio: periodo[0].inicio,
      fin: periodo[0].fin,
      zonas: rows
    });
  } catch (err) {
    console.error('[ERROR] /api/estadisticas:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/perfil', async (req, res) => {
  try {
    const mac = process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
    const [estado, zonas, rutina, config] = await Promise.all([
      pool.query(
        `SELECT nombre_zona, actualizado_en
         FROM estado_actual
         WHERE UPPER(mac) = UPPER($1)
         ORDER BY actualizado_en DESC NULLS LAST
         LIMIT 1`,
        [mac]
      ),
      pool.query(`SELECT nombre_zona FROM zonas ORDER BY nombre_zona`),
      pool.query(
        `SELECT COUNT(DISTINCT franja_horaria)::int AS franjas,
                COALESCE(SUM(tiempo_total_min), 0)::numeric(10,1) AS minutos
         FROM rutinas_patron
         WHERE UPPER(mac) = UPPER($1) AND dia_tipo = 'todos'`,
        [mac]
      ),
      pool.query('SELECT * FROM gato_config WHERE mac = $1', [mac]),
    ]);
    res.json({
      nombre: config.rows[0]?.nombre || process.env.CAT_NAME || 'Michi',
      mac,
      zona_actual: estado.rows[0]?.nombre_zona || null,
      ultima_lectura: estado.rows[0]?.actualizado_en || null,
      zonas: zonas.rows.map(zona => zona.nombre_zona),
      aprendizaje: rutina.rows[0],
    });
  } catch (err) {
    console.error('[ERROR] /api/perfil:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function iniciarServidor(portIndex = 0) {
  const port = PORT_CANDIDATES[portIndex];
  const server = app.listen(port, () => {
    console.log(`Dashboard corriendo en http://localhost:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && portIndex < PORT_CANDIDATES.length - 1) {
      console.warn(`[PORT] Puerto ${port} ocupado. Intentando el siguiente: ${PORT_CANDIDATES[portIndex + 1]}`);
      iniciarServidor(portIndex + 1);
      return;
    }
    console.error('[PORT] No se pudo iniciar el servidor', err.message);
    process.exit(1);
  });
}

iniciarServidor();