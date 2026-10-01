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

client.on('connect', async () => {
  console.log(`[MQTT] Conectado a ${mqttUrl}`);
  try {
    await ensureGatewayRegistrySchema(pool);
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
