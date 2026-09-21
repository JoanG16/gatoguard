require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TARGET_MAC = process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
const POLL_INTERVAL_MS = 30000;
const STALE_AFTER_SECONDS = Number(process.env.STALE_AFTER_SECONDS || 60);
const Z_SCORE_THRESHOLD = Number(process.env.Z_SCORE_THRESHOLD || 3);
const IF_SCORE_THRESHOLD = Number(process.env.IF_SCORE_THRESHOLD || 0.62);
const MIN_TRAINING_ROWS = Number(process.env.MIN_TRAINING_ROWS || 50);
const ROUTINE_CONFIRM_POLLS = Number(process.env.ROUTINE_CONFIRM_POLLS || 3);
const MIN_ROUTINE_DWELL_MINUTES = Number(process.env.MIN_ROUTINE_DWELL_MINUTES || 60);
const ZONE_WINDOW_SECONDS = Number(process.env.ZONE_WINDOW_SECONDS || 8);
const MIN_RSSI_DBM = Number(process.env.MIN_RSSI_DBM || -65);
const TREE_COUNT = 50;
const SAMPLE_SIZE = 128;
const TIME_ZONE = process.env.TIME_ZONE || 'America/Bogota';
let rutinaPendiente = null;
let rutinaConfirmaciones = 0;

async function umbralSinLecturas() {
  const { rows } = await pool.query(
    'SELECT umbral_sin_lecturas_segundos FROM gato_config WHERE UPPER(mac) = UPPER($1)',
    [TARGET_MAC]
  );
  return Number(rows[0]?.umbral_sin_lecturas_segundos || STALE_AFTER_SECONDS);
}

function franjaActual(fecha) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, hour: 'numeric', minute: 'numeric', hour12: false
  }).formatToParts(fecha);
  const hora = Number(partes.find(parte => parte.type === 'hour').value) % 24;
  const minuto = Number(partes.find(parte => parte.type === 'minute').value);
  return Math.floor((hora * 60 + minuto) / 30);
}

function minutosActual(fecha) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, hour: 'numeric', minute: 'numeric', hour12: false
  }).formatToParts(fecha);
  const hora = Number(partes.find(parte => parte.type === 'hour').value) % 24;
  const minuto = Number(partes.find(parte => parte.type === 'minute').value);
  return hora * 60 + minuto;
}

function media(valores) {
  return valores.reduce((total, valor) => total + valor, 0) / valores.length;
}

function desviacionEstandar(valores, promedio) {
  if (valores.length < 2) return 0;
  return Math.sqrt(
    valores.reduce((total, valor) => total + ((valor - promedio) ** 2), 0) / (valores.length - 1)
  );
}

function cFactor(n) {
  if (n <= 1) return 0;
  return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1) / n);
}

function construirArbol(muestras, profundidad, profundidadMaxima) {
  if (muestras.length <= 1 || profundidad >= profundidadMaxima) {
    return { hoja: true, tamaño: muestras.length };
  }

  const columnas = muestras[0].length;
  const columna = Math.floor(Math.random() * columnas);
  const valores = muestras.map(muestra => muestra[columna]);
  const minimo = Math.min(...valores);
  const maximo = Math.max(...valores);
  if (minimo === maximo) return { hoja: true, tamaño: muestras.length };

  const corte = minimo + Math.random() * (maximo - minimo);
  const menores = muestras.filter(muestra => muestra[columna] < corte);
  const mayores = muestras.filter(muestra => muestra[columna] >= corte);
  return {
    columna,
    corte,
    menores: construirArbol(menores, profundidad + 1, profundidadMaxima),
    mayores: construirArbol(mayores, profundidad + 1, profundidadMaxima),
  };
}

function profundidadEnArbol(arbol, muestra, profundidad) {
  if (arbol.hoja) return profundidad + cFactor(arbol.tamaño);
  const rama = muestra[arbol.columna] < arbol.corte ? arbol.menores : arbol.mayores;
  return profundidadEnArbol(rama, muestra, profundidad + 1);
}

function duracionTexto(minutos) {
  if (minutos < 1) return 'menos de 1 minuto';
  if (minutos < 60) return `${Math.round(minutos)} minutos`;
  return `${Math.floor(minutos / 60)} h ${Math.round(minutos % 60)} min`;
}

function tiempoSinLecturaTexto(segundos) {
  if (segundos < 60) return `${Math.round(segundos)} segundos`;
  const minutos = segundos / 60;
  if (minutos < 60) return `${Math.round(minutos)} minutos`;
  const horas = minutos / 60;
  if (horas < 24) return `${Math.floor(horas)} h ${Math.round(minutos % 60)} min`;
  return `${Math.floor(horas / 24)} días ${Math.floor(horas % 24)} h`;
}

