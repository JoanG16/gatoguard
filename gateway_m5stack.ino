#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEScan.h>
#include <vector>
#include <FastLED.h>

// Configuración del Servidor AP y MQTT
const char *AP_SSID = "GatoGateway-Setup";
const char *AP_PASS = "gatoguard";
const char *MQTT_BROKER = "broker.hivemq.com";
const int MQTT_PORT = 1883;

// Variables globales de identificación
String clienteID = "demo_cliente";
String deviceID = "GW-1";

// Instancias principales
WebServer server(80);
WiFiClient espClient;
PubSubClient mqttClient(espClient);
BLEScan *pBLEScan;
Preferences prefs;

// Lista dinámica en memoria de MACs de beacons permitidos (llega por MQTT desde el dashboard)
std::vector<String> beaconsPermitidos;

// -------------------------------------------------------------
// LED RGB INTEGRADO (NeoPixel del M5Atom, GPIO 27)
// -------------------------------------------------------------
// M5Atom Lite trae 1 LED; M5Atom Matrix trae 25. Si usas el Matrix y quieres
// que se iluminen todos los pixeles igual, cambia NUM_LEDS a 25.
#define LED_PIN 27
#define NUM_LEDS 1
CRGB leds[NUM_LEDS];

// Colores según el estado del gateway
const CRGB COLOR_MODO_AP        = CRGB(0, 0, 255);   // Azul: sin red configurada / portal de configuración activo
const CRGB COLOR_CONECTADO      = CRGB(0, 255, 0);   // Verde: conectado a Wi-Fi con batería en buen nivel
const CRGB COLOR_BATERIA_MEDIA  = CRGB(255, 160, 0); // Naranja: batería ~ al 50%
const CRGB COLOR_BATERIA_BAJA   = CRGB(255, 0, 0);   // Rojo: batería crítica, a punto de apagarse

unsigned long ultimoParpadeo = 0;
bool parpadeoEncendido = true;

// -------------------------------------------------------------
// LECTURA DE BATERÍA (pendiente de definir el hardware final)
// -------------------------------------------------------------
// El proveedor aún no confirma qué batería/módulo se va a montar. Dejamos
// preparada la lectura por un pin ADC vía divisor de voltaje (opción más común
// para alimentar un M5Atom con una batería LiPo externa), pero deshabilitada
// por defecto (BATERIA_DISPONIBLE = false) para no reportar datos falsos.
// Cuando se confirme el módulo de batería:
//   1. Cambia BATERIA_DISPONIBLE a true.
//   2. Ajusta PIN_BATERIA al GPIO ADC realmente usado.
//   3. Calibra BATERIA_VOLTAJE_MIN/MAX y la relación del divisor de voltaje
//      (R1/R2) según el circuito real, o reemplaza leerPorcentajeBateria()
//      por la lectura del chip fuel-gauge si el módulo trae uno por I2C.
const bool BATERIA_DISPONIBLE = false;
const int PIN_BATERIA = 33;                 // GPIO ADC sugerido, ajustar según el cableado real
const float BATERIA_VOLTAJE_MIN = 3.3;      // Voltaje de una LiPo "vacía"
const float BATERIA_VOLTAJE_MAX = 4.2;      // Voltaje de una LiPo cargada al 100%
const float DIVISOR_VOLTAJE = 2.0;          // Ajustar según relación real del divisor resistivo (R1+R2)/R2

// Devuelve el porcentaje de batería (0-100), o -1 si aún no hay hardware de batería configurado.
int leerPorcentajeBateria() {
  if (!BATERIA_DISPONIBLE) return -1;

  int lecturaCruda = analogRead(PIN_BATERIA);          // 0-4095 en ESP32 (ADC de 12 bits)
  float voltajePin = (lecturaCruda / 4095.0) * 3.3;    // Voltaje real en el pin ADC
  float voltajeBateria = voltajePin * DIVISOR_VOLTAJE;  // Voltaje real de la batería tras el divisor

  float porcentaje = (voltajeBateria - BATERIA_VOLTAJE_MIN) / (BATERIA_VOLTAJE_MAX - BATERIA_VOLTAJE_MIN) * 100.0;
  if (porcentaje > 100) porcentaje = 100;
  if (porcentaje < 0) porcentaje = 0;
  return (int)porcentaje;
}

