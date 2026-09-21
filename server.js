require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 10000, query_timeout: 10000 });
pool.on('error', (err) => console.error('[ERROR] Pool de Postgres:', err.message));
const app = express();
const PORT_CANDIDATES = Array.from(new Set([Number(process.env.DASHBOARD_PORT || 3000), 3001, 3002, 3003, 3010]));
app.use(express.json());

async function ensureDeviceSchema() {
  try {
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
  } catch (err) {
    console.error('[ERROR] ensureDeviceSchema:', err.message);
  }
}

async function ensureDefaultDevices() {
  try {
    await pool.query(`
      INSERT INTO gateways (cliente_id, device_id, nombre_zona, nombre, icono, online, updated_at)
      SELECT 'cliente-demo', 'M5_PISO_1_ESCRITORIO', 'Escritorio', 'Escritorio', 'chair', false, now()
      WHERE NOT EXISTS (SELECT 1 FROM gateways LIMIT 1)
      ON CONFLICT (device_id) DO NOTHING
    `);

    await pool.query(`
      UPDATE gateways
      SET nombre = COALESCE(nombre, nombre_zona, 'Gateway'),
          nombre_zona = COALESCE(nombre_zona, 'Escritorio')
      WHERE device_id = 'M5_PISO_1_ESCRITORIO'
    `);

    await pool.query(`
      INSERT INTO beacons (mac, nombre, nombre_mascota, icono, asignado, ultimo_visto, updated_at)
      SELECT $1, 'Michi', 'Michi', 'pets', true, now(), now()
      WHERE NOT EXISTS (SELECT 1 FROM beacons LIMIT 1)
      ON CONFLICT (mac) DO NOTHING
    `, [process.env.TARGET_MAC || 'dd:88:00:00:3e:15']);

    await pool.query(`
      UPDATE beacons
      SET nombre = COALESCE(nombre, 'Michi'),
          nombre_mascota = COALESCE(nombre_mascota, nombre, 'Michi'),
          icono = COALESCE(icono, 'pets'),
          asignado = COALESCE(asignado, true)
      WHERE mac = $1
    `, [process.env.TARGET_MAC || 'dd:88:00:00:3e:15']);
  } catch (err) {
    console.error('[ERROR] ensureDefaultDevices:', err.message);
  }
}

ensureDeviceSchema().then(() => ensureDefaultDevices());

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

