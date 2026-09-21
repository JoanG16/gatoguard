require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const scripts = ['schema.sql', 'zonas.sql'];

async function inicializarBaseDeDatos() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const archivo of scripts) {
      const sql = fs.readFileSync(path.join(__dirname, archivo), 'utf8');
      await client.query(sql);
      console.log(`[DB] Aplicado ${archivo}`);
    }
    await client.query('COMMIT');
    console.log('[DB] Esquema listo.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

inicializarBaseDeDatos().catch(err => {
  console.error('[DB] No se pudo inicializar la base de datos:', err.message);
  process.exitCode = 1;
});
