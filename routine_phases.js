// Fases de aprendizaje de rutina:
//   días 0-3  : aprendiendo (sin alertas de rutina)
//   día 3     : pre-rutina aprendida de los días 1-3
//   día 7     : los días 4-7 deben concordar TODOS con la pre-rutina -> validada_7
//               si algún día no concuerda -> reevaluacion_14 (sin alertas de rutina hasta el día 14)
//   día 14    : confirmada (validada y los días 8-14 siguen concordando) o evaluada_14
//               (la rutina se construye con los 14 días completos)
// Una visita cuenta aunque dure solo segundos: lo que importa es que se repita en varios días.

const DAY_MS = 24 * 60 * 60 * 1000;
const PRE_DAYS = 3;
const VALIDATION_DAYS = 7;
const FINAL_DAYS = 14;
const MIN_PRE_DAYS = 2;
const MATCH_RATIO = Number(process.env.ROUTINE_MATCH_RATIO) > 0 ? Number(process.env.ROUTINE_MATCH_RATIO) : 0.7;
const SLOT_TOLERANCE = Number(process.env.ROUTINE_SLOT_TOLERANCE) >= 0 ? Number(process.env.ROUTINE_SLOT_TOLERANCE) : 2;
const FINAL_CONFIRM_DAY_RATIO = 0.8;
const FINAL_MIN_DAY_RATIO = 0.3;

const FASES_CON_RUTINA = ['pre_rutina', 'validada_7', 'confirmada', 'evaluada_14'];

function groupVisitsByDay(events, start, slotOf) {
  const days = new Map();
  for (const event of events) {
    const index = Math.floor((event.at.getTime() - start.getTime()) / DAY_MS);
    if (index < 0) continue;
    if (!days.has(index)) days.set(index, []);
    days.get(index).push({ zone: event.zone, slot: slotOf(event.at) });
  }
  return days;
}

function hasVisit(visits, zone, slot) {
  return visits.some(visit => visit.zone === zone && Math.abs(visit.slot - slot) <= SLOT_TOLERANCE);
}

// Zonas/franjas de 5 min que se repiten en al menos `minDays` días del rango [fromDay, toDay).
function buildItems(days, fromDay, toDay, minDays) {
  const candidates = new Map();
  for (let day = fromDay; day < toDay; day += 1) {
    for (const visit of days.get(day) || []) candidates.set(`${visit.zone}|${visit.slot}`, visit);
  }
  const scored = [];
  for (const candidate of candidates.values()) {
    let count = 0;
    for (let day = fromDay; day < toDay; day += 1) {
      if (hasVisit(days.get(day) || [], candidate.zone, candidate.slot)) count += 1;
    }
    if (count >= minDays) scored.push({ ...candidate, days: count });
  }
  scored.sort((a, b) => b.days - a.days || a.slot - b.slot);
  const kept = [];
  for (const item of scored) {
    if (!kept.some(other => other.zone === item.zone && Math.abs(other.slot - item.slot) <= SLOT_TOLERANCE)) {
      kept.push(item);
    }
  }
  return kept;
}

function dayCoverage(items, visits) {
  if (!items.length) return 0;
  return items.filter(item => hasVisit(visits, item.zone, item.slot)).length / items.length;
}

function coverageByDay(items, days, fromDay, toDay) {
  const result = [];
  for (let day = fromDay; day < toDay; day += 1) {
    const coincidencia = Math.round(dayCoverage(items, days.get(day) || []) * 100) / 100;
    result.push({ dia: day + 1, coincidencia, ok: coincidencia >= MATCH_RATIO });
  }
  return result;
}

function evaluatePhase(events, start, until, slotOf) {
  const elapsed = until.getTime() - start.getTime();
  const days = groupVisitsByDay(events, start, slotOf);
  const pre = buildItems(days, 0, PRE_DAYS, MIN_PRE_DAYS);
  const evaluacion = { items_pre_rutina: pre.length, dias_validacion: [], dias_confirmacion: [] };

  if (elapsed < PRE_DAYS * DAY_MS) return { fase: 'aprendiendo', windowDays: PRE_DAYS, evaluacion };
  if (elapsed < VALIDATION_DAYS * DAY_MS) return { fase: 'pre_rutina', windowDays: PRE_DAYS, evaluacion };

  evaluacion.dias_validacion = coverageByDay(pre, days, PRE_DAYS, VALIDATION_DAYS);
  const validated = pre.length > 0 && evaluacion.dias_validacion.every(day => day.ok);
  if (elapsed < FINAL_DAYS * DAY_MS) {
    return validated
      ? { fase: 'validada_7', windowDays: VALIDATION_DAYS, evaluacion }
      : { fase: 'reevaluacion_14', windowDays: PRE_DAYS, evaluacion };
  }

  if (!validated) return { fase: 'evaluada_14', windowDays: FINAL_DAYS, evaluacion };
  const week = buildItems(days, 0, VALIDATION_DAYS, Math.max(MIN_PRE_DAYS, Math.ceil(FINAL_MIN_DAY_RATIO * VALIDATION_DAYS)));
  evaluacion.dias_confirmacion = coverageByDay(week, days, VALIDATION_DAYS, FINAL_DAYS);
  const matching = evaluacion.dias_confirmacion.filter(day => day.ok).length;
  const confirmed = week.length > 0 && matching / evaluacion.dias_confirmacion.length >= FINAL_CONFIRM_DAY_RATIO;
  return { fase: confirmed ? 'confirmada' : 'evaluada_14', windowDays: FINAL_DAYS, evaluacion };
}

module.exports = { DAY_MS, FINAL_DAYS, FASES_CON_RUTINA, evaluatePhase };
