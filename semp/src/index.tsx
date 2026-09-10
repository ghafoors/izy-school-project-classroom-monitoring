import { Hono } from 'hono'
import type { FC, Child } from 'hono/jsx'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

type ZoneId = 'courtyard' | 'classroom' | 'library'

type ZoneMeta = {
  id: ZoneId
  label: string
  short: string
  kind: 'outdoor' | 'indoor'
}

type MetricStatus = 'good' | 'watch' | 'alert'

type Telemetry = {
  zone: ZoneId
  uvIndex: number
  co2Ppm: number
  mq2Adc: number | null
  mq2Voltage: number | null
  mq2SignalPct: number | null
  temperatureC: number
  humidityPct: number
  pressureHpa: number | null
  noiseDb: number
  updatedAt: string
}

type HourlyCo2 = { hour: string; ppm: number }

type ZoneSnapshot = {
  zone: ZoneId
  label: string
  uvIndex: number
  co2Ppm: number
  temperatureC: number
  humidityPct: number
  noiseDb: number
  status: MetricStatus
  statusLabel: string
}

type Advisory = {
  level: MetricStatus
  title: string
  message: string
}

type MetricMeta = {
  label: string
  status: MetricStatus
  badge: string
  subtitle: string
}

type PressureInfo = {
  label: string
  severity: string
  color: string
  description: string
}

type MetricTrends = {
  uvIndex: number[]
  co2Ppm: number[]
  mq2Voltage: number[]
  temperatureC: number[]
  humidityPct: number[]
  noiseDb: number[]
}

type DataMode = 'actual' | 'local' | 'simulated'

type DashboardPayload = {
  zone: ZoneMeta
  telemetry: Telemetry
  mode: DataMode
  source: 'live' | 'live-partial' | 'local-usb' | 'simulated' | 'no-data'
  available?: {
    uv: boolean
    air: boolean
    mq2: boolean
    climate: boolean
    noise: boolean
    pressure?: boolean
    altitude?: boolean
  }
  trends: MetricTrends
  hourly: HourlyCo2[]
  snapshots: ZoneSnapshot[]
  advisory: Advisory
  metrics: {
    uv: MetricMeta
    co2: MetricMeta
    mq2: MetricMeta
    climate: MetricMeta
    noise: MetricMeta
  }
  updatedAtFormatted: string
}

type ReadingRow = {
  device_id: string
  zone: ZoneId
  recorded_at: string
  aht20_temperature_c: number | null
  aht20_humidity_pct: number | null
  bmp280_temperature_c: number | null
  bmp280_pressure_hpa: number | null
  mq2_adc: number | null
  mq2_voltage: number | null
  mq135_adc: number | null
  sound_adc: number | null
  uv_index: number | null
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const ZONES: ZoneMeta[] = [
  { id: 'courtyard', label: 'Courtyard (Outdoor)', short: 'Courtyard', kind: 'outdoor' },
  { id: 'classroom', label: 'Grade 4 Classroom', short: 'Classroom', kind: 'indoor' },
  { id: 'library', label: 'School Library', short: 'Library', kind: 'indoor' },
]

const ZONE_BASELINES: Record<
  ZoneId,
  {
    uvIndex: number
    co2Ppm: number
    temperatureC: number
    humidityPct: number
    noiseDb: number
  }
> = {
  courtyard: {
    uvIndex: 9.2,
    co2Ppm: 90,
    temperatureC: 31.5,
    humidityPct: 78,
    noiseDb: 42,
  },
  classroom: {
    uvIndex: 0.4,
    co2Ppm: 72,
    temperatureC: 27.8,
    humidityPct: 68,
    noiseDb: 55,
  },
  library: {
    uvIndex: 0.2,
    co2Ppm: 84,
    temperatureC: 26.4,
    humidityPct: 62,
    noiseDb: 24,
  },
}

const TREND_POINTS = 12
const POLL_MS = 3000
const LOCAL_POLL_MS = 3000

function pollMsForMode(mode: DataMode): number {
  return mode === 'local' ? LOCAL_POLL_MS : POLL_MS
}

const STATUS_STROKE: Record<MetricStatus, string> = {
  good: '#2dd4bf',
  watch: '#fbbf24',
  alert: '#fb7185',
}

/* -------------------------------------------------------------------------- */
/* Mock telemetry helpers                                                     */
/* -------------------------------------------------------------------------- */

function jitter(base: number, spread: number, decimals = 1): number {
  const value = base + (Math.random() * 2 - 1) * spread
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function generateMockTelemetry(zone: ZoneId): Telemetry {
  const base = ZONE_BASELINES[zone]
  const isOutdoor = zone === 'courtyard'

  return {
    zone,
    uvIndex: isOutdoor
      ? clamp(jitter(base.uvIndex, 1.4, 1), 0, 14)
      : clamp(jitter(base.uvIndex, 0.15, 1), 0, 2),
    co2Ppm: Math.round(clamp(jitter(base.co2Ppm, isOutdoor ? 4 : 8, 0), 0, 100)),
    mq2Adc: Math.round(clamp(jitter(1400, 120, 0), 0, 4095)),
    mq2Voltage: clamp(jitter(1.15, 0.08, 2), 0, 3.3),
    mq2SignalPct: Math.round(clamp(jitter(34, 4, 0), 0, 100)),
    temperatureC: clamp(jitter(base.temperatureC, 0.8, 1), 22, 36),
    humidityPct: Math.round(clamp(jitter(base.humidityPct, 4, 0), 40, 95)),
    pressureHpa: jitter(1012, 2, 1),
    noiseDb: Math.round(clamp(jitter(base.noiseDb, 8, 0), 0, 100)),
    updatedAt: new Date().toISOString(),
  }
}

function generateTrend(
  current: number,
  spread: number,
  decimals: number,
  min: number,
  max: number,
  points = TREND_POINTS,
): number[] {
  const series: number[] = []
  let cursor = current
  for (let i = points - 1; i >= 1; i--) {
    cursor = clamp(jitter(cursor, spread, decimals), min, max)
    series.unshift(cursor)
  }
  series.push(current)
  return series
}

function generateHourlyCo2(zone: ZoneId): HourlyCo2[] {
  const base = ZONE_BASELINES[zone].co2Ppm
  const changes = [8, 3, -4, -10, 0]
  const chartHours = ['8 AM', '9 AM', '10 AM', '11 AM', '1 PM']
  return chartHours.map((hour, i) => ({
    hour,
    ppm: Math.round(clamp(jitter(base + (changes[i] ?? 0), 4, 0), 0, 100)),
  }))
}

function uvLabel(uv: number): { label: string; status: MetricStatus } {
  if (uv >= 11) return { label: 'Extreme', status: 'alert' }
  if (uv >= 8) return { label: 'Very High', status: 'alert' }
  if (uv >= 6) return { label: 'High', status: 'watch' }
  if (uv >= 3) return { label: 'Moderate', status: 'watch' }
  return { label: 'Low', status: 'good' }
}

function co2Label(score: number): { label: string; status: MetricStatus } {
  if (score < 35) return { label: 'Poor', status: 'alert' }
  if (score < 60) return { label: 'Fair', status: 'watch' }
  if (score < 80) return { label: 'Good', status: 'good' }
  return { label: 'Excellent', status: 'good' }
}

function climateLabel(temp: number, humidity: number): { label: string; status: MetricStatus } {
  if (temp >= 32 || humidity >= 85) return { label: 'Hot / Humid', status: 'watch' }
  if (temp >= 29 && humidity >= 70) return { label: 'Tropical Warm', status: 'watch' }
  if (temp >= 24 && temp <= 29 && humidity >= 55 && humidity <= 75) {
    return { label: 'Tropical Comfort', status: 'good' }
  }
  return { label: 'Stable', status: 'good' }
}

function absolutePressureInfo(pressureHpa: number | null): PressureInfo | null {
  if (pressureHpa === null || !Number.isFinite(pressureHpa)) return null
  if (pressureHpa < 990) {
    return {
      label: 'Very Low',
      severity: 'Warning',
      color: '#FF3B30',
      description:
        'Major low-pressure system or severe storm nearby. Heavy rain and high winds may occur.',
    }
  }
  if (pressureHpa < 1009) {
    return {
      label: 'Low',
      severity: 'Caution',
      color: '#FFCC00',
      description: 'Unsettled weather, cloud cover, or rain is likely.',
    }
  }
  if (pressureHpa < 1021) {
    return {
      label: 'Normal',
      severity: 'Optimal',
      color: '#34C759',
      description: 'Stable or fair weather near the 1013.25 hPa sea-level baseline.',
    }
  }
  if (pressureHpa <= 1030) {
    return {
      label: 'High',
      severity: 'Info',
      color: '#007AFF',
      description: 'Fair weather, clear skies, dry air, and high atmospheric stability.',
    }
  }
  return {
    label: 'Very High',
    severity: 'Notice',
    color: '#AF52DE',
    description:
      'Strong anticyclone with unusually dry air or a possible temperature inversion.',
  }
}

function noiseLabel(activity: number): { label: string; status: MetricStatus } {
  if (activity >= 75) return { label: 'Very Loud', status: 'alert' }
  if (activity >= 50) return { label: 'Busy', status: 'watch' }
  if (activity >= 25) return { label: 'Moderate', status: 'good' }
  return { label: 'Quiet', status: 'good' }
}

function worstStatus(...statuses: MetricStatus[]): MetricStatus {
  if (statuses.includes('alert')) return 'alert'
  if (statuses.includes('watch')) return 'watch'
  return 'good'
}

function zoneOverallStatus(t: Telemetry): { status: MetricStatus; label: string } {
  const uv = uvLabel(t.uvIndex)
  const co2 = co2Label(t.co2Ppm)
  const climate = climateLabel(t.temperatureC, t.humidityPct)
  const noise = noiseLabel(t.noiseDb)
  const status = worstStatus(uv.status, co2.status, climate.status, noise.status)
  const label =
    status === 'alert' ? 'Action Needed' : status === 'watch' ? 'Monitor Closely' : 'Healthy'
  return { status, label }
}

function buildAdvisory(t: Telemetry, zone: ZoneMeta): Advisory {
  const uv = uvLabel(t.uvIndex)

  if (zone.kind === 'outdoor' && t.uvIndex > 7) {
    return {
      level: uv.status === 'alert' ? 'alert' : 'watch',
      title: 'High UV Radiation Warning',
      message:
        'Outdoor recess should be limited to shaded areas. Encourage hats, sunscreen, and shorter sun exposure windows between 10 AM and 2 PM.',
    }
  }

  if (t.co2Ppm < 35) {
    return {
      level: 'alert',
      title: 'Air Quality Signal Needs Attention',
      message: `The display score is ${t.co2Ppm}/100 in the ${zone.short}. Check ventilation and confirm the MQ-135 sensor is warmed up and calibrated.`,
    }
  }

  if (t.co2Ppm < 60) {
    return {
      level: 'watch',
      title: 'Air Quality Score Is Lower Than Usual',
      message: `The display score is ${t.co2Ppm}/100 in the ${zone.short}. Consider improving airflow and watching the trend.`,
    }
  }

  if (t.noiseDb >= 75) {
    return {
      level: 'alert',
      title: 'High Sound Activity',
      message: `Sound activity is ${t.noiseDb}%. Consider a quieter classroom activity or check for persistent background noise.`,
    }
  }

  if (t.temperatureC >= 32) {
    return {
      level: 'watch',
      title: 'Heat Advisory',
      message: `Temperature is ${t.temperatureC}°C with ${t.humidityPct}% humidity. Prioritize hydration and shaded outdoor movement.`,
    }
  }

  return {
    level: 'good',
    title: 'Conditions Look Healthy',
    message: `${zone.label} is within recommended comfort ranges for learning. Keep windows and shaded outdoor routines as planned.`,
  }
}

function generateAllZoneSnapshots(): ZoneSnapshot[] {
  return ZONES.map((z) => {
    const t = generateMockTelemetry(z.id)
    const overall = zoneOverallStatus(t)
    return {
      zone: z.id,
      label: z.label,
      uvIndex: t.uvIndex,
      co2Ppm: t.co2Ppm,
      temperatureC: t.temperatureC,
      humidityPct: t.humidityPct,
      noiseDb: t.noiseDb,
      status: overall.status,
      statusLabel: overall.label,
    }
  })
}

function parseZone(raw: string | undefined | null): ZoneId {
  if (raw === 'classroom' || raw === 'library' || raw === 'courtyard') return raw
  return 'courtyard'
}

function parseMode(raw: string | undefined | null): DataMode {
  if (raw === 'local') return 'local'
  return raw === 'simulated' ? 'simulated' : 'actual'
}

function formatTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-MV', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZone: 'Indian/Maldives',
    }).format(new Date(iso))
  } catch {
    return new Date(iso).toLocaleTimeString()
  }
}

