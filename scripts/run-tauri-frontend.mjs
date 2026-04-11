import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(scriptDir, '..')
const viteCli = resolve(rootDir, 'node_modules', 'vite', 'bin', 'vite.js')

const mode = process.argv[2]
const shouldPrepareAssets = process.argv.includes('--prepare-assets')

if (!['dev', 'build'].includes(mode)) {
  console.error('Usage: node scripts/run-tauri-frontend.mjs <dev|build> [--prepare-assets]')
  process.exit(1)
}

if (shouldPrepareAssets) {
  await runCommand(process.execPath, [resolve(scriptDir, 'prepare-tauri-assets.mjs')], {
    env: {
      ...process.env,
      MELODY_TAURI_FRONTEND_MODE: mode,
    },
  })
}

const env = {
  ...process.env,
  VITE_RENDER_API_BASE_URL: process.env.VITE_RENDER_API_BASE_URL || 'http://127.0.0.1:5000',
  VITE_SEEDVC_API_BASE_URL: process.env.VITE_SEEDVC_API_BASE_URL || 'http://127.0.0.1:5001',
}

const args = [viteCli]

if (mode === 'dev') {
  env.MELODY_TAURI_DEV = '1'
  env.MELODY_FRONTEND_PORT = process.env.MELODY_FRONTEND_PORT || '1420'
  args.push('--host', '127.0.0.1', '--port', env.MELODY_FRONTEND_PORT, '--strictPort')
} else {
  args.push('build')
}

await runCommand(process.execPath, args, { env })

function runCommand(command, args, { env = process.env } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env,
      stdio: 'inherit',
    })

    child.on('error', rejectPromise)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      rejectPromise(new Error(`${command} exited with code ${code ?? 'null'}${signal ? ` (signal: ${signal})` : ''}`))
    })
  })
}