// Estado actual de cada beacon monitoreado (por ahora, uno solo, pero el endpoint ya soporta varios).
app.get('/api/estado', async (req, res) => {
  try {
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
       LEFT JOIN estado_actual e ON e.device_id = u.device_id
       ORDER BY u.nombre_zona ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[ERROR] /api/estado:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// ELIMINAR GATEWAY
// =========================================================================
app.delete('/api/gateways/:device_id', async (req, res) => {
  const { device_id } = req.params;
  try {
    // 1. Eliminar la zona mapeada asociada
    await pool.query('DELETE FROM zonas WHERE device_id = $1', [device_id]);

    // 2. Eliminar el gateway
    const { rowCount } = await pool.query('DELETE FROM gateways WHERE device_id = $1', [device_id]);

    if (!rowCount) {
      return res.status(404).json({ error: 'Gateway no encontrado en la base de datos.' });
    }

    console.log(`[DELETE] Gateway ${device_id} eliminado con éxito.`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ERROR] DELETE /api/gateways/:device_id:', err.message);
    res.status(500).json({ error: err.message });
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
    const { rows } = await pool.query(
      `SELECT mac, nombre_zona, cambiado_en
       FROM historial_zona
       ORDER BY cambiado_en DESC
       LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('[ERROR] /api/historial:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/anomalias', async (req, res) => {
  try {
    const desde = req.query.desde || null;
    const hasta = req.query.hasta || null;
    const revisada = req.query.revisada;
    const archivada = req.query.archivada === 'true';
    const condiciones = ['mac = $1', archivada ? 'archivada_en IS NOT NULL' : 'archivada_en IS NULL'];
    const parametros = [process.env.TARGET_MAC || 'dd:88:00:00:3e:15'];
    if (desde) { parametros.push(desde); condiciones.push(`detectada_en >= $${parametros.length}::date`); }
    if (hasta) { parametros.push(hasta); condiciones.push(`detectada_en < ($${parametros.length}::date + interval '1 day')`); }
    if (revisada === 'true') condiciones.push('revisada_en IS NOT NULL');
    if (revisada === 'false') condiciones.push('revisada_en IS NULL');
    const { rows } = await pool.query(
      `SELECT id, tipo, descripcion, capa, z_score, if_score, detectada_en, resuelta_en,
              revisada_en, archivada_en, comentario, falso_positivo,
              (SELECT z.nombre_zona
               FROM estado_actual e
               JOIN zonas z ON z.device_id = e.device_id
               WHERE e.mac = $1
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
    const mac = process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
    const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || '')) ? String(req.query.mes) : null;
    const { rows } = await pool.query(
      `SELECT (detectada_en AT TIME ZONE 'America/Bogota')::date AS fecha,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE falso_positivo IS NOT TRUE)::int AS relevantes
       FROM anomalias
       WHERE mac = $1
         AND archivada_en IS NULL
         AND ($2::date IS NULL OR (detectada_en AT TIME ZONE 'America/Bogota') >= $2::date)
         AND ($2::date IS NULL OR (detectada_en AT TIME ZONE 'America/Bogota') < ($2::date + interval '1 month'))
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
    const mac = process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
    const fecha = req.params.fecha;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
    const { rows } = await pool.query(
      `SELECT id, tipo, descripcion, capa, z_score, if_score, detectada_en, resuelta_en, revisada_en, comentario, falso_positivo
       FROM anomalias
       WHERE mac = $1
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
    const mac = process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
    const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || '')) ? String(req.query.mes) : null;
    const { rows } = await pool.query(
      `SELECT id, fecha, hora, titulo, notificar, notificado
       FROM recordatorios
       WHERE mac = $1
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
    const mac = process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
    const { fecha, hora, titulo, notificar } = req.body || {};
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
    const mac = process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
    const { notificar } = req.body || {};
    const { rowCount } = await pool.query(
      'UPDATE recordatorios SET notificar = $1 WHERE id = $2 AND mac = $3',
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
    const mac = process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
    const { rowCount } = await pool.query('DELETE FROM recordatorios WHERE id = $1 AND mac = $2', [req.params.id, mac]);
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
    const mac = process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
    const { rows } = await pool.query(
      `SELECT id, fecha, hora, titulo
       FROM recordatorios
       WHERE mac = $1
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
    if (accion === 'comentar') {
      const { rowCount } = await pool.query('UPDATE anomalias SET comentario = $1 WHERE id = $2 AND mac = $3', [req.body.comentario || null, req.params.id, process.env.TARGET_MAC || 'dd:88:00:00:3e:15']);
      if (!rowCount) return res.status(404).json({ error: 'Alerta no encontrada.' });
      return res.json({ ok: true });
    }
    if (accion === 'falso_positivo') {
      const { rowCount } = await pool.query('UPDATE anomalias SET falso_positivo = $1 WHERE id = $2 AND mac = $3', [Boolean(req.body.valor), req.params.id, process.env.TARGET_MAC || 'dd:88:00:00:3e:15']);
      if (!rowCount) return res.status(404).json({ error: 'Alerta no encontrada.' });
      return res.json({ ok: true });
    }
    const campo = accion === 'revisar' ? 'revisada_en' : 'archivada_en';
    const valor = accion === 'desarchivar' ? null : 'now()';
    const { rowCount } = await pool.query(
      `UPDATE anomalias SET ${campo} = ${valor === null ? 'NULL' : `COALESCE(${campo}, now())`}
       WHERE id = $1 AND mac = $2`,
      [req.params.id, process.env.TARGET_MAC || 'dd:88:00:00:3e:15']
    );
    if (!rowCount) return res.status(404).json({ error: 'Alerta no encontrada.' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/gateways', async (req, res) => {
  try {
    // "online" ya no es un flag estático: un gateway se considera en línea solo si
    // tiene una lectura reciente en estado_actual (es decir, si realmente está mandando datos por MQTT).
    // El M5Stack manda una lectura cada ~3s, así que una ventana corta detecta la desconexión casi al instante.
    const ONLINE_WINDOW_SECONDS = 15;
    const { rows } = await pool.query(
      `SELECT g.*,
              (e.actualizado_en IS NOT NULL AND e.actualizado_en > now() - ($1 || ' seconds')::interval) AS online,
              e.actualizado_en AS ultimo_heartbeat
       FROM gateways g
       LEFT JOIN estado_actual e ON e.device_id = g.device_id
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
  const {
    nombre_zona,
    icono,
    cliente_id,
    wifi_ssid,
    wifi_password,
    mqtt_host,
    mqtt_port,
    mqtt_user,
    mqtt_password,
    online
  } = req.body || {};

  try {
    if (nombre_zona && nombre_zona.trim()) {
      const { rows: actual } = await pool.query('SELECT cliente_id FROM gateways WHERE device_id = $1', [device_id]);
      if (!actual[0]) return res.status(404).json({ error: 'Gateway no encontrado.' });
      const clienteActual = cliente_id || actual[0].cliente_id;

      const { rows: duplicados } = await pool.query(
        `SELECT device_id FROM gateways
         WHERE cliente_id = $1
           AND device_id <> $2
           AND LOWER(TRIM(nombre_zona)) = LOWER($3)`,
        [clienteActual, device_id, nombre_zona.trim()]
      );
      if (duplicados.length) {
        return res.status(409).json({ error: `Ya existe un gateway llamado "${nombre_zona.trim()}". Elige otro nombre.` });
      }
    }

    const { rows } = await pool.query(
      `UPDATE gateways
       SET nombre_zona = COALESCE($1, nombre_zona),
          icono = COALESCE($2, icono),
          nombre = COALESCE($1, nombre, nombre_zona),
          cliente_id = COALESCE($3, cliente_id),
          wifi_ssid = COALESCE($4, wifi_ssid),
          wifi_password = COALESCE($5, wifi_password),
          mqtt_host = COALESCE($6, mqtt_host),
          mqtt_port = COALESCE($7, mqtt_port),
          mqtt_user = COALESCE($8, mqtt_user),
          mqtt_password = COALESCE($9, mqtt_password),
          online = COALESCE($10, online),
          updated_at = now()
       WHERE device_id = $11
       RETURNING *`,
      [
       nombre_zona ?? null,
       icono ?? null,
       cliente_id ?? null,
       wifi_ssid ?? null,
       wifi_password ?? null,
       mqtt_host ?? null,
       mqtt_port ?? null,
       mqtt_user ?? null,
       mqtt_password ?? null,
       online ?? null,
       device_id
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Gateway no encontrado.' });
    await sincronizarZonaDesdeGateway(rows[0].device_id, rows[0].nombre_zona);
    res.json({ ...rows[0], icono: rows[0].icono || 'location_on', nombre: rows[0].nombre || rows[0].nombre_zona || 'Gateway' });
  } catch (err) {
    console.error('[ERROR] /api/gateways/:device_id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/gateways/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre_zona, wifi_ssid, wifi_password, mqtt_host, mqtt_port, mqtt_user, mqtt_password, online, icono } = req.body || {};

  try {
    const { rows } = await pool.query(
      `UPDATE gateways
       SET nombre_zona = COALESCE($1, nombre_zona),
          icono = COALESCE($9, icono),
          wifi_ssid = COALESCE($2, wifi_ssid),
          wifi_password = COALESCE($3, wifi_password),
          mqtt_host = COALESCE($4, mqtt_host),
          mqtt_port = COALESCE($5, mqtt_port),
          mqtt_user = COALESCE($6, mqtt_user),
          mqtt_password = COALESCE($7, mqtt_password),
          online = COALESCE($8, online),
          updated_at = now()
       WHERE id = $10
       RETURNING *`,
      [nombre_zona ?? null, wifi_ssid ?? null, wifi_password ?? null, mqtt_host ?? null, mqtt_port ?? null, mqtt_user ?? null, mqtt_password ?? null, online ?? null, icono ?? null, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Gateway no encontrado.' });
    await sincronizarZonaDesdeGateway(rows[0].device_id, rows[0].nombre_zona);
    res.json({ ...rows[0], icono: rows[0].icono || 'location_on' });
  } catch (err) {
    console.error('[ERROR] /api/gateways/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gateways/provision', async (req, res) => {
  const { cliente_id, device_id, nombre_zona, wifi_ssid, wifi_password, mqtt_host, mqtt_port, mqtt_user, mqtt_password, icono } = req.body || {};
  if (!cliente_id || !device_id) {
    return res.status(400).json({ error: 'cliente_id y device_id son obligatorios.' });
  }

  try {
    const nombreZonaLimpio = (nombre_zona || device_id || '').trim();
    if (nombreZonaLimpio) {
      const { rows: duplicados } = await pool.query(
        `SELECT device_id FROM gateways
         WHERE cliente_id = $1
           AND device_id <> $2
           AND LOWER(TRIM(nombre_zona)) = LOWER($3)`,
        [cliente_id, device_id, nombreZonaLimpio]
      );
      if (duplicados.length) {
        return res.status(409).json({ error: `Ya existe un gateway llamado "${nombreZonaLimpio}". Elige otro nombre.` });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO gateways (cliente_id, device_id, nombre_zona, icono, wifi_ssid, wifi_password, mqtt_host, mqtt_port, mqtt_user, mqtt_password, updated_at)
       VALUES ($1, $2, COALESCE($3, $2), COALESCE($4, 'location_on'), $5, $6, COALESCE($7, 'broker.hivemq.com'), COALESCE($8, 1883), $9, $10, now())
       ON CONFLICT (device_id) DO UPDATE SET
         cliente_id = EXCLUDED.cliente_id,
         nombre_zona = COALESCE(EXCLUDED.nombre_zona, gateways.nombre_zona),
         icono = COALESCE(EXCLUDED.icono, gateways.icono),
         wifi_ssid = EXCLUDED.wifi_ssid,
         wifi_password = EXCLUDED.wifi_password,
         mqtt_host = EXCLUDED.mqtt_host,
         mqtt_port = EXCLUDED.mqtt_port,
         mqtt_user = EXCLUDED.mqtt_user,
         mqtt_password = EXCLUDED.mqtt_password,
         updated_at = now()
       RETURNING *`,
      [cliente_id, device_id, nombreZonaLimpio || null, icono || null, wifi_ssid || null, wifi_password || null, mqtt_host || null, mqtt_port || null, mqtt_user || null, mqtt_password || null]
    );
    await sincronizarZonaDesdeGateway(rows[0].device_id, rows[0].nombre_zona);
    res.status(201).json({ ...rows[0], icono: rows[0].icono || 'location_on' });
  } catch (err) {
    console.error('[ERROR] /api/gateways/provision:', err.message);
    res.status(500).json({ error: err.message });
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
    const { rowCount } = await pool.query(
      'DELETE FROM anomalias WHERE id = $1 AND mac = $2',
      [req.params.id, process.env.TARGET_MAC || 'dd:88:00:00:3e:15']
    );
    if (!rowCount) return res.status(404).json({ error: 'Alerta no encontrada.' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/rutina', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const { rows } = await pool.query(
      `WITH eventos AS (
         SELECT nombre_zona, cambiado_en,
                LEAD(cambiado_en) OVER (ORDER BY cambiado_en) AS siguiente
         FROM historial_zona
         WHERE mac = $1
       ),
       segmentos AS (
         SELECT nombre_zona,
                EXTRACT(HOUR FROM cambiado_en AT TIME ZONE 'America/Bogota')::int * 60 +
                  EXTRACT(MINUTE FROM cambiado_en AT TIME ZONE 'America/Bogota')::int AS inicio_min,
                EXTRACT(EPOCH FROM (siguiente - cambiado_en)) / 60 AS duracion_min
         FROM eventos
         WHERE siguiente IS NOT NULL
           AND siguiente > cambiado_en
           AND siguiente - cambiado_en <= interval '24 hours'
       ),
       patrones AS (
         SELECT inicio_min, nombre_zona, COUNT(*)::int AS observaciones
         FROM segmentos
         GROUP BY inicio_min, nombre_zona
         HAVING COUNT(*) >= 2
       ),
       ordenados AS (
         SELECT inicio_min, nombre_zona, observaciones,
                LEAD(inicio_min) OVER (ORDER BY inicio_min) AS siguiente_inicio
         FROM (
           SELECT patrones.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY inicio_min
                    ORDER BY observaciones DESC, nombre_zona
                  ) AS prioridad
           FROM patrones
         ) seleccionados
         WHERE prioridad = 1
       )
       SELECT inicio_min AS franja_horaria, nombre_zona,
              GREATEST(1, COALESCE(siguiente_inicio, 1440) - inicio_min)::int AS duracion_promedio_min,
              observaciones
       FROM ordenados
       ORDER BY inicio_min`,
      [process.env.TARGET_MAC || 'dd:88:00:00:3e:15']
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
         WHERE mac = $1
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
    const { rows } = await pool.query(
      `WITH eventos AS (
         SELECT nombre_zona, cambiado_en,
                LEAD(cambiado_en) OVER (ORDER BY cambiado_en) AS siguiente
         FROM historial_zona
         WHERE mac = $1
       )
       SELECT (cambiado_en AT TIME ZONE 'America/Bogota')::date AS fecha,
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
      [process.env.TARGET_MAC || 'dd:88:00:00:3e:15', dias, inicio]
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
    const mac = process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
    const fecha = req.params.fecha;
    const hora = Number(req.params.hora);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
    if (!Number.isInteger(hora) || hora < 0 || hora > 23) return res.status(400).json({ error: 'Hora inválida.' });
    const { rows } = await pool.query(
      `WITH eventos AS (
         SELECT nombre_zona, cambiado_en,
                LEAD(cambiado_en) OVER (ORDER BY cambiado_en) AS siguiente
         FROM historial_zona
         WHERE mac = $1
       )
       SELECT nombre_zona, cambiado_en,
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
    const mac = process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
    const fecha = req.params.fecha;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
    const { rows } = await pool.query(
      `WITH eventos AS (
         SELECT nombre_zona, cambiado_en,
                LEAD(cambiado_en) OVER (ORDER BY cambiado_en) AS siguiente
         FROM historial_zona
         WHERE mac = $1
       )
       SELECT nombre_zona, cambiado_en,
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
    const { rows } = await pool.query(
      `WITH limites AS (
         SELECT
           CASE WHEN $2 = 'month'
             THEN date_trunc('month', now() AT TIME ZONE $3) + ($4 * interval '1 month')
             ELSE date_trunc('week', now() AT TIME ZONE $3) + ($4 * interval '1 week')
           END AS inicio_local
       ),
       eventos AS (
         SELECT nombre_zona, cambiado_en,
                LEAD(cambiado_en) OVER (ORDER BY cambiado_en) AS siguiente
         FROM historial_zona
         WHERE mac = $1
       ),
       segmentos AS (
         SELECT nombre_zona,
                (cambiado_en AT TIME ZONE $3)::date AS fecha,
                GREATEST(cambiado_en, inicio_local AT TIME ZONE $3) AS inicio,
                LEAST(COALESCE(siguiente, now()), (inicio_local + CASE WHEN $2 = 'month' THEN interval '1 month' ELSE interval '7 days' END) AT TIME ZONE $3) AS fin
         FROM eventos, limites
         WHERE cambiado_en < ((inicio_local + CASE WHEN $2 = 'month' THEN interval '1 month' ELSE interval '7 days' END) AT TIME ZONE $3)
           AND COALESCE(siguiente, now()) > (inicio_local AT TIME ZONE $3)
       )
       SELECT nombre_zona,
              ROUND(SUM(EXTRACT(EPOCH FROM (fin - inicio)) / 60))::int AS minutos,
              COUNT(DISTINCT fecha)::int AS dias,
              MIN(fecha) AS primera_fecha,
              MAX(fecha) AS ultima_fecha
       FROM segmentos
       WHERE fin > inicio
       GROUP BY nombre_zona
       ORDER BY minutos DESC`,
      [process.env.TARGET_MAC || 'dd:88:00:00:3e:15', modo, zona, desplazamiento]
    );
    const { rows: config } = await pool.query(
      'SELECT nombre FROM gato_config WHERE mac = $1',
      [process.env.TARGET_MAC || 'dd:88:00:00:3e:15']
    );
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
    res.json({ nombre: config[0]?.nombre || 'Michi', modo, inicio: periodo[0].inicio, fin: periodo[0].fin, zonas: rows });
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
        `SELECT nombre_zona, actualizado_en FROM estado_actual WHERE mac = $1`,
        [mac]
      ),
      pool.query(`SELECT nombre_zona FROM zonas ORDER BY nombre_zona`),
      pool.query(
        `SELECT COUNT(DISTINCT franja_horaria)::int AS franjas,
                COALESCE(SUM(tiempo_total_min), 0)::numeric(10,1) AS minutos
         FROM rutinas_patron WHERE mac = $1 AND dia_tipo = 'todos'`,
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