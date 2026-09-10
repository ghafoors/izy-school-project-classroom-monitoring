import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SerialPort } from 'serialport'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WINDOWS = process.platform === 'win32'
const NPM = IS_WINDOWS ? 'npm.cmd' : 'npm'

const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 8788)
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 8787)
const SERIAL_BAUD = Number(process.env.SERIAL_BAUD || 115200)
const HISTORY_LIMIT = 12
const MQ2_CALIBRATION_SAMPLES = 10
const SOUND_CALIBRATION_SAMPLES = 10
const SOUND_AVERAGE_SAMPLES = 10
const SOUND_ACTIVITY_RANGE_ADC = 600

let serial
let dashboard
let latest = null
let mq2BaselineAdc = null
const mq2Calibration = []
let soundBaselineAdc =
  process.env.SOUND_BASELINE_ADC && Number.isFinite(Number(process.env.SOUND_BASELINE_ADC))
    ? Number(process.env.SOUND_BASELINE_ADC)
    : null
const soundCalibration = []
const soundActivitySamples = []
let serialPath = process.env.SERIAL_PORT || ''
let lineBuffer = ''
const history = {
  mq2Voltage: [],
  noiseDb: [],
  temperatureC: [],
  humidityPct: [],
}

function appendHistory(key, value) {
  if (!Number.isFinite(value)) return
  history[key].push(value)
  if (history[key].length > HISTORY_LIMIT) history[key].shift()
}

function soundActivityFor(adc) {
  return Math.round(
    Math.max(0, Math.min(100, ((adc - soundBaselineAdc) / SOUND_ACTIVITY_RANGE_ADC) * 100)),
  )
}

function average(values) {
  return values.length
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : 0
}

function acceptReading(reading) {
  latest = {
    ...reading,
    recorded_at: reading.recorded_at || new Date().toISOString(),
  }
  appendHistory(
    'temperatureC',
    latest.aht20_temperature_c ?? latest.bmp280_temperature_c,
  )
  appendHistory('humidityPct', latest.aht20_humidity_pct)
  appendHistory('mq2Voltage', latest.mq2_voltage)
  if (mq2BaselineAdc === null && Number.isFinite(latest.mq2_adc)) {
    mq2Calibration.push(latest.mq2_adc)
    if (mq2Calibration.length >= MQ2_CALIBRATION_SAMPLES) {
      const sorted = mq2Calibration.slice().sort((a, b) => a - b)
      const trimmed = sorted.slice(1, -1)
      mq2BaselineAdc = Math.round(trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length)
      console.log(`[sensor] MQ-2 ambient baseline calibrated at ADC ${mq2BaselineAdc}`)
    }
  }
  if (soundBaselineAdc === null && Number.isFinite(latest.sound_adc)) {
    soundCalibration.push(latest.sound_adc)
    if (soundCalibration.length >= SOUND_CALIBRATION_SAMPLES) {
      const sorted = soundCalibration.slice().sort((a, b) => a - b)
      const trimmed = sorted.slice(1, -1)
      soundBaselineAdc = Math.round(
        trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length,
      )
      console.log(`[sensor] Sound ambient baseline calibrated at amplitude ${soundBaselineAdc}`)
    }
  }
  if (soundBaselineAdc !== null && Number.isFinite(latest.sound_adc)) {
    soundActivitySamples.push(soundActivityFor(latest.sound_adc))
    if (soundActivitySamples.length > SOUND_AVERAGE_SAMPLES) soundActivitySamples.shift()
    appendHistory('noiseDb', average(soundActivitySamples))
  }
  console.log(
    `[sensor] ${latest.recorded_at}  ` +
      `AHT20 ${latest.aht20_temperature_c ?? '—'}°C / ${latest.aht20_humidity_pct ?? '—'}%  ` +
      `BMP280 ${latest.bmp280_pressure_hpa ?? '—'} hPa  ` +
      `MQ-2 ${latest.mq2_voltage ?? '—'} V  ` +
      `Sound amplitude ${latest.sound_adc ?? '—'} ADC / ${latest.sound_voltage ?? '—'} V  ` +
      `DO ${latest.sound_detected == null ? '—' : latest.sound_detected ? 'detected' : 'quiet'}`,
  )
}

