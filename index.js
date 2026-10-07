require('dotenv').config();
const mqtt = require('mqtt');
const { Pool } = require('pg');
const { ensureGatewayRegistrySchema, registerGateway } = require('./gateway_registry');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 10000, query_timeout: 10000 });
pool.on('error', (err) => console.error('[ERROR] Pool de Postgres:', err.message));

const mqttUrl = process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883';
const client = mqtt.connect(mqttUrl);

// Comodines: captura cualquier cliente_id y cualquier device_id, sin hardcodear nombres.
const TOPIC_PATTERN = 'telemetria/+/+/beacon';
const GATEWAY_REGISTER_PATTERN = 'telemetria/+/+/gateway/register';
let rechazadasAcumuladas = 0;
let aceptadasAcumuladas = 0;
let proximoLogResumen = Date.now() + 30000;

client.on('connect', async () => {
  console.log(`[MQTT] Conectado a ${mqttUrl}`);
  try {
    await ensureGatewayRegistrySchema(pool);
    await pool.query(
      'ALTER TABLE telemetria_raw ADD COLUMN IF NOT EXISTS sample_count INTEGER NOT NULL DEFAULT 1'
    );
    client.subscribe([TOPIC_PATTERN, GATEWAY_REGISTER_PATTERN], (err) => {
      if (err) console.error('[MQTT] Error al suscribirse:', err.message);
      else console.log(`[MQTT] Suscrito a "${TOPIC_PATTERN}" y "${GATEWAY_REGISTER_PATTERN}"`);
    });
  } catch (err) {
    console.error('[MQTT] No se pudo preparar el registro de gateways:', err.message);
  }
});

client.on('reconnect', () => console.log('[MQTT] Reconectando...'));
client.on('error', (err) => console.error('[MQTT] Error de conexión:', err.message));

client.on('message', async (topic, payloadBuffer) => {
  const topicParts = topic.split('/');
  if (
    topicParts.length === 5
    && topicParts[0] === 'telemetria'
    && topicParts[3] === 'gateway'
    && topicParts[4] === 'register'
  ) {
    const [, topicClientId, topicDeviceId] = topicParts;
    let registration;
    try {
      registration = JSON.parse(payloadBuffer.toString());
    } catch (err) {
      console.warn(`[WARN] Registro MQTT no es JSON válido en "${topic}".`);
      return;
    }
    if (!registration || typeof registration !== 'object' || Array.isArray(registration)) {
      console.warn(`[WARN] Registro MQTT inválido en "${topic}".`);
      return;
    }

    const ackTopic = `telemetria/${topicClientId}/${topicDeviceId}/gateway/ack`;
    const token = typeof registration.provisioning_token === 'string'
      ? registration.provisioning_token
      : '';
    try {
      if (registration.cliente_id !== topicClientId || registration.device_id !== topicDeviceId) {
        throw new Error('El identificador del mensaje no coincide con el topic MQTT.');
      }
      const result = await registerGateway(pool, registration);
      client.publish(ackTopic, JSON.stringify(result), { qos: 1, retain: false }, err => {
        if (err) console.error('[MQTT] No se pudo confirmar el registro del gateway:', err.message);
      });
      console.log(`[GATEWAY] ${topicDeviceId} registrado en "${result.nombre_zona}".`);
    } catch (err) {
      const response = {
        ok: false,
        cliente_id: topicClientId,
        device_id: topicDeviceId,
        provisioning_token: token,
        error: err.message
      };
      client.publish(ackTopic, JSON.stringify(response), { qos: 1, retain: false }, publishError => {
        if (publishError) console.error('[MQTT] No se pudo enviar el rechazo del gateway:', publishError.message);
      });
      console.error(`[GATEWAY] Registro rechazado para ${topicDeviceId}:`, err.message);
    }
    return;
  }

  if (
    topicParts.length !== 4
    || topicParts[0] !== 'telemetria'
    || topicParts[3] !== 'beacon'
  ) {
    console.warn(`[WARN] Se descarta mensaje fuera del topic de lecturas: "${topic}".`);
    return;
  }

  let data;
  try {
    data = JSON.parse(payloadBuffer.toString());
  } catch (err) {
    console.warn(`[WARN] Payload no es JSON válido en topic "${topic}":`, payloadBuffer.toString());
    return;
  }

  const { cliente_id, device_id, schema_version } = data;

  if (!cliente_id || !device_id) {
    console.warn('[WARN] Payload incompleto, se descarta:', data);
    return;
  }

  const [, topicClienteId, topicDeviceId] = topicParts;
  if (
    cliente_id !== topicClienteId
    || device_id !== topicDeviceId
  ) {
    console.warn(`[WARN] Lectura con identidad o valores inválidos; se descarta: "${topic}".`);
    return;
  }

  const lecturas = schema_version === 2 && Array.isArray(data.beacons)
    ? data.beacons
    : schema_version === 1
      ? [data]
      : null;
  if (!lecturas || lecturas.length === 0 || lecturas.length > 48) {
    console.warn(`[WARN] Lote de lecturas vacío, inválido o demasiado grande; se descarta: "${topic}".`);
    return;
  }

  const lecturasNormalizadas = [];
  for (const lectura of lecturas) {
    const mac = String(lectura?.mac || '').trim().replace(/-/g, ':').toUpperCase();
    const rssi = lectura?.rssi;
    const sampleCount = schema_version === 2 ? lectura?.sample_count : 1;
    if (
      !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)
      || !Number.isInteger(rssi)
      || rssi < -127
      || rssi > 0
      || !Number.isInteger(sampleCount)
      || sampleCount < 1
      || sampleCount > 65535
    ) {
      console.warn(`[WARN] Lectura inválida dentro del lote; se descarta el mensaje: "${topic}".`);
      return;
    }
    lecturasNormalizadas.push({ mac, rssi, sample_count: sampleCount });
  }

  try {
    const { rowCount } = await pool.query(
      `INSERT INTO telemetria_raw (cliente_id, device_id, mac, rssi, sample_count)
       SELECT g.cliente_id, g.device_id, incoming.mac, incoming.rssi, incoming.sample_count
       FROM jsonb_to_recordset($3::jsonb)
         AS incoming(mac TEXT, rssi INTEGER, sample_count INTEGER)
       JOIN gateways g ON g.cliente_id = $1 AND g.device_id = $2
       JOIN gateway_registry gr
         ON gr.device_id = g.device_id
        AND gr.cliente_id = g.cliente_id
        AND gr.deleted = false
       WHERE EXISTS (
           SELECT 1
           FROM beacons b
           WHERE UPPER(TRIM(b.mac)) = incoming.mac
             AND b.asignado = true
         )`,
      [cliente_id, device_id, JSON.stringify(lecturasNormalizadas)]
    );
    aceptadasAcumuladas += rowCount;
    rechazadasAcumuladas += lecturasNormalizadas.length - rowCount;
    if (Date.now() >= proximoLogResumen) {
      const mensaje = `[MQTT] En 30s: ${aceptadasAcumuladas} resumen(es) RSSI guardados, ${rechazadasAcumuladas} rechazados (MAC no asignada o gateway inactivo).`;
      if (rechazadasAcumuladas > 0) console.warn(mensaje);
      else console.log(mensaje);
      aceptadasAcumuladas = 0;
      rechazadasAcumuladas = 0;
      proximoLogResumen = Date.now() + 30000;
    }
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
