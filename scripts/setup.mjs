import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIN_NODE_MAJOR = 18
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sempDir = join(root, 'semp')
const isWindows = process.platform === 'win32'
const npmCmd = isWindows ? 'npm.cmd' : 'npm'

function fail(message) {
  console.error(`\n[setup] ${message}`)
  process.exit(1)
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
    shell: isWindows,
  })
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed.`)
}

function nodeMajor() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10)
  return Number.isFinite(major) ? major : 0
}

console.log('EcoSchool Sense — laptop setup')
console.log(`OS: ${process.platform} ${process.arch}`)
console.log(`Node: ${process.version}`)

if (nodeMajor() < MIN_NODE_MAJOR) {
  fail(
    `Node.js ${MIN_NODE_MAJOR}+ is required. Install the LTS build from https://nodejs.org and run this again.`,
  )
}

const npmCheck = spawnSync(npmCmd, ['--version'], { encoding: 'utf8', shell: isWindows })
if (npmCheck.status !== 0) {
  fail('npm was not found. Reinstall Node.js from https://nodejs.org (it includes npm).')
}
console.log(`npm: ${String(npmCheck.stdout || '').trim()}`)

if (!existsSync(join(root, 'package.json')) || !existsSync(join(sempDir, 'package.json'))) {
  fail('Run this from the project folder (package.json and semp/package.json must exist).')
}

console.log('\n[1/3] Installing USB serial tools…')
run(npmCmd, ['install'], root)

console.log('\n[2/3] Installing the dashboard…')
run(npmCmd, ['install'], sempDir)

console.log('\n[3/3] Checking for a connected sensor board…')
try {
  const { SerialPort } = await import('serialport')
  const ports = await SerialPort.list()
  const usbish = ports.filter((port) => {
    const hay = [port.path, port.manufacturer, port.friendlyName, port.pnpId, port.vendorId]
      .filter(Boolean)
      .join(' ')
    if (/bluetooth|debug-console|incoming/i.test(hay)) return false
    return /usbserial|usbmodem|cp210|silicon labs|ch340|wch|ftdi|^COM\d+$/i.test(hay)
  })

  if (usbish.length === 0) {
    console.log('No USB serial board found yet. Plug in the ESP32 and try again if needed.')
    if (isWindows) {
      console.log(
        'Windows: if the board never appears, install the Silicon Labs CP210x driver, then replug the USB cable.',
      )
    }
  } else {
    console.log('Possible sensor ports:')
    for (const port of usbish) {
      const extra = [port.manufacturer, port.friendlyName, port.vendorId].filter(Boolean).join(' · ')
      console.log(`  ${port.path}${extra ? `  (${extra})` : ''}`)
    }
  }
} catch (error) {
  console.warn(`[setup] Could not list serial ports: ${error.message}`)
}

console.log('\nSetup finished.')
console.log('1. Plug in the ESP32 over USB.')
console.log('2. From this folder run:  npm start')
console.log('3. The dashboard opens at http://127.0.0.1:8787/?zone=classroom&mode=local')
console.log('4. In the header, keep “Local USB” selected.')
if (isWindows) {
  console.log('\nIf the board is not detected, set the port first, for example:')
  console.log('  set SERIAL_PORT=COM3')
  console.log('  npm start')
} else {
  console.log('\nIf the board is not detected, set the port first, for example:')
  console.log('  SERIAL_PORT=/dev/cu.usbserial-0001 npm start')
}
console.log('')
