#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEScan.h>
#include <vector>
#include <FastLED.h>
#include <algorithm>
#include <ctype.h>
#include <stdio.h>


const char *AP_SSID = "GatoGateway-Setup";
const char *AP_PASS = "gatoguard";
const char *MQTT_BROKER = "broker.hivemq.com";
const int MQTT_PORT = 1883;
const char *PREFS_PROVISIONING_TOKEN = "prov_token";
const char *PREFS_ALLOWLIST_RECEIVED = "allowlist_ok";


String clienteID = "demo_cliente";
String deviceID;
String nombreZona = "";
String provisioningToken = "";
unsigned int configVersion = 0;
bool modoApActivo = false;
bool gatewayEliminado = false;
bool registroConfirmado = false;
bool bleInicializado = false;
bool listaBeaconsRecibida = false;
bool avisoEsperandoLista = false;
bool escaneoRedesSolicitado = false;
bool escaneoRedesIniciado = false;
bool escaneoRedesFallido = false;
bool pausarReintentosWifi = false;
unsigned long ultimoIntentoWiFi = 0;
unsigned long ultimoIntentoMQTT = 0;
unsigned long ultimaPublicacionRegistro = 0;
unsigned long ultimaPublicacionHeartbeat = 0;
const unsigned long REINTENTO_WIFI_MS = 15000;
const unsigned long TIMEOUT_CONEXION_WIFI_MS = 30000;
const unsigned long REINTENTO_MQTT_MS = 5000;
const unsigned long REINTENTO_REGISTRO_MS = 60000;
const unsigned long INTERVALO_HEARTBEAT_MS = 10000;

struct LecturaBeacon {
  String mac;
  int rssi;
  uint16_t sampleCount;
  uint32_t capturedAtMs;
};

struct VentanaBeacon {
  String mac;
  int muestrasRSSI[16];
  uint8_t muestrasGuardadas;
  uint8_t siguienteMuestra;
  uint16_t detecciones;
};

std::vector<VentanaBeacon> lecturasVentana;
std::vector<LecturaBeacon> colaLecturas;
const unsigned long VENTANA_ESCANEO_MS = 1000;
const size_t MAX_LECTURAS_POR_MENSAJE = 48;
const size_t MAX_LECTURAS_EN_COLA = 256;
const size_t MAX_BEACONS_POR_VENTANA = 128;
const size_t MAX_BEACONS_PERMITIDOS = 256;
const unsigned long MAX_ANTIGUEDAD_EN_COLA_MS = 2500;
uint32_t beaconsIgnoradosVentana = 0;
uint32_t resumenesDescartadosCola = 0;
std::vector<String> beaconsPermitidos;

WebServer server(80);
WiFiClient espClient;
PubSubClient mqttClient(espClient);
BLEScan *pBLEScan;
Preferences prefs;

// -------------------------------------------------------------
// LED RGB (NeoPixel GPIO 27)
// -------------------------------------------------------------
#define LED_PIN 27
#define NUM_LEDS 1
CRGB leds[NUM_LEDS];

const CRGB COLOR_MODO_AP   = CRGB(0, 0, 255); // Azul
const CRGB COLOR_CONECTADO = CRGB(0, 255, 0); // Verde

CRGB ultimoColorMostrado = CRGB::Black;

void fijarColorLed(CRGB color) {
  if (ultimoColorMostrado != color) {
    ultimoColorMostrado = color;
    FastLED.showColor(color);
  }
}

// -------------------------------------------------------------
// BOTÓN DE RESET (GPIO 39, integrado en M5Atom)
// Movido ANTES de setup()/loop() a propósito: el #define BTN_PIN tiene
// que existir textualmente antes de usarlo en pinMode() dentro de setup().
// -------------------------------------------------------------
#define BTN_PIN 39
unsigned long tiempoInicioPresion = 0;
bool botonPresionado = false;

void comprobarBotonReset() {
  if (digitalRead(BTN_PIN) == LOW) { // El botón está presionado
    if (!botonPresionado) {
      botonPresionado = true;
      tiempoInicioPresion = millis();
    } else if (millis() - tiempoInicioPresion > 2000) { // Si se mantiene 2 segundos
      Serial.println("\n[RESET] Botón presionado por 2s. Borrando solo Wi-Fi; se conserva el registro del gateway.");

      // Parpadeo rápido en rojo para confirmar el reset
      for (int i = 0; i < 5; i++) {
        FastLED.showColor(CRGB::Red);
        delay(100);
        FastLED.showColor(CRGB::Black);
        delay(100);
      }

      // El reset de red no debe borrar el token ni la identidad persistente del gateway.
      prefs.begin("gateway_cfg", false);
      prefs.remove("wifi_ssid");
      prefs.remove("wifi_pass");
      prefs.end();

      ESP.restart();
    }
  } else {
    botonPresionado = false;
  }
}

