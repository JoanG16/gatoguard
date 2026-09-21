# Guía del proyecto para IA / mantenimiento futuro

Este documento resume qué hace este proyecto, cómo está estructurado, qué fue implementado, qué faltaría ampliar y dónde conviene tocar cada archivo si se pide hacer cambios.

## 1. Objetivo del sistema

El proyecto busca aprender la rutina de un gato a partir de detecciones de beacons por gateways M5Stack, detectar cambios de zona y generar alertas cuando el comportamiento se desvía de la rutina esperada.

La idea general es:

- M5Stack detecta beacons BLE (collar del gato)
- el gateway publica RSSI + MAC + device_id + cliente_id
- el backend recibe esos datos por MQTT
- se limpia y valida la información
- se determina la zona/ubicación probable
- se compara con la rutina aprendida
- si hay desviación importante, se genera una anomalía/alerta
- la web muestra: home, historial, alertas, estadísticas y configuración de dispositivos

## 2. Arquitectura general

Flujo principal:

MQTT + M5Stack
  -> ingestión
  -> limpieza / validación / histéresis
  -> aprendizaje de rutina
  -> detección de anomalías
  -> dashboard web + alertas

En términos del proyecto actual:

- Firmware M5Stack: publica payload con RSSI y MAC del beacon
- Backend Node.js + PostgreSQL: recibe los datos, los normaliza, guarda historial, calcula zonas, alertas y estadísticas
- Dashboard web: muestra estado actual, historial, alertas y configuración
- Algunas lógicas de rutina y detección están implementadas como scripts separados para ejecutar en batch

## 3. Flujo real del sistema

### 3.1. Ingesta desde gateway

El firmware M5Stack publicará mensajes al topic:

telemetria/{cliente_id}/{device_id}/beacon

Formato esperado:

```json
{
  "schema_version": 1,
  "cliente_id": "demo_cliente",
  "device_id": "M5_1",
  "mac": "dd:88:00:00:3e:15",
  "rssi": -55
}
```

Este formato está documentado en:

- INGESTION_CONTRACT.md

### 3.2. Recepción y almacenamiento

El backend usa MQTT y guarda cada lectura en PostgreSQL en la tabla `telemetria_raw`.

La estructura es:

- time
- cliente_id
- device_id
- mac
- rssi

Luego el sistema puede:
- calcular zona actual por beacon
- comparar con la rutina esperada
- detectar anomalías
- guardar historial

### 3.3. Detección de zona y rutina

Se ha trabajado con una lógica de:

- RSSI crudo
- histéresis
- ventana temporal
- comparación con norma esperada
- z-score para detectar desviaciones
- intención de usar Isolation Forest como confirmación adicional

Esto está tanto en:

- zone_detector.js
- routine_learning_job.js
- anomaly_detector.js

### 3.4. Detección de anomalías

La idea es que, si el gato está en una zona distinta a la esperada por horario, se generate una alerta.

El sistema intenta diferenciar:

- comportamiento normal
- cambio breve de paso
- cambio real de rutina
- posible problema del animal o señal de un cambio de hábitos

### 3.5. Dashboard y alertas

La app web sirve páginas en `public/` y se alimenta de los endpoints REST del backend.

Páginas relevantes:

- public/index.html -> Home / estado actual
- public/historial.html -> historial de cambios de zona
- public/alertas.html -> alertas activas
- public/alertas-archivadas.html -> historial de alertas archivadas
- public/estadisticas.html -> métricas y gráfica de rutina
- public/perfil.html -> perfil del gato / persona
- public/dispositivos.html -> gestión de gateways y beacons

## 4. Estructura de archivos del proyecto

### 4.1. Archivos raíz

#### .env
Archivo de configuración local con variables de entorno.

Incluye normalmente:
- DATABASE_URL
- DASHBOARD_PORT
- TARGET_MAC

Importante: si lo cambia una IA, debe respetar reglas reales del entorno, no inventar valores.

