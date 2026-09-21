# INGESTION_CONTRACT.md - Contrato de Ingesta v1

Este documento es la fuente de verdad de cómo cualquier gateway (M5Stack u otro hardware futuro)
debe comunicarse con el sistema. Ningún servicio backend asume nada del hardware más allá de esto.

## Topic MQTT
```
telemetria/{cliente_id}/{device_id}/beacon
```
- `cliente_id`: identificador del cliente/hogar (string, ej. `demo_cliente`).
- `device_id`: identificador único del gateway físico (string, ej. `M5_PISO_1_ESCRITORIO`).

## Payload (JSON)
```json
{
  "schema_version": 1,
  "cliente_id": "demo_cliente",
  "device_id": "M5_PISO_1_ESCRITORIO",
  "mac": "dd:88:00:00:3e:15",
  "rssi": -55
}
```

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `schema_version` | int | sí | Permite evolucionar el contrato sin romper gateways ya desplegados. |
| `cliente_id` | string | sí | Debe coincidir con el segmento del topic. |
| `device_id` | string | sí | Debe coincidir con el segmento del topic. |
| `mac` | string | sí | MAC del beacon detectado, formato `aa:bb:cc:dd:ee:ff`. |
| `rssi` | int | sí | Valor crudo de RSSI, sin procesar en el dispositivo. |

## Reglas
- El dispositivo publica **solo cuando detecta el beacon** (no publica "ausencia") — la ausencia se
  infiere en el backend por timeout (si no llega ningún mensaje de un `device_id` en X segundos).
- Frecuencia de publicación: cada 2-3 segundos mientras hay detección (definido por `sendInterval`
  en el firmware). No publicar más rápido que eso — no aporta precisión y satura el broker.
- El backend es responsable de suavizado/histéresis. El firmware **nunca** decide "zona", solo
  reporta RSSI crudo — así el algoritmo se puede mejorar sin re-flashear los dispositivos.
- Timestamp de la lectura = hora de llegada al backend (`now()` en el consumidor). No se envía
  timestamp desde el dispositivo en v1 porque el ESP32 no tiene RTC confiable sin NTP — se agrega
  en una v2 del contrato si hace falta precisión de latencia.

## Cambios respecto al código de prueba original
- Se agrega `schema_version` (nuevo).
- Se renombra la clave `cliente` → `cliente_id` (consistencia con el resto del sistema).
- Todo lo demás se mantiene igual — el firmware que ya probaste necesita un cambio mínimo.