// -------------------------------------------------------------
// FUNCIONES AUXILIARES
// -------------------------------------------------------------
String extractField(const String &body, const char *key) {
  String marker = String("\"") + key + "\"";
  int index = body.indexOf(marker);
  if (index < 0) return "";
  index = body.indexOf(':', index + marker.length());
  if (index < 0) return "";
  index++;
  while (index < body.length() && isspace(body[index])) index++;
  if (index >= body.length() || body[index] != '"') return "";

  String value;
  for (int i = index + 1; i < body.length(); i++) {
    char current = body[i];
    if (current == '"') return value;
    if (current != '\\') {
      value += current;
      continue;
    }
    if (++i >= body.length()) return "";
    switch (body[i]) {
      case '"': value += '"'; break;
      case '\\': value += '\\'; break;
      case '/': value += '/'; break;
      case 'b': value += '\b'; break;
      case 'f': value += '\f'; break;
      case 'n': value += '\n'; break;
      case 'r': value += '\r'; break;
      case 't': value += '\t'; break;
      default: return "";
    }
  }
  return "";
}

String escaparJson(const String &value) {
  String escaped;
  for (size_t i = 0; i < value.length(); i++) {
    const uint8_t current = static_cast<uint8_t>(value[i]);
    if (current == '"' || current == '\\') {
      escaped += '\\';
      escaped += static_cast<char>(current);
    } else if (current < 0x20) {
      char unicodeEscape[7];
      snprintf(unicodeEscape, sizeof(unicodeEscape), "\\u%04x", current);
      escaped += unicodeEscape;
    } else {
      escaped += static_cast<char>(current);
    }
  }
  return escaped;
}

bool normalizarMacBeacon(const String &raw, String &normalizada) {
  if (raw.length() != 17) return false;
  for (size_t i = 0; i < raw.length(); i++) {
    const char current = raw[i];
    if (i % 3 == 2) {
      if (current != ':' && current != '-') return false;
    } else if (!isxdigit(static_cast<unsigned char>(current))) {
      return false;
    }
  }
  normalizada = raw;
  normalizada.replace("-", ":");
  normalizada.toUpperCase();
  return true;
}

bool extraerListaBeacons(const String &json, std::vector<String> &resultado) {
  const int key = json.indexOf("\"macs\"");
  if (key < 0) return false;
  int cursor = json.indexOf('[', key);
  if (cursor < 0) return false;
  cursor++;
  resultado.clear();

  while (cursor < static_cast<int>(json.length())) {
    while (cursor < static_cast<int>(json.length()) &&
           isspace(static_cast<unsigned char>(json[cursor]))) {
      cursor++;
    }
    if (cursor >= static_cast<int>(json.length())) return false;
    if (json[cursor] == ']') return true;
    if (json[cursor] != '"') return false;

    const int end = json.indexOf('"', cursor + 1);
    if (end < 0) return false;
    String mac;
    if (!normalizarMacBeacon(json.substring(cursor + 1, end), mac)) return false;
    if (std::find(resultado.begin(), resultado.end(), mac) == resultado.end()) {
      if (resultado.size() >= MAX_BEACONS_PERMITIDOS) return false;
      resultado.push_back(mac);
    }

    cursor = end + 1;
    while (cursor < static_cast<int>(json.length()) &&
           isspace(static_cast<unsigned char>(json[cursor]))) {
      cursor++;
    }
    if (cursor >= static_cast<int>(json.length())) return false;
    if (json[cursor] == ']') return true;
    if (json[cursor] != ',') return false;
    cursor++;
  }
  return false;
}

bool restaurarListaBeacons(const String &serializada) {
  beaconsPermitidos.clear();
  if (serializada.length() % 12 != 0 ||
      serializada.length() / 12 > MAX_BEACONS_PERMITIDOS) return false;
  for (size_t inicio = 0; inicio < serializada.length(); inicio += 12) {
    String compacta = serializada.substring(inicio, inicio + 12);
    String raw;
    for (size_t i = 0; i < compacta.length(); i += 2) {
      if (i > 0) raw += ':';
      raw += compacta.substring(i, i + 2);
    }
    String mac;
    if (!normalizarMacBeacon(raw, mac) ||
        beaconsPermitidos.size() >= MAX_BEACONS_PERMITIDOS) {
      beaconsPermitidos.clear();
      return false;
    }
    if (std::find(beaconsPermitidos.begin(), beaconsPermitidos.end(), mac) == beaconsPermitidos.end()) {
      beaconsPermitidos.push_back(mac);
    }
  }
  return true;
}