#### package.json
Define scripts de trabajo del proyecto.

Scripts principales:
- npm run init-db
- npm run detect-zone
- npm run dashboard
- npm run learn-routine
- npm run simulate-week
- npm run simulate-anomaly
- npm run schedule-anomaly
- npm run detect-anomalies

#### server.js
Archivo central del backend. Es el punto más importante para entender el proyecto.

Hace:
- arranca Express
- sirve archivos estáticos de public/
- define endpoints REST de la app
- conecta a PostgreSQL
- expone historial, alertas, gateways, beacons, estado
- gestiona actualización de registros de gateways/beacons
- hace seeding demo si la base está vacía
- atiende la UI y la lógica de alertas

#### index.js
Archivo base de arranque del proyecto. En la practica del repo actual funciona como entrada general del backend/consumo. Debe revisarse si se usa para arranque general o si quedó legacy.

#### db_init.js
Script para inicializar la base de datos o verificar estructura.

Usado para:
- crear tablas si no existen
- preparar el estado inicial
- lanzar la base con la estructura necesaria

#### schema.sql
SQL principal del proyecto para crear tablas base.

Tablas clave:
- telemetria_raw
- gateways
- beacons

#### zonas.sql
SQL complementario sobre zonas / dispositivos / datos iniciales.

#### INGESTION_CONTRACT.md
Define el contrato MQTT del sistema. Es la fuente de verdad del payload.

Es importante porque no se debe romper si se cambia firmware.

#### gateway_m5stack.ino
Firmware base para M5Stack.

Hace:
- conexión Wi‑Fi
- conexión MQTT
- BLE scanning
- publicar RSSI/MAC en MQTT
- nodos básicos de configuración wifi/mqtt
- abierto a evolución hacia multi-beacon y AP de configuración

#### anomaly_detector.js
Script principal para detectar anomalías por capas.

Hace:
- revisar eventos históricos
- compara rutina esperada vs actual
- genera alertas o episodios de anomalía
- usa capa de detección y normalización del texto para UI

#### routine_learning_job.js
Aprende la rutina del gato por franja horaria.

Hace:
- leer cambios de zona
- agrupar por día / franja
- calcular patrón esperado por lugar
- guardar en tabla de rutina

#### zone_detector.js
Script para distinguir / confirmar zona desde RSSI.

Hace:
- interpretar lecturas RSSI
- aplicar filtro / histéresis / validación
- decidir si el gato está en una zona o no

#### simulate_week.js
Genera datos simulados de una semana para probar la lógica de rutina.

#### simulate_anomaly.js
Genera una anomalía simulada para probar la detección y alertas.

#### schedule_anomaly.js
Programación de anomalías simuladas para pruebas.

## 5. Base de datos (PostgreSQL)

### 5.1. Tabla telemetria_raw

```sql
CREATE TABLE IF NOT EXISTS telemetria_raw (
    id BIGSERIAL PRIMARY KEY,
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    cliente_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    mac TEXT NOT NULL,
    rssi SMALLINT NOT NULL
);
```

Rol:
- almacena todas las lecturas raw del beacon
- es la base para posterior limpieza, cálculo de zona y rutina

### 5.2. Tabla gateways

