require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const mac = process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
const cliente = process.env.CLIENTE_ID || 'demo_cliente';
const device = process.env.ANOMALY_DEVICE_ID || 'M5_PISO_1_COCINA';
const rssi = Number(process.env.ANOMALY_RSSI || -10);

async function insertarLecturaAnomala() {
  try {
    const { rows } = await pool.query(
      `INSERT INTO telemetria_raw (cliente_id, device_id, mac, rssi)
       VALUES ($1, $2, $3, $4)
       RETURNING id, time, device_id, rssi`,
      [cliente, device, mac, rssi]
    );
    console.log('[SIMULACION] Lectura anómala insertada:', rows[0]);
    console.log('Mantén ejecutándose detect-zone y detect-anomalies para confirmarla.');
  } finally {
    await pool.end();
  }
}

insertarLecturaAnomala().catch(err => {
  console.error('[SIMULACION] Error:', err.message);
  process.exitCode = 1;
});