// Display-only scores. D1 continues to retain the original 12-bit ADC readings.
function adcToAirQualityScore(adc: number): number {
  return Math.round(clamp(100 - (adc / 4095) * 100, 0, 100))
}

function adcToSoundActivity(adc: number): number {
  // Firmware stores peak-to-peak amplitude over a 250 ms sample window.
  // 600 ADC counts is treated as full-scale classroom activity for display.
  return Math.round(clamp((adc / 600) * 100, 0, 100))
}

function mq2SignalPercent(adc: number): number {
  return Math.round(clamp((adc / 4095) * 100, 0, 100))
}

function mq2SignalMeta(adc: number | null, voltage: number | null): MetricMeta {
  if (adc === null || voltage === null) {
    return {
      label: 'Unavailable',
      status: 'good',
      badge: 'N/A',
      subtitle: 'MQ-2 sensor not enabled',
    }
  }
  const percent = mq2SignalPercent(adc)
  const label =
    percent >= 98
      ? 'Saturated'
      : percent >= 70
        ? 'High signal'
        : percent >= 40
          ? 'Moderate signal'
          : 'Low signal'
  const elevated = percent >= 70
  return {
    label,
    status: elevated ? 'watch' : 'good',
    badge: label,
    subtitle: `${voltage.toFixed(2)} V · uncalibrated signal`,
  }
}

function readingToTelemetry(row: ReadingRow, zoneId: ZoneId): Telemetry {
  const fallback = ZONE_BASELINES[zoneId]
  return {
    zone: zoneId,
    uvIndex: row.uv_index ?? fallback.uvIndex,
    co2Ppm:
      row.mq135_adc === null ? fallback.co2Ppm : adcToAirQualityScore(row.mq135_adc),
    mq2Adc: row.mq2_adc,
    mq2Voltage: row.mq2_voltage,
    mq2SignalPct: row.mq2_adc === null ? null : mq2SignalPercent(row.mq2_adc),
    temperatureC:
      row.aht20_temperature_c ?? row.bmp280_temperature_c ?? fallback.temperatureC,
    humidityPct: row.aht20_humidity_pct ?? fallback.humidityPct,
    pressureHpa: row.bmp280_pressure_hpa,
    noiseDb: row.sound_adc === null ? fallback.noiseDb : adcToSoundActivity(row.sound_adc),
    updatedAt: row.recorded_at,
  }
}

function hasCompleteReading(row: ReadingRow): boolean {
  return (
    row.uv_index !== null &&
    row.mq135_adc !== null &&
    (row.aht20_temperature_c !== null || row.bmp280_temperature_c !== null) &&
    row.aht20_humidity_pct !== null &&
    row.sound_adc !== null
  )
}

function readingSeries(
  rows: ReadingRow[],
  select: (row: ReadingRow) => number | null,
  fallback: number[],
): number[] {
  const values = rows
    .slice()
    .reverse()
    .map(select)
    .filter((value): value is number => value !== null)
  return values.length >= 2 ? values : fallback
}

