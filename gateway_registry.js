const DUPLICATE_ZONE = 'DUPLICATE_ZONE';
const DEVICE_CONFLICT = 'DEVICE_CONFLICT';
const DEVICE_DELETED = 'DEVICE_DELETED';

async function ensureGatewayRegistrySchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gateway_registry (
      device_id TEXT PRIMARY KEY,
      cliente_id TEXT NOT NULL,
      provisioning_token TEXT NOT NULL,
      nombre_zona TEXT NOT NULL,
      config_version INTEGER NOT NULL DEFAULT 1,
      deleted BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function validateIdentity({ cliente_id, device_id, nombre_zona, provisioning_token }) {
  const values = [cliente_id, device_id, nombre_zona, provisioning_token];
  if (values.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('cliente_id, device_id, nombre_zona y provisioning_token son obligatorios.');
  }
  if (/[+#/]/.test(cliente_id) || /[+#/]/.test(device_id)) {
    throw new Error('cliente_id y device_id no pueden contener /, + o #.');
  }
}

async function acquireLocks(client, cliente_id, device_id, nombre_zona) {
  const keys = [
    `gateway-device:${device_id}`,
    `gateway-zone:${cliente_id}:${nombre_zona.trim().toLocaleLowerCase('es')}`
  ].sort();
  for (const key of keys) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  }
}

async function canonicalZone(client, name) {
  const { rows: zones } = await client.query(
    `SELECT nombre_zona FROM zonas
     WHERE LOWER(TRIM(nombre_zona)) = LOWER(TRIM($1))
     ORDER BY device_id
     LIMIT 1`,
    [name]
  );
  if (zones[0]) return zones[0].nombre_zona;

  const { rows: routines } = await client.query(
    `SELECT nombre_zona FROM rutinas_patron
     WHERE LOWER(TRIM(nombre_zona)) = LOWER(TRIM($1))
     ORDER BY nombre_zona
     LIMIT 1`,
    [name]
  );
  return routines[0]?.nombre_zona || name.trim();
}

async function occupiedGateway(client, cliente_id, device_id, nombre_zona) {
  const { rows } = await client.query(
    `SELECT device_id FROM (
       SELECT g.device_id, 1 AS prioridad
       FROM gateways g
       LEFT JOIN gateway_registry r
         ON r.device_id = g.device_id AND r.deleted = false
       LEFT JOIN (
         SELECT device_id, MAX(time) AS ultimo_dato
         FROM telemetria_raw
         GROUP BY device_id
       ) t ON t.device_id = g.device_id
       WHERE g.cliente_id = $1
         AND g.device_id <> $2
         AND LOWER(TRIM(g.nombre_zona)) = LOWER(TRIM($3))
         AND (
           r.device_id IS NOT NULL
           OR NULLIF(TRIM(g.wifi_ssid), '') IS NOT NULL
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
    [cliente_id, device_id, nombre_zona]
  );
  return rows[0]?.device_id || null;
}

async function withTransaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function validateGatewayZone(pool, identity) {
  validateIdentity(identity);
  return withTransaction(pool, async client => {
    await acquireLocks(client, identity.cliente_id, identity.device_id, identity.nombre_zona);
    const name = await canonicalZone(client, identity.nombre_zona);
    const occupiedBy = await occupiedGateway(client, identity.cliente_id, identity.device_id, name);
    return { nombre_zona: name, gateway_en_uso: occupiedBy };
  });
}

async function registerGateway(pool, gateway) {
  validateIdentity(gateway);
  return withTransaction(pool, async client => {
    const canonicalName = await canonicalZone(client, gateway.nombre_zona);
    await acquireLocks(client, gateway.cliente_id, gateway.device_id, canonicalName);

    const { rows: registryRows } = await client.query(
      'SELECT * FROM gateway_registry WHERE device_id = $1 FOR UPDATE',
      [gateway.device_id]
    );
    const registry = registryRows[0];

    if (registry && registry.cliente_id !== gateway.cliente_id) {
      const error = new Error('Ese identificador ya está registrado para otra cuenta.');
      error.code = DEVICE_CONFLICT;
      throw error;
    }
    if (
      registry
      && registry.provisioning_token
      && registry.provisioning_token !== gateway.provisioning_token
      && !registry.deleted
    ) {
      const error = new Error('Ese identificador ya está vinculado a otra configuración.');
      error.code = DEVICE_CONFLICT;
      throw error;
    }
    if (registry && registry.provisioning_token === gateway.provisioning_token && registry.deleted) {
      const error = new Error('Este gateway fue eliminado. Inicia una nueva configuración para volver a agregarlo.');
      error.code = DEVICE_DELETED;
      throw error;
    }

    const { rows: currentRows } = await client.query(
      'SELECT cliente_id FROM gateways WHERE device_id = $1 FOR UPDATE',
      [gateway.device_id]
    );
    if (currentRows[0] && currentRows[0].cliente_id !== gateway.cliente_id) {
      const error = new Error('Ese identificador ya está registrado para otra cuenta.');
      error.code = DEVICE_CONFLICT;
      throw error;
    }

    const keepExistingZone = registry
      && !registry.deleted
      && (!registry.provisioning_token || registry.provisioning_token === gateway.provisioning_token);
    const zoneName = keepExistingZone ? registry.nombre_zona : canonicalName;

    if (!keepExistingZone) {
      const occupiedBy = await occupiedGateway(client, gateway.cliente_id, gateway.device_id, zoneName);
      if (occupiedBy) {
        const error = new Error(`La zona "${zoneName}" ya está asignada al M5Stack ${occupiedBy}.`);
        error.code = DUPLICATE_ZONE;
        throw error;
      }
    }

    const configVersion = registry
      ? registry.config_version + (keepExistingZone ? 0 : 1)
      : 1;

    await client.query(
      `INSERT INTO gateways (cliente_id, device_id, nombre, nombre_zona, icono, updated_at)
       VALUES ($1, $2, $3, $3, COALESCE($4, 'location_on'), now())
       ON CONFLICT (device_id) DO UPDATE SET
         cliente_id = EXCLUDED.cliente_id,
         nombre = EXCLUDED.nombre,
         nombre_zona = EXCLUDED.nombre_zona,
         icono = COALESCE(EXCLUDED.icono, gateways.icono),
         updated_at = now()`,
      [gateway.cliente_id, gateway.device_id, zoneName, gateway.icono || null]
    );
    await client.query(
      `INSERT INTO gateway_registry
         (device_id, cliente_id, provisioning_token, nombre_zona, config_version, deleted, updated_at)
       VALUES ($1, $2, $3, $4, $5, false, now())
       ON CONFLICT (device_id) DO UPDATE SET
         cliente_id = EXCLUDED.cliente_id,
         provisioning_token = EXCLUDED.provisioning_token,
         nombre_zona = EXCLUDED.nombre_zona,
         config_version = EXCLUDED.config_version,
         deleted = false,
         updated_at = now()`,
      [gateway.device_id, gateway.cliente_id, gateway.provisioning_token, zoneName, configVersion]
    );
    await client.query(
      `INSERT INTO zonas (device_id, nombre_zona)
       VALUES ($1, $2)
       ON CONFLICT (device_id) DO UPDATE SET nombre_zona = EXCLUDED.nombre_zona`,
      [gateway.device_id, zoneName]
    );

    return {
      ok: true,
      device_id: gateway.device_id,
      cliente_id: gateway.cliente_id,
      nombre_zona: zoneName,
      provisioning_token: gateway.provisioning_token,
      config_version: configVersion,
      deleted: false
    };
  });
}

async function updateGatewayZone(pool, { device_id, nombre_zona, icono }) {
  if (typeof nombre_zona !== 'string' || !nombre_zona.trim()) {
    throw new Error('Escribe el nombre de la zona para continuar.');
  }

  return withTransaction(pool, async client => {
    const { rows: currentRows } = await client.query(
      'SELECT cliente_id FROM gateways WHERE device_id = $1',
      [device_id]
    );
    if (!currentRows[0]) return null;

    const canonicalName = await canonicalZone(client, nombre_zona);
    await acquireLocks(client, currentRows[0].cliente_id, device_id, canonicalName);
    const { rows: lockedRows } = await client.query(
      'SELECT cliente_id FROM gateways WHERE device_id = $1 FOR UPDATE',
      [device_id]
    );
    if (!lockedRows[0]) return null;
    const occupiedBy = await occupiedGateway(client, currentRows[0].cliente_id, device_id, canonicalName);
    if (occupiedBy) {
      const error = new Error(`La zona "${canonicalName}" ya está asignada al M5Stack ${occupiedBy}.`);
      error.code = DUPLICATE_ZONE;
      throw error;
    }

    const { rows: gateways } = await client.query(
      `UPDATE gateways
       SET nombre = $1, nombre_zona = $1, icono = COALESCE($2, icono), updated_at = now()
       WHERE device_id = $3
       RETURNING *`,
      [canonicalName, icono || null, device_id]
    );
    const { rows: registryRows } = await client.query(
      `INSERT INTO gateway_registry
         (device_id, cliente_id, provisioning_token, nombre_zona, config_version, deleted, updated_at)
       VALUES ($1, $2, '', $3, 1, false, now())
       ON CONFLICT (device_id) DO UPDATE SET
         nombre_zona = EXCLUDED.nombre_zona,
         config_version = gateway_registry.config_version + 1,
         updated_at = now()
       RETURNING *`,
      [device_id, currentRows[0].cliente_id, canonicalName]
    );
    await client.query(
      `INSERT INTO zonas (device_id, nombre_zona)
       VALUES ($1, $2)
       ON CONFLICT (device_id) DO UPDATE SET nombre_zona = EXCLUDED.nombre_zona`,
      [device_id, canonicalName]
    );
    return { ...gateways[0], registry: registryRows[0] };
  });
}

async function deleteGateway(pool, { device_id, provisioning_token, cliente_id, nombre_zona }) {
  return withTransaction(pool, async client => {
    const { rows: currentRegistryRows } = await client.query(
      'SELECT * FROM gateway_registry WHERE device_id = $1',
      [device_id]
    );
    const { rows: currentGatewayRows } = await client.query(
      'SELECT cliente_id, nombre_zona FROM gateways WHERE device_id = $1',
      [device_id]
    );
    const currentRegistry = currentRegistryRows[0];
    const currentGateway = currentGatewayRows[0];
    const lockClientId = currentRegistry?.cliente_id || currentGateway?.cliente_id || cliente_id;
    const lockZoneName = currentRegistry?.nombre_zona || currentGateway?.nombre_zona || nombre_zona;
    if (lockClientId && lockZoneName) {
      await acquireLocks(client, lockClientId, device_id, lockZoneName);
    } else {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`gateway-device:${device_id}`]);
    }

    const { rows: registryRows } = await client.query(
      'SELECT * FROM gateway_registry WHERE device_id = $1 FOR UPDATE',
      [device_id]
    );
    const registry = registryRows[0];
    if (registry && provisioning_token && registry.provisioning_token && registry.provisioning_token !== provisioning_token) {
      const error = new Error('El token de configuración no corresponde a este gateway.');
      error.code = DEVICE_CONFLICT;
      throw error;
    }
    if (!registry) {
      const { rows: gatewayRows } = await client.query(
        'SELECT cliente_id, nombre_zona FROM gateways WHERE device_id = $1 FOR UPDATE',
        [device_id]
      );
      if (!gatewayRows[0] && !(provisioning_token && cliente_id && nombre_zona)) return null;
      await client.query(
        `INSERT INTO gateway_registry
           (device_id, cliente_id, provisioning_token, nombre_zona, config_version, deleted, updated_at)
         VALUES ($1, $2, $3, $4, 1, true, now())`,
        [
          device_id,
          gatewayRows[0]?.cliente_id || cliente_id,
          provisioning_token || '',
          gatewayRows[0]?.nombre_zona || nombre_zona || device_id
        ]
      );
    } else if (!registry.deleted) {
      await client.query(
        `UPDATE gateway_registry
         SET deleted = true, config_version = config_version + 1, updated_at = now()
         WHERE device_id = $1`,
        [device_id]
      );
    } else {
      return { ...registry, deleted: true };
    }
    await client.query('DELETE FROM zonas WHERE device_id = $1', [device_id]);
    const { rowCount } = await client.query('DELETE FROM gateways WHERE device_id = $1', [device_id]);
    const { rows: finalRegistryRows } = await client.query(
      'SELECT * FROM gateway_registry WHERE device_id = $1',
      [device_id]
    );
    return {
      ...finalRegistryRows[0],
      ok: true,
      existed: rowCount > 0
    };
  });
}

module.exports = {
  DUPLICATE_ZONE,
  DEVICE_CONFLICT,
  DEVICE_DELETED,
  ensureGatewayRegistrySchema,
  validateGatewayZone,
  registerGateway,
  updateGatewayZone,
  deleteGateway
};
