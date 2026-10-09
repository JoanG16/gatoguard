// Rebuilds routine aggregates per assigned cat from zone history without altering telemetry.
// Usage: node routine_learning_job.js [optional MAC] [--hasta=ISO date]

require('dotenv').config();
const { Pool } = require('pg');
const { ensureRoutineDetailSchema } = require('./routine_schema');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SLOT_MINUTES = 30;
const DETAIL_SLOT_MINUTES = 5;
const ROUTINE_LEARNING_DAYS = 7;
const ROUTINE_CONFIRMATION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIME_ZONE = process.env.TIME_ZONE || 'America/Bogota';
const args = process.argv.slice(2);
const requestedMacArg = args.find(argument => !argument.startsWith('--'));
const untilArg = args.find(argument => argument.startsWith('--hasta='));
const REQUESTED_MAC = requestedMacArg
  ? requestedMacArg.trim().replace(/-/g, ':').toUpperCase()
  : null;
const UNTIL = untilArg ? new Date(untilArg.slice('--hasta='.length)) : null;
if (UNTIL && Number.isNaN(UNTIL.getTime())) {
  throw new Error('La fecha --hasta debe ser una fecha ISO válida.');
}

let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });

function slotFor(date, slotMinutes = SLOT_MINUTES) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find(part => part.type === 'hour').value) % 24;
  const minute = Number(parts.find(part => part.type === 'minute').value);
  return Math.floor((hour * 60 + minute) / slotMinutes);
}

function localDay(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = type => parts.find(value => value.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function nextSlotStart(date, slotMinutes) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, minute: 'numeric', second: 'numeric',
  }).formatToParts(date);
  const minute = Number(parts.find(part => part.type === 'minute').value);
  const second = Number(parts.find(part => part.type === 'second').value);
  const millisecondsToBoundary =
    ((slotMinutes - (minute % slotMinutes)) * 60 - second) * 1000 - date.getMilliseconds();
  return new Date(date.getTime() + millisecondsToBoundary);
}

function splitSegment(start, end, slotMinutes) {
  const parts = [];
  let cursor = new Date(start);
  while (cursor < end) {
    const boundary = nextSlotStart(cursor, slotMinutes);
    const limit = boundary < end ? boundary : end;
    parts.push({
      slot: slotFor(cursor, slotMinutes),
      day: localDay(cursor),
      seconds: (limit.getTime() - cursor.getTime()) / 1000,
      start: new Date(cursor),
    });
    cursor = limit;
  }
  return parts;
}

function routineWindows(start) {
  const learningStart = new Date(start);
  const learningEnd = new Date(learningStart.getTime() + ROUTINE_LEARNING_DAYS * DAY_MS);
  return {
    learningStart,
    learningEnd,
    confirmationEnd: new Date(learningEnd.getTime() + ROUTINE_CONFIRMATION_DAYS * DAY_MS),
  };
}

function getDetail(details, slot, zone) {
  const key = `${slot}|${zone}`;
  if (!details.has(key)) {
    details.set(key, {
      zone,
      slot,
      days: new Set(),
      learningDays: new Set(),
      confirmationDays: new Set(),
      visits: 0,
      completeVisits: 0,
      durationSeconds: 0,
      learningVisits: 0,
      learningCompleteVisits: 0,
      learningDurationSeconds: 0,
      confirmationVisits: 0,
    });
  }
  return details.get(key);
}

function recordVisit(details, event, learning, complete, durationSeconds) {
  const detail = getDetail(details, slotFor(event.at, DETAIL_SLOT_MINUTES), event.zone);
  const day = localDay(event.at);
  detail.days.add(day);
  detail.visits += 1;
  if (complete) {
    detail.completeVisits += 1;
    detail.durationSeconds += durationSeconds;
  }
  if (learning) {
    detail.learningDays.add(day);
    detail.learningVisits += 1;
    if (complete) {
      detail.learningCompleteVisits += 1;
      detail.learningDurationSeconds += durationSeconds;
    }
  } else {
    detail.confirmationDays.add(day);
    detail.confirmationVisits += 1;
  }
}