async function getZoneReadings(db: D1Database, zoneId: ZoneId): Promise<ReadingRow[]> {
  const result = await db
    .prepare(
      `SELECT device_id, zone, recorded_at,
        aht20_temperature_c, aht20_humidity_pct, bmp280_temperature_c,
        bmp280_pressure_hpa,
        mq2_adc, mq2_voltage, mq135_adc, sound_adc, uv_index
       FROM readings
       WHERE zone = ?
       ORDER BY recorded_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(zoneId, TREND_POINTS)
    .all<ReadingRow>()
  return result.results
}

async function buildDashboardPayload(
  zoneId: ZoneId,
  mode: DataMode,
  db: D1Database,
): Promise<DashboardPayload> {
  const zone = ZONES.find((z) => z.id === zoneId) ?? ZONES[0]
  const zoneRows = mode === 'actual' ? await getZoneReadings(db, zone.id) : []
  const latest = zoneRows[0]
  const telemetry =
    mode === 'simulated'
      ? generateMockTelemetry(zone.id)
      : latest
        ? readingToTelemetry(latest, zone.id)
        : {
            zone: zone.id,
            uvIndex: 0,
            co2Ppm: 0,
            mq2Adc: null,
            mq2Voltage: null,
            mq2SignalPct: null,
            temperatureC: 0,
            humidityPct: 0,
            pressureHpa: null,
            noiseDb: 0,
            updatedAt: new Date().toISOString(),
          }
  const source =
    mode === 'simulated'
      ? 'simulated'
      : latest
        ? hasCompleteReading(latest)
          ? 'live'
          : 'live-partial'
        : 'no-data'
  const isOutdoor = zone.kind === 'outdoor'
  const fallbackTrends: MetricTrends = source === 'no-data' ? {
    uvIndex: [],
    co2Ppm: [],
    mq2Voltage: [],
    temperatureC: [],
    humidityPct: [],
    noiseDb: [],
  } : {
    uvIndex: generateTrend(telemetry.uvIndex, isOutdoor ? 0.45 : 0.05, 1, 0, isOutdoor ? 14 : 2),
    co2Ppm: generateTrend(telemetry.co2Ppm, isOutdoor ? 3 : 6, 0, 0, 100),
    mq2Voltage:
      telemetry.mq2Voltage === null
        ? []
        : generateTrend(telemetry.mq2Voltage, 0.08, 2, 0, 3.3),
    temperatureC: generateTrend(telemetry.temperatureC, 0.35, 1, 22, 36),
    humidityPct: generateTrend(telemetry.humidityPct, 2, 0, 40, 95),
    noiseDb: generateTrend(telemetry.noiseDb, 5, 0, 0, 100),
  }
  const trends: MetricTrends = {
    uvIndex: readingSeries(zoneRows, (row) => row.uv_index, fallbackTrends.uvIndex),
    co2Ppm: readingSeries(
      zoneRows,
      (row) => (row.mq135_adc === null ? null : adcToAirQualityScore(row.mq135_adc)),
      fallbackTrends.co2Ppm,
    ),
    mq2Voltage: readingSeries(
      zoneRows,
      (row) => row.mq2_voltage,
      fallbackTrends.mq2Voltage,
    ),
    temperatureC: readingSeries(
      zoneRows,
      (row) => row.aht20_temperature_c ?? row.bmp280_temperature_c,
      fallbackTrends.temperatureC,
    ),
    humidityPct: readingSeries(
      zoneRows,
      (row) => row.aht20_humidity_pct,
      fallbackTrends.humidityPct,
    ),
    noiseDb: readingSeries(
      zoneRows,
      (row) => (row.sound_adc === null ? null : adcToSoundActivity(row.sound_adc)),
      fallbackTrends.noiseDb,
    ),
  }

  const airReadings = zoneRows
    .filter((row) => row.mq135_adc !== null)
    .slice(0, 5)
    .reverse()
  const hourly =
    mode === 'simulated'
      ? generateHourlyCo2(zone.id)
      : airReadings.map((row) => ({
          hour: formatTime(row.recorded_at).replace(/:\d{2}\s/, ' '),
          ppm: row.mq135_adc === null ? 0 : adcToAirQualityScore(row.mq135_adc),
        }))
  const snapshots =
    mode === 'simulated'
      ? generateAllZoneSnapshots()
      : mode === 'local'
        ? [
            {
              zone: zone.id,
              label: zone.label,
              uvIndex: 0,
              co2Ppm: 0,
              temperatureC: 0,
              humidityPct: 0,
              noiseDb: 0,
              status: 'good' as const,
              statusLabel: 'Waiting for USB',
            },
          ]
        : ZONES.map((snapshotZone) => ({
          zone: snapshotZone.id,
          label: snapshotZone.label,
          uvIndex: 0,
          co2Ppm: 0,
          temperatureC: 0,
          humidityPct: 0,
          noiseDb: 0,
          status: 'good' as const,
          statusLabel: 'No data',
        }))
  const otherZoneRows =
    mode === 'actual'
      ? await Promise.all(
          ZONES.map(async (snapshotZone) => (await getZoneReadings(db, snapshotZone.id))[0]),
        )
      : []
  otherZoneRows.forEach((row, index) => {
    if (!row) return
    const snapshotTelemetry = readingToTelemetry(row, ZONES[index].id)
    const overall = zoneOverallStatus(snapshotTelemetry)
    snapshots[index] = {
      zone: ZONES[index].id,
      label: ZONES[index].label,
      uvIndex: snapshotTelemetry.uvIndex,
      co2Ppm: snapshotTelemetry.co2Ppm,
      temperatureC: snapshotTelemetry.temperatureC,
      humidityPct: snapshotTelemetry.humidityPct,
      noiseDb: snapshotTelemetry.noiseDb,
      status: overall.status,
      statusLabel: overall.label,
    }
  })
  const activeIdx = snapshots.findIndex((s) => s.zone === zone.id)
  if (activeIdx >= 0 && (latest || mode === 'simulated')) {
    const overall = zoneOverallStatus(telemetry)
    snapshots[activeIdx] = {
      ...snapshots[activeIdx],
      uvIndex: telemetry.uvIndex,
      co2Ppm: telemetry.co2Ppm,
      temperatureC: telemetry.temperatureC,
      humidityPct: telemetry.humidityPct,
      noiseDb: telemetry.noiseDb,
      status: overall.status,
      statusLabel: overall.label,
    }
  }

  const uv = uvLabel(telemetry.uvIndex)
  const co2 = co2Label(telemetry.co2Ppm)
  const mq2 = mq2SignalMeta(telemetry.mq2Adc, telemetry.mq2Voltage)
  const climate = climateLabel(telemetry.temperatureC, telemetry.humidityPct)
  const noise = noiseLabel(telemetry.noiseDb)
  const advisory =
    source === 'no-data'
      ? {
          level: 'good' as const,
          title: mode === 'local' ? 'Waiting for USB sensor data' : 'Waiting for actual sensor data',
          message:
            mode === 'local'
              ? `Only the connected USB node (${zone.label}) is shown in Local USB mode.`
              : `No D1 readings exist for ${zone.label} yet. Switch to Simulated to preview the dashboard.`,
        }
      : buildAdvisory(telemetry, zone)

  return {
    zone,
    telemetry,
    mode,
    source,
    trends,
    hourly,
    snapshots,
    advisory,
    metrics: {
      uv: {
        label: uv.label,
        status: uv.status,
        badge: uv.status === 'alert' ? 'Alert' : uv.status === 'watch' ? 'Watch' : 'OK',
        subtitle: `${uv.label} · ${isOutdoor ? 'Direct sun exposure' : 'Indoor residual'}`,
      },
      co2: {
        label: co2.label,
        status: co2.status,
        badge: co2.label,
        subtitle: `${co2.label} air quality · display score`,
      },
      mq2,
      climate: {
        label: climate.label,
        status: climate.status,
        badge: climate.status === 'good' ? 'Comfort' : 'Warm',
        subtitle: climate.label,
      },
      noise: {
        label: noise.label,
        status: noise.status,
        badge: noise.label,
        subtitle: `${noise.label} sound activity · display level`,
      },
    },
    updatedAtFormatted: formatTime(telemetry.updatedAt),
  }
}

/* -------------------------------------------------------------------------- */
/* Style / sparkline helpers                                                  */
/* -------------------------------------------------------------------------- */

function statusTone(status: MetricStatus): {
  pill: string
  badge: string
  banner: string
  ring: string
  text: string
} {
  switch (status) {
    case 'alert':
      return {
        pill: 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-400/40',
        badge: 'bg-rose-500 text-white',
        banner: 'from-rose-950/90 via-rose-900/70 to-amber-950/40 border-rose-500/40',
        ring: 'ring-rose-400/30',
        text: 'text-rose-300',
      }
    case 'watch':
      return {
        pill: 'bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/40',
        badge: 'bg-amber-400 text-slate-950',
        banner: 'from-amber-950/90 via-amber-900/60 to-orange-950/30 border-amber-400/35',
        ring: 'ring-amber-400/30',
        text: 'text-amber-300',
      }
    default:
      return {
        pill: 'bg-teal-500/15 text-teal-200 ring-1 ring-teal-400/35',
        badge: 'bg-teal-400 text-slate-950',
        banner: 'from-teal-950/80 via-cyan-950/50 to-slate-900/40 border-teal-400/30',
        ring: 'ring-teal-400/25',
        text: 'text-teal-300',
      }
  }
}

function sparklineGeometry(values: number[], w = 160, h = 42) {
  if (values.length < 2) {
    return { line: '', area: '', lastX: w, lastY: h / 2 }
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w
    const y = h - ((v - min) / range) * (h - 8) - 4
    return { x, y }
  })
  const line = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ')
  const last = pts[pts.length - 1]
  const area = `${line} L${last.x.toFixed(2)} ${h} L0 ${h} Z`
  return { line, area, lastX: last.x, lastY: last.y }
}

/* -------------------------------------------------------------------------- */
/* Icons                                                                      */
/* -------------------------------------------------------------------------- */

const IconSun: FC = () => (
  <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.6">
    <circle cx="12" cy="12" r="4" />
    <path
      stroke-linecap="round"
      d="M12 2v2.5M12 19.5V22M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77"
    />
  </svg>
)

const IconAir: FC = () => (
  <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.6">
    <path stroke-linecap="round" d="M4 8h11a3 3 0 1 0-3-3" />
    <path stroke-linecap="round" d="M4 12h14a3 3 0 1 1-3 3" />
    <path stroke-linecap="round" d="M4 16h8a2.5 2.5 0 1 1-2.5 2.5" />
  </svg>
)

const IconThermo: FC = () => (
  <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.6">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      d="M14 14.76V5a2 2 0 1 0-4 0v9.76a4 4 0 1 0 4 0Z"
    />
    <path stroke-linecap="round" d="M12 16.5v1.5" />
  </svg>
)

const IconNoise: FC = () => (
  <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.6">
    <path stroke-linecap="round" stroke-linejoin="round" d="M11 5 6.5 9H3v6h3.5L11 19V5Z" />
    <path stroke-linecap="round" d="M15.5 8.5a4.5 4.5 0 0 1 0 7" />
    <path stroke-linecap="round" d="M18.2 6a8 8 0 0 1 0 12" />
  </svg>
)

/* -------------------------------------------------------------------------- */
/* UI components                                                              */
/* -------------------------------------------------------------------------- */

const Sparkline: FC<{
  id: string
  values: number[]
  status: MetricStatus
  label: string
}> = ({ id, values, status, label }) => {
  const stroke = STATUS_STROKE[status]
  const { line, area, lastX, lastY } = sparklineGeometry(values)
  return (
    <div class="mt-auto border-t border-white/5 pt-2">
      <div class="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.12em] text-slate-500">
        <span>Trend · {values.length} pts</span>
        <span class="normal-case tracking-normal text-slate-400">{label}</span>
      </div>
      <svg
        data-sparkline={id}
        viewBox="0 0 160 42"
        class="h-9 w-full overflow-visible"
        role="img"
        aria-label={`${label} trend`}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={`fill-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color={stroke} stop-opacity="0.35" />
            <stop offset="100%" stop-color={stroke} stop-opacity="0.02" />
          </linearGradient>
        </defs>
        <path data-spark-area="1" d={area} fill={`url(#fill-${id})`} />
        <path
          data-spark-line="1"
          d={line}
          fill="none"
          stroke={stroke}
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          vector-effect="non-scaling-stroke"
        />
        <circle data-spark-dot="1" cx={lastX} cy={lastY} r="2.6" fill={stroke} />
      </svg>
    </div>
  )
}