String serializarListaBeacons() {
  String serializada;
  for (const String &mac : beaconsPermitidos) {
    for (size_t i = 0; i < mac.length(); i++) {
      if (mac[i] != ':') serializada += mac[i];
    }
  }
  return serializada;
}

void guardarListaBeacons() {
  prefs.begin("gateway_cfg", false);
  prefs.putString("allowed_macs", serializarListaBeacons());
  prefs.putBool(PREFS_ALLOWLIST_RECEIVED, true);
  prefs.end();
}

unsigned int extraerNumeroJson(const String &body, const char *key, unsigned int fallback) {
  String marker = String("\"") + key + "\"";
  int index = body.indexOf(marker);
  if (index < 0) return fallback;
  index = body.indexOf(':', index + marker.length());
  if (index < 0) return fallback;
  index++;
  while (index < body.length() && isspace(body[index])) index++;
  return static_cast<unsigned int>(body.substring(index).toInt());
}

void guardarConfiguracionGateway() {
  prefs.begin("gateway_cfg", false);
  prefs.putString("nombre_zona", nombreZona);
  prefs.putUInt("config_version", configVersion);
  prefs.putBool("gateway_deleted", gatewayEliminado);
  prefs.end();
}

void reconectarWifiGuardado() {
  prefs.begin("gateway_cfg", true);
  String savedSsid = prefs.getString("wifi_ssid", "");
  String savedPass = prefs.getString("wifi_pass", "");
  prefs.end();
  if (savedSsid.length() == 0) return;

  WiFi.begin(savedSsid.c_str(), savedPass.c_str());
  ultimoIntentoWiFi = millis();
}

void detenerModoAP() {
  if (!modoApActivo) return;
  server.stop();
  WiFi.softAPdisconnect(true);
  modoApActivo = false;
}

void iniciarModoAP() {
  if (modoApActivo) return;
  WiFi.mode(WIFI_AP_STA);
  if (!WiFi.softAP(AP_SSID, AP_PASS)) {
    Serial.println("[WiFi] No se pudo iniciar el punto de acceso de configuración.");
    return;
  }
  modoApActivo = true;
  setupHttpEndpoints();
  Serial.print("[WiFi] Modo AP disponible en ");
  Serial.println(WiFi.softAPIP());
}

void publicarRegistroGateway() {
  if (!mqttClient.connected() || provisioningToken.length() == 0 || nombreZona.length() == 0 || gatewayEliminado) return;
  String topic = "telemetria/" + clienteID + "/" + deviceID + "/gateway/register";
  String payload = "{\"cliente_id\":\"" + escaparJson(clienteID) +
                   "\",\"device_id\":\"" + escaparJson(deviceID) +
                   "\",\"nombre_zona\":\"" + escaparJson(nombreZona) +
                   "\",\"provisioning_token\":\"" + escaparJson(provisioningToken) +
                   "\",\"config_version\":" + String(configVersion) + "}";
  if (mqttClient.publish(topic.c_str(), payload.c_str())) {
    ultimaPublicacionRegistro = millis();
    Serial.println("[MQTT] Registro de zona enviado; esperando confirmación del servidor.");
  } else {
    ultimaPublicacionRegistro = millis();
    Serial.println("[MQTT] No se pudo publicar el registro pendiente.");
  }
}

void publicarHeartbeatGateway() {
  if (!mqttClient.connected() || !registroConfirmado || provisioningToken.length() == 0 || gatewayEliminado) return;

  const String topic = "telemetria/" + clienteID + "/" + deviceID + "/gateway/heartbeat";
  const String payload = "{\"cliente_id\":\"" + escaparJson(clienteID) +
                        "\",\"device_id\":\"" + escaparJson(deviceID) +
                        "\",\"provisioning_token\":\"" + escaparJson(provisioningToken) + "\"}";
  if (!mqttClient.publish(topic.c_str(), payload.c_str())) {
    Serial.println("[MQTT] No se pudo publicar el heartbeat del gateway.");
  } else {
    Serial.println("[MQTT] Heartbeat del gateway enviado.");
  }
}

void enableCORS() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
  server.sendHeader("Cache-Control", "no-store");
}

void iniciarEscaneoRedesSolicitado() {
  if (!escaneoRedesSolicitado || escaneoRedesIniciado || escaneoRedesFallido) return;
  if (WiFi.status() == WL_IDLE_STATUS) return;

  const int resultado = WiFi.scanNetworks(true, true);
  if (resultado == WIFI_SCAN_FAILED) {
    escaneoRedesFallido = true;
    Serial.printf("[WiFi] No se pudo iniciar el escaneo; estado STA=%d.\n", static_cast<int>(WiFi.status()));
    return;
  }

  escaneoRedesIniciado = true;
  Serial.println("[WiFi] Escaneo de redes iniciado.");
}

void finalizarEscaneoRedes() {
  escaneoRedesSolicitado = false;
  escaneoRedesIniciado = false;
  escaneoRedesFallido = false;
  WiFi.scanDelete();
}

String obtenerDeviceIdFisico() {
  const uint64_t chipMac = ESP.getEfuseMac() & 0xFFFFFFFFFFFFULL;
  char id[16];
  snprintf(id, sizeof(id), "GW-%012llX", static_cast<unsigned long long>(chipMac));
  return String(id);
}

bool esFormatoIBeacon(BLEAdvertisedDevice &device) {
  if (!device.haveManufacturerData()) return false;

  String datos = device.getManufacturerData(); // String, no std::string, en esta versión de la librería
  if (datos.length() < 4) return false;

  uint8_t b0 = (uint8_t)datos[0];
  uint8_t b1 = (uint8_t)datos[1];
  uint8_t b2 = (uint8_t)datos[2];
  uint8_t b3 = (uint8_t)datos[3];

  return (b0 == 0x4C && b1 == 0x00 && b2 == 0x02 && b3 == 0x15);
}

int obtenerRSSIMediano(const VentanaBeacon &ventana) {
  int ordenadas[16];
  for (uint8_t i = 0; i < ventana.muestrasGuardadas; i++) {
    ordenadas[i] = ventana.muestrasRSSI[i];
  }
  std::sort(ordenadas, ordenadas + ventana.muestrasGuardadas);

  const uint8_t centro = ventana.muestrasGuardadas / 2;
  if (ventana.muestrasGuardadas % 2 == 0) {
    return (ordenadas[centro - 1] + ordenadas[centro]) / 2;
  }
  return ordenadas[centro];
}

// -------------------------------------------------------------
// CALLBACK MQTT
// -------------------------------------------------------------
void callbackMQTT(char *topic, byte *payload, unsigned int length) {
  String mensaje = "";
  for (unsigned int i = 0; i < length; i++) {
    mensaje += (char)payload[i];
  }

  String topicName(topic);
  if (topicName.endsWith("/gateway/beacons")) {
    std::vector<String> listaNueva;
    if (!extraerListaBeacons(mensaje, listaNueva)) {
      Serial.println("[MQTT] Lista de beacons inválida; se conserva la última lista guardada.");
      return;
    }
    beaconsPermitidos = listaNueva;
    listaBeaconsRecibida = true;
    avisoEsperandoLista = false;
    lecturasVentana.clear();
    colaLecturas.clear();
    guardarListaBeacons();
    Serial.printf("[BLE] Lista permitida actualizada: %u beacon(s).\n", static_cast<unsigned int>(beaconsPermitidos.size()));
    return;
  }

  if (topicName.endsWith("/gateway/ack")) {
    if (extractField(mensaje, "provisioning_token") != provisioningToken) return;
    if (mensaje.indexOf("\"ok\":true") < 0) {
      registroConfirmado = false;
      Serial.print("[MQTT] Registro pendiente: ");
      Serial.println(extractField(mensaje, "error"));
      return;
    }
    const unsigned int version = extraerNumeroJson(mensaje, "config_version", configVersion);
    if (version >= configVersion) {
      String zone = extractField(mensaje, "nombre_zona");
      if (zone.length() > 0) nombreZona = zone;
      configVersion = version;
      gatewayEliminado = false;
      guardarConfiguracionGateway();
    }
    registroConfirmado = true;
    Serial.print("[MQTT] Gateway registrado en la zona: ");
    Serial.println(nombreZona);
    detenerModoAP();
    return;
  }

  if (topicName.endsWith("/gateway/config")) {
    if (extractField(mensaje, "provisioning_token") != provisioningToken) return;
    const unsigned int version = extraerNumeroJson(mensaje, "config_version", 0);
    if (version < configVersion) return;
    configVersion = version;
    if (mensaje.indexOf("\"deleted\":true") >= 0) {
      gatewayEliminado = true;
      registroConfirmado = false;
      lecturasVentana.clear();
      colaLecturas.clear();
      Serial.println("[MQTT] Gateway eliminado desde la app; se detiene el envío de datos.");
      detenerModoAP();
    } else {
      String zone = extractField(mensaje, "nombre_zona");
      if (zone.length() > 0) nombreZona = zone;
      gatewayEliminado = false;
      registroConfirmado = true;
      Serial.print("[MQTT] Zona actualizada desde la app: ");
      Serial.println(nombreZona);
    }
    guardarConfiguracionGateway();
    return;
  }

}

