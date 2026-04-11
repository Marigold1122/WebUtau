import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { access, cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(scriptDir, '..')
const srcTauriDir = resolve(rootDir, 'src-tauri')
const runtimeResourcesDir = resolve(srcTauriDir, 'resources', 'runtime')
const runtimeBackendDir = resolve(runtimeResourcesDir, 'backend')
const runtimeVoicebanksDir = resolve(runtimeResourcesDir, 'voicebanks-seed')
const manifestPath = resolve(runtimeResourcesDir, 'backend-manifest.json')
const backendProjectPath = resolve(rootDir, 'server', 'DiffSingerApi', 'DiffSingerApi.csproj')
const voicebanksSourceDir = resolve(rootDir, 'server', 'voicebanks')
const backendBuildRoot = resolve(rootDir, 'src-tauri', '.backend-build')
const prepareMode = process.env.MELODY_TAURI_FRONTEND_MODE || 'build'

const host = detectHostPlatform()
const backendExecutable = host.platform === 'win32' ? 'DiffSingerApi.exe' : 'DiffSingerApi'
const defaultBackendSourceDir = resolve(backendBuildRoot, host.key)
const configuredBackendSourceDir = resolveOptionalPath(process.env.MELODY_TAURI_BACKEND_SOURCE_DIR)
const backendSourceDir = configuredBackendSourceDir || defaultBackendSourceDir

await rm(runtimeResourcesDir, { recursive: true, force: true })
await mkdir(runtimeResourcesDir, { recursive: true })

if (configuredBackendSourceDir) {
  await ensureDirExists(configuredBackendSourceDir, [
    `MELODY_TAURI_BACKEND_SOURCE_DIR does not exist: ${configuredBackendSourceDir}`,
    'Expected a self-contained `dotnet publish` output directory that already contains DiffSinger/OpenUtau runtime files.',
  ].join('\n'))
} else {
  const shouldPublishBackend = prepareMode === 'build'
    || process.env.MELODY_TAURI_FORCE_BACKEND_PUBLISH === '1'
    || !existsSync(defaultBackendSourceDir)

  if (shouldPublishBackend) {
    const dotnetBin = await resolveDotnetBinary()
    if (!dotnetBin) {
      throw new Error([
        'Unable to locate `dotnet` for Tauri asset preparation.',
        'Set `DOTNET_BIN` explicitly, or prebuild the backend and point `MELODY_TAURI_BACKEND_SOURCE_DIR` at that publish directory.',
      ].join('\n'))
    }
    await publishBackend(dotnetBin, defaultBackendSourceDir, host.rid)
  }
}

await cp(backendSourceDir, runtimeBackendDir, { recursive: true, force: true })

const hasSeedVoicebanks = await directoryHasFiles(voicebanksSourceDir)
if (hasSeedVoicebanks) {
  await cp(voicebanksSourceDir, runtimeVoicebanksDir, { recursive: true, force: true })
}

const fingerprint = await fingerprintDirectory(runtimeResourcesDir)
const manifest = {
  platform: host.key,
  backendExecutable: backendExecutable,
  fingerprint: fingerprint,
  backendSource: relative(rootDir, backendSourceDir).replaceAll('\\', '/'),
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

async function publishBackend(dotnetBin, outputDir, rid) {
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })

  const args = [
    'publish',
    backendProjectPath,
    '-c',
    'Release',
    '-r',
    rid,
    '--self-contained',
    'true',
    '-p:PublishSingleFile=false',
    '-o',
    outputDir,
  ]

  const onnxProvider = process.env.MELODY_TAURI_ONNX_PROVIDER?.trim()
  if (onnxProvider) {
    args.push(`-p:OnnxProvider=${onnxProvider}`)
  }

  await runCommand(dotnetBin, args)
}

function detectHostPlatform() {
  const { platform, arch } = process
  const key = `${platform}-${arch}`
  const ridByKey = {
    'darwin-arm64': 'osx-arm64',
    'darwin-x64': 'osx-x64',
    'linux-arm64': 'linux-arm64',
    'linux-x64': 'linux-x64',
    'win32-arm64': 'win-arm64',
    'win32-x64': 'win-x64',
  }
  const rid = ridByKey[key]
  if (!rid) {
    throw new Error(`Unsupported host platform for Tauri backend packaging: ${key}`)
  }
  return { platform, arch, key, rid }
}

async function resolveDotnetBinary() {
  const explicit = process.env.DOTNET_BIN?.trim()
  if (explicit) {
    await ensureExecutable(explicit, `DOTNET_BIN is not executable: ${explicit}`)
    return explicit
  }

  if (await commandWorks('dotnet', ['--version'])) {
    return 'dotnet'
  }

  const home = process.env.HOME || ''
  const candidates = [
    '/opt/homebrew/bin/dotnet',
    '/usr/local/bin/dotnet',
    '/usr/local/share/dotnet/dotnet',
    '/usr/share/dotnet/dotnet',
    home ? join(home, '.dotnet', 'dotnet') : '',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    if (await commandWorks(candidate, ['--version'])) {
      return candidate
    }
  }

  return null
}

async function fingerprintDirectory(directory) {
  const hash = createHash('sha256')
  await appendDirectoryFingerprint(hash, directory, directory)
  return hash.digest('hex')
}

async function appendDirectoryFingerprint(hash, root, current) {
  if (!existsSync(current)) return

  const entries = await readdir(current, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    const fullPath = join(current, entry.name)
    const relativePath = relative(root, fullPath).replaceAll('\\', '/')
    if (entry.isDirectory()) {
      hash.update(`dir:${relativePath}\n`)
      await appendDirectoryFingerprint(hash, root, fullPath)
      continue
    }
    const info = await stat(fullPath)
    hash.update(`file:${relativePath}:${info.size}:${Math.trunc(info.mtimeMs)}\n`)
  }
}

async function directoryHasFiles(directory) {
  if (!existsSync(directory)) return false
  const entries = await readdir(directory)
  return entries.some((entry) => entry !== '.DS_Store')
}

function resolveOptionalPath(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? resolve(rootDir, trimmed) : null
}

async function ensureDirExists(directory, message) {
  if (!existsSync(directory)) {
    throw new Error(message)
  }
}

async function ensureExecutable(filePath, message) {
  try {
    await access(filePath)
  } catch {
    throw new Error(message)
  }
}

async function commandWorks(command, args) {
  try {
    await runCommand(command, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function runCommand(command, args, { stdio = 'inherit' } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: process.env,
      stdio,
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
