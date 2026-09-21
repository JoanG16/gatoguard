// routine_learning_job.js
//
// Reconstruye COMPLETA la matriz de rutina (rutinas_patron) a partir de historial_zona.
// Se ejecuta periódicamente (ej. una vez al día, vía cron). Como el volumen de datos de
// un solo gato/beacon es chico, reconstruir todo desde cero es más simple y menos propenso
// a bugs que llevar un "watermark" incremental — a esta escala el costo es insignificante.
//
// Uso: node routine_learning_job.js  [MAC opcional, si no se pasa usa TARGET_MAC del .env]

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SLOT_MINUTES = 30; // 48 franjas de 30 min por día
const MAC = process.argv[2] || process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
const TIME_ZONE = process.env.TIME_ZONE || 'America/Bogota';

if (!MAC) {
  console.error('Falta la MAC del beacon. Uso: node routine_learning_job.js <mac>');
  process.exit(1);
}

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

async function reconstruirMatriz() {
  console.log(`Reconstruyendo matriz de rutina para MAC ${MAC}...`);

  const { rows: eventos } = await pool.query(
    `SELECT nombre_zona, cambiado_en
     FROM historial_zona
     WHERE UPPER(mac) = UPPER($1)
     ORDER BY cambiado_en ASC`,
    [MAC]
  );

  if (eventos.length === 0) {
    console.log('No hay eventos en historial_zona todavía. Nada que aprender aún.');
    return;
  }

  // Acumulador en memoria: clave = "franja|zona" -> { minutos, visitas }
  const acumulado = new Map();

  for (let i = 0; i < eventos.length; i++) {
    const actual = eventos[i];
    const siguiente = eventos[i + 1];
    const inicio = new Date(actual.cambiado_en);
    const fin = siguiente ? new Date(siguiente.cambiado_en) : new Date(); // el último segmento llega hasta "ahora"

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
    await client.query('DELETE FROM rutinas_patron WHERE UPPER(mac) = UPPER($1) AND dia_tipo = $2', [MAC, 'todos']);

    for (const [clave, datos] of acumulado.entries()) {
      const [franja, zona] = clave.split('|');
      await client.query(
        `INSERT INTO rutinas_patron (mac, dia_tipo, franja_horaria, nombre_zona, tiempo_total_min, frecuencia_visitas)
         VALUES ($1, 'todos', $2, $3, $4, $5)`,
        [MAC, Number(franja), zona, datos.minutos, datos.visitas]
      );
    }

    await client.query('COMMIT');
    console.log('Matriz de rutina actualizada correctamente.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

reconstruirMatriz()
  .catch(err => console.error('[ERROR]', err.message))
  .finally(() => pool.end());