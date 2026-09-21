require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 10000, query_timeout: 10000 });
// Si una conexión inactiva del pool se cae (por red o timeout del servidor), 'error' se dispara en el
// pool en vez de tumbar el proceso. Sin este listener, un error no capturado podía congelar el detector
// (el setInterval seguía "vivo" pero las consultas jamás resolvían), causando falsos "Sin señal" en el Home.
pool.on('error', (err) => console.error('[ERROR] Pool de Postgres:', err.message));

// --- CONFIGURACIÓN ---
const TARGET_MAC = process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
const WINDOW_SECONDS = 8;         // ventana de lecturas recientes a promediar (suavizado)
const HYSTERESIS_MARGIN = 6;      // dB que la nueva zona debe superar a la actual para considerar el cambio
const CONFIRM_POLLS_NEEDED = 2;   // veces SEGUIDAS que el candidato debe ganar antes de aceptar el cambio
const POLL_INTERVAL_MS = 3000;    // cada cuánto se re-evalúa
const MIN_RSSI_DBM = Number(process.env.MIN_RSSI_DBM || -65); // RSSI mínimo fijado estrictamente en -65 dBm
const TIME_ZONE = process.env.TIME_ZONE || 'America/Mexico_City';

let currentZoneDeviceId = null; // zona confirmada, en memoria
let pendingZoneDeviceId = null; // candidato a nueva zona, todavía sin suficientes confirmaciones
let pendingCount = 0;

function horaLog() {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: TIME_ZONE, dateStyle: 'short', timeStyle: 'medium'
  }).format(new Date());
}

async function evaluarZona() {
  // Se usa UPPER(mac) = UPPER($1) para hacer el filtro insensible a mayúsculas/minúsculas
  const { rows } = await pool.query(
    `SELECT device_id, AVG(rssi)::numeric(6,2) AS rssi_promedio, COUNT(*) AS muestras
     FROM telemetria_raw
     WHERE UPPER(mac) = UPPER($1) AND rssi >= $3
       AND time > now() - ($2 || ' seconds')::interval
     GROUP BY device_id`,
    [TARGET_MAC, WINDOW_SECONDS, MIN_RSSI_DBM]
  );

  if (rows.length === 0) {
    console.log(`[${horaLog()}] Sin lecturas recientes del beacon ${TARGET_MAC}.`);
    return;
  }

  rows.sort((a, b) => b.rssi_promedio - a.rssi_promedio);
  const candidato = rows[0];

  console.log(
    `[${horaLog()}] Lecturas: ` +
    rows.map(r => `${r.device_id}=${r.rssi_promedio}dBm(${r.muestras})`).join(', ')
  );

  let zonaConfirmadaCambio = false;
  let zonaParaGuardar;

  if (!currentZoneDeviceId) {
    currentZoneDeviceId = candidato.device_id;
    pendingZoneDeviceId = null;
    pendingCount = 0;
    zonaConfirmadaCambio = true;
    zonaParaGuardar = candidato;

  } else if (candidato.device_id === currentZoneDeviceId) {
    pendingZoneDeviceId = null;
    pendingCount = 0;
    zonaParaGuardar = candidato;

  } else {
    const filaActual = rows.find(r => r.device_id === currentZoneDeviceId);
    zonaParaGuardar = filaActual || candidato;

    let pasaMargen;
    let etiquetaDiferencia;

    if (!filaActual) {
      pasaMargen = true;
      etiquetaDiferencia = 'sin lecturas recientes de la zona actual, no se compara margen';
    } else {
      const diferencia = Number(candidato.rssi_promedio) - Number(filaActual.rssi_promedio);
      pasaMargen = diferencia >= HYSTERESIS_MARGIN;
      etiquetaDiferencia = `+${diferencia.toFixed(1)}dB`;
    }

    if (!pasaMargen) {
      console.log(`  -> "${candidato.device_id}" no supera el margen (${etiquetaDiferencia} < ${HYSTERESIS_MARGIN}dB). Se mantiene zona actual.`);
      pendingZoneDeviceId = null;
      pendingCount = 0;

    } else if (pendingZoneDeviceId === candidato.device_id) {
      pendingCount += 1;
      if (pendingCount >= CONFIRM_POLLS_NEEDED) {
        console.log(`  -> "${candidato.device_id}" confirmado ${pendingCount}/${CONFIRM_POLLS_NEEDED} veces seguidas (${etiquetaDiferencia}). Se acepta el cambio.`);
        currentZoneDeviceId = candidato.device_id;
        pendingZoneDeviceId = null;
        pendingCount = 0;
        zonaConfirmadaCambio = true;
        zonaParaGuardar = candidato;
      } else {
        console.log(`  -> "${candidato.device_id}" supera el margen (${etiquetaDiferencia}), confirmación ${pendingCount}/${CONFIRM_POLLS_NEEDED}. Se mantiene zona actual por ahora.`);
      }

    } else {
      pendingZoneDeviceId = candidato.device_id;
      pendingCount = 1;
      console.log(`  -> "${candidato.device_id}" supera el margen (${etiquetaDiferencia}), primera confirmación (1/${CONFIRM_POLLS_NEEDED}).`);
    }
  }

  const { rows: zonaRows } = await pool.query(
    `SELECT nombre_zona FROM zonas WHERE device_id = $1`,
    [zonaParaGuardar.device_id]
  );
  const nombreZona = zonaRows[0]?.nombre_zona || zonaParaGuardar.device_id;

  await pool.query(
    `INSERT INTO estado_actual (mac, device_id, nombre_zona, rssi_promedio, actualizado_en)
     VALUES (UPPER($1), $2, $3, $4, now())
     ON CONFLICT (mac) DO UPDATE
       SET device_id = EXCLUDED.device_id,
           nombre_zona = EXCLUDED.nombre_zona,
           rssi_promedio = EXCLUDED.rssi_promedio,
           actualizado_en = now()`,
    [TARGET_MAC, zonaParaGuardar.device_id, nombreZona, zonaParaGuardar.rssi_promedio]
  );

  if (zonaConfirmadaCambio) {
    console.log(`  >>> CAMBIO DE ZONA CONFIRMADO: ahora en "${nombreZona}" (${zonaParaGuardar.rssi_promedio}dBm)`);
    await pool.query(
      `INSERT INTO historial_zona (mac, device_id, nombre_zona, rssi_promedio)
       VALUES (UPPER($1), $2, $3, $4)`,
      [TARGET_MAC, zonaParaGuardar.device_id, nombreZona, zonaParaGuardar.rssi_promedio]
    );
  }
}

console.log(`Iniciando detector de zona para beacon ${TARGET_MAC}...`);
console.log(`Ventana: ${WINDOW_SECONDS}s | RSSI mínimo: ${MIN_RSSI_DBM}dBm | Histéresis: ${HYSTERESIS_MARGIN}dB | Confirmaciones: ${CONFIRM_POLLS_NEEDED} | Poll: ${POLL_INTERVAL_MS}ms\n`);

setInterval(() => {
  evaluarZona().catch(err => console.error('[ERROR] evaluarZona:', err.message));
}, POLL_INTERVAL_MS);

process.on('SIGINT', async () => {
  console.log('\nCerrando...');
  await pool.end();
  process.exit(0);
});