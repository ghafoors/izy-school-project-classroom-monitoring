const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
} as const;

const MAX_BODY_BYTES = 8_192;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type NumericField = number | null;

type IngestPayload = {
  device_id?: unknown;
  zone?: unknown;
  recorded_at?: unknown;
  wifi_rssi?: unknown;
  aht20_temperature_c?: unknown;
  aht20_humidity_pct?: unknown;
  bmp280_temperature_c?: unknown;
  bmp280_pressure_hpa?: unknown;
  bmp280_altitude_m?: unknown;
  mq2_adc?: unknown;
  mq2_voltage?: unknown;
  mq4_adc?: unknown;
  mq4_voltage?: unknown;
  mq6_adc?: unknown;
  mq6_voltage?: unknown;
  mq135_adc?: unknown;
  mq135_voltage?: unknown;
  sound_adc?: unknown;
  sound_voltage?: unknown;
  sound_detected?: unknown;
  uv_adc?: unknown;
  uv_voltage?: unknown;
  uv_index?: unknown;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function verifyToken(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function bearerToken(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? "";
}

function optionalNumber(value: unknown): NumericField {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("invalid_number");
  }
  return value;
}

function optionalInt(value: unknown): NumericField {
  const n = optionalNumber(value);
  if (n === null) {
    return null;
  }
  if (!Number.isInteger(n)) {
    throw new Error("invalid_integer");
  }
  return n;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/readings") {
        return listReadings(url, env);
      }

      if (request.method === "POST" && url.pathname === "/readings") {
        return ingestReading(request, env);
      }

      return json({ error: "not_found" }, 404);
    } catch (error) {
      console.error("unhandled_error", error);
      return json({ error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function listReadings(url: URL, env: Env): Promise<Response> {
  const limitParam = url.searchParams.get("limit");
  const parsed = limitParam === null ? DEFAULT_LIMIT : Number(limitParam);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return json({ error: "invalid_limit" }, 400);
  }
  const limit = Math.min(parsed, MAX_LIMIT);
  const deviceId = url.searchParams.get("device_id");

  const result = deviceId
    ? await env.DB.prepare(
        `SELECT * FROM readings WHERE device_id = ? ORDER BY recorded_at DESC, id DESC LIMIT ?`,
      )
        .bind(deviceId, limit)
        .all()
    : await env.DB.prepare(
        `SELECT * FROM readings ORDER BY recorded_at DESC, id DESC LIMIT ?`,
      )
        .bind(limit)
        .all();

  return json({ readings: result.results });
}

async function ingestReading(request: Request, env: Env): Promise<Response> {
  if (!env.INGEST_TOKEN) {
    return json({ error: "ingest_not_configured" }, 503);
  }

  const authorized = await verifyToken(bearerToken(request), env.INGEST_TOKEN);
  if (!authorized) {
    return json({ error: "unauthorized" }, 401);
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }

  let payload: IngestPayload;
  try {
    payload = (await request.json()) as IngestPayload;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const deviceId = typeof payload.device_id === "string" ? payload.device_id.trim() : "";
  if (!deviceId || deviceId.length > 64) {
    return json({ error: "invalid_device_id" }, 400);
  }
  const zone = typeof payload.zone === "string" ? payload.zone.trim() : "classroom";
  if (!["courtyard", "classroom", "library"].includes(zone)) {
    return json({ error: "invalid_zone" }, 400);
  }

  const recordedAt =
    typeof payload.recorded_at === "string" && payload.recorded_at.length > 0
      ? payload.recorded_at
      : new Date().toISOString();
  if (recordedAt.length > 40) {
    return json({ error: "invalid_recorded_at" }, 400);
  }

  try {
    const inserted = await env.DB.prepare(
      `INSERT INTO readings (
        device_id, zone, recorded_at, wifi_rssi,
        aht20_temperature_c, aht20_humidity_pct,
        bmp280_temperature_c, bmp280_pressure_hpa, bmp280_altitude_m,
        mq2_adc, mq2_voltage, mq4_adc, mq4_voltage,
        mq6_adc, mq6_voltage, mq135_adc, mq135_voltage,
        sound_adc, sound_voltage, sound_detected,
        uv_adc, uv_voltage, uv_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id, recorded_at`,
    )
      .bind(
        deviceId,
        zone,
        recordedAt,
        optionalInt(payload.wifi_rssi),
        optionalNumber(payload.aht20_temperature_c),
        optionalNumber(payload.aht20_humidity_pct),
        optionalNumber(payload.bmp280_temperature_c),
        optionalNumber(payload.bmp280_pressure_hpa),
        optionalNumber(payload.bmp280_altitude_m),
        optionalInt(payload.mq2_adc),
        optionalNumber(payload.mq2_voltage),
        optionalInt(payload.mq4_adc),
        optionalNumber(payload.mq4_voltage),
        optionalInt(payload.mq6_adc),
        optionalNumber(payload.mq6_voltage),
        optionalInt(payload.mq135_adc),
        optionalNumber(payload.mq135_voltage),
        optionalInt(payload.sound_adc),
        optionalNumber(payload.sound_voltage),
        optionalInt(payload.sound_detected),
        optionalInt(payload.uv_adc),
        optionalNumber(payload.uv_voltage),
        optionalNumber(payload.uv_index),
      )
      .first<{ id: number; recorded_at: string }>();

    return json({ ok: true, id: inserted?.id, recorded_at: inserted?.recorded_at }, 201);
  } catch (error) {
    if (error instanceof Error && (error.message === "invalid_number" || error.message === "invalid_integer")) {
      return json({ error: error.message }, 400);
    }
    console.error("insert_failed", error);
    return json({ error: "insert_failed" }, 500);
  }
}
