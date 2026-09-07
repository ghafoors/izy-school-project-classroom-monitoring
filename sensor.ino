#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <time.h>
#include <Wire.h>
#include <Adafruit_AHTX0.h>
#include <Adafruit_BMP280.h>

#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Missing secrets.h. Copy secrets.example.h or run: npm run map-env --prefix worker"
#endif

#ifndef DEVICE_ZONE
#define DEVICE_ZONE "classroom"
#endif

// ============================================================================
// 1. CONFIGURATION & PIN DEFINITIONS
// ============================================================================

const char* ssid = WIFI_SSID;
const char* password = WIFI_PASSWORD;
const char* ingest_url = INGEST_URL;
const char* ingest_token = INGEST_TOKEN;
const char* device_id = DEVICE_ID;  // empty = Wi-Fi MAC
const char* device_zone = DEVICE_ZONE;

const unsigned long sample_interval_ms = 10000;

#define I2C_SDA 21
#define I2C_SCL 22

// Analog sensors use ADC1 only (ADC2 is unusable while Wi-Fi is on).
#define PIN_MQ2 36
#define PIN_MQ4 39
#define PIN_MQ6 34
#define PIN_MQ135 35
#define PIN_SOUND_AO 32
#define PIN_SOUND_DO 25
#define PIN_UV 33

// Flip these to true after each module is wired. Unconnected ADC pins store noise.
const bool enable_mq2 = false;
const bool enable_mq4 = false;
const bool enable_mq6 = false;
const bool enable_mq135 = false;
const bool enable_sound = false;
const bool enable_uv = false;

// GUVA-S12SD modules are commonly ~0.1 V per UV index.
const float uv_volts_per_index = 0.1f;

Adafruit_AHTX0 aht;
Adafruit_BMP280 bmp;

bool aht_found = false;
bool bmp_found = false;
String resolved_device_id;

// ============================================================================
// Helpers
// ============================================================================

void appendJsonNull(String& json, const char* key) {
  json += '"';
  json += key;
  json += "\":null";
}

void appendJsonString(String& json, const char* key, const String& value) {
  json += '"';
  json += key;
  json += "\":\"";
  json += value;
  json += '"';
}

void appendJsonInt(String& json, const char* key, long value) {
  json += '"';
  json += key;
  json += "\":";
  json += String(value);
}

void appendJsonFloat(String& json, const char* key, float value, int decimals) {
  json += '"';
  json += key;
  json += "\":";
  json += String(value, decimals);
}

void appendJsonOptionalInt(String& json, const char* key, bool present, int value) {
  if (present) {
    appendJsonInt(json, key, value);
  } else {
    appendJsonNull(json, key);
  }
}

void appendJsonOptionalFloat(String& json, const char* key, bool present, float value, int decimals) {
  if (present) {
    appendJsonFloat(json, key, value, decimals);
  } else {
    appendJsonNull(json, key);
  }
}

bool readAnalog(int pin, int& adc, float& voltage) {
  adc = analogRead(pin);
  voltage = analogReadMilliVolts(pin) / 1000.0f;
  return true;
}

String isoTimestampUtc() {
  time_t now = time(nullptr);
  if (now < 1700000000) {
    return "";
  }
  struct tm t;
  gmtime_r(&now, &t);
  char buf[25];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &t);
  return String(buf);
}

bool postReading(const String& body) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WARN] Wi-Fi down; skip cloud ingest.");
    return false;
  }
  if (ingest_url[0] == '\0' || ingest_token[0] == '\0') {
    Serial.println("[WARN] ingest_url / ingest_token not set; skip cloud ingest.");
    return false;
  }

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  if (!http.begin(client, ingest_url)) {
    Serial.println("[ERROR] HTTP begin failed.");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + ingest_token);
  const int code = http.POST(body);
  const String response = http.getString();
  http.end();

  Serial.printf("[CLOUD] HTTP %d %s\n", code, response.c_str());
  return code >= 200 && code < 300;
}

// ============================================================================
// 2. SETUP
// ============================================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n--- Starting ESP32-WROVER Environmental Node ---");

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
  pinMode(PIN_SOUND_DO, INPUT);

  if (psramFound()) {
    Serial.printf("PSRAM detected! Free PSRAM: %d bytes\n", ESP.getFreePsram());
  } else {
    Serial.println("PSRAM not detected or disabled.");
  }

  Wire.begin(I2C_SDA, I2C_SCL);

  if (aht.begin(&Wire)) {
    Serial.println("[SUCCESS] AHT20 sensor initialized.");
    aht_found = true;
  } else {
    Serial.println("[WARNING] AHT20 sensor not found on I2C bus!");
  }

  if (bmp.begin(0x76)) {
    Serial.println("[SUCCESS] BMP280 sensor initialized at address 0x76.");
    bmp_found = true;
  } else if (bmp.begin(0x77)) {
    Serial.println("[SUCCESS] BMP280 sensor initialized at address 0x77.");
    bmp_found = true;
  } else {
    Serial.println("[WARNING] BMP280 sensor not found on I2C bus!");
  }

  WiFi.begin(ssid, password);
  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\n[SUCCESS] Wi-Fi connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());

  resolved_device_id = strlen(device_id) > 0 ? String(device_id) : WiFi.macAddress();
  Serial.print("Device ID: ");
  Serial.println(resolved_device_id);

  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
}

