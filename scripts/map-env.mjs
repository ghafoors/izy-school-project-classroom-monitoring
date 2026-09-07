#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");

function parseEnv(source) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function escapeCString(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function required(values, key) {
  if (!(key in values)) {
    throw new Error(`Missing ${key} in .env`);
  }
  return values[key];
}

const values = parseEnv(readFileSync(envPath, "utf8"));
const wifiSsid = required(values, "WIFI_SSID");
const wifiPassword = required(values, "WIFI_PASSWORD");
const ingestUrl = required(values, "INGEST_URL");
const ingestToken = required(values, "INGEST_TOKEN");
const deviceId = required(values, "DEVICE_ID");
const deviceZone = required(values, "DEVICE_ZONE");

const secretsH = `#pragma once

#define WIFI_SSID "${escapeCString(wifiSsid)}"
#define WIFI_PASSWORD "${escapeCString(wifiPassword)}"
#define INGEST_URL "${escapeCString(ingestUrl)}"
#define INGEST_TOKEN "${escapeCString(ingestToken)}"
#define DEVICE_ID "${escapeCString(deviceId)}"
#define DEVICE_ZONE "${escapeCString(deviceZone)}"
`;

writeFileSync(join(root, "secrets.h"), secretsH);
writeFileSync(join(root, "worker", ".dev.vars"), `INGEST_TOKEN=${ingestToken}\n`);

console.log("Mapped .env -> secrets.h and worker/.dev.vars");