// Decide qué color debe mostrar el LED según el estado de red y de batería.
void actualizarLed() {
  bool conectado = (WiFi.status() == WL_CONNECTED);

  // 1. Sin red configurada / en modo portal de configuración (AP) -> Azul
  if (!conectado) {
    FastLED.showColor(COLOR_MODO_AP);
    return;
  }

  int bateria = leerPorcentajeBateria();

  // 2. Sin hardware de batería aún (bateria == -1) -> se asume alimentación estable, color de "conectado"
  if (bateria < 0) {
    FastLED.showColor(COLOR_CONECTADO);
    return;
  }

  // 3. Batería crítica (a punto de apagarse) -> Rojo parpadeante para llamar la atención
  if (bateria <= 15) {
    unsigned long ahora = millis();
    if (ahora - ultimoParpadeo > 500) {
      parpadeoEncendido = !parpadeoEncendido;
      ultimoParpadeo = ahora;
    }
    FastLED.showColor(parpadeoEncendido ? COLOR_BATERIA_BAJA : CRGB::Black);
    return;
  }

  // 4. Batería a la mitad -> Naranja
  if (bateria <= 55) {
    FastLED.showColor(COLOR_BATERIA_MEDIA);
    return;
  }

  // 5. Batería en buen nivel -> mismo color que "conectado a la red"
  FastLED.showColor(COLOR_CONECTADO);
}

// -------------------------------------------------------------
// FUNCIONES AUXILIARES Y MANEJO DE CORS
// -------------------------------------------------------------
String extractField(String body, String key) {
  int index = body.indexOf(key);
  if (index < 0) return "";
  index += key.length();
  int end = body.indexOf("\"", index);
  if (end < 0) return "";
  return body.substring(index, end);
}

void enableCORS() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

bool esMacPermitida(String mac) {
  mac.toUpperCase();
  // Si no hay lista recibida aún, permite cualquier beacon detectado (se filtra igual por formato iBeacon).
  if (beaconsPermitidos.empty()) return true;

  for (String permitida : beaconsPermitidos) {
    if (mac.equals(permitida)) return true;
  }
  return false;
}

// Los BlueCharm (y la mayoría de beacons BLE reales) transmiten en formato iBeacon:
// manufacturerData empieza con el Company ID de Apple (0x4C 0x00) seguido del tipo/longitud iBeacon (0x02 0x15).
// Los celulares, audífonos y relojes NO transmiten este formato; filtrando por esto evitamos
// que cualquier dispositivo BLE cercano se confunda con un collar real ("falso collar nuevo").
bool esFormatoIBeacon(BLEAdvertisedDevice &device) {
  if (!device.haveManufacturerData()) return false;
  std::string datos = device.getManufacturerData();
  if (datos.length() < 4) return false;
  uint8_t b0 = (uint8_t)datos[0];
  uint8_t b1 = (uint8_t)datos[1];
  uint8_t b2 = (uint8_t)datos[2];
  uint8_t b3 = (uint8_t)datos[3];
  // Company ID 0x004C (Apple, little-endian: 4C 00) + iBeacon type/length (02 15)
  return (b0 == 0x4C && b1 == 0x00 && b2 == 0x02 && b3 == 0x15);
}

