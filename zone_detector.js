require('dotenv').config();
const { Pool } = require('pg');
const { ensureGatewayRegistrySchema } = require('./gateway_registry');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 10000, query_timeout: 10000 });
// Si una conexión inactiva del pool se cae (por red o timeout del servidor), 'error' se dispara en el
// pool en vez de tumbar el proceso. Sin este listener, un error no capturado podía congelar el detector
// (el setInterval seguía "vivo" pero las consultas jamás resolvían), causando falsos "Sin señal" en el Home.
pool.on('error', (err) => console.error('[ERROR] Pool de Postgres:', err.message));

// --- CONFIGURACIÓN ---
const WINDOW_SECONDS = 3;         // ventana corta para no ocultar visitas breves
const MAX_SAMPLE_AGE_MS = 2500;   // solo confirma con telemetría realmente reciente
const HYSTERESIS_MARGIN = 6;      // dB que la nueva zona debe superar a la actual para considerar el cambio
const CONFIRM_POLLS_NEEDED = 2;   // veces SEGUIDAS que el candidato debe ganar antes de aceptar el cambio
const POLL_INTERVAL_MS = 1000;    // cada cuánto se re-evalúa
const MIN_RSSI_DBM = Number(process.env.MIN_RSSI_DBM || -65); // RSSI mínimo fijado estrictamente en -65 dBm
const TIME_ZONE = process.env.TIME_ZONE || 'America/Bogota';
const estadoPorMac = new Map();

function horaLog() {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: TIME_ZONE, dateStyle: 'short', timeStyle: 'medium'
  }).format(new Date());
}

function resolverZona(mac, estado, filas) {
  if (!filas.length) {
    estado.pendingZoneDeviceId = null;
    estado.pendingCount = 0;
    estado.pendingLastSampleTime = null;
    return null;
  }

  filas.sort((a, b) => Number(b.rssi_promedio) - Number(a.rssi_promedio));
  const candidato = filas[0];
  if (candidato.device_id === estado.currentZoneDeviceId) {
    estado.pendingZoneDeviceId = null;
    estado.pendingCount = 0;
    estado.pendingLastSampleTime = null;
    return { mac, zona: candidato, cambioConfirmado: false };
  }

  const filaActual = estado.currentZoneDeviceId
    ? filas.find(fila => fila.device_id === estado.currentZoneDeviceId)
    : null;
  const diferencia = filaActual
    ? Number(candidato.rssi_promedio) - Number(filaActual.rssi_promedio)
    : null;
  if (diferencia !== null && diferencia < HYSTERESIS_MARGIN) {
    estado.pendingZoneDeviceId = null;
    estado.pendingCount = 0;
    estado.pendingLastSampleTime = null;
    return filaActual ? { mac, zona: filaActual, cambioConfirmado: false } : null;
  }

  const tiempoMuestra = new Date(candidato.ultima_muestra).getTime();
  if (estado.pendingZoneDeviceId === candidato.device_id) {
    if (tiempoMuestra > (estado.pendingLastSampleTime || 0)) {
      estado.pendingCount += 1;
      estado.pendingLastSampleTime = tiempoMuestra;
    }
  } else {
    estado.pendingZoneDeviceId = candidato.device_id;
    estado.pendingCount = 1;
    estado.pendingLastSampleTime = tiempoMuestra;
  }

  if (estado.pendingCount < CONFIRM_POLLS_NEEDED) {
    return filaActual ? { mac, zona: filaActual, cambioConfirmado: false } : null;
  }

  estado.currentZoneDeviceId = candidato.device_id;
  estado.pendingZoneDeviceId = null;
  estado.pendingCount = 0;
  estado.pendingLastSampleTime = null;
  return { mac, zona: candidato, cambioConfirmado: true };
}