function isolationForest(muestras, objetivo) {
  const tamañoMuestra = Math.min(SAMPLE_SIZE, muestras.length);
  const entrenamiento = muestras.slice(-tamañoMuestra);
  const profundidadMaxima = Math.ceil(Math.log2(tamañoMuestra));
  const profundidades = [];

  for (let i = 0; i < TREE_COUNT; i += 1) {
    const muestraArbol = entrenamiento
      .slice()
      .sort(() => Math.random() - 0.5)
      .slice(0, tamañoMuestra);
    const arbol = construirArbol(muestraArbol, 0, profundidadMaxima);
    profundidades.push(profundidadEnArbol(arbol, objetivo, 0));
  }

  const factor = cFactor(tamañoMuestra);
  return factor === 0 ? 0.5 : 2 ** (-media(profundidades) / factor);
}

function claveRutina(descripcion) {
  const coincidencia = descripcion.match(/(?:está|fue) en "([^"]+)", aunque a esta hora suele estar en "([^"]+)"/);
  return coincidencia ? `${coincidencia[1]}|${coincidencia[2]}` : descripcion;
}

async function abrirAnomalia(tipo, descripcion, zScore, ifScore, capa = 3, clave = null) {
  const { rows } = await pool.query(
    `SELECT id, descripcion
     FROM anomalias
     WHERE UPPER(mac) = UPPER($1) AND tipo = $2 AND resuelta_en IS NULL`,
    [TARGET_MAC, tipo]
  );
  const mismaAnomalia = rows.length > 0 && (
    tipo !== 'rutina_inusual'
    || claveRutina(rows[0].descripcion) === clave
  );
  if (!mismaAnomalia) {
    if (rows.length > 0) await resolverAnomalia(tipo);
    await pool.query(
      `INSERT INTO anomalias (mac, tipo, descripcion, capa, z_score, if_score)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [TARGET_MAC, tipo, descripcion, capa, zScore, ifScore]
    );
    console.warn(`[ANOMALIA][Capa ${capa}] ${descripcion}`);
  } else if (rows[0].descripcion !== descripcion) {
    await pool.query(
      `UPDATE anomalias
       SET descripcion = $1, capa = $2, z_score = $3, if_score = $4
       WHERE id = $5`,
      [descripcion, capa, zScore, ifScore, rows[0].id]
    );
    console.warn(`[ANOMALIA][Capa ${capa}] Alerta actualizada: ${descripcion}`);
  }
}

async function resolverAnomalia(tipo) {
  await pool.query(
    `UPDATE anomalias
     SET resuelta_en = now()
     WHERE UPPER(mac) = UPPER($1) AND tipo = $2 AND resuelta_en IS NULL`,
    [TARGET_MAC, tipo]
  );
}

async function detectar() {
  const { rows: ultimasLecturas } = await pool.query(
    `SELECT time
     FROM telemetria_raw
     WHERE UPPER(mac) = UPPER($1)
     ORDER BY time DESC
     LIMIT 1`,
    [TARGET_MAC]
  );
  const ultimaLecturaEn = ultimasLecturas[0]?.time;
  const segundosDesdeUltimaLectura = ultimaLecturaEn
    ? (Date.now() - new Date(ultimaLecturaEn).getTime()) / 1000
    : Infinity;
  const umbralLecturas = await umbralSinLecturas();

  const { rows: estados } = await pool.query(
    `SELECT device_id, nombre_zona, rssi_promedio, actualizado_en
     FROM estado_actual
     WHERE UPPER(mac) = UPPER($1)
     ORDER BY actualizado_en DESC NULLS LAST
     LIMIT 1`,
    [TARGET_MAC]
  );
  let estado = estados[0];

  if (!estado) {
    // El detector de zona y este proceso arrancan en paralelo. Si todavía no
    // existe estado_actual, reconstruimos la ubicación con la misma ventana
    // y umbral RSSI en vez de abandonar este ciclo de anomalías.
    const { rows: lecturasRecientes } = await pool.query(
      `SELECT device_id, AVG(rssi)::numeric(6,2) AS rssi_promedio
       FROM telemetria_raw
       WHERE UPPER(mac) = UPPER($1)
         AND rssi >= $2
         AND time > now() - ($3 || ' seconds')::interval
       GROUP BY device_id
       ORDER BY rssi_promedio DESC
       LIMIT 1`,
      [TARGET_MAC, MIN_RSSI_DBM, ZONE_WINDOW_SECONDS]
    );
    const lecturaReciente = lecturasRecientes[0];
    if (lecturaReciente) {
      const { rows: zonasRecientes } = await pool.query(
        'SELECT nombre_zona FROM zonas WHERE device_id = $1',
        [lecturaReciente.device_id]
      );
      estado = {
        device_id: lecturaReciente.device_id,
        nombre_zona: zonasRecientes[0]?.nombre_zona || lecturaReciente.device_id,
        rssi_promedio: lecturaReciente.rssi_promedio,
        actualizado_en: new Date(),
      };
      console.warn(`[ZONA] Estado aún no persistido; uso lectura reciente de "${estado.nombre_zona}" para evaluar anomalías.`);
    } else if (segundosDesdeUltimaLectura <= umbralLecturas) {
      console.warn('[ZONA] Se reciben lecturas, pero ninguna supera el RSSI mínimo para confirmar una zona.');
      await resolverAnomalia('sin_datos');
      await resolverAnomalia('zona_no_confirmada');
      return;
    } else {
      await abrirAnomalia('sin_datos', 'No hay una ubicación confirmada para el gato.', null, null, 1);
      await resolverAnomalia('zona_no_confirmada');
      return;
    }
  }
  await resolverAnomalia('sin_datos');

  const segundosSinLectura = segundosDesdeUltimaLectura;
  const sinSenal = segundosSinLectura > umbralLecturas;
  if (sinSenal) {
    await abrirAnomalia(
      'sin_senal',
      `No se reciben lecturas desde hace ${tiempoSinLecturaTexto(segundosSinLectura)}. La última ubicación conocida fue "${estado.nombre_zona}".`,
      null,
      null,
      1
    );
  } else {
    await resolverAnomalia('sin_senal');
  }
  if (!sinSenal && ultimaLecturaEn && new Date(estado.actualizado_en) < new Date(ultimaLecturaEn)) {
    console.warn('[ZONA] Hay lecturas recientes, pero ninguna zona ha sido confirmada por RSSI suficiente.');
    await resolverAnomalia('zona_no_confirmada');
  } else {
    await resolverAnomalia('zona_no_confirmada');
  }

  const { rows: lecturas } = await pool.query(
    `SELECT device_id, rssi, time
     FROM telemetria_raw
     WHERE UPPER(mac) = UPPER($1) AND time > now() - interval '30 days'
     ORDER BY time ASC`,
    [TARGET_MAC]
  );
  if (lecturas.length < MIN_TRAINING_ROWS) {
    if (sinSenal) {
      rutinaPendiente = null;
      rutinaConfirmaciones = 0;
      await resolverAnomalia('rutina_inusual');
    }
    return;
  }
  const ultimaLectura = lecturas[lecturas.length - 1];
  const dispositivos = [...new Set(lecturas.map(lectura => lectura.device_id))].sort();
  const indiceDispositivo = new Map(dispositivos.map((id, indice) => [id, indice]));
  const promedio = media(lecturas.map(lectura => Number(lectura.rssi)));
  const desviacion = desviacionEstandar(lecturas.map(lectura => Number(lectura.rssi)), promedio);
  const lecturaSospechosa = {
    ...ultimaLectura,
    device_id: estado.device_id,
    rssi: estado.rssi_promedio,
  };
  const { rows: nombresZona } = await pool.query(
    `SELECT nombre_zona FROM zonas WHERE device_id = $1`,
    [lecturaSospechosa.device_id]
  );
  const zonaObservada = nombresZona[0]?.nombre_zona || lecturaSospechosa.device_id;
  const zScore = desviacion === 0
    ? 0
    : (Number(lecturaSospechosa.rssi) - promedio) / desviacion;
  const slot = franjaActual(new Date());
  const minutoActual = minutosActual(new Date());
  const patron = await pool.query(
    `WITH eventos AS (
      SELECT nombre_zona, cambiado_en,
             LEAD(cambiado_en) OVER (ORDER BY cambiado_en) AS siguiente
      FROM historial_zona
      WHERE UPPER(mac) = UPPER($1)
     ),
     segmentos AS (
      SELECT nombre_zona,
             EXTRACT(HOUR FROM cambiado_en AT TIME ZONE $2)::int * 60 +
               EXTRACT(MINUTE FROM cambiado_en AT TIME ZONE $2)::int AS inicio_min,
             EXTRACT(EPOCH FROM (siguiente - cambiado_en)) / 60 AS duracion_min
      FROM eventos
      WHERE siguiente IS NOT NULL
        AND siguiente > cambiado_en
        AND siguiente - cambiado_en <= interval '24 hours'
     ),
     patrones AS (
      SELECT inicio_min, nombre_zona, COUNT(*)::int AS observaciones
      FROM segmentos
      GROUP BY inicio_min, nombre_zona
      HAVING COUNT(*) >= 2
     ),
     ordenados AS (
      SELECT inicio_min, nombre_zona, observaciones,
             LEAD(inicio_min) OVER (ORDER BY inicio_min) AS siguiente_inicio
      FROM (
        SELECT patrones.*,
               ROW_NUMBER() OVER (
                 PARTITION BY inicio_min
                 ORDER BY observaciones DESC, nombre_zona
               ) AS prioridad
        FROM patrones
      ) seleccionados
      WHERE prioridad = 1
     )
     SELECT nombre_zona, inicio_min AS franja_horaria,
           GREATEST(1, COALESCE(siguiente_inicio, 1440) - inicio_min)::int AS duracion_promedio_min
     FROM ordenados
     ORDER BY inicio_min`,
    [TARGET_MAC, TIME_ZONE]
  );
  const tramoEsperado = patron.rows.find(tramo => {
    const inicio = Number(tramo.franja_horaria);
    return minutoActual >= inicio && minutoActual < inicio + Number(tramo.duracion_promedio_min);
  });
  const patronActual = tramoEsperado ? { rows: [tramoEsperado] } : { rows: [] };
  const zonaInusual = patronActual.rows[0] && patronActual.rows[0].nombre_zona !== zonaObservada;
  if (sinSenal) {
    rutinaPendiente = null;
    rutinaConfirmaciones = 0;
    await resolverAnomalia('rutina_inusual');
  }
  const candidatoZScore = Math.abs(zScore) >= Z_SCORE_THRESHOLD || zonaInusual;

  const muestras = lecturas.map(lectura => [
    franjaActual(new Date(lectura.time)) / 47,
    (indiceDispositivo.get(lectura.device_id) || 0) / Math.max(dispositivos.length - 1, 1),
    Number(lectura.rssi) / 100,
  ]);
  const objetivo = [
    slot / 47,
    (indiceDispositivo.get(lecturaSospechosa.device_id) || 0) / Math.max(dispositivos.length - 1, 1),
    Number(lecturaSospechosa.rssi) / 100,
  ];
  const ifScore = isolationForest(muestras, objetivo);

  const rutinaConfirmada = zonaInusual && !sinSenal && (() => {
    if (rutinaPendiente === zonaObservada) {
      rutinaConfirmaciones += 1;
    } else {
      rutinaPendiente = zonaObservada;
      rutinaConfirmaciones = 1;
    }
    return rutinaConfirmaciones >= ROUTINE_CONFIRM_POLLS;
  })();
  if (!zonaInusual || sinSenal) {
    rutinaPendiente = null;
    rutinaConfirmaciones = 0;
  }

  const { rows: cambios } = await pool.query(
    `SELECT cambiado_en
     FROM historial_zona
     WHERE UPPER(mac) = UPPER($1)
     ORDER BY cambiado_en DESC
     LIMIT 1`,
    [TARGET_MAC]
  );
  const minutosEnZona = cambios[0]
    ? (Date.now() - new Date(cambios[0].cambiado_en).getTime()) / 60000
    : 0;
  const rutinaPersistente = rutinaConfirmada && minutosEnZona >= MIN_ROUTINE_DWELL_MINUTES;
  if (candidatoZScore && ((rutinaPersistente) || (!zonaInusual && ifScore >= IF_SCORE_THRESHOLD))) {
    const tipo = rutinaPersistente ? 'rutina_inusual' : 'rssi_inusual';
    const descripcion = zonaInusual
      ? `${sinSenal ? 'La última ubicación conocida de Michi fue' : 'Michi está'} en "${zonaObservada}", aunque a esta hora suele estar en "${patronActual.rows[0].nombre_zona}". ${sinSenal ? `No hay lecturas desde hace ${tiempoSinLecturaTexto(segundosSinLectura)}.` : `Lleva allí ${duracionTexto(minutosEnZona)}.`}`
      : `La señal detectada (${Number(lecturaSospechosa.rssi).toFixed(1)} dBm) está muy fuera de lo habitual (desviación ${Math.abs(zScore).toFixed(2)}×).`;
    const clave = zonaInusual
      ? `${zonaObservada}|${patronActual.rows[0].nombre_zona}`
      : null;
    await abrirAnomalia(tipo, descripcion, zScore, ifScore, 3, clave);
  } else {
    if (!zonaInusual || sinSenal) await resolverAnomalia('rutina_inusual');
    await resolverAnomalia('rssi_inusual');
  }
}

console.log(`Detector de anomalías por capas iniciado para ${TARGET_MAC}.`);
detectar().catch(err => console.error('[ERROR] detectar:', err.message));
setInterval(() => detectar().catch(err => console.error('[ERROR] detectar:', err.message)), POLL_INTERVAL_MS);

process.on('SIGINT', async () => {
  await pool.end();
  process.exit(0);
});
