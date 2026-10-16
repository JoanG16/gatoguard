const webpush = require('web-push');

const ENDPOINT_HOSTS = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  'push.apple.com',
  'notify.windows.com',
];

class PushSubscriptionValidationError extends Error {}

function vapidConfiguration() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

function getVapidPublicKey() {
  return vapidConfiguration()?.publicKey || null;
}

async function ensurePushSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      subscription JSONB NOT NULL,
      mac TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_mac ON push_subscriptions (UPPER(mac))');
}

function validateSubscription(subscription) {
  if (!subscription || typeof subscription !== 'object' || typeof subscription.endpoint !== 'string') {
    throw new PushSubscriptionValidationError('La suscripción push no tiene un formato válido.');
  }
  let endpoint;
  try {
    endpoint = new URL(subscription.endpoint);
  } catch {
    throw new PushSubscriptionValidationError('El endpoint de notificaciones no es una URL válida.');
  }
  const hostAllowed = ENDPOINT_HOSTS.some(host =>
    endpoint.hostname === host || endpoint.hostname.endsWith(`.${host}`)
  );
  if (endpoint.protocol !== 'https:' || !hostAllowed) {
    throw new PushSubscriptionValidationError('El endpoint de notificaciones no pertenece a un proveedor Web Push permitido.');
  }
  if (
    typeof subscription.keys?.p256dh !== 'string'
    || typeof subscription.keys?.auth !== 'string'
  ) {
    throw new PushSubscriptionValidationError('Faltan las claves cifradas de la suscripción push.');
  }
  return endpoint.toString();
}

async function savePushSubscription(pool, subscription, mac = null) {
  const endpoint = validateSubscription(subscription);
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, subscription, mac)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (endpoint) DO UPDATE
       SET subscription = EXCLUDED.subscription,
           mac = EXCLUDED.mac,
           updated_at = now()`,
    [endpoint, JSON.stringify(subscription), mac]
  );
}

async function removePushSubscription(pool, subscription) {
  const endpoint = validateSubscription(subscription);
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

async function sendPushToSubscribers(pool, { mac, tipo, title, body, url, tag }) {
  if (mac) {
    const { rows: configuracion } = await pool.query(
      `SELECT avisos_alertas, avisos_sin_lecturas
       FROM gato_config
       WHERE UPPER(mac) = UPPER($1)
       LIMIT 1`,
      [mac]
    );
    const avisosPermitidos = tipo === 'sin_senal'
      ? configuracion[0]?.avisos_sin_lecturas !== false
      : configuracion[0]?.avisos_alertas !== false;
    if (!avisosPermitidos) return 0;
  }

  const { rows: subscriptions } = await pool.query(
    mac
      ? `SELECT endpoint, subscription
         FROM push_subscriptions
         WHERE mac IS NULL OR UPPER(mac) = UPPER($1)`
      : 'SELECT endpoint, subscription FROM push_subscriptions',
    mac ? [mac] : []
  );
  if (!subscriptions.length) return 0;

  const configuration = vapidConfiguration();
  if (!configuration) {
    console.error('[PUSH] Hay suscripciones, pero faltan VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY o VAPID_SUBJECT.');
    return 0;
  }

  webpush.setVapidDetails(
    configuration.subject,
    configuration.publicKey,
    configuration.privateKey
  );
  const payload = JSON.stringify({ title, body, url, tag });

  // TTL de 24 h: si el teléfono está apagado o sin red, el aviso llega cuando se reconecte.
  const results = await Promise.all(subscriptions.map(async ({ endpoint, subscription }) => {
    try {
      await webpush.sendNotification(subscription, payload, { TTL: 86400, urgency: 'high' });
      return 1;
    } catch (error) {
      const statusCode = Number(error.statusCode);
      if (statusCode === 404 || statusCode === 410) {
        await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
        return 0;
      }
      console.error(`[PUSH] No se pudo enviar notificación (${statusCode || 'error'}):`, error.message);
      return 0;
    }
  }));
  return results.reduce((total, value) => total + value, 0);
}

module.exports = {
  ensurePushSchema,
  getVapidPublicKey,
  PushSubscriptionValidationError,
  savePushSubscription,
  removePushSubscription,
  sendPushToSubscribers,
};