const MetricCard: FC<{
  id: string
  title: string
  value: string
  unit?: string
  subtitle: string
  badge: string
  status: MetricStatus
  icon: Child
  trend: number[]
  trendLabel: string
  detail?: Child
}> = ({ id, title, value, unit, subtitle, badge, status, icon, trend, trendLabel, detail }) => {
  const tone = statusTone(status)
  return (
    <article
      data-metric-card={id}
      data-status={status}
      class={`metric-card flex h-full min-h-0 flex-col rounded-xl bg-slate-900/70 p-3 ring-1 ring-white/10 backdrop-blur-sm ${tone.ring} shadow-[0_0_0_1px_rgba(255,255,255,0.03)] transition-shadow duration-500`}
    >
      <div class="flex items-start justify-between gap-2">
        <div class={`rounded-lg bg-white/5 p-1.5 ${tone.text}`} data-metric-icon>
          {icon}
        </div>
        <span
          data-metric-badge
          class={`rounded-md px-2 py-0.5 text-[10px] font-semibold tracking-wide ${tone.badge}`}
        >
          {badge}
        </span>
      </div>
      <p class="mt-2 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">{title}</p>
      <p class="mt-1 flex items-baseline gap-1">
        <span
          data-metric-value
          class="text-3xl font-semibold tracking-tight text-white tabular-nums transition-colors duration-300 xl:text-4xl"
        >
          {value}
        </span>
        {unit ? (
          <span data-metric-unit class="text-sm text-slate-400">
            {unit}
          </span>
        ) : (
          <span data-metric-unit class="text-sm text-slate-400" />
        )}
      </p>
      <p data-metric-subtitle class={`mt-0.5 truncate text-xs font-medium ${tone.text}`}>
        {subtitle}
      </p>
      {detail}
      <Sparkline id={id} values={trend} status={status} label={trendLabel} />
    </article>
  )
}

const PressureSummary: FC<{ pressureHpa: number | null }> = ({ pressureHpa }) => {
  const info = absolutePressureInfo(pressureHpa)
  return (
    <div
      data-pressure-summary
      class="mt-1.5 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5"
      hidden={info === null}
    >
      <div class="flex items-center justify-between gap-2">
        <p class="text-lg font-semibold leading-none text-white tabular-nums">
          <span data-pressure-value>
            {pressureHpa === null ? '—' : pressureHpa.toFixed(1)}
          </span>{' '}
          <span class="text-[10px] font-medium text-slate-400">hPa</span>
        </p>
        <span
          data-pressure-label
          class="rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
          style={
            info
              ? `color:${info.color};border-color:${info.color}66;background:${info.color}18`
              : ''
          }
        >
          {info?.label ?? ''}
        </span>
      </div>
      <p data-pressure-description class="mt-1 line-clamp-2 text-[10px] leading-tight text-slate-400">
        {info ? `${info.severity} · ${info.description}` : ''}
      </p>
    </div>
  )
}

