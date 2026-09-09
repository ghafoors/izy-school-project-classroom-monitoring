# EcoSchool Sense

School environmental monitoring for a Maldives campus prototype. An ESP32 node reads classroom sensors and can show live values on a laptop over USB, or post them to Cloudflare for a shared dashboard.

This repo contains:

- **Firmware** for an ESP32 environmental node (`sensor.ino`, Arduino sketch `izy.ino`)
- **Local USB dashboard** so a laptop can display the board without Wi‑Fi (`scripts/`)
- **Ingest Worker + D1** for cloud storage (`worker/`)
- **EcoSchool Sense dashboard** (Hono on Cloudflare Workers) (`semp/`)

---

## What it measures today

| Sensor | Status in firmware | What you see |
| --- | --- | --- |
| **AHT20** (I2C) | Auto-detected | Temperature (°C), relative humidity (%) |
| **BMP280** (I2C, address `0x76` or `0x77`) | Auto-detected | Temperature, pressure (hPa), approximate altitude |
| MQ-2 / MQ-4 / MQ-6 / MQ-135 | Wired only if `enable_*` is `true` | Gas / air-quality ADC (dashboard air-quality score uses MQ-135) |
| XD-74 sound | Off until `enable_sound` | Sound activity |
| GUVA-S12SD UV | Off until `enable_uv` | UV index |

Unconnected analog pins are left **disabled** on purpose. ADC2 is unused because it conflicts with Wi‑Fi.

Sampling interval is **3 seconds**. The dashboard polls on the same interval.

---

## Quick start: laptop dashboard (USB)

This is the path for a Windows or Mac laptop (for example, a nephew running the demo at home). **No Wi‑Fi, no Cloudflare account, and no Arduino flash is required** if the board already has this firmware.

### 1. Install Node.js