function consumeSerial(chunk) {
  lineBuffer += chunk.toString('utf8')
  const lines = lineBuffer.split(/\r?\n/)
  lineBuffer = lines.pop() || ''

  for (const line of lines) {
    const marker = line.indexOf('[DATA] ')
    if (marker === -1) continue
    try {
      acceptReading(JSON.parse(line.slice(marker + 7)))
    } catch (error) {
      console.warn('[serial] Ignoring malformed data line:', error.message)
    }
  }
}

function portHaystack(port) {
  return [port.path, port.manufacturer, port.friendlyName, port.pnpId, port.vendorId]
    .filter(Boolean)
    .join(' ')
}

function isLikelySensorPort(port) {
  const hay = portHaystack(port)
  if (/bluetooth|debug-console|incoming/i.test(hay)) return false
  return /usbserial|usbmodem|cp210|silicon labs|ch340|wch|ftdi|10c4|1a86|0403|303a/i.test(hay)
}

function looksLikeComPort(port) {
  return /^COM\d+$/i.test(port.path)
}

async function chooseSerialPort() {
  if (serialPath) return serialPath
  const ports = await SerialPort.list()
  const comPorts = ports.filter(
    (port) => looksLikeComPort(port) && !/bluetooth/i.test(portHaystack(port)),
  )
  const candidate = ports.find(isLikelySensorPort) || (comPorts.length === 1 ? comPorts[0] : undefined)
  if (!candidate) {
    const hint = IS_WINDOWS
      ? 'Set SERIAL_PORT=COM3 (Device Manager → Ports) and retry.'
      : 'Set SERIAL_PORT=/dev/cu.usbserial-XXXX and retry.'
    throw new Error(`No USB serial device found. ${hint}`)
  }
  return candidate.path
}

function openBrowser(url) {
  if (IS_WINDOWS) {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref()
    return
  }
  if (process.platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
    return
  }
  spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
}

function stopChild(child) {
  if (!child?.pid) return
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    return
  }
  if (!child.killed) child.kill('SIGTERM')
}

async function connectSerial() {
  try {
    serialPath = await chooseSerialPort()
    serial = new SerialPort({ path: serialPath, baudRate: SERIAL_BAUD })
    serial.on('data', consumeSerial)
    serial.on('open', () => {
      serial.set({ dtr: false, rts: false })
      console.log(`[serial] Connected to ${serialPath} at ${SERIAL_BAUD}`)
    })
    serial.on('error', (error) => console.error('[serial]', error.message))
    serial.on('close', () => {
      console.warn('[serial] Disconnected; retrying in 2 seconds')
      serial = undefined
      setTimeout(connectSerial, 2000)
    })
  } catch (error) {
    console.error(`[serial] ${error.message}`)
    setTimeout(connectSerial, 2000)
  }
}

const ZONE_META = {
  courtyard: {
    id: 'courtyard',
    label: 'Courtyard (Outdoor)',
    short: 'Courtyard',
    kind: 'outdoor',
  },
  classroom: {
    id: 'classroom',
    label: 'Grade 4 Classroom',
    short: 'Classroom',
    kind: 'indoor',
  },
  library: {
    id: 'library',
    label: 'School Library',
    short: 'Library',
    kind: 'indoor',
  },
}

function resolveZone(raw) {
  return ZONE_META[raw] || ZONE_META.classroom
}

function statusForClimate(temperatureC, humidityPct) {
  if (temperatureC >= 32 || humidityPct >= 85) return ['watch', 'Hot / Humid']
  if (temperatureC >= 29 && humidityPct >= 70) return ['watch', 'Tropical Warm']
  return ['good', 'Stable']
}