// ============================================================================
// 3. LOOP
// ============================================================================
void loop() {
  static unsigned long last_check = 0;
  if (millis() - last_check > sample_interval_ms) {
    last_check = millis();

    float aht_t = 0, aht_h = 0;
    if (aht_found) {
      sensors_event_t humidity, temp;
      aht.getEvent(&humidity, &temp);
      aht_t = temp.temperature;
      aht_h = humidity.relative_humidity;
    }

    float bmp_t = 0, bmp_p = 0, bmp_alt = 0;
    if (bmp_found) {
      bmp_t = bmp.readTemperature();
      bmp_p = bmp.readPressure() / 100.0F;
      bmp_alt = bmp.readAltitude(1013.25);
    }

    int mq2_adc = 0, mq4_adc = 0, mq6_adc = 0, mq135_adc = 0, sound_adc = 0, uv_adc = 0;
    float mq2_v = 0, mq4_v = 0, mq6_v = 0, mq135_v = 0, sound_v = 0, uv_v = 0, uv_index = 0;
    int sound_detected = 0;

    if (enable_mq2) readAnalog(PIN_MQ2, mq2_adc, mq2_v);
    if (enable_mq4) readAnalog(PIN_MQ4, mq4_adc, mq4_v);
    if (enable_mq6) readAnalog(PIN_MQ6, mq6_adc, mq6_v);
    if (enable_mq135) readAnalog(PIN_MQ135, mq135_adc, mq135_v);
    if (enable_sound) {
      readAnalog(PIN_SOUND_AO, sound_adc, sound_v);
      sound_detected = digitalRead(PIN_SOUND_DO) == LOW ? 1 : 0;
    }
    if (enable_uv) {
      readAnalog(PIN_UV, uv_adc, uv_v);
      uv_index = uv_volts_per_index > 0 ? uv_v / uv_volts_per_index : 0;
    }

    Serial.println("\n--- Environmental Sensor Readings ---");
    if (aht_found) {
      Serial.printf("Temperature (AHT20): %.2f °C\n", aht_t);
      Serial.printf("Humidity    (AHT20): %.2f %%\n", aht_h);
    }
    if (bmp_found) {
      Serial.printf("Temperature (BMP280): %.2f °C\n", bmp_t);
      Serial.printf("Pressure   (BMP280): %.2f hPa\n", bmp_p);
      Serial.printf("Altitude   (BMP280): %.2f m\n", bmp_alt);
    }
    if (enable_mq2) Serial.printf("MQ-2  (smoke/LPG): adc=%d  %.3f V\n", mq2_adc, mq2_v);
    if (enable_mq4) Serial.printf("MQ-4  (CH4):       adc=%d  %.3f V\n", mq4_adc, mq4_v);
    if (enable_mq6) Serial.printf("MQ-6  (LPG):       adc=%d  %.3f V\n", mq6_adc, mq6_v);
    if (enable_mq135) Serial.printf("MQ-135 (air):      adc=%d  %.3f V\n", mq135_adc, mq135_v);
    if (enable_sound) Serial.printf("Sound XD-74:       adc=%d  %.3f V  detected=%d\n", sound_adc, sound_v, sound_detected);
    if (enable_uv) Serial.printf("UV GUVA-S12SD:     adc=%d  %.3f V  index≈%.2f\n", uv_adc, uv_v, uv_index);
    Serial.println("-------------------------------------");

    String json = "{";
    appendJsonString(json, "device_id", resolved_device_id);
    json += ',';
    appendJsonString(json, "zone", String(device_zone));
    json += ',';
    const String ts = isoTimestampUtc();
    if (ts.length() > 0) {
      appendJsonString(json, "recorded_at", ts);
    } else {
      appendJsonNull(json, "recorded_at");
    }
    json += ',';
    appendJsonInt(json, "wifi_rssi", WiFi.RSSI());
    json += ',';
    appendJsonOptionalFloat(json, "aht20_temperature_c", aht_found, aht_t, 2);
    json += ',';
    appendJsonOptionalFloat(json, "aht20_humidity_pct", aht_found, aht_h, 2);
    json += ',';
    appendJsonOptionalFloat(json, "bmp280_temperature_c", bmp_found, bmp_t, 2);
    json += ',';
    appendJsonOptionalFloat(json, "bmp280_pressure_hpa", bmp_found, bmp_p, 2);
    json += ',';
    appendJsonOptionalFloat(json, "bmp280_altitude_m", bmp_found, bmp_alt, 2);
    json += ',';
    appendJsonOptionalInt(json, "mq2_adc", enable_mq2, mq2_adc);
    json += ',';
    appendJsonOptionalFloat(json, "mq2_voltage", enable_mq2, mq2_v, 3);
    json += ',';
    appendJsonOptionalInt(json, "mq4_adc", enable_mq4, mq4_adc);
    json += ',';
    appendJsonOptionalFloat(json, "mq4_voltage", enable_mq4, mq4_v, 3);
    json += ',';
    appendJsonOptionalInt(json, "mq6_adc", enable_mq6, mq6_adc);
    json += ',';
    appendJsonOptionalFloat(json, "mq6_voltage", enable_mq6, mq6_v, 3);
    json += ',';
    appendJsonOptionalInt(json, "mq135_adc", enable_mq135, mq135_adc);
    json += ',';
    appendJsonOptionalFloat(json, "mq135_voltage", enable_mq135, mq135_v, 3);
    json += ',';
    appendJsonOptionalInt(json, "sound_adc", enable_sound, sound_adc);
    json += ',';
    appendJsonOptionalFloat(json, "sound_voltage", enable_sound, sound_v, 3);
    json += ',';
    appendJsonOptionalInt(json, "sound_detected", enable_sound, sound_detected);
    json += ',';
    appendJsonOptionalInt(json, "uv_adc", enable_uv, uv_adc);
    json += ',';
    appendJsonOptionalFloat(json, "uv_voltage", enable_uv, uv_v, 3);
    json += ',';
    appendJsonOptionalFloat(json, "uv_index", enable_uv, uv_index, 2);
    json += '}';

    postReading(json);
  }

  delay(10);
}
