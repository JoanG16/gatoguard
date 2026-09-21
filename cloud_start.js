const { spawn } = require('child_process');

const children = ['server.js', 'index.js', 'zone_detector.js', 'anomaly_detector.js']
  .map(script => {
    const child = spawn(process.execPath, [script], { stdio: 'inherit', env: process.env });
    child.on('exit', (code, signal) => {
      if (code !== 0) console.error(`[CLOUD] ${script} terminó con código ${code || signal}.`);
    });
    return child;
  });

function shutdown(signal) {
  children.forEach(child => child.kill(signal));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