async function evaluarActivas() {
  const { rows } = await pool.query(
    `WITH activas AS (
       SELECT DISTINCT ON (UPPER(TRIM(b.mac)))
              UPPER(TRIM(b.mac)) AS mac,
              e.device_id AS current_zone_device_id
       FROM beacons b
       LEFT JOIN estado_actual e ON UPPER(TRIM(e.mac)) = UPPER(TRIM(b.mac))
       WHERE b.asignado = true
       ORDER BY UPPER(TRIM(b.mac)), e.actualizado_en DESC NULLS LAST
     ),
     lecturas AS (
       SELECT UPPER(TRIM(t.mac)) AS mac,
              t.device_id,
              AVG(t.rssi)::numeric(6,2) AS rssi_promedio,
              SUM(t.sample_count)::bigint AS muestras,
              MAX(t.time) AS ultima_muestra
       FROM telemetria_raw t
       JOIN activas a ON a.mac = UPPER(TRIM(t.mac))
       JOIN gateways g ON g.device_id = t.device_id AND g.cliente_id = t.cliente_id
       JOIN gateway_registry gr
         ON gr.device_id = g.device_id
        AND gr.cliente_id = g.cliente_id
        AND gr.deleted = false
       WHERE t.rssi >= $1
         AND t.time > now() - ($2 || ' seconds')::interval
       GROUP BY UPPER(TRIM(t.mac)), t.device_id
       HAVING MAX(t.time) > now() - ($3 || ' milliseconds')::interval
     )
     SELECT a.mac,
            a.current_zone_device_id,
            l.device_id,
            l.rssi_promedio,
            l.muestras,
            l.ultima_muestra,
            COALESCE(z.nombre_zona, l.device_id) AS nombre_zona
     FROM activas a
     LEFT JOIN lecturas l ON l.mac = a.mac
     LEFT JOIN zonas z ON z.device_id = l.device_id
     ORDER BY a.mac, l.device_id`,
    [MIN_RSSI_DBM, WINDOW_SECONDS, MAX_SAMPLE_AGE_MS]
  );

  const lecturasPorMac = new Map();
  const macsActivas = new Set();
  for (const fila of rows) {
    macsActivas.add(fila.mac);
    const estado = estadoPorMac.get(fila.mac) || {
      currentZoneDeviceId: fila.current_zone_device_id || null,
      pendingZoneDeviceId: null,
      pendingCount: 0,
      pendingLastSampleTime: null
    };
    estado.currentZoneDeviceId = fila.current_zone_device_id || null;
    estadoPorMac.set(fila.mac, estado);
    if (!fila.device_id) continue;
    if (!lecturasPorMac.has(fila.mac)) lecturasPorMac.set(fila.mac, []);
    lecturasPorMac.get(fila.mac).push(fila);
  }
  for (const mac of estadoPorMac.keys()) {
    if (!macsActivas.has(mac)) estadoPorMac.delete(mac);
  }

  const ubicaciones = [];
  const historial = [];
  for (const mac of macsActivas) {
    const estado = estadoPorMac.get(mac);
    const resultado = resolverZona(mac, estado, lecturasPorMac.get(mac) || []);
    if (!resultado) continue;

    ubicaciones.push({
      mac,
      device_id: resultado.zona.device_id,
      nombre_zona: resultado.zona.nombre_zona || resultado.zona.device_id,
      rssi_promedio: Number(resultado.zona.rssi_promedio)
    });
    if (resultado.cambioConfirmado) {
      historial.push(ubicaciones[ubicaciones.length - 1]);
      console.log(`[ZONA] ${mac} -> "${resultado.zona.nombre_zona}" (${resultado.zona.rssi_promedio} dBm)`);
    }
  }

  if (ubicaciones.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO estado_actual (mac, device_id, nombre_zona, rssi_promedio, actualizado_en)
         SELECT UPPER(item.mac), item.device_id, item.nombre_zona, item.rssi_promedio, now()
         FROM jsonb_to_recordset($1::jsonb)
           AS item(mac TEXT, device_id TEXT, nombre_zona TEXT, rssi_promedio NUMERIC)
         ON CONFLICT (mac) DO UPDATE
           SET device_id = EXCLUDED.device_id,
               nombre_zona = EXCLUDED.nombre_zona,
               rssi_promedio = EXCLUDED.rssi_promedio,
               actualizado_en = now()`,
        [JSON.stringify(ubicaciones)]
      );
      if (historial.length) {
        await client.query(
          `INSERT INTO historial_zona (mac, device_id, nombre_zona, rssi_promedio)
           SELECT UPPER(item.mac), item.device_id, item.nombre_zona, item.rssi_promedio
           FROM jsonb_to_recordset($1::jsonb)
             AS item(mac TEXT, device_id TEXT, nombre_zona TEXT, rssi_promedio NUMERIC)`,
          [JSON.stringify(historial)]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  console.log(`[${horaLog()}] Detector: ${macsActivas.size} gato(s), ${ubicaciones.length} ubicación(es) actualizada(s), ${historial.length} cambio(s) confirmado(s).`);
}

async function iniciar() {
  await ensureGatewayRegistrySchema(pool);
  await pool.query(
    'ALTER TABLE telemetria_raw ADD COLUMN IF NOT EXISTS sample_count INTEGER NOT NULL DEFAULT 1'
  );
  const { rows } = await pool.query('SELECT count(*)::int AS cantidad FROM beacons WHERE asignado = true');
  console.log(`Iniciando detector de zona para ${rows[0].cantidad} MAC(s) asignada(s)...`);
  console.log(`Ventana: ${WINDOW_SECONDS}s | RSSI reciente: ${MAX_SAMPLE_AGE_MS}ms | RSSI mínimo: ${MIN_RSSI_DBM}dBm | Histéresis: ${HYSTERESIS_MARGIN}dB | Confirmaciones: ${CONFIRM_POLLS_NEEDED} muestras | Poll: ${POLL_INTERVAL_MS}ms`);
  const ciclo = async () => {
    try {
      await evaluarActivas();
    } catch (err) {
      console.error('[ERROR] evaluar zonas:', err.message);
    }
    setTimeout(ciclo, POLL_INTERVAL_MS);
  };
  ciclo();
}

iniciar().catch(err => {
  console.error('[ERROR] iniciar detector de zona:', err.message);
  process.exitCode = 1;
});

process.on('SIGINT', async () => {
  console.log('\nCerrando...');
  await pool.end();
  process.exit(0);
});