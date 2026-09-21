require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const MAC = process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
const CLIENTE = process.env.CLIENTE_ID || 'demo_cliente';
const TIME_ZONE = process.env.TIME_ZONE || 'America/Bogota';
const DEVICE = process.env.ANOMALY_DEVICE_ID || 'M5_PISO_1_COCINA';
const RSSI = Number(process.env.ANOMALY_RSSI || -10);
const horaObjetivo = process.env.ANOMALY_AT || '17:00';

function ahoraEnZona() {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
  }).formatToParts(new Date());
  return {
    hora: Number(partes.find(parte => parte.type === 'hour').value) % 24,
    minuto: Number(partes.find(parte => parte.type === 'minute').value),
    segundo: Number(partes.find(parte => parte.type === 'second').value),
  };
}

async function programar() {
  const [hora, minuto] = horaObjetivo.split(':').map(Number);
  if (!Number.isInteger(hora) || !Number.isInteger(minuto) || hora < 0 || hora > 23 || minuto < 0 || minuto > 59) {
    throw new Error('ANOMALY_AT debe tener formato HH:MM, por ejemplo 17:00');
  }

  console.log(`[SIMULACION] Esperando ${horaObjetivo} en ${TIME_ZONE} para generar la anomalía...`);
  while (true) {
    const actual = ahoraEnZona();
    const faltan = (hora * 3600 + minuto * 60) - (actual.hora * 3600 + actual.minuto * 60 + actual.segundo);
    if (faltan <= 0 && faltan > -60) break;
    const espera = faltan > 0 ? Math.min(faltan, 30) : 60;
    await new Promise(resolve => setTimeout(resolve, espera * 1000));
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO telemetria_raw (cliente_id, device_id, mac, rssi)
       VALUES ($1, $2, $3, $4) RETURNING id, time, device_id, rssi`,
      [CLIENTE, DEVICE, MAC, RSSI]
    );
    console.log('[SIMULACION] Anomalía programada insertada:', rows[0]);
    console.log('El detector debería mostrarla en la interfaz en menos de 30 segundos.');
  } finally {
    await pool.end();
  }
}

programar().catch(err => {
  console.error('[SIMULACION] Error:', err.message);
  process.exitCode = 1;
});
