const { spawn } = require('child_process');
const path = require('path');

const DAILY_INTERVAL_MS = Number(process.env.ROUTINE_LEARNING_INTERVAL_MS) > 0
  ? Number(process.env.ROUTINE_LEARNING_INTERVAL_MS)
  : 24 * 60 * 60 * 1000;
const JOB_PATH = path.join(__dirname, 'routine_learning_job.js');
let child = null;
let timer = null;
let shuttingDown = false;

function scheduleNextRun() {
  if (shuttingDown) return;
  timer = setTimeout(run, DAILY_INTERVAL_MS);
}

function run() {
  if (shuttingDown || child) return;
  console.log('[RUTINA] Iniciando reconstrucción automática de rutinas.');
  const currentChild = spawn(process.execPath, [JOB_PATH], {
    stdio: 'inherit',
    env: process.env,
  });
  child = currentChild;
  let settled = false;
  const settle = (message) => {
    if (settled) return;
    settled = true;
    if (child === currentChild) child = null;
    if (message) console.error(`[RUTINA] ${message}`);
    else console.log('[RUTINA] Reconstrucción finalizada.');
    scheduleNextRun();
  };
  currentChild.once('error', err => settle(`No se pudo iniciar el trabajo: ${err.message}`));
  currentChild.once('close', (code, signal) => {
    settle(code === 0
      ? null
      : `El trabajo terminó con código ${code == null ? signal : code}. Se reintentará en la siguiente ejecución.`);
  });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (timer) clearTimeout(timer);
  if (!child) {
    process.exit(0);
    return;
  }

  console.log(`[RUTINA] Deteniendo el trabajo hijo por ${signal}.`);
  const currentChild = child;
  currentChild.kill(signal);
  const forceTimer = setTimeout(() => {
    if (child === currentChild) currentChild.kill('SIGKILL');
  }, 10000);
  currentChild.once('close', () => {
    clearTimeout(forceTimer);
    process.exit(0);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
run();