Install **Node.js 18+ LTS** from [https://nodejs.org](https://nodejs.org) (this also installs npm).

### 2. Get the project

```bash
git clone https://github.com/ghafoors/izy-school-project-classroom-monitoring.git
cd izy-school-project-classroom-monitoring
```

### 3. One-time setup

From the project folder:

```bash
npm run setup
```

This installs USB serial tools and the dashboard, then lists any connected ESP32.

### 4. Plug in the board and start

1. Connect the ESP32 with a **data** USB cable (not charge-only).
2. Run:

```bash
npm start
```

3. A browser should open  
   `http://127.0.0.1:8787/?zone=classroom&mode=local`
4. Keep **Local USB** selected in the header.

Local USB mode shows **only the connected node’s zone** (not courtyard / library placeholders).

Stop with `Ctrl+C`.

### Windows extras

- If the port never appears, install the [Silicon Labs CP210x USB to UART driver](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers), then unplug and replug.
- Device Manager → **Ports (COM & LPT)** shows something like `COM3`.
- If auto-detect fails:

```bat
set SERIAL_PORT=COM3
npm start
```

### macOS extras

Typical port: `/dev/cu.usbserial-0001`.

```bash
SERIAL_PORT=/dev/cu.usbserial-0001 npm start
```

---

## How the pieces fit

```text
ESP32  --USB serial [DATA] JSON-->  local bridge :8788  -->  dashboard :8787  (Local USB)
   |
   +--Wi-Fi HTTPS POST /readings-->  izy-sensors Worker + D1
                                         ^
                                         |
                              EcoSchool dashboard (semp) reads D1
```

- **Local USB:** firmware prints one `[DATA] { ... }` line per sample. `scripts/local-dashboard.mjs` reads that serial stream and serves `/api/telemetry`. The dashboard fetches `http://127.0.0.1:8788` when mode is Local USB.
- **Cloud:** firmware POSTs the same JSON to the ingest Worker with `Authorization: Bearer <token>`. The dashboard **Actual D1** mode reads Cloudflare D1. **Simulated** is mock data for demos without hardware.

If Wi‑Fi is down, the node still samples and prints USB JSON after a 10 second connect timeout.

---

## Hardware

### Board

- ESP32 (this prototype: ESP32-D0WD-V3, CP2102 USB-UART)
- PSRAM is **not** required (the sketch reports if it is missing)

### I2C

| Signal | ESP32 pin |
| --- | --- |
| SDA | GPIO 21 |
| SCL | GPIO 22 |

### Analog (enable in firmware after wiring)

Use **ADC1 only**.

| Module | Pin |
| --- | --- |
| MQ-2 | GPIO 36 |
| MQ-4 | GPIO 39 |
| MQ-6 | GPIO 34 |
| MQ-135 | GPIO 35 |
| Sound AO | GPIO 32 |
| Sound DO | GPIO 25 |
| UV | GPIO 33 |

Set the matching `enable_mq2`, `enable_mq4`, `enable_mq6`, `enable_mq135`, `enable_sound`, or `enable_uv` flags in `sensor.ino` to `true` after the module is wired.

### Zones

Firmware `DEVICE_ZONE` must be one of:

- `courtyard`
- `classroom`
- `library`

---

## Firmware (Arduino)

Sketch entry file is `izy.ino`; implementation lives in `sensor.ino`. You need `secrets.h` to compile (gitignored).

### Libraries

- Adafruit AHTX0
- Adafruit BMP280 Library  
  (Adafruit BusIO and Adafruit Unified Sensor are pulled in as dependencies)

Board package: **esp32:esp32** (ESP32 Arduino core). FQBN used here: `esp32:esp32:esp32`.

### Secrets

**Option A — copy the example**

```bash
cp secrets.example.h secrets.h
```

Edit Wi‑Fi, ingest URL, and token.

**Option B — generate from `.env`**

```bash
cp .env.example .env
# edit .env
npm install --prefix worker
npm run map-env --prefix worker
```

That writes `secrets.h` and `worker/.dev.vars`.

| Variable | Purpose |
| --- | --- |
| `WIFI_SSID` / `WIFI_PASSWORD` | Campus or home Wi‑Fi |
| `INGEST_URL` | `https://<ingest-worker>/readings` |
| `INGEST_TOKEN` | Same token as Worker secret `INGEST_TOKEN` |
| `DEVICE_ID` | Optional. Empty → `esp32-<efuse-mac>` |
| `DEVICE_ZONE` | `classroom`, `courtyard`, or `library` |

### Build and flash (arduino-cli)

```bash
arduino-cli core install esp32:esp32
arduino-cli lib install "Adafruit AHTX0" "Adafruit BMP280 Library"
arduino-cli compile --fqbn esp32:esp32:esp32 .
arduino-cli upload --fqbn esp32:esp32:esp32 --port /dev/cu.usbserial-0001 .
```

On Windows, use `--port COM3` (your COM number). Close `npm start` first so the serial port is free.

Arduino IDE: open the project folder (it must contain `izy.ino`), install the ESP32 board package and Adafruit libraries, then upload.

Serial monitor: **115200** baud. Look for AHT20 / BMP280 success lines, then `[DATA] { ... }` every 3 seconds.

---

## Cloud ingest Worker (`worker/`)

Stores readings in D1 database `izy-sensors`.

### API

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/health` | none | `{ "ok": true }` |
| `GET` | `/readings?limit=&device_id=` | none | Newest first, default 50, max 200 |
| `POST` | `/readings` | `Authorization: Bearer <INGEST_TOKEN>` | JSON body from the ESP32 |

Zones on ingest: `courtyard` \| `classroom` \| `library`.

### Local Worker

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars   # or npm run map-env from repo root
npm run db:migrate:local
npm run dev
```

Set `INGEST_TOKEN` in `.dev.vars`. Point firmware `INGEST_URL` at that local URL only if the ESP32 can reach your machine (usually you use the deployed Worker instead).

### Deploy ingest

```bash
cd worker
npx wrangler secret put INGEST_TOKEN
npm run db:migrate:remote
npm run deploy
```

`wrangler.jsonc` already has database id `29f1da56-39f6-430f-b359-704d9b2d0610`. For a new Cloudflare account, run `npm run db:create` and paste the new id.

---

## Dashboard Worker (`semp/`)

Hono UI: **EcoSchool Sense • Maldives Campus**.

```bash
cd semp
npm install
npm run dev          # default wrangler port, or npm start from repo root for USB
npm run typecheck
npm run deploy
```

Data modes in the header:

| Mode | Source |
| --- | --- |
| **Actual D1** | Cloudflare D1 readings by zone |
| **Local USB** | Laptop serial bridge on port 8788 |
| **Simulated** | Generated demo telemetry |

Air-quality score on the dashboard is a **display-only** mapping of MQ-135 ADC (`100 - adc/4095 * 100`). D1 still stores raw ADC.

Pressure on the climate card uses absolute hPa bands:

| Range (hPa) | Label |
| --- | --- |
| &lt; 990 | Very Low |
| 990–1008.99 | Low |
| 1009–1020.99 | Normal |
| 1021–1030 | High |
| &gt; 1030 | Very High |

GitHub Actions: `semp/.github/workflows/deploy.yml` deploys on push to `main` using `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

---

## Repository layout

```text
.
├── izy.ino                 # Arduino sketch name (required by Arduino)
├── sensor.ino              # Firmware implementation
├── secrets.example.h       # Template for secrets.h
├── .env.example
├── package.json            # npm run setup / npm start
├── scripts/
│   ├── setup.mjs           # Cross-platform laptop setup
│   ├── local-dashboard.mjs # USB serial → HTTP + wrangler dashboard
│   └── map-env.mjs         # .env → secrets.h + worker/.dev.vars
├── worker/                 # Ingest API + D1
└── semp/                   # Dashboard Worker
```

Gitignored (never commit): `.env`, `secrets.h`, `worker/.dev.vars`, `node_modules/`, `.wrangler/`.

---

## Troubleshooting

**Dashboard says waiting for USB**  
Firmware must print `[DATA]` lines. Old firmware blocked forever on Wi‑Fi and never sampled. Flash current `sensor.ino`. Confirm Serial Monitor at 115200.

**`Resource busy` / cannot open COM port**  
Stop `npm start`, Arduino Serial Monitor, and other serial tools. Only one program can hold the port.

**Windows: no COM port**  
Charge-only cable, missing CP210x driver, or wrong USB port. Replug after driver install.

**AHT20 or BMP280 not found**  
Check 3.3 V, GND, SDA=21, SCL=22. BMP280 is tried at `0x76` then `0x77`.

**Cloud ingest HTTP 401**  
`INGEST_TOKEN` in `secrets.h` must match `wrangler secret put INGEST_TOKEN`.

**Cloud ingest skipped**  
Wi‑Fi failed or `INGEST_URL` / token empty. USB `[DATA]` still works.

**Local USB metrics stuck on UV / air / noise N/A**  
Those modules are disabled in firmware until wired and `enable_*` is set `true`.

**Browser cannot reach Local USB**  
Keep the dashboard on `127.0.0.1` (not another hostname) so it can call `http://127.0.0.1:8788`. Allow the page if the browser blocks mixed content; both are HTTP on localhost.

---

## Commands cheat sheet

| Task | Command |
| --- | --- |
| Laptop install | `npm run setup` |
| Live USB dashboard | `npm start` |
| Map `.env` → firmware + local Worker secrets | `npm run map-env --prefix worker` |
| Ingest Worker (local) | `npm run dev --prefix worker` |
| Dashboard only (D1 / simulated) | `npm run dev --prefix semp` |
| Typecheck dashboard | `npm run typecheck --prefix semp` |

---

## License / status

Prototype / PoC for EcoSchool Sense classroom monitoring. Hardware flags and display scores are not a calibrated scientific instrument.