// -------------------------------------------------------------
// CALLBACK MQTT (Recibe lista de beacons desde Node.js)
// -------------------------------------------------------------
void callbackMQTT(char *topic, byte *payload, unsigned int length) {
  String mensaje = "";
  for (unsigned int i = 0; i < length; i++) {
    mensaje += (char)payload[i];
  }

  Serial.print("[MQTT CONFIG] Actualización recibida en ");
  Serial.println(topic);
  Serial.println(mensaje);

  // Limpiar vector e incorporar las MACs recibidas
  beaconsPermitidos.clear();

  // Parsea un array simple JSON como ["DD:88:00:00:3E:15", "AA:BB:CC:DD:EE:FF"]
  int start = 0;
  while ((start = mensaje.indexOf('"', start)) != -1) {
    int end = mensaje.indexOf('"', start + 1);
    if (end == -1) break;
    String mac = mensaje.substring(start + 1, end);
    mac.toUpperCase();
    if (mac.length() == 17) { // Validar longitud típica de MAC
      beaconsPermitidos.push_back(mac);
      Serial.print(" -> MAC añadida a la lista blanca: ");
      Serial.println(mac);
    }
    start = end + 1;
  }
}

void conectarMQTT() {
  while (!mqttClient.connected()) {
    Serial.print("[MQTT] Conectando a HiveMQ...");
    String clientIdStr = "M5Gateway-" + String(random(0xffff), HEX);

    if (mqttClient.connect(clientIdStr.c_str())) {
      Serial.println(" ¡Conectado!");

      // Suscribirse al tópico de configuración de beacons del cliente
      String configTopic = "telemetria/" + clienteID + "/config/beacons";
      mqttClient.subscribe(configTopic.c_str());
      Serial.print("[MQTT] Suscrito a: ");
      Serial.println(configTopic);
    } else {
      Serial.print(" Falló, rc=");
      Serial.print(mqttClient.state());
      Serial.println(" reintentando en 3s...");
      delay(3000);
    }
  }
}

// -------------------------------------------------------------
// CALLBACK ESCÁNER BLE
// -------------------------------------------------------------
class AdvertisedDeviceCallbacks : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice advertisedDevice) {
    // FILTRO 1: Descartar cualquier dispositivo BLE que no tenga formato iBeacon
    // (celulares, audífonos, relojes, etc. no son collares BlueCharm reales).
    if (!esFormatoIBeacon(advertisedDevice)) {
      return;
    }

    String mac = advertisedDevice.getAddress().toString().c_str();
    mac.toUpperCase();

    // FILTRO 2: Rechazar si la MAC no está en la lista de beacons permitidos (cuando exista lista)
    if (!esMacPermitida(mac)) {
      return;
    }

    int rssi = advertisedDevice.getRSSI();

    // 1. Tópico requerido por index.js: telemetria/<cliente_id>/<device_id>/beacon
    String topic = "telemetria/" + clienteID + "/" + deviceID + "/beacon";

    // 2. Payload JSON estructurado con schema_version: 1
    String payload = "{\"cliente_id\":\"" + clienteID +
                     "\",\"device_id\":\"" + deviceID +
                     "\",\"mac\":\"" + mac +
                     "\",\"rssi\":" + String(rssi) +
                     ",\"schema_version\":1}";

    Serial.print("[BLE->MQTT] ACEPTADO ");
    Serial.println(payload);

    mqttClient.publish(topic.c_str(), payload.c_str());
  }
};

// -------------------------------------------------------------
// ENDPOINTS DEL SERVIDOR HTTP LOCAL (MODO CONFIGURACIÓN / AP)
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

  server.on("/networks", HTTP_GET, []() {
    enableCORS();
    Serial.println("[WiFi] Escaneando redes cercanas...");
    int n = WiFi.scanNetworks();
    String json = "[";
    for (int i = 0; i < n; ++i) {
      if (i > 0) json += ",";
      json += "{\"ssid\":\"" + WiFi.SSID(i) + "\",\"rssi\":" + String(WiFi.RSSI(i)) + "}";
    }
    json += "]";
    WiFi.scanDelete();
    server.send(200, "application/json", json);
  });

  server.on("/config", HTTP_POST, []() {
    enableCORS();
    String body = server.arg("plain");

    String wifiSsid = extractField(body, "\"wifi_ssid\":\"");
    String wifiPass = extractField(body, "\"wifi_pass\":\"");
    String device = extractField(body, "\"device_id\":\"");
    String client = extractField(body, "\"cliente_id\":\"");

    wifiSsid.trim();
    wifiPass.trim();

    if (wifiSsid.length() == 0 || wifiPass.length() == 0) {
      server.send(400, "application/json", "{\"ok\":false,\"error\":\"Faltan credenciales\"}");
      return;
    }

    if (device.length() > 0) deviceID = device;
    if (client.length() > 0) clienteID = client;

    prefs.begin("gateway_cfg", false);
    prefs.putString("wifi_ssid", wifiSsid);
    prefs.putString("wifi_pass", wifiPass);
    prefs.putString("cliente_id", clienteID);
    prefs.putString("device_id", deviceID);
    prefs.end();

    server.send(200, "application/json", "{\"ok\":true,\"device_id\":\"" + deviceID + "\"}");
    delay(1500);
    ESP.restart();
  });

  server.begin();
}

