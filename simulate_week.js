require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const MAC = process.env.TARGET_MAC || 'dd:88:00:00:3e:15';
const CLIENTE = process.env.CLIENTE_ID || 'demo_cliente';
const ZONES = [
  { device: 'M5_PISO_1_SALA', name: 'Sala', rssi: -59 },
  { device: 'M5_PISO_1_COCINA', name: 'Cocina', rssi: -62 },
  { device: 'M5_PISO_1_COMEDOR', name: 'Comedor', rssi: -55 },
  { device: 'M5_PISO_1_DORMITORIO', name: 'Dormitorio', rssi: -51 },
  { device: 'M5_PISO_1_ARENA', name: 'Arenero', rssi: -66 },
];

function fechaDe(dia, hora, minuto) {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() - (6 - dia));
  fecha.setHours(hora, minuto, 0, 0);
  return fecha;
}

async function simularSemana() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM anomalias WHERE mac = $1', [MAC]);
    await client.query('DELETE FROM rutinas_patron WHERE mac = $1', [MAC]);
    await client.query('DELETE FROM historial_zona WHERE mac = $1', [MAC]);
    await client.query('DELETE FROM estado_actual WHERE mac = $1', [MAC]);
    await client.query('DELETE FROM telemetria_raw WHERE mac = $1', [MAC]);

    let ultimoEvento;
    const ahora = new Date();
    for (let dia = 0; dia < 7; dia += 1) {
      // Patrón sintético basado en hábitos normales: mucho descanso, comidas breves,
      // juego/actividad repartida y visitas al arenero de pocos minutos.
      const agenda = [
        [0, 0, 'Dormitorio'], [6, 30, 'Arenero'], [6, 40, 'Cocina'],
        [6, 55, 'Sala'], [8, 30, 'Dormitorio'], [12, 0, 'Cocina'],
        [12, 15, 'Sala'], [15, 30, 'Arenero'], [15, 40, 'Sala'],
        [18, 0, 'Cocina'], [18, 15, 'Sala'], [20, 30, 'Arenero'],
        [20, 40, 'Sala'], [22, 30, 'Dormitorio'],
      ];
      for (let i = 0; i < agenda.length; i += 1) {
        const [hora, minuto, nombreZona] = agenda[i];
        if (dia === 6 && (hora > ahora.getHours() ||
          (hora === ahora.getHours() && minuto > ahora.getMinutes() - 2))) continue;
        const fecha = fechaDe(dia, hora, minuto);
        const zona = ZONES.find(item => item.name === nombreZona);
        ultimoEvento = { fecha, zona };
        await client.query(
          `INSERT INTO historial_zona (mac, device_id, nombre_zona, rssi_promedio, cambiado_en)
           VALUES ($1, $2, $3, $4, $5)`,
          [MAC, zona.device, zona.name, zona.rssi, fecha]
        );
        for (let muestra = 0; muestra < 5; muestra += 1) {
          const lectura = new Date(fecha.getTime() + muestra * 60000);
          await client.query(
            `INSERT INTO telemetria_raw (time, cliente_id, device_id, mac, rssi)
             VALUES ($1, $2, $3, $4, $5)`,
            [lectura, CLIENTE, zona.device, MAC, zona.rssi + ((muestra % 3) - 1) * 2]
          );
        }
      }
    }

    await client.query(
      `INSERT INTO estado_actual (mac, device_id, nombre_zona, rssi_promedio, actualizado_en)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (mac) DO UPDATE SET device_id = EXCLUDED.device_id,
         nombre_zona = EXCLUDED.nombre_zona, rssi_promedio = EXCLUDED.rssi_promedio,
         actualizado_en = EXCLUDED.actualizado_en`,
      [MAC, ultimoEvento.zona.device, ultimoEvento.zona.name, ultimoEvento.zona.rssi]
    );
    await client.query('COMMIT');
    console.log(`[SIMULACION] Cargados 7 días de rutina para ${MAC}.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

simularSemana().catch(err => {
  console.error('[SIMULACION] Error:', err.message);
  process.exitCode = 1;
});
