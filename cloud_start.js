const { spawn } = require('child_process');

const children = ['server.js', 'index.js', 'zone_detector.js', 'anomaly_detector.js', 'routine_learning_scheduler.js']
  .map(script => {
    const child = spawn(process.execPath, [script], { stdio: 'inherit', env: process.env });
    child.on('exit', (code, signal) => {
      if (code !== 0) console.error(`[CLOUD] ${script} terminó con código ${code || signal}.`);
    });
    return child;
  });

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  children.forEach(child => child.kill(signal));
  const forceTimer = setTimeout(() => {
    children.forEach(child => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    process.exit(0);
  }, 15000);
  Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('close', resolve);
  }))).then(() => {
    clearTimeout(forceTimer);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
