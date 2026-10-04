// routine_learning_job.js
//
// Reconstruye COMPLETA la matriz de rutina (rutinas_patron) a partir de historial_zona.
// Se ejecuta periódicamente (ej. una vez al día) y reconstruye cada mascota
// por separado, evitando mezclar sus eventos.
//
// Uso: node routine_learning_job.js [MAC opcional] [--hasta=fecha ISO opcional]

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SLOT_MINUTES = 30; // 48 franjas de 30 min por día
const argumentos = process.argv.slice(2);
const argumentoMac = argumentos.find(argumento => !argumento.startsWith('--'));
const argumentoHasta = argumentos.find(argumento => argumento.startsWith('--hasta='));
const MAC_SOLICITADA = argumentoMac
  ? argumentoMac.trim().replace(/-/g, ':').toUpperCase()
  : null;
const HASTA = argumentoHasta ? new Date(argumentoHasta.slice('--hasta='.length)) : null;
if (HASTA && Number.isNaN(HASTA.getTime())) {
  throw new Error('La fecha --hasta debe ser una fecha ISO válida.');
}
const TIME_ZONE = process.env.TIME_ZONE || 'America/Bogota';

function franjaDe(fecha) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, hour: 'numeric', minute: 'numeric', hour12: false
  }).formatToParts(fecha);
  const hora = Number(partes.find(parte => parte.type === 'hour').value) % 24;
  const minuto = Number(partes.find(parte => parte.type === 'minute').value);
  const minutosDesdeMedianoche = hora * 60 + minuto;
  return Math.floor(minutosDesdeMedianoche / SLOT_MINUTES);
}

function inicioDeSiguienteFranja(fecha) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, minute: 'numeric', second: 'numeric'
  }).formatToParts(fecha);
  const minuto = Number(partes.find(parte => parte.type === 'minute').value);
  const segundo = Number(partes.find(parte => parte.type === 'second').value);
  const milisegundo = fecha.getMilliseconds();
  const minutosHastaCorte = SLOT_MINUTES - (minuto % SLOT_MINUTES);
  const milisegundosHastaCorte =
    (minutosHastaCorte * 60 - segundo) * 1000 - milisegundo;
  return new Date(fecha.getTime() + milisegundosHastaCorte);
}

/**
 * Reparte un segmento [inicio, fin) en una zona entre las franjas de 30 min que cruza.
 * Devuelve un array de { franja, minutos }.
 */
function repartirSegmento(inicio, fin) {
  const partes = [];
  let cursor = new Date(inicio);

  while (cursor < fin) {
    const finFranja = inicioDeSiguienteFranja(cursor);
    const limite = finFranja < fin ? finFranja : fin;
    const minutos = (limite - cursor) / 60000;

    if (minutos > 0) {
      partes.push({ franja: franjaDe(cursor), minutos });
    }
    cursor = limite;
  }

  return partes;
}

async function reconstruirMatriz(mac, hasta = null) {
  console.log(`Reconstruyendo matriz de rutina para MAC ${mac}...`);

  const { rows: eventos } = await pool.query(
    `SELECT h.nombre_zona, h.cambiado_en
     FROM historial_zona h
     JOIN beacons b ON UPPER(TRIM(b.mac)) = UPPER(TRIM(h.mac)) AND b.asignado = true
     WHERE UPPER(TRIM(h.mac)) = UPPER($1)
       AND ($2::timestamptz IS NULL OR h.cambiado_en < $2::timestamptz)
     ORDER BY h.cambiado_en ASC`,
    [mac, hasta]
  );

  // Acumulador en memoria: clave = "franja|zona" -> { minutos, visitas }
  const acumulado = new Map();

  for (let i = 0; i < eventos.length; i++) {
    const actual = eventos[i];
    const siguiente = eventos[i + 1];
    const inicio = new Date(actual.cambiado_en);
    const fin = siguiente ? new Date(siguiente.cambiado_en) : (hasta || new Date());

    if (fin <= inicio) continue; // por seguridad, ignorar segmentos de duración cero o negativa

    const partes = repartirSegmento(inicio, fin);
    for (const parte of partes) {
      const clave = `${parte.franja}|${actual.nombre_zona}`;
      const previo = acumulado.get(clave) || { minutos: 0, visitas: 0 };
      previo.minutos += parte.minutos;
      acumulado.set(clave, previo);
    }

    // Contamos "una visita" por cada vez que este evento inició una franja distinta a la anterior del mismo evento
    // (visita = entrada real a la zona, no cada sub-franja que cruza).
    const franjaInicio = franjaDe(inicio);
    const claveVisita = `${franjaInicio}|${actual.nombre_zona}`;
    const previoVisita = acumulado.get(claveVisita) || { minutos: 0, visitas: 0 };
    previoVisita.visitas += 1;
    acumulado.set(claveVisita, previoVisita);
  }

  console.log(`Procesados ${eventos.length} eventos, ${acumulado.size} combinaciones franja/zona.`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM rutinas_patron WHERE UPPER(mac) = UPPER($1) AND dia_tipo = $2', [mac, 'todos']);

    for (const [clave, datos] of acumulado.entries()) {
      const [franja, zona] = clave.split('|');
      await client.query(
        `INSERT INTO rutinas_patron (mac, dia_tipo, franja_horaria, nombre_zona, tiempo_total_min, frecuencia_visitas)
         VALUES ($1, 'todos', $2, $3, $4, $5)`,
        [mac, Number(franja), zona, datos.minutos, datos.visitas]
      );
    }

    await client.query('COMMIT');
    console.log(eventos.length
      ? 'Matriz de rutina actualizada correctamente.'
      : 'No hay historial para esta mascota; se limpió su rutina anterior.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function reconstruirMascotasAsignadas() {
  const { rows } = await pool.query(
    `SELECT DISTINCT UPPER(TRIM(mac)) AS mac
     FROM beacons
     WHERE asignado = true
       AND ($1::text IS NULL OR UPPER(TRIM(mac)) = UPPER($1))
     ORDER BY 1`,
    [MAC_SOLICITADA]
  );
  if (!rows.length) {
    console.warn(MAC_SOLICITADA
      ? `La MAC ${MAC_SOLICITADA} no está registrada y asignada; no se modificó ninguna rutina.`
      : 'No hay mascotas asignadas; no se modificó ninguna rutina.');
    return;
  }
  for (const { mac } of rows) {
    await reconstruirMatriz(mac, HASTA);
  }
}

reconstruirMascotasAsignadas()
  .catch(err => {
    console.error('[ERROR]', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());