void conectarMQTT() {
  if (mqttClient.connected()) return;
  Serial.print("[MQTT] Conectando a HiveMQ...");
  String clientIdStr = "M5Gateway-" + String(random(0xffff), HEX);

  if (mqttClient.connect(clientIdStr.c_str())) {
    Serial.println(" ¡Conectado!");
    String ackTopic = "telemetria/" + clienteID + "/" + deviceID + "/gateway/ack";
    mqttClient.subscribe(ackTopic.c_str());
    String zoneTopic = "telemetria/" + clienteID + "/" + deviceID + "/gateway/config";
    mqttClient.subscribe(zoneTopic.c_str());
    String beaconsTopic = "telemetria/" + clienteID + "/" + deviceID + "/gateway/beacons";
    mqttClient.subscribe(beaconsTopic.c_str(), 1);
    Serial.println(ackTopic);
    Serial.println(zoneTopic);
    Serial.println(beaconsTopic);
    ultimaPublicacionRegistro = 0;
  } else {
    Serial.print(" Falló, rc=");
    Serial.println(mqttClient.state());
  }
}

// -------------------------------------------------------------
// CALLBACK ESCÁNER BLE
// -------------------------------------------------------------
class AdvertisedDeviceCallbacks : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice advertisedDevice) {
    if (!esFormatoIBeacon(advertisedDevice)) return;

    String mac = advertisedDevice.getAddress().toString().c_str();
    mac.toUpperCase();
    if (!listaBeaconsRecibida ||
        std::find(beaconsPermitidos.begin(), beaconsPermitidos.end(), mac) == beaconsPermitidos.end()) {
      return;
    }

    int indice = -1;
    for (size_t i = 0; i < lecturasVentana.size(); i++) {
      if (lecturasVentana[i].mac == mac) {
        indice = i;
        break;
      }
    }

    if (indice < 0) {
      if (lecturasVentana.size() >= MAX_BEACONS_POR_VENTANA) {
        beaconsIgnoradosVentana++;
        return;
      }
      VentanaBeacon nueva = {};
      nueva.mac = mac;
      lecturasVentana.push_back(nueva);
      indice = lecturasVentana.size() - 1;
    }

    VentanaBeacon &ventana = lecturasVentana[indice];
    if (ventana.muestrasGuardadas < 16) {
      ventana.muestrasRSSI[ventana.muestrasGuardadas++] = advertisedDevice.getRSSI();
    } else {
      ventana.muestrasRSSI[ventana.siguienteMuestra] = advertisedDevice.getRSSI();
      ventana.siguienteMuestra = (ventana.siguienteMuestra + 1) % 16;
    }
    if (ventana.detecciones < UINT16_MAX) ventana.detecciones++;
  }
};

void iniciarBLE() {
  if (bleInicializado) return;
  BLEDevice::init("");
  pBLEScan = BLEDevice::getScan();
  pBLEScan->setAdvertisedDeviceCallbacks(new AdvertisedDeviceCallbacks(), true);
  pBLEScan->setActiveScan(true);
  pBLEScan->setInterval(1000);
  pBLEScan->setWindow(1000);
  bleInicializado = true;
}