// -------------------------------------------------------------
// SETUP PRINCIPAL
// -------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1000);

  // Inicializar el LED RGB integrado (NeoPixel, GPIO 27 en M5Atom)
  FastLED.addLeds<WS2812, LED_PIN, GRB>(leds, NUM_LEDS);
  FastLED.setBrightness(40);
  FastLED.showColor(COLOR_MODO_AP); // Color inicial mientras arranca (aún sin red)

  // 1. Leer credenciales guardadas en NVS
  prefs.begin("gateway_cfg", true);
  String savedSsid = prefs.getString("wifi_ssid", "");
  String savedPass = prefs.getString("wifi_pass", "");
  clienteID = prefs.getString("cliente_id", clienteID);
  deviceID = prefs.getString("device_id", deviceID);
  prefs.end();

  // 2. Intentar conectar a la red Wi-Fi
  if (savedSsid.length() > 0) {
    Serial.print("[WiFi] Intentando conectar a: ");
    Serial.println(savedSsid);

    WiFi.mode(WIFI_STA);
    WiFi.begin(savedSsid.c_str(), savedPass.c_str());

    int intentos = 0;
    while (WiFi.status() != WL_CONNECTED && intentos < 20) {
      delay(500);
      Serial.print(".");
      intentos++;
    }

    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("\n[WiFi] ¡Conectado exitosamente!");
      Serial.print("[WiFi] IP asignada: ");
      Serial.println(WiFi.localIP());

      // Configurar cliente MQTT
      mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
      mqttClient.setCallback(callbackMQTT);

      // Inicializar escáner BLE
      BLEDevice::init("");
      pBLEScan = BLEDevice::getScan();
      pBLEScan->setAdvertisedDeviceCallbacks(new AdvertisedDeviceCallbacks());
      pBLEScan->setActiveScan(true);
      pBLEScan->setInterval(100);
      pBLEScan->setWindow(99);

      return; // Continuar al loop normal en modo STA
    }
  }

  // 3. Si no hay red guardada o falló la conexión, habilitar el Modo AP
  Serial.println("\n[WiFi] Levantando Punto de Acceso de configuración...");
  WiFi.persistent(false);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASS);

  IPAddress ip = WiFi.softAPIP();
  Serial.print("[WiFi] IP del Gateway en Modo AP: ");
  Serial.println(ip);

  setupHttpEndpoints();
}

// -------------------------------------------------------------
// BUCLE PRINCIPAL (LOOP)
// -------------------------------------------------------------
void loop() {
  // Actualiza el color del LED en cada vuelta según el estado de red/batería.
  actualizarLed();

  // Si no logró conectarse a Wi-Fi, atiende el portal web en modo AP
  if (WiFi.status() != WL_CONNECTED) {
    server.handleClient();
    delay(10);
    return;
  }

  // Si está conectado a Wi-Fi, procesa MQTT y BLE
  if (!mqttClient.connected()) {
    conectarMQTT();
  }
  mqttClient.loop();

  // Escaneo BLE continuo de 2 segundos
  pBLEScan->start(2, false);
  pBLEScan->clearResults();
  delay(1000);
}
