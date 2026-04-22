// Windows 构建后运行：对 NSIS 安装包签名（tauri updater 签名，非 Authenticode），并生成 latest.json。
//
// Tauri v2 的 --bundles 不再支持 updater 目标，需要手动完成：
//   1. 用 TAURI_SIGNING_PRIVATE_KEY 对 .exe 签名 → .exe.sig
//   2. 生成 latest.json（包含 windows-x86_64 平台条目）

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const tauriConf = JSON.parse(
  readFileSync(path.join(rootDir, 'src-tauri', 'tauri.conf.json'), 'utf8'),
)
const productName = tauriConf.productName || 'webUTAU'
const version = tauriConf.version || '0.0.0'

const tauriPrivateKey = (process.env.TAURI_SIGNING_PRIVATE_KEY || '').trim()
const tauriPrivateKeyPassword = (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || '').trim()

const nsisDir = path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
if (!existsSync(nsisDir)) {
  console.error('NSIS bundle directory not found:', nsisDir)
  process.exit(1)
}

const candidateName = `${productName}_${version}_x64-setup.exe`
const candidatePath = path.join(nsisDir, candidateName)
let installerPath
if (existsSync(candidatePath)) {
  installerPath = candidatePath
} else {
  const found = readdirSync(nsisDir).find((f) => f.endsWith('-setup.exe'))
  if (!found) {
    console.error('NSIS installer not found:', candidatePath)
    process.exit(1)
  }
  console.warn(`Expected ${candidateName}, found ${found}`)
  installerPath = path.join(nsisDir, found)
}
const installerName = path.basename(installerPath)

console.log(`Installer: ${installerPath}`)

const sigPath = `${installerPath}.sig`

if (tauriPrivateKey) {
  console.log('Signing installer with TAURI_SIGNING_PRIVATE_KEY...')
  const tauriBin = path.join(
    rootDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tauri.cmd' : 'tauri',
  )

  const signResult = spawnSync(tauriBin, ['signer', 'sign', installerPath], {
    encoding: 'utf8',
    shell: true,
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: tauriPrivateKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: tauriPrivateKeyPassword || '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (signResult.status !== 0) {
    console.error('Signer failed:', (signResult.stderr || '').trim())
  }

  if (!existsSync(sigPath) && signResult.stdout?.trim()) {
    writeFileSync(sigPath, signResult.stdout.trim())
  }

  if (existsSync(sigPath)) {
    console.log(`Signature: ${sigPath}`)
  } else {
    console.error('ERROR: signature file not created. Updater will not work!')
    console.error('  stdout:', (signResult.stdout || '').slice(0, 200))
    console.error('  stderr:', (signResult.stderr || '').slice(0, 200))
    process.exit(1)
  }
} else {
  console.warn('TAURI_SIGNING_PRIVATE_KEY not set, skipping signature.')
}

let signature = ''
try {
  signature = existsSync(sigPath) ? readFileSync(sigPath, 'utf8').trim() : ''
} catch {}

const updaterEndpoints = tauriConf.plugins?.updater?.endpoints || []
let releaseBaseUrl = `https://github.com/Marigold1122/melody-singer/releases/download/v${version}`
for (const endpoint of updaterEndpoints) {
  const m = endpoint.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/releases\//)
  if (m) {
    releaseBaseUrl = `${m[1]}/releases/download/v${version}`
    break
  }
}

const latestJson = {
  version,
  notes: `${productName} v${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `${releaseBaseUrl}/${installerName}`,
    },
  },
}

const latestPath = path.join(nsisDir, 'latest.json')
writeFileSync(latestPath, JSON.stringify(latestJson, null, 2) + '\n')
console.log(`latest.json: ${latestPath}`)

console.log(`
=== Windows build complete ===
  Installer : ${installerPath}${existsSync(sigPath) ? `\n  Signature : ${sigPath}` : ''}
  latest.json: ${latestPath}
`)