function mq2SignalInfo(adc, baseline) {
  if (baseline === null) return null
  const headroom = Math.max(1, 4095 - baseline)
  const percent = Math.round(Math.max(0, Math.min(100, ((adc - baseline) / headroom) * 100)))
  if (percent >= 60) return { percent, label: 'High increase', status: 'watch' }
  if (percent >= 30) return { percent, label: 'Elevated', status: 'watch' }
  if (percent >= 10) return { percent, label: 'Slight increase', status: 'good' }
  return { percent, label: 'Ambient baseline', status: 'good' }
}

function buildPayload() {
  const hasReading = latest !== null
  const temperatureC =
    latest?.aht20_temperature_c ?? latest?.bmp280_temperature_c ?? 0
  const humidityPct = latest?.aht20_humidity_pct ?? 0
  const hasClimate = hasReading && Number.isFinite(temperatureC) && Number.isFinite(humidityPct)
  const [climateStatus, climateLabel] = statusForClimate(temperatureC, humidityPct)
  const mq2Adc = latest?.mq2_adc ?? null
  const mq2Voltage = latest?.mq2_voltage ?? null
  const mq2Available = Number.isFinite(mq2Adc) && Number.isFinite(mq2Voltage)
  const mq2 = mq2Available ? mq2SignalInfo(mq2Adc, mq2BaselineAdc) : null
  const soundAvailable = Number.isFinite(latest?.sound_adc)
  const soundActivity =
    soundAvailable && soundBaselineAdc !== null
      ? average(soundActivitySamples)
      : 0
  const soundStatus = soundActivity >= 75 ? 'alert' : soundActivity >= 50 ? 'watch' : 'good'
  const soundLabel =
    soundActivity >= 75
      ? 'Too loud'
      : soundActivity >= 50
        ? 'Loud'
        : soundActivity >= 20
          ? 'Active'
          : 'Quiet'
  const updatedAt = latest?.recorded_at || new Date().toISOString()
  const zone = resolveZone(latest?.zone)

  return {
    zone,
    telemetry: {
      zone: zone.id,
      uvIndex: latest?.uv_index ?? 0,
      co2Ppm:
        latest?.mq135_adc == null
          ? 0
          : Math.round(Math.max(0, Math.min(100, 100 - (latest.mq135_adc / 4095) * 100))),
      mq2Adc,
      mq2Voltage,
      mq2SignalPct: mq2?.percent ?? null,
      mq2BaselineAdc,
      temperatureC,
      humidityPct,
      pressureHpa: latest?.bmp280_pressure_hpa ?? null,
      noiseDb:
        soundActivity,
      updatedAt,
    },
    mode: 'local',
    source: hasReading ? 'local-usb' : 'no-data',
    available: {
      uv: latest?.uv_index != null,
      air: latest?.mq135_adc != null,
      mq2: mq2Available,
      climate: hasClimate,
      noise: soundAvailable,
      pressure: latest?.bmp280_pressure_hpa != null,
      altitude: latest?.bmp280_altitude_m != null,
    },
    raw: latest,
    trends: {
      uvIndex: [],
      co2Ppm: [],
      mq2Voltage: history.mq2Voltage,
      temperatureC: history.temperatureC,
      humidityPct: history.humidityPct,
      noiseDb: history.noiseDb,
    },
    hourly: [],
    snapshots: [
      {
        zone: zone.id,
        label: zone.label,
        uvIndex: latest?.uv_index ?? 0,
        co2Ppm: 0,
        temperatureC,
        humidityPct,
        noiseDb: 0,
        status: hasReading ? climateStatus : 'good',
        statusLabel: hasReading ? climateLabel : 'Waiting for USB',
      },
    ],
    advisory:
      soundBaselineAdc !== null && soundActivity >= 75
        ? {
            level: 'alert',
            title: 'Classroom noise is too loud',
            message: `Noise activity is ${soundActivity}% above the room baseline. Lower voices or reduce the sound source.`,
          }
        : soundBaselineAdc !== null && soundActivity >= 50
          ? {
              level: 'watch',
              title: 'Classroom noise is rising',
              message: `Noise activity is ${soundActivity}% above the room baseline. Consider reducing the volume.`,
            }
          : hasReading
            ? {
          level: climateStatus,
          title: 'USB sensors connected',
          message:
            `AHT20: ${temperatureC.toFixed(1)}°C, ${humidityPct.toFixed(1)}% RH` +
            (latest?.bmp280_pressure_hpa == null
              ? ''
              : ` · BMP280: ${latest.bmp280_pressure_hpa.toFixed(1)} hPa`),
              }
            : {
          level: 'good',
          title: 'Waiting for USB sensor data',
          message: `Connected bridge is waiting for [DATA] readings from ${serialPath || 'the ESP32'}.`,
        },
    metrics: {
      uv: { label: 'Unavailable', status: 'good', badge: 'N/A', subtitle: 'UV sensor not enabled' },
      co2: {
        label: 'Unavailable',
        status: 'good',
        badge: 'N/A',
        subtitle: 'Air-quality sensor not enabled',
      },
      mq2: mq2Available
        ? mq2
          ? {
            label: mq2.label,
            status: mq2.status,
            badge: mq2.label,
            subtitle: `${mq2Voltage.toFixed(2)} V · baseline ADC ${mq2BaselineAdc}`,
          }
          : {
              label: 'Calibrating',
              status: 'good',
              badge: `${mq2Calibration.length}/${MQ2_CALIBRATION_SAMPLES}`,
              subtitle: 'Keep air stable for ambient baseline',
            }
        : {
            label: 'Unavailable',
            status: 'good',
            badge: 'N/A',
            subtitle: 'MQ-2 sensor not enabled',
          },
      climate: {
        label: climateLabel,
        status: climateStatus,
        badge: hasClimate ? climateLabel : 'N/A',
        subtitle: hasClimate ? climateLabel : 'Waiting for AHT20',
      },
      noise: {
        label:
          !soundAvailable
            ? 'Unavailable'
            : soundBaselineAdc === null
              ? 'Calibrating'
              : soundLabel,
        status: soundAvailable && soundBaselineAdc !== null ? soundStatus : 'good',
        badge:
          !soundAvailable
            ? 'N/A'
            : soundBaselineAdc === null
              ? `${soundCalibration.length}/${SOUND_CALIBRATION_SAMPLES}`
              : soundLabel,
        subtitle:
          !soundAvailable
            ? 'Sound sensor not enabled'
            : soundBaselineAdc === null
              ? 'Keep room at its normal quiet level'
              : `10-sample average · ambient ${soundBaselineAdc}`,
      },
    },
    updatedAtFormatted: new Intl.DateTimeFormat('en-MV', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZone: 'Indian/Maldives',
    }).format(new Date(updatedAt)),
  }
}