```sql
CREATE TABLE IF NOT EXISTS gateways (
    id BIGSERIAL PRIMARY KEY,
    cliente_id TEXT NOT NULL,
    device_id TEXT NOT NULL UNIQUE,
    nombre TEXT,
    nombre_zona TEXT,
    icono TEXT,
    wifi_ssid TEXT,
    wifi_password TEXT,
    mqtt_host TEXT NOT NULL DEFAULT 'broker.hivemq.com',
    mqtt_port INTEGER NOT NULL DEFAULT 1883,
    mqtt_user TEXT,
    mqtt_password TEXT,
    online BOOLEAN NOT NULL DEFAULT false,
    ultimo_heartbeat TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Rol:
- representa cada M5Stack/gateway
- permite configurar nombre de zona, icono y estado online
- la pantalla de dispositivos usa esta tabla

### 5.3. Tabla beacons

```sql
CREATE TABLE IF NOT EXISTS beacons (
    mac TEXT PRIMARY KEY,
    nombre TEXT,
    nombre_mascota TEXT,
    icono TEXT,
    mascota_id TEXT,
    asignado BOOLEAN NOT NULL DEFAULT false,
    ultimo_visto TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Rol:
- representa cada collar/beacon
- se usa para identificar la mascota y su nombre asociado
- admite más de un beacon y múltiples mascotas

### 5.4. Otras tablas

El proyecto ya incluyó varios datos secundarios para la detección, por ejemplo:
- historial de cambios de zona
- rutinas aprendidas
- alertas / anomalías
- estado actual

Hay que entender que el proyecto ha evolucionado con varias capas. Si se va a modificar la lógica de detección, se deben revisar también las tablas relacionadas con historial, alertas y rutina que aparecen en `server.js` y scripts de aprendizaje.

## 6. Endpoints principales del backend

El backend expone una API REST en `server.js`.

### 6.1. /api/estado
Devuelve el estado actual por beacon/gateway.

### 6.2. /api/historial
Devuelve el historial de zonas confirmadas.

### 6.3. /api/anomalias
Devuelve alertas/anomalías.

### 6.4. /api/gateways
Lista gateways.

### 6.5. /api/gateways/:device_id
Actualiza un gateway (nombre de zona, icono, etc).

### 6.6. /api/gateways/provision
Crea o actualiza un gateway con datos de configuración (Wi‑Fi/MQTT). Eso es relevante para el flujo de onboarding.

### 6.7. /api/beacons
Lista beacons asignados.

### 6.8. /api/beacons/sin-asignar
Lista beacons detectados que aún no tienen nombre/mascota asignado.

### 6.9. /api/beacons
POST: crea o actualiza beacon y lo asigna a una mascota.

### 6.10. /api/beacons/:mac
Actualiza beacon.

## 7. Dashboard web: pantallas principales

### public/index.html
Home de estado actual del gato.

Incluye:
- ubicación actual
- zona esperada
- rutina vigente
- resumen de alertas
- diseño principal del sistema

### public/historial.html
Muestra cambios de zona, franja temporal, estado del historial.

### public/alertas.html
Lista y revisión de alertas activas.

### public/alertas-archivadas.html
Alertas ya revisadas/archivadas.

### public/estadisticas.html
Estadísticas por periodo, visualización y patrones de rutina.

### public/perfil.html
Perfil del gato y del usuario: nombre, edad, notas etc.

### public/dispositivos.html
Pantalla de dispositivos. Es clave para:
- gateways
- beacons
- asignación de nombre
- edición de zona
- agregar gateways/beacons

## 8. Qué ya está hecho y qué falta

### Implementado

- arquitectura MQTT + Node + Postgres
- detección de beacons por M5Stack
- flujo de lectura RSSI + almacenamiento
- backoffice web de dashboard
- historial y alertas
- gestión básica de gateways/beacons
- seeding demo/ fallback de puerto
- lógica de aprendizaje de rutina
- lógica de anomalías y alertas por capas
- pantalla de dispositivos con tabs de gateways y mascotas

### Lo que sigue siendo un prototipo o requiere validación real

- configuración real del M5Stack en hardware
- onboarding real de Wi‑Fi y MQTT
- prueba end-to-end con M5Stack físico
- integración con broker privado real
- validación con beacons reales y casa real
- seguridad / producción
- soporte real de varios beacons/gateways en escena real

## 9. Dónde tocar si hay que modificar algo

### Si se cambia la lógica de detección de zona
Revisar:
- zone_detector.js
- server.js (si usa datos de `estado_actual`/historial)
- routine_learning_job.js
- anomaly_detector.js

### Si se cambia el formato MQTT
Revisar:
- INGESTION_CONTRACT.md
- gateway_m5stack.ino
- server.js (los consumidores de MQTT si existen)

### Si se cambia la UI de dispositivos
Revisar:
- public/dispositivos.html
- server.js endpoints `/api/gateways` y `/api/beacons`

### Si se cambia la base de datos
Revisar:
- schema.sql
- db_init.js
- server.js para `ensureDeviceSchema` y `ensureDefaultDevices`

### Si se modifica la lógica de alertas
Revisar:
- anomaly_detector.js
- server.js endpoints `/api/anomalias` y `/api/anomalias/:id`
- public/alertas.html

### Si se cambia la lógica de rutina aprendida
Revisar:
- routine_learning_job.js
- public/estadisticas.html
- server.js si usa `rutinas_patron`

## 10. Cómo arrancar el proyecto

### 1) Preparar la base de datos PostgreSQL
Ejecutar:

```bash
npm run init-db
```

### 2) Levantar backend web

```bash
npm run dashboard
```

### 3) Cargar rutina

```bash
npm run learn-routine
```

### 4) Ejecutar detección por capas

```bash
npm run detect-anomalies
```

### 5) Abrir dashboard

Normalmente en:

- http://localhost:3000 o puerto alternativo
- el sistema ya tiene fallback a 3001/3002/3003/3010

## 11. Recomendaciones para cualquier IA que quiera continuar el proyecto

1. No romper el contrato MQTT de `INGESTION_CONTRACT.md`.
2. Mantener la separación entre:
   - firmware M5Stack
   - backend Node
   - dashboard web
   - scripts de batch
3. Cuando añadas columnas o tablas, actualiza `schema.sql` y los scripts de seeding.
4. Cuando cambies endpoints, revisar `public/*.html` que los consumen.
5. Al tocar la lógica de la rutina, validar siempre con datos simulados antes de usar en producción.
6. Cuando se hable de “configuración del M5Stack”, recordar que la app es la que debe configurar Wi‑Fi y zonas; el hardware no debe tener nombre de lugar duro-coded.
7. Mantener `device_id` técnico y `nombre_zona` visible separados.
8. El flujo de verdad del sistema está en `server.js` + `schema.sql` + `gateway_m5stack.ino` + `anomaly_detector.js` + `routine_learning_job.js`.

## 12. Resumen muy corto para IA

Si una IA nueva entra al proyecto, lo esencial es esto:

- `gateway_m5stack.ino` publica detecta beacon y manda RSSI
- `server.js` recibe/gestiona todo y expone API
- `schema.sql` crea la base de datos
- `routine_learning_job.js` aprende el patrón habitual
- `anomaly_detector.js` detecta anomalías
- `public/*.html` muestran la UI
- `dispositivos.html` es la interfaz de administración de gateways y beacons

## 13. Archivos clave resumidos

- `server.js` -> backend central
- `schema.sql` -> base de datos del sistema
- `gateway_m5stack.ino` -> firmware del dispositivo
- `INGESTION_CONTRACT.md` -> protocolo MQTT
- `routine_learning_job.js` -> aprendizaje de la rutina
- `anomaly_detector.js` -> detección de anomalías
- `zone_detector.js` -> lógica de zona / rango RSSI
- `public/dispositivos.html` -> gestión de gateways y mascotas
- `public/index.html` -> Home
- `public/alertas.html` -> alertas
- `public/historial.html` -> historial
- `public/estadisticas.html` -> estadísticas

## 14. Estado actual del proyecto

Actualmente el proyecto está funcionando como prueba de concepto con:

- firmware base de M5Stack
- backend y API
- base de datos PostgreSQL
- UI web de dashboard
- gestión de dispositivos básica
- lógica de aprendizaje y anomalías

Todavía falta validar en hardware real y cerrar la parte de onboarding/configuración del M5Stack en la práctica real.

---

Este archivo es un mapa de contexto para futuras IAs y para continuar el desarrollo sin perder la referencia del proyecto.