// -------------------------------------------------------------
// ENDPOINTS HTTP (MODO AP)
// -------------------------------------------------------------
void setupHttpEndpoints() {
  server.onNotFound([]() {
    if (server.method() == HTTP_OPTIONS) {
      enableCORS();
      server.send(204);
    } else {
      enableCORS();
      server.send(404, "application/json", "{\"ok\":false,\"error\":\"Not Found\"}");
    }
  });

  server.on("/health", HTTP_GET, []() {
    enableCORS();
    server.send(200, "application/json", "{\"ok\":true,\"mode\":\"setup\"}");
  });

  server.on("/identity", HTTP_GET, []() {
    enableCORS();
    const String response = "{\"ok\":true,\"device_id\":\"" + deviceID +
      "\",\"token_guardado\":" + String(provisioningToken.length() > 0 ? "true" : "false") + "}";
    server.send(200, "application/json", response);
  });

  server.on("/networks", HTTP_GET, []() {
    int n = WiFi.scanComplete();
    if (n == WIFI_SCAN_RUNNING) {
      enableCORS();
      server.send(202, "application/json", "{\"status\":\"scanning\"}");
      return;
    }
    if (escaneoRedesSolicitado && !escaneoRedesIniciado && !escaneoRedesFallido) {
      enableCORS();
      server.send(202, "application/json", "{\"status\":\"scanning\"}");
      return;
    }
    if (escaneoRedesFallido || (escaneoRedesSolicitado && escaneoRedesIniciado && n == WIFI_SCAN_FAILED)) {
      const bool reintentarWifi = pausarReintentosWifi;
      finalizarEscaneoRedes();
      enableCORS();
      server.send(503, "application/json", "{\"status\":\"error\",\"error\":\"El M5 no pudo iniciar el escaneo. Mantén el teléfono conectado a GatoGateway-Setup e inténtalo otra vez.\"}");
      if (reintentarWifi) {
        pausarReintentosWifi = false;
        reconectarWifiGuardado();
      }
      return;
    }
    if (n == WIFI_SCAN_FAILED) {
      WiFi.scanDelete();
      escaneoRedesSolicitado = true;
      escaneoRedesIniciado = false;
      escaneoRedesFallido = false;
      if (WiFi.status() != WL_CONNECTED) {
        pausarReintentosWifi = true;
        WiFi.disconnect(false, false);
        Serial.println("[WiFi] Pausando la reconexión para escanear redes.");
      }
      enableCORS();
      server.send(202, "application/json", "{\"status\":\"scanning\"}");
      return;
    }

    enableCORS();
    String json = "[";
    for (int i = 0; i < n; ++i) {
      if (i > 0) json += ",";
      json += "{\"ssid\":\"" + escaparJson(WiFi.SSID(i)) + "\",\"rssi\":" + String(WiFi.RSSI(i)) + "}";
    }
    json += "]";
    server.send(200, "application/json", json);
    if (escaneoRedesSolicitado) {
      finalizarEscaneoRedes();
      Serial.println("[WiFi] Escaneo terminado.");
    }
  });

  server.on("/config", HTTP_POST, []() {
    enableCORS();
    String body = server.arg("plain");

    String wifiSsid = extractField(body, "wifi_ssid");
    String wifiPass = extractField(body, "wifi_pass");
    String device = extractField(body, "device_id");
    String client = extractField(body, "cliente_id");
    String zone = extractField(body, "nombre_zona");
    String token = extractField(body, "provisioning_token");

    if (zone.length() == 0 || token.length() == 0) {
      server.send(400, "application/json", "{\"ok\":false,\"error\":\"Faltan el nombre de zona o el token de registro\"}");
      return;
    }
    if (device.length() > 0 && device != deviceID) {
      server.send(409, "application/json", "{\"ok\":false,\"error\":\"El ID no coincide con el identificador físico del M5Stack\",\"device_id\":\"" + deviceID + "\"}");
      return;
    }

    const bool actualizarWifi = wifiSsid.length() > 0;
    if (client.length() > 0) clienteID = client;
    nombreZona = zone;
    provisioningToken = token;
    configVersion = 0;
    gatewayEliminado = false;

    prefs.begin("gateway_cfg", false);
    if (actualizarWifi) {
      prefs.putString("wifi_ssid", wifiSsid);
      prefs.putString("wifi_pass", wifiPass);
    }
    prefs.putString("cliente_id", clienteID);
    prefs.putString("device_id", deviceID);
    prefs.putString("nombre_zona", nombreZona);
    prefs.putString(PREFS_PROVISIONING_TOKEN, provisioningToken);
    prefs.putUInt("config_version", configVersion);
    prefs.putBool("gateway_deleted", false);
    prefs.end();

    prefs.begin("gateway_cfg", true);
    const String tokenPersistido = prefs.getString(PREFS_PROVISIONING_TOKEN, "");
    prefs.end();
    if (tokenPersistido != provisioningToken) {
      provisioningToken = tokenPersistido;
      registroConfirmado = false;
      server.send(500, "application/json", "{\"ok\":false,\"error\":\"No se pudo verificar el token guardado en el M5Stack. Vuelve a guardar la configuración antes de reiniciarlo.\"}");
      Serial.println("[CONFIG] ERROR: el token de registro no quedó guardado en NVS.");
      return;
    }
    Serial.println("[CONFIG] Token de registro verificado en NVS; se conservará al reiniciar.");

    server.send(200, "application/json", "{\"ok\":true,\"device_id\":\"" + escaparJson(deviceID) + "\",\"nombre_zona\":\"" + escaparJson(nombreZona) + "\"}");
    registroConfirmado = false;
    ultimaPublicacionRegistro = 0;
    if (actualizarWifi) {
      mqttClient.disconnect();
      pausarReintentosWifi = false;
      WiFi.disconnect(false, false);
      WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
      ultimoIntentoWiFi = millis();
      Serial.println("[CONFIG] Wi-Fi actualizado. Reconectando sin reiniciar.");
    } else if (pausarReintentosWifi) {
      pausarReintentosWifi = false;
      reconectarWifiGuardado();
    } else {
      Serial.println("[CONFIG] Registro actualizado sin cambiar Wi-Fi ni reiniciar.");
    }
  });

  server.begin();
}