const Co2Chart: FC<{ series: HourlyCo2[] }> = ({ series }) => {
  const max = Math.max(...series.map((s) => s.ppm), 1)
  const chartH = 120
  const chartW = 420
  const padX = 28
  const padY = 14
  const barGap = 18
  const usableW = chartW - padX * 2
  const barW = (usableW - barGap * (series.length - 1)) / series.length

  return (
    <div class="flex min-h-0 w-full flex-1 flex-col" data-co2-chart>
      <svg
        viewBox={`0 0 ${chartW} ${chartH + 28}`}
        class="min-h-0 w-full flex-1"
        role="img"
        aria-label="Air quality score trend"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="co2Grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#2dd4bf" stop-opacity="0.95" />
            <stop offset="100%" stop-color="#0f766e" stop-opacity="0.55" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((f) => {
          const y = padY + (1 - f) * (chartH - padY)
          return (
            <line
              x1={padX}
              x2={chartW - padX}
              y1={y}
              y2={y}
              stroke="rgba(148,163,184,0.18)"
              stroke-dasharray="4 6"
            />
          )
        })}
        <g data-co2-bars>
          {series.map((point, i) => {
            const h = ((point.ppm / max) * (chartH - padY)) | 0
            const x = padX + i * (barW + barGap)
            const y = chartH - h
            const alert = point.ppm < 60
            return (
              <g data-co2-bar={i}>
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={h}
                  rx="6"
                  fill="url(#co2Grad)"
                  opacity={alert ? '1' : '0.85'}
                />
                <text
                  x={x + barW / 2}
                  y={y - 6}
                  text-anchor="middle"
                  fill={alert ? '#fcd34d' : '#99f6e4'}
                  font-size="11"
                  font-weight="600"
                >
                  {point.ppm}
                </text>
                <text
                  x={x + barW / 2}
                  y={chartH + 18}
                  text-anchor="middle"
                  fill="#94a3b8"
                  font-size="11"
                >
                  {point.hour}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}

const ZoneTable: FC<{ rows: ZoneSnapshot[]; active: ZoneId }> = ({ rows, active }) => (
  <div class="min-h-0 flex-1 overflow-auto">
    <table class="w-full min-w-[480px] text-left text-sm">
      <thead>
        <tr class="border-b border-white/10 text-[10px] uppercase tracking-[0.12em] text-slate-400">
          <th class="pb-2 pr-2 font-medium">Location</th>
          <th class="pb-2 pr-2 font-medium">UV</th>
          <th class="pb-2 pr-2 font-medium">Air Quality</th>
          <th class="pb-2 pr-2 font-medium">Temp / RH</th>
          <th class="pb-2 pr-2 font-medium">Noise</th>
          <th class="pb-2 font-medium">Status</th>
        </tr>
      </thead>
      <tbody data-zone-tbody>
        {rows.map((row) => {
          const tone = statusTone(row.status)
          const isActive = row.zone === active
          return (
            <tr
              data-zone-row={row.zone}
              class={`border-b border-white/5 ${isActive ? 'bg-teal-500/5' : 'hover:bg-white/[0.02]'}`}
            >
              <td class="py-2 pr-2 font-medium text-slate-100">
                <span class="inline-flex items-center gap-2">
                  <span
                    data-zone-dot
                    class={`inline-block h-1.5 w-1.5 rounded-full ${isActive ? 'bg-teal-400' : 'bg-slate-600'}`}
                  />
                  {row.label}
                </span>
              </td>
              <td data-zone-uv class="py-2 pr-2 tabular-nums text-slate-300">
                {row.uvIndex.toFixed(1)}
              </td>
              <td data-zone-co2 class="py-2 pr-2 tabular-nums text-slate-300">
                {row.co2Ppm}/100
              </td>
              <td data-zone-climate class="py-2 pr-2 tabular-nums text-slate-300">
                {row.temperatureC.toFixed(1)}°C / {row.humidityPct}%
              </td>
              <td data-zone-noise class="py-2 pr-2 tabular-nums text-slate-300">
                {row.noiseDb}%
              </td>
              <td class="py-2">
                <span
                  data-zone-status
                  class={`inline-flex rounded-md px-2 py-0.5 text-[10px] font-semibold ${tone.pill}`}
                >
                  {row.statusLabel}
                </span>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  </div>
)

const clientScript = `
(function () {
  var POLL_MS = ${POLL_MS};
  var LOCAL_POLL_MS = ${LOCAL_POLL_MS};
  var TREND_POINTS = ${TREND_POINTS};
  var STATUS_STROKE = { good: '#2dd4bf', watch: '#fbbf24', alert: '#fb7185' };
  var BADGE = {
    good: 'bg-teal-400 text-slate-950',
    watch: 'bg-amber-400 text-slate-950',
    alert: 'bg-rose-500 text-white'
  };
  var TEXT = { good: 'text-teal-300', watch: 'text-amber-300', alert: 'text-rose-300' };
  var RING = {
    good: 'ring-teal-400/25',
    watch: 'ring-amber-400/30',
    alert: 'ring-rose-400/30'
  };
  var PILL = {
    good: 'bg-teal-500/15 text-teal-200 ring-1 ring-teal-400/35',
    watch: 'bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/40',
    alert: 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-400/40'
  };
  var BANNER = {
    good: 'from-teal-950/80 via-cyan-950/50 to-slate-900/40 border-teal-400/30',
    watch: 'from-amber-950/90 via-amber-900/60 to-orange-950/30 border-amber-400/35',
    alert: 'from-rose-950/90 via-rose-900/70 to-amber-950/40 border-rose-500/40'
  };
  var BASE_CARD = 'metric-card flex h-full min-h-0 flex-col rounded-xl bg-slate-900/70 p-3 ring-1 ring-white/10 backdrop-blur-sm shadow-[0_0_0_1px_rgba(255,255,255,0.03)] transition-shadow duration-500';
  var BASE_BANNER = 'shrink-0 rounded-xl border bg-gradient-to-r px-3 py-2';
  var histories = null;
  var currentZone = document.body.getAttribute('data-zone') || 'courtyard';
  var currentMode = document.body.getAttribute('data-mode') || 'actual';
  var pollTimer = null;
  var scheduledMs = 0;
  var fetching = false;

  function sparkGeom(values, w, h) {
    w = w || 160; h = h || 42;
    if (!values || values.length < 2) return { line: '', area: '', lastX: w, lastY: h / 2 };
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var range = max - min || 1;
    var pts = values.map(function (v, i) {
      return {
        x: (i / (values.length - 1)) * w,
        y: h - ((v - min) / range) * (h - 8) - 4
      };
    });
    var line = pts.map(function (p, i) {
      return (i === 0 ? 'M' : 'L') + p.x.toFixed(2) + ' ' + p.y.toFixed(2);
    }).join(' ');
    var last = pts[pts.length - 1];
    return {
      line: line,
      area: line + ' L' + last.x.toFixed(2) + ' ' + h + ' L0 ' + h + ' Z',
      lastX: last.x,
      lastY: last.y
    };
  }

  function pulse(el) {
    if (!el) return;
    el.classList.remove('value-flash');
    void el.offsetWidth;
    el.classList.add('value-flash');
  }

  function pressureInfo(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (value < 990) return {
      label: 'Very Low', severity: 'Warning', color: '#FF3B30',
      description: 'Major low-pressure system or severe storm nearby. Heavy rain and high winds may occur.'
    };
    if (value < 1009) return {
      label: 'Low', severity: 'Caution', color: '#FFCC00',
      description: 'Unsettled weather, cloud cover, or rain is likely.'
    };
    if (value < 1021) return {
      label: 'Normal', severity: 'Optimal', color: '#34C759',
      description: 'Stable or fair weather near the 1013.25 hPa sea-level baseline.'
    };
    if (value <= 1030) return {
      label: 'High', severity: 'Info', color: '#007AFF',
      description: 'Fair weather, clear skies, dry air, and high atmospheric stability.'
    };
    return {
      label: 'Very High', severity: 'Notice', color: '#AF52DE',
      description: 'Strong anticyclone with unusually dry air or a possible temperature inversion.'
    };
  }

  function updatePressure(value) {
    var summary = document.querySelector('[data-pressure-summary]');
    if (!summary) return;
    var info = pressureInfo(value);
    summary.hidden = !info;
    if (!info) return;
    var valueEl = summary.querySelector('[data-pressure-value]');
    var labelEl = summary.querySelector('[data-pressure-label]');
    var descriptionEl = summary.querySelector('[data-pressure-description]');
    if (valueEl) valueEl.textContent = value.toFixed(1);
    if (labelEl) {
      labelEl.textContent = info.label;
      labelEl.style.color = info.color;
      labelEl.style.borderColor = info.color + '66';
      labelEl.style.backgroundColor = info.color + '18';
    }
    if (descriptionEl) descriptionEl.textContent = info.severity + ' · ' + info.description;
  }

  function setSpark(id, values, status) {
    var svg = document.querySelector('[data-sparkline="' + id + '"]');
    if (!svg) return;
    var g = sparkGeom(values);
    var stroke = STATUS_STROKE[status] || STATUS_STROKE.good;
    var area = svg.querySelector('[data-spark-area]');
    var line = svg.querySelector('[data-spark-line]');
    var dot = svg.querySelector('[data-spark-dot]');
    var grad = svg.querySelector('linearGradient');
    if (area) area.setAttribute('d', g.area);
    if (line) {
      line.setAttribute('d', g.line);
      line.setAttribute('stroke', stroke);
    }
    if (dot) {
      dot.setAttribute('cx', g.lastX);
      dot.setAttribute('cy', g.lastY);
      dot.setAttribute('fill', stroke);
    }
    if (grad) {
      var stops = grad.querySelectorAll('stop');
      if (stops[0]) stops[0].setAttribute('stop-color', stroke);
      if (stops[1]) stops[1].setAttribute('stop-color', stroke);
    }
  }

  function pushHistory(key, value) {
    if (!histories[key]) histories[key] = [];
    histories[key].push(value);
    if (histories[key].length > TREND_POINTS) histories[key].shift();
  }

  function seedHistories(trends) {
    histories = {
      uvIndex: trends.uvIndex.slice(),
      co2Ppm: trends.co2Ppm.slice(),
      mq2Voltage: (trends.mq2Voltage || []).slice(),
      temperatureC: trends.temperatureC.slice(),
      humidityPct: trends.humidityPct.slice(),
      noiseDb: trends.noiseDb.slice()
    };
  }

  function updateMetricCard(id, valueText, unitText, meta, historyKey, historyValue, appendHistory) {
    var card = document.querySelector('[data-metric-card="' + id + '"]');
    if (!card) return;
    var status = meta.status;
    card.setAttribute('data-status', status);
    card.className = BASE_CARD + ' ' + (RING[status] || RING.good);
    var badge = card.querySelector('[data-metric-badge]');
    var value = card.querySelector('[data-metric-value]');
    var unit = card.querySelector('[data-metric-unit]');
    var subtitle = card.querySelector('[data-metric-subtitle]');
    var icon = card.querySelector('[data-metric-icon]');
    if (badge) {
      badge.className = 'rounded-md px-2 py-0.5 text-[10px] font-semibold tracking-wide ' + (BADGE[status] || BADGE.good);
      badge.textContent = meta.badge;
    }
    if (value) {
      if (value.textContent !== valueText) pulse(value);
      value.textContent = valueText;
    }
    if (unit) unit.textContent = unitText || '';
    if (subtitle) {
      subtitle.className = 'mt-0.5 truncate text-xs font-medium ' + (TEXT[status] || TEXT.good);
      subtitle.textContent = meta.subtitle;
    }
    if (icon) icon.className = 'rounded-lg bg-white/5 p-1.5 ' + (TEXT[status] || TEXT.good);
    if (appendHistory) pushHistory(historyKey, historyValue);
    setSpark(id, histories[historyKey], status);
  }

  function updateCo2Chart(series) {
    var max = Math.max.apply(null, series.map(function (s) { return s.ppm; }).concat([1]));
    var chartH = 120, padX = 28, padY = 14, barGap = 18, chartW = 420;
    var usableW = chartW - padX * 2;
    var barW = (usableW - barGap * (series.length - 1)) / series.length;
    series.forEach(function (point, i) {
      var g = document.querySelector('[data-co2-bar="' + i + '"]');
      if (!g) return;
      var h = (point.ppm / max) * (chartH - padY) | 0;
      var x = padX + i * (barW + barGap);
      var y = chartH - h;
      var alert = point.ppm < 60;
      var rect = g.querySelector('rect');
      var texts = g.querySelectorAll('text');
      if (rect) {
        rect.setAttribute('x', x);
        rect.setAttribute('y', y);
        rect.setAttribute('width', barW);
        rect.setAttribute('height', Math.max(h, 2));
        rect.setAttribute('opacity', alert ? '1' : '0.85');
      }
      if (texts[0]) {
        texts[0].setAttribute('x', x + barW / 2);
        texts[0].setAttribute('y', y - 6);
        texts[0].setAttribute('fill', alert ? '#fcd34d' : '#99f6e4');
        texts[0].textContent = String(point.ppm);
      }
      if (texts[1]) {
        texts[1].setAttribute('x', x + barW / 2);
        texts[1].setAttribute('y', chartH + 18);
        texts[1].textContent = point.hour;
      }
    });
  }

  function updateZoneTable(rows, active) {
    var tbody = document.querySelector('[data-zone-tbody]');
    if (!tbody) return;
    tbody.innerHTML = (rows || []).map(function (row) {
      var isActive = row.zone === active;
      var pill = PILL[row.status] || PILL.good;
      return '<tr data-zone-row="' + escapeHtml(row.zone) + '" class="border-b border-white/5 ' + (isActive ? 'bg-teal-500/5' : 'hover:bg-white/[0.02]') + '">' +
        '<td class="py-2 pr-2 font-medium text-slate-100"><span class="inline-flex items-center gap-2"><span data-zone-dot class="inline-block h-1.5 w-1.5 rounded-full ' + (isActive ? 'bg-teal-400' : 'bg-slate-600') + '"></span>' + escapeHtml(row.label) + '</span></td>' +
        '<td data-zone-uv class="py-2 pr-2 tabular-nums text-slate-300">' + row.uvIndex.toFixed(1) + '</td>' +
        '<td data-zone-co2 class="py-2 pr-2 tabular-nums text-slate-300">' + row.co2Ppm + '/100</td>' +
        '<td data-zone-climate class="py-2 pr-2 tabular-nums text-slate-300">' + row.temperatureC.toFixed(1) + '°C / ' + row.humidityPct + '%</td>' +
        '<td data-zone-noise class="py-2 pr-2 tabular-nums text-slate-300">' + row.noiseDb + '%</td>' +
        '<td class="py-2"><span data-zone-status class="inline-flex rounded-md px-2 py-0.5 text-[10px] font-semibold ' + pill + '">' + escapeHtml(row.statusLabel) + '</span></td>' +
        '</tr>';
    }).join('');
  }

  function updateAdvisory(advisory, zoneLabel) {
    var banner = document.querySelector('[data-advisory]');
    if (!banner) return;
    var level = advisory.level;
    banner.className = BASE_BANNER + ' ' + (BANNER[level] || BANNER.good);
    var icon = level === 'alert' ? '⚠️' : level === 'watch' ? '⚡' : '✓';
    var iconEl = banner.querySelector('[data-advisory-icon]');
    var titleEl = banner.querySelector('[data-advisory-title]');
    var msgEl = banner.querySelector('[data-advisory-message]');
    var zoneEl = banner.querySelector('[data-advisory-zone]');
    if (iconEl) iconEl.textContent = icon;
    if (zoneEl) zoneEl.textContent = 'Health Advisory · ' + zoneLabel;
    var title = icon + ' ' + advisory.title;
    if (level !== 'good' && advisory.title.indexOf('UV') !== -1) {
      title += ': Outdoor recess should be limited to shaded areas.';
    }
    if (titleEl) {
      titleEl.className = 'mt-0.5 truncate font-display text-sm font-semibold text-white lg:text-base';
      titleEl.textContent = title;
    }
    if (msgEl) msgEl.textContent = advisory.message;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setZoneTabs(rows, active) {
    var nav = document.querySelector('[data-zone-nav]');
    if (!nav) return;
    nav.hidden = !rows || rows.length < 2;
    nav.innerHTML = (rows || []).map(function (row) {
      var on = row.zone === active;
      var cls = on
        ? 'rounded-lg bg-teal-400 px-3 py-1.5 text-xs font-semibold text-slate-950 shadow-lg shadow-teal-500/20'
        : 'rounded-lg bg-slate-900/60 px-3 py-1.5 text-xs font-medium text-slate-300 ring-1 ring-white/10 hover:bg-slate-800/80 hover:text-white';
      return '<button type="button" data-zone-tab="' + escapeHtml(row.zone) + '" aria-pressed="' + (on ? 'true' : 'false') + '" class="' + cls + '">' +
        escapeHtml(row.label) + '</button>';
    }).join('');
  }

  function applyPayload(data, resetHistory) {
    currentZone = data.zone.id;
    currentMode = data.mode;
    document.body.setAttribute('data-zone', currentZone);
    document.body.setAttribute('data-mode', currentMode);
    var append = true;
    if (resetHistory || !histories) {
      seedHistories(data.trends);
      append = false;
    }

    var updated = document.querySelector('[data-updated-at]');
    var refreshMs = currentMode === 'local' ? LOCAL_POLL_MS : POLL_MS;
    if (updated) updated.textContent = 'Updated ' + data.updatedAtFormatted + ' MVT · ' + data.source + ' · ' + (refreshMs / 1000) + 's';
    var footerRefresh = document.querySelector('[data-refresh-interval]');
    if (footerRefresh) footerRefresh.textContent = String(refreshMs / 1000);
    schedule();

    var zoneShort = document.querySelector('[data-zone-short]');
    if (zoneShort) zoneShort.textContent = 'Five school hours · ' + data.zone.short + ' · live edge telemetry';

    var footerZone = document.querySelector('[data-footer-zone]');
    if (footerZone) footerZone.textContent = data.zone.id;

    setZoneTabs(data.snapshots, currentZone);
    var compareCopy = document.querySelector('[data-zone-compare-copy]');
    if (compareCopy) {
      compareCopy.textContent = currentMode === 'local'
        ? 'Connected USB sensor only'
        : 'Live status across all school locations';
    }
    document.querySelectorAll('[data-mode-switch]').forEach(function (btn) {
      var active = btn.getAttribute('data-mode-switch') === currentMode;
      btn.className = active
        ? 'rounded-md bg-teal-400 px-2.5 py-1 text-[11px] font-semibold text-slate-950'
        : 'rounded-md px-2.5 py-1 text-[11px] font-medium text-slate-400 hover:text-white';
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    updateAdvisory(data.advisory, data.zone.label);

    var noData = data.source === 'no-data';
    var available = data.available || { uv: true, air: true, mq2: true, climate: true, noise: true };
    var hasUv = !noData && available.uv;
    var hasAir = !noData && available.air;
    var hasMq2 = !noData && available.mq2 !== false && data.telemetry.mq2Voltage != null;
    var hasMq2Signal = hasMq2 && data.telemetry.mq2SignalPct != null;
    var hasClimate = !noData && available.climate;
    var hasNoise = !noData && available.noise;
    updateMetricCard('uv', hasUv ? data.telemetry.uvIndex.toFixed(1) : '—', '', data.metrics.uv, 'uvIndex', data.telemetry.uvIndex, append && hasUv);
    updateMetricCard('co2', hasAir ? String(data.telemetry.co2Ppm) : '—', hasAir ? '/100' : '', data.metrics.co2, 'co2Ppm', data.telemetry.co2Ppm, append && hasAir);
    updateMetricCard('mq2', hasMq2Signal ? String(data.telemetry.mq2SignalPct) : '—', hasMq2Signal ? '%' : '', data.metrics.mq2, 'mq2Voltage', data.telemetry.mq2Voltage || 0, append && hasMq2);
    updateMetricCard(
      'climate',
      hasClimate ? data.telemetry.temperatureC.toFixed(1) + '°C' : '—',
      hasClimate ? '/ ' + data.telemetry.humidityPct + '%' : '',
      data.metrics.climate,
      'temperatureC',
      data.telemetry.temperatureC,
      append && hasClimate
    );
    if (append && hasClimate) pushHistory('humidityPct', data.telemetry.humidityPct);
    updatePressure(
      !noData && available.pressure !== false ? data.telemetry.pressureHpa : null
    );
    updateMetricCard('noise', hasNoise ? String(data.telemetry.noiseDb) : '—', hasNoise ? '%' : '', data.metrics.noise, 'noiseDb', data.telemetry.noiseDb, append && hasNoise);

    updateCo2Chart(data.hourly);
    updateZoneTable(data.snapshots, currentZone);

    var live = document.querySelector('[data-live-pill]');
    if (live) {
      live.lastChild.textContent = data.source === 'simulated'
        ? 'Simulated Data'
        : data.source === 'local-usb'
          ? 'Live Data — Local USB'
        : data.source === 'no-data'
          ? currentMode === 'local'
            ? 'Local USB — Waiting for readings'
            : 'Actual Data — Waiting for readings'
          : 'Actual Data — Cloudflare D1';
      live.classList.remove('live-tick');
      void live.offsetWidth;
      live.classList.add('live-tick');
    }
  }

  async function fetchPayload(zone, resetHistory) {
    if (fetching) return;
    fetching = true;
    try {
      var endpoint = currentMode === 'local'
        ? 'http://127.0.0.1:8788/api/telemetry'
        : '/api/telemetry?zone=' + encodeURIComponent(zone) + '&mode=' + encodeURIComponent(currentMode);
      var res = await fetch(endpoint, {
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      if (!res.ok) throw new Error('bad status');
      var data = await res.json();
      applyPayload(data, !!resetHistory);
    } catch (err) {
      console.warn('telemetry poll failed', err);
    } finally {
      fetching = false;
    }
  }

  function schedule() {
    var ms = currentMode === 'local' ? LOCAL_POLL_MS : POLL_MS;
    if (pollTimer && scheduledMs === ms) return;
    if (pollTimer) clearInterval(pollTimer);
    scheduledMs = ms;
    pollTimer = setInterval(function () {
      fetchPayload(currentZone, false);
    }, ms);
  }

  var zoneNav = document.querySelector('[data-zone-nav]');
  if (zoneNav) {
    zoneNav.addEventListener('click', function (event) {
      var btn = event.target.closest('[data-zone-tab]');
      if (!btn || !zoneNav.contains(btn)) return;
      var zone = btn.getAttribute('data-zone-tab');
      if (!zone || zone === currentZone) return;
      var url = new URL(window.location.href);
      url.searchParams.set('zone', zone);
      history.pushState({ zone: zone }, '', url);
      fetchPayload(zone, true);
    });
  }

  document.querySelectorAll('[data-mode-switch]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.getAttribute('data-mode-switch');
      if (!mode || mode === currentMode) return;
      currentMode = mode;
      var url = new URL(window.location.href);
      url.searchParams.set('mode', mode);
      history.pushState({ zone: currentZone, mode: mode }, '', url);
      fetchPayload(currentZone, true);
    });
  });

  window.addEventListener('popstate', function () {
    var url = new URL(window.location.href);
    var zone = url.searchParams.get('zone') || 'courtyard';
    var mode = url.searchParams.get('mode');
    currentMode = mode === 'simulated' ? 'simulated' : mode === 'local' ? 'local' : 'actual';
    fetchPayload(zone, true);
  });

  // Seed histories from SSR bootstrap payload
  try {
    var boot = JSON.parse(document.getElementById('dashboard-bootstrap').textContent);
    seedHistories(boot.trends);
  } catch (e) {
    histories = { uvIndex: [], co2Ppm: [], mq2Voltage: [], temperatureC: [], humidityPct: [], noiseDb: [] };
  }

  schedule();
})();
`

const Dashboard: FC<{ data: DashboardPayload }> = ({ data }) => {
  const { zone, telemetry, trends, hourly, snapshots, advisory, metrics } = data
  const hasData = data.source !== 'no-data'
  const advisoryTone = statusTone(advisory.level)
  const advisoryIcon =
    advisory.level === 'alert' ? '⚠️' : advisory.level === 'watch' ? '⚡' : '✓'
  const bootstrapJson = JSON.stringify(data).replace(/</g, '\\u003c')

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>EcoSchool Sense • Maldives Campus</title>
        <meta
          name="description"
          content="School environmental monitoring dashboard for EcoSchool Sense — Maldives Campus."
        />
        <script src="https://cdn.tailwindcss.com"></script>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              tailwind.config = {
                theme: {
                  extend: {
                    fontFamily: {
                      sans: ['"DM Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
                      display: ['"Sora"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
                    },
                  },
                },
              };
            `,
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=Sora:wght@500;600;700&display=swap"
          rel="stylesheet"
        />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              :root { color-scheme: dark; }
              html, body {
                height: 100%;
                overflow: hidden;
              }
              body {
                margin: 0;
                font-family: "DM Sans", ui-sans-serif, system-ui, sans-serif;
                background:
                  radial-gradient(1200px 600px at 10% -10%, rgba(45, 212, 191, 0.12), transparent 55%),
                  radial-gradient(900px 500px at 95% 0%, rgba(56, 189, 248, 0.10), transparent 50%),
                  radial-gradient(800px 500px at 50% 110%, rgba(15, 118, 110, 0.18), transparent 55%),
                  linear-gradient(165deg, #020617 0%, #0b1220 45%, #07111a 100%);
                color: #e2e8f0;
              }
              .mesh {
                background-image:
                  linear-gradient(rgba(148, 163, 184, 0.04) 1px, transparent 1px),
                  linear-gradient(90deg, rgba(148, 163, 184, 0.04) 1px, transparent 1px);
                background-size: 48px 48px;
              }
              .dashboard-shell {
                height: 100dvh;
                max-height: 100dvh;
                display: grid;
                grid-template-rows: auto auto minmax(0, 0.95fr) minmax(0, 1.15fr) auto;
                gap: 0.5rem;
                padding: 0.6rem 0.85rem 0.45rem;
                box-sizing: border-box;
              }
              @media (min-width: 1024px) {
                .dashboard-shell {
                  gap: 0.65rem;
                  padding: 0.75rem 1rem 0.5rem;
                }
              }
              @keyframes pulse-dot {
                0%, 100% { opacity: 1; transform: scale(1); }
                50% { opacity: 0.55; transform: scale(0.85); }
              }
              .live-dot { animation: pulse-dot 1.8s ease-in-out infinite; }
              @keyframes value-flash {
                0% { color: #5eead4; text-shadow: 0 0 18px rgba(45,212,191,0.35); }
                100% { color: #ffffff; text-shadow: none; }
              }
              .value-flash { animation: value-flash 0.7s ease-out; }
              @keyframes live-tick {
                0% { box-shadow: 0 0 0 0 rgba(45, 212, 191, 0.45); }
                100% { box-shadow: 0 0 0 12px rgba(45, 212, 191, 0); }
              }
              .live-tick { animation: live-tick 0.9s ease-out; }
            `,
          }}
        />
      </head>
      <body class="overflow-hidden antialiased" data-zone={zone.id} data-mode={data.mode}>
        <div class="mesh dashboard-shell">
            <header class="shrink-0 flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2">
              <div class="min-w-0">
                <h1 class="font-display text-xl font-semibold tracking-tight text-white lg:text-2xl">
                  EcoSchool Sense <span class="text-slate-500">•</span> Maldives Campus
                </h1>
                <p class="mt-0.5 hidden text-xs text-slate-400 sm:block">
                  Live classroom &amp; courtyard air · UV · comfort monitoring
                </p>
              </div>

              <div class="flex flex-wrap items-center gap-2">
                <div class="inline-flex rounded-lg bg-slate-900/70 p-0.5 ring-1 ring-white/10" aria-label="Data source">
                  {(['actual', 'local', 'simulated'] as const).map((mode) => (
                    <button
                      type="button"
                      data-mode-switch={mode}
                      aria-pressed={data.mode === mode ? 'true' : 'false'}
                      class={
                        data.mode === mode
                          ? 'rounded-md bg-teal-400 px-2.5 py-1 text-[11px] font-semibold text-slate-950'
                          : 'rounded-md px-2.5 py-1 text-[11px] font-medium text-slate-400 hover:text-white'
                      }
                    >
                      {mode === 'actual'
                        ? 'Actual D1'
                        : mode === 'local'
                          ? 'Local USB'
                          : 'Simulated'}
                    </button>
                  ))}
                </div>
                <div
                  data-live-pill
                  class="inline-flex items-center gap-2 rounded-full bg-teal-500/10 px-2.5 py-1 text-xs font-medium text-teal-200 ring-1 ring-teal-400/30"
                >
                  <span class="live-dot inline-block h-1.5 w-1.5 rounded-full bg-teal-400" />
                  {data.source === 'simulated'
                    ? 'Simulated Data'
                    : data.source === 'local-usb'
                      ? 'Live Data — Local USB'
                    : data.source === 'no-data'
                      ? data.mode === 'local'
                        ? 'Local USB — Waiting for readings'
                        : 'Actual Data — Waiting for readings'
                      : 'Actual Data — Cloudflare D1'}
                </div>
                <p data-updated-at class="text-[11px] text-slate-500">
                  Updated {data.updatedAtFormatted} MVT · {data.source} · {pollMsForMode(data.mode) / 1000}s
                </p>
              </div>
            </header>

            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <nav
                class={`flex flex-wrap gap-1.5${snapshots.length < 2 ? ' hidden' : ''}`}
                aria-label="Location switcher"
                data-zone-nav
              >
                {snapshots.map((z) => {
                  const active = z.zone === zone.id
                  return (
                    <button
                      type="button"
                      data-zone-tab={z.zone}
                      aria-pressed={active ? 'true' : 'false'}
                      class={
                        active
                          ? 'rounded-lg bg-teal-400 px-3 py-1.5 text-xs font-semibold text-slate-950 shadow-lg shadow-teal-500/20'
                          : 'rounded-lg bg-slate-900/60 px-3 py-1.5 text-xs font-medium text-slate-300 ring-1 ring-white/10 hover:bg-slate-800/80 hover:text-white'
                      }
                    >
                      {z.label}
                    </button>
                  )
                })}
              </nav>

              <section
                data-advisory
                class={`min-w-0 flex-1 rounded-xl border bg-gradient-to-r px-3 py-2 ${advisoryTone.banner}`}
                role="status"
                aria-live="polite"
              >
                <div class="flex items-start gap-2.5">
                  <div
                    data-advisory-icon
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-black/25 text-sm"
                  >
                    {advisoryIcon}
                  </div>
                  <div class="min-w-0 flex-1">
                    <p
                      data-advisory-zone
                      class="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/70"
                    >
                      Health Advisory · {zone.label}
                    </p>
                    <h2
                      data-advisory-title
                      class="mt-0.5 truncate font-display text-sm font-semibold text-white lg:text-base"
                    >
                      {advisoryIcon} {advisory.title}
                      {advisory.level !== 'good' && advisory.title.includes('UV')
                        ? ': Outdoor recess should be limited to shaded areas.'
                        : ''}
                    </h2>
                    <p
                      data-advisory-message
                      class="mt-0.5 line-clamp-1 text-xs leading-snug text-slate-200/90"
                    >
                      {advisory.message}
                    </p>
                  </div>
                </div>
              </section>
            </div>

            <section class="grid min-h-0 grid-cols-2 gap-2 xl:grid-cols-5">
              <MetricCard
                id="uv"
                title="Outdoor UV Index"
                value={hasData ? telemetry.uvIndex.toFixed(1) : '—'}
                subtitle={metrics.uv.subtitle}
                badge={metrics.uv.badge}
                status={metrics.uv.status}
                icon={<IconSun />}
                trend={trends.uvIndex}
                trendLabel="UV"
              />
              <MetricCard
                id="co2"
                title="Air Quality Score"
                value={hasData ? String(telemetry.co2Ppm) : '—'}
                unit={hasData ? '/100' : ''}
                subtitle={metrics.co2.subtitle}
                badge={metrics.co2.badge}
                status={metrics.co2.status}
                icon={<IconAir />}
                trend={trends.co2Ppm}
                trendLabel="Air quality"
              />
              <MetricCard
                id="mq2"
                title="Smoke / Gas Signal"
                value={
                  hasData && telemetry.mq2SignalPct !== null
                    ? String(telemetry.mq2SignalPct)
                    : '—'
                }
                unit={hasData && telemetry.mq2SignalPct !== null ? '%' : ''}
                subtitle={metrics.mq2.subtitle}
                badge={metrics.mq2.badge}
                status={metrics.mq2.status}
                icon={<IconAir />}
                trend={trends.mq2Voltage}
                trendLabel="MQ-2 signal"
              />
              <MetricCard
                id="climate"
                title="Temperature, Humidity & Pressure"
                value={hasData ? `${telemetry.temperatureC.toFixed(1)}°C` : '—'}
                unit={hasData ? `/ ${telemetry.humidityPct}%` : ''}
                subtitle={metrics.climate.subtitle}
                badge={metrics.climate.badge}
                status={metrics.climate.status}
                icon={<IconThermo />}
                trend={trends.temperatureC}
                trendLabel="Temp"
                detail={<PressureSummary pressureHpa={telemetry.pressureHpa} />}
              />
              <MetricCard
                id="noise"
                title="Sound Activity"
                value={hasData ? String(telemetry.noiseDb) : '—'}
                unit={hasData ? '%' : ''}
                subtitle={metrics.noise.subtitle}
                badge={metrics.noise.badge}
                status={metrics.noise.status}
                icon={<IconNoise />}
                trend={trends.noiseDb}
                trendLabel="Noise"
              />
            </section>

            <section class="grid min-h-0 grid-cols-1 gap-2 lg:grid-cols-2">
              <div class="flex min-h-0 flex-col rounded-xl bg-slate-900/70 p-3 ring-1 ring-white/10 backdrop-blur-sm">
                <div class="mb-2 flex shrink-0 items-end justify-between gap-2">
                  <div class="min-w-0">
                    <h3 class="font-display text-sm font-semibold text-white">Air Quality Trend</h3>
                    <p data-zone-short class="truncate text-[11px] text-slate-400">
                      Five school hours · {zone.short} · live edge telemetry
                    </p>
                  </div>
                  <span class="shrink-0 rounded-md bg-white/5 px-2 py-0.5 text-[10px] font-medium text-slate-300 ring-1 ring-white/10">
                    8 AM – 1 PM
                  </span>
                </div>
                <Co2Chart series={hourly} />
              </div>

              <div class="flex min-h-0 flex-col rounded-xl bg-slate-900/70 p-3 ring-1 ring-white/10 backdrop-blur-sm">
                <div class="mb-2 shrink-0">
                  <h3 class="font-display text-sm font-semibold text-white">Zone Comparison</h3>
                  <p data-zone-compare-copy class="text-[11px] text-slate-400">
                    {data.mode === 'local'
                      ? 'Connected USB sensor only'
                      : 'Live status across all school locations'}
                  </p>
                </div>
                <ZoneTable rows={snapshots} active={zone.id} />
              </div>
            </section>

            <footer class="flex shrink-0 items-center justify-between gap-2 border-t border-white/10 pt-1.5 text-[10px] text-slate-500">
              <p class="truncate">
                EcoSchool Sense PoC · Hono on Cloudflare Workers · live JSON poll
              </p>
              <p class="shrink-0 tabular-nums">
                Soft refresh <span data-refresh-interval>{pollMsForMode(data.mode) / 1000}</span>s · Zone:{' '}
                <span data-footer-zone>{zone.id}</span>
              </p>
            </footer>
        </div>

        <script
          id="dashboard-bootstrap"
          type="application/json"
          dangerouslySetInnerHTML={{ __html: bootstrapJson }}
        />
        <script dangerouslySetInnerHTML={{ __html: clientScript }} />
      </body>
    </html>
  )
}

/* -------------------------------------------------------------------------- */
/* App                                                                        */
/* -------------------------------------------------------------------------- */

const app = new Hono<{ Bindings: Env }>()

app.get('/api/telemetry', async (c) => {
  const zoneId = parseZone(c.req.query('zone'))
  const mode = parseMode(c.req.query('mode'))
  const payload = await buildDashboardPayload(zoneId, mode, c.env.DB)
  return c.json(payload, 200, {
    'Cache-Control': 'no-store',
  })
})

app.get('/', async (c) => {
  const zoneId = parseZone(c.req.query('zone'))
  const mode = parseMode(c.req.query('mode'))
  const data = await buildDashboardPayload(zoneId, mode, c.env.DB)
  return c.html(<Dashboard data={data} />)
})

app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'ecoschool-sense',
    edge: 'cloudflare-workers',
    timestamp: new Date().toISOString(),
  }),
)

export default app
