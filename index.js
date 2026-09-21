require('dotenv').config();
const mqtt = require('mqtt');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 10000, query_timeout: 10000 });
pool.on('error', (err) => console.error('[ERROR] Pool de Postgres:', err.message));

const mqttUrl = process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883';
const client = mqtt.connect(mqttUrl);

// Comodines: captura cualquier cliente_id y cualquier device_id, sin hardcodear nombres.
const TOPIC_PATTERN = 'telemetria/+/+/beacon';

client.on('connect', () => {
  console.log(`[MQTT] Conectado a ${mqttUrl}`);
  client.subscribe(TOPIC_PATTERN, (err) => {
    if (err) console.error('[MQTT] Error al suscribirse:', err.message);
    else console.log(`[MQTT] Suscrito a "${TOPIC_PATTERN}"`);
  });
});

client.on('reconnect', () => console.log('[MQTT] Reconectando...'));
client.on('error', (err) => console.error('[MQTT] Error de conexión:', err.message));

client.on('message', async (topic, payloadBuffer) => {
  let data;
  try {
    data = JSON.parse(payloadBuffer.toString());
  } catch (err) {
    console.warn(`[WARN] Payload no es JSON válido en topic "${topic}":`, payloadBuffer.toString());
    return;
  }

  const { cliente_id, device_id, mac, rssi, schema_version } = data;

  if (!cliente_id || !device_id || !mac || typeof rssi !== 'number') {
    console.warn('[WARN] Payload incompleto, se descarta:', data);
    return;
  }

  if (schema_version !== 1) {
    console.warn(`[WARN] schema_version desconocida (${schema_version}), se procesa igual pero revisar.`);
  }

  try {
    await pool.query(
      `INSERT INTO telemetria_raw (cliente_id, device_id, mac, rssi) VALUES ($1, $2, $3, $4)`,
      [cliente_id, device_id, mac, rssi]
    );
    console.log(`[OK] ${device_id} <- ${mac} RSSI=${rssi}`);
  } catch (err) {
    console.error('[ERROR] No se pudo escribir en Postgres:', err.message);
  }
});

process.on('SIGINT', async () => {
  console.log('\nCerrando conexiones...');
  client.end();
  await pool.end();
  process.exit(0);
});