// -------------------------------------------------------------
// SETUP
// -------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(BTN_PIN, INPUT); // habilita la lectura del botón de reset (GPIO 39 es solo lectura, sin pull-up interno)

  FastLED.addLeds<WS2812, LED_PIN, GRB>(leds, NUM_LEDS);
  FastLED.setBrightness(40);
  fijarColorLed(COLOR_MODO_AP);

  prefs.begin("gateway_cfg", true);
  String savedSsid = prefs.getString("wifi_ssid", "");
  String savedPass = prefs.getString("wifi_pass", "");
  clienteID = prefs.getString("cliente_id", clienteID);
  deviceID = obtenerDeviceIdFisico();
  nombreZona = prefs.getString("nombre_zona", "");
  provisioningToken = prefs.getString(PREFS_PROVISIONING_TOKEN, "");
  configVersion = prefs.getUInt("config_version", 0);
  gatewayEliminado = prefs.getBool("gateway_deleted", false);
  const bool listaGuardada = prefs.getBool(PREFS_ALLOWLIST_RECEIVED, false);
  const String listaSerializada = prefs.getString("allowed_macs", "");
  prefs.end();
  listaBeaconsRecibida = listaGuardada && restaurarListaBeacons(listaSerializada);
  if (!listaBeaconsRecibida) beaconsPermitidos.clear();
  Serial.printf(
    "[CONFIG] Gateway %s; zona %s; token %s.\n",
    deviceID.c_str(),
    nombreZona.length() > 0 ? "configurada" : "FALTA",
    provisioningToken.length() > 0 ? "guardado" : "FALTA"
  );

  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.mode(WIFI_AP_STA);
  iniciarModoAP();

  if (savedSsid.length() > 0) {
    Serial.print("[WiFi] Intentando conectar a: ");
    Serial.println(savedSsid);
    WiFi.begin(savedSsid.c_str(), savedPass.c_str());
    ultimoIntentoWiFi = millis();
  } else {
    Serial.println("[WiFi] Sin credenciales; esperando configuración desde la app.");
  }

  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(callbackMQTT);
  mqttClient.setBufferSize(8192);
}