const bridge = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Cache-Control', 'no-store')

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept',
    })
    return response.end()
  }

  if (request.url?.startsWith('/api/telemetry')) {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return response.end(JSON.stringify(buildPayload()))
  }

  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return response.end(
      JSON.stringify({ ok: true, serial: serial?.isOpen || false, path: serialPath, latest }),
    )
  }

  response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ error: 'not_found' }))
})

bridge.listen(BRIDGE_PORT, '127.0.0.1', () => {
  console.log(`[bridge] Listening at http://127.0.0.1:${BRIDGE_PORT}`)
  dashboard = spawn(
    NPM,
    ['run', 'dev', '--prefix', 'semp', '--', '--port', String(DASHBOARD_PORT)],
    { cwd: ROOT, stdio: 'inherit', shell: IS_WINDOWS, env: process.env },
  )
  dashboard.on('error', (error) => console.error('[dashboard]', error.message))

  setTimeout(() => {
    const url = `http://127.0.0.1:${DASHBOARD_PORT}/?zone=classroom&mode=local`
    console.log(`[dashboard] Opening ${url}`)
    openBrowser(url)
  }, 3500)
})

void connectSerial()

function shutdown() {
  if (serial?.isOpen) serial.close()
  stopChild(dashboard)
  dashboard = undefined
  bridge.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