function recordLearningDuration(routine, zone, start, end) {
  if (end <= start) return;
  for (const part of splitSegment(start, end, SLOT_MINUTES)) {
    const key = `${part.slot}|${zone}`;
    const data = routine.get(key) || { zone, slot: part.slot, minutes: 0, visits: 0 };
    data.minutes += part.seconds / 60;
    routine.set(key, data);
  }
}

async function readEvents(mac, until) {
  const { rows } = await pool.query(
    `SELECT h.nombre_zona AS zone, h.cambiado_en AS at
     FROM historial_zona h
     WHERE UPPER(TRIM(h.mac)) = $1
       AND h.cambiado_en < $2::timestamptz
       AND EXISTS (
         SELECT 1 FROM beacons b
         WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = $1
       )
     ORDER BY h.cambiado_en ASC`,
    [mac, until]
  );
  return rows;
}

async function processCat(mac, until) {
  console.log(`[RUTINA] Procesando MAC ${mac} por separado.`);
  const { rows: firstEvent } = await pool.query(
    `SELECT MIN(h.cambiado_en) AS inicio
     FROM historial_zona h
     WHERE UPPER(TRIM(h.mac)) = $1
       AND h.cambiado_en < $2::timestamptz
       AND EXISTS (
         SELECT 1 FROM beacons b
         WHERE b.asignado = true AND UPPER(TRIM(b.mac)) = $1
       )`,
    [mac, until]
  );
  if (!firstEvent[0]?.inicio) {
    console.log(`[RUTINA] MAC ${mac}: sin historial; no se modificaron sus agregados.`);
    return;
  }

  const { learningStart, learningEnd, confirmationEnd } = routineWindows(firstEvent[0].inicio);
  const observedUntil = new Date(Math.min(until.getTime(), confirmationEnd.getTime()));
  const events = await readEvents(mac, observedUntil);
  const routine = new Map();
  const details = new Map();

  for (let index = 0; index < events.length; index += 1) {
    const current = { zone: events[index].zone, at: new Date(events[index].at) };
    const next = events[index + 1] ? new Date(events[index + 1].at) : observedUntil;
    const learningVisit = current.at >= learningStart && current.at < learningEnd;
    const confirmationVisit = current.at >= learningEnd && current.at < confirmationEnd;
    const learningComplete = Boolean(events[index + 1]
      && next.getTime() > current.at.getTime()
      && next.getTime() <= learningEnd.getTime());
    const confirmationComplete = Boolean(events[index + 1]
      && next.getTime() > current.at.getTime()
      && next.getTime() > learningEnd.getTime()
      && next.getTime() <= confirmationEnd.getTime());
    if (learningVisit) {
      recordVisit(
        details,
        current,
        true,
        learningComplete,
        learningComplete ? (next.getTime() - current.at.getTime()) / 1000 : 0
      );
      const key = `${slotFor(current.at)}|${current.zone}`;
      const data = routine.get(key) || { zone: current.zone, slot: slotFor(current.at), minutes: 0, visits: 0 };
      data.visits += 1;
      routine.set(key, data);
    } else if (confirmationVisit) {
      recordVisit(
        details,
        current,
        false,
        confirmationComplete,
        confirmationComplete ? (next.getTime() - current.at.getTime()) / 1000 : 0
      );
    }

    const segmentEnd = new Date(Math.min(next.getTime(), observedUntil.getTime()));
    const learningSegmentStart = new Date(Math.max(current.at.getTime(), learningStart.getTime()));
    const learningSegmentEnd = new Date(Math.min(segmentEnd.getTime(), learningEnd.getTime()));
    recordLearningDuration(routine, current.zone, learningSegmentStart, learningSegmentEnd);
  }

  const learningComplete = until >= learningEnd;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO rutina_estado (mac, inicio_aprendizaje, fin_aprendizaje, fin_reconfirmacion, actualizado_en)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (mac) DO UPDATE SET
         inicio_aprendizaje = EXCLUDED.inicio_aprendizaje,
         fin_aprendizaje = EXCLUDED.fin_aprendizaje,
         fin_reconfirmacion = EXCLUDED.fin_reconfirmacion,
         actualizado_en = now()`,
      [mac, learningStart, learningEnd, confirmationEnd]
    );
    await client.query(
      `DELETE FROM rutinas_patron
       WHERE UPPER(TRIM(mac)) = $1 AND dia_tipo = 'todos'`,
      [mac]
    );
    await client.query('DELETE FROM rutina_detalle WHERE UPPER(TRIM(mac)) = $1', [mac]);

    for (const item of routine.values()) {
      await client.query(
        `INSERT INTO rutinas_patron
           (mac, dia_tipo, franja_horaria, nombre_zona, tiempo_total_min, frecuencia_visitas)
         VALUES ($1, 'todos', $2, $3, $4, $5)`,
        [mac, item.slot, item.zone, item.minutes, item.visits]
      );
    }
    for (const item of details.values()) {
      await client.query(
        `INSERT INTO rutina_detalle
           (mac, franja_5min, nombre_zona, dias_observados, frecuencia_visitas,
            visitas_completas, duracion_total_seg, dias_aprendizaje, aprendizaje_completo,
            visitas_aprendizaje, visitas_completas_aprendizaje, duracion_aprendizaje_seg,
            dias_reconfirmacion, visitas_reconfirmacion)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          mac,
          item.slot,
          item.zone,
          item.days.size,
          item.visits,
          item.completeVisits,
          item.durationSeconds,
          item.learningDays.size,
          learningComplete,
          item.learningVisits,
          item.learningCompleteVisits,
          item.learningDurationSeconds,
          item.confirmationDays.size,
          item.confirmationVisits,
        ]
      );
    }
    await client.query('COMMIT');
    console.log(`[RUTINA] MAC ${mac}: ${events.length} eventos, ${routine.size} franjas de 30 min, ${details.size} franjas de 5 min; ${learningComplete ? 'aprendizaje completo' : 'aprendizaje en curso'}.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function run() {
  const until = UNTIL || new Date();
  await ensureRoutineDetailSchema(pool);
  const lockClient = await pool.connect();
  let lockHeld = false;
  try {
    const { rows: lockRows } = await lockClient.query(
      "SELECT pg_try_advisory_lock(hashtext('gatoguard:routine-learning')) AS locked"
    );
    lockHeld = lockRows[0].locked;
    if (!lockHeld) {
      console.log('[RUTINA] Ya hay otra reconstrucción activa; se omite esta ejecución.');
      return;
    }

    const { rows: cats } = await pool.query(
      `SELECT DISTINCT UPPER(TRIM(mac)) AS mac
       FROM beacons
       WHERE asignado = true
         AND ($1::text IS NULL OR UPPER(TRIM(mac)) = $1)
       ORDER BY 1`,
      [REQUESTED_MAC]
    );
    if (!cats.length) {
      console.log(REQUESTED_MAC
        ? `[RUTINA] La MAC ${REQUESTED_MAC} no está registrada y asignada; no se modificó ninguna rutina.`
        : '[RUTINA] No hay gatos asignados; no se modificó ninguna rutina.');
      return;
    }
    let failures = 0;
    for (const { mac } of cats) {
      if (stopping) break;
      try {
        await processCat(mac, until);
      } catch (err) {
        failures += 1;
        console.error(`[RUTINA][ERROR] MAC ${mac}: ${err.message}`);
      }
    }
    if (failures) throw new Error(`${failures} MAC(s) no pudieron actualizar sus rutinas.`);
  } finally {
    if (lockHeld) {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext('gatoguard:routine-learning'))");
    }
    lockClient.release();
  }
}

if (require.main === module) {
  run()
    .catch(err => {
      console.error('[RUTINA][ERROR]', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = { localDay, nextSlotStart, routineWindows, slotFor, splitSegment };