// -------------------------------------------------------------
// LOOP PRINCIPAL
// -------------------------------------------------------------
void loop() {
  comprobarBotonReset(); // primera línea: funciona tanto conectado como en modo AP

  if (modoApActivo) server.handleClient();
  iniciarEscaneoRedesSolicitado();

  if (WiFi.status() != WL_CONNECTED) {
    fijarColorLed(COLOR_MODO_AP);
    const wl_status_t estadoWiFi = WiFi.status();
    if (!pausarReintentosWifi && estadoWiFi == WL_IDLE_STATUS &&
        millis() - ultimoIntentoWiFi >= TIMEOUT_CONEXION_WIFI_MS) {
      Serial.println("[WiFi] El intento sigue activo tras 30 s; se cancela antes de reintentar.");
      WiFi.disconnect(false, false);
      ultimoIntentoWiFi = millis();
      delay(100);
      return;
    }
    if (!pausarReintentosWifi && estadoWiFi != WL_IDLE_STATUS &&
        millis() - ultimoIntentoWiFi >= REINTENTO_WIFI_MS &&
        WiFi.getMode() == WIFI_AP_STA) {
      prefs.begin("gateway_cfg", true);
      String savedSsid = prefs.getString("wifi_ssid", "");
      String savedPass = prefs.getString("wifi_pass", "");
      prefs.end();
      if (savedSsid.length() > 0) {
        Serial.printf("[WiFi] Estado %d; reintentando conexión a la red guardada.\n", static_cast<int>(estadoWiFi));
        ultimoIntentoWiFi = millis();
        WiFi.begin(savedSsid.c_str(), savedPass.c_str());
      }
    }
    delay(100);
    return;
  }

  fijarColorLed(COLOR_CONECTADO);

  if (!mqttClient.connected() && millis() - ultimoIntentoMQTT >= REINTENTO_MQTT_MS) {
    ultimoIntentoMQTT = millis();
    conectarMQTT();
  }
  mqttClient.loop();

  if (provisioningToken.length() > 0 && nombreZona.length() > 0 &&
      (ultimaPublicacionRegistro == 0 ||
       millis() - ultimaPublicacionRegistro >= REINTENTO_REGISTRO_MS)) {
    publicarRegistroGateway();
  }

  if (gatewayEliminado || !registroConfirmado) {
    delay(100);
    return;
  }

  if (ultimaPublicacionHeartbeat == 0 ||
      millis() - ultimaPublicacionHeartbeat >= INTERVALO_HEARTBEAT_MS) {
    ultimaPublicacionHeartbeat = millis();
    publicarHeartbeatGateway();
  }

  if (!listaBeaconsRecibida) {
    if (!avisoEsperandoLista) {
      Serial.println("[BLE] Esperando la lista de beacons asignados recibida por MQTT.");
      avisoEsperandoLista = true;
    }
    delay(100);
    return;
  }

  iniciarBLE();
  pBLEScan->start(1, false);

  for (const VentanaBeacon &ventana : lecturasVentana) {
    if (ventana.muestrasGuardadas == 0) continue;
    if (colaLecturas.size() >= MAX_LECTURAS_EN_COLA) {
      resumenesDescartadosCola++;
      continue;
    }
    LecturaBeacon lectura = {
      ventana.mac,
      obtenerRSSIMediano(ventana),
      ventana.detecciones,
      millis()
    };
    colaLecturas.push_back(lectura);
  }
  lecturasVentana.clear();
  if (beaconsIgnoradosVentana > 0) {
    Serial.print("[BLE] Beacons iBeacon omitidos por superar el limite por ventana: ");
    Serial.println(beaconsIgnoradosVentana);
    beaconsIgnoradosVentana = 0;
  }
  if (resumenesDescartadosCola > 0) {
    Serial.print("[MQTT] Resumenes omitidos por cola llena: ");
    Serial.println(resumenesDescartadosCola);
    resumenesDescartadosCola = 0;
  }

  const String topic = "telemetria/" + clienteID + "/" + deviceID + "/beacon";
  uint32_t lecturasCaducadas = 0;
  while (!colaLecturas.empty() &&
         (uint32_t)(millis() - colaLecturas.front().capturedAtMs) > MAX_ANTIGUEDAD_EN_COLA_MS) {
    colaLecturas.erase(colaLecturas.begin());
    lecturasCaducadas++;
  }
  if (lecturasCaducadas > 0) {
    Serial.print("[MQTT] Resumenes descartados por antiguedad: ");
    Serial.println(lecturasCaducadas);
  }

  while (!colaLecturas.empty() && mqttClient.connected()) {
    const size_t cantidad = min(MAX_LECTURAS_POR_MENSAJE, colaLecturas.size());
    String payload = "{\"cliente_id\":\"" + escaparJson(clienteID) +
                     "\",\"device_id\":\"" + escaparJson(deviceID) +
                     "\",\"schema_version\":2,\"window_ms\":" + String(VENTANA_ESCANEO_MS) +
                     ",\"beacons\":[";
    for (size_t i = 0; i < cantidad; i++) {
      if (i > 0) payload += ",";
      const LecturaBeacon &item = colaLecturas[i];
      payload += "{\"mac\":\"" + item.mac +
                 "\",\"rssi\":" + String(item.rssi) +
                 ",\"sample_count\":" + String(item.sampleCount) + "}";
    }
    payload += "]}";

    if (!mqttClient.publish(topic.c_str(), payload.c_str())) {
      Serial.println("[MQTT] Lectura conservada en la cola para el siguiente reintento.");
      break;
    }
    for (size_t i = 0; i < cantidad; i++) {
      const LecturaBeacon &item = colaLecturas[i];
      Serial.printf(
        "[MQTT] Enviado MAC=%s RSSI=%d dBm muestras=%u\n",
        item.mac.c_str(),
        item.rssi,
        item.sampleCount
      );
    }
    colaLecturas.erase(colaLecturas.begin(), colaLecturas.begin() + cantidad);
  }

  pBLEScan->clearResults();
  delay(100);
}
