// CI 用：收集各平台构建产生的 latest.json 片段，合并成完整 latest.json，
// 同时生成 GitHub 变体（url 指向 github releases）和 R2 变体（url 指向公域）。
//
// 输入：
//   artifacts/<job>/latest.json  （job = macos-arm64 / windows-x64）
//     每份只包含自己那个平台的 platforms 条目，由各平台构建脚本生成。
//
// 输出：
//   dist-release/latest.github.json  （url → github.com/.../releases/download/<tag>/<file>）
//   dist-release/latest.r2.json      （url → R2_PUBLIC_BASE/<file>）
//
// 环境变量：
//   VERSION              发版版本号（不带 v 前缀）
//   RELEASE_NOTES_FILE   Release Notes 的文件路径（会读进 notes 字段）
//   R2_PUBLIC_BASE       R2 公域（如 https://melody-singer.harucdn.com）
//   GITHUB_REPOSITORY    owner/repo（GHA 自动注入）
//
// 用法：node scripts/ci-compose-latest-json.mjs

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const artifactsDir = path.join(rootDir, 'artifacts')
const outputDir = path.join(rootDir, 'dist-release')

const version = (process.env.VERSION || '').replace(/^v/, '')
if (!version) {
  console.error('VERSION env var required')
  process.exit(1)
}

const notesFile = process.env.RELEASE_NOTES_FILE
let notes = `webUTAU v${version}`
if (notesFile && existsSync(notesFile)) {
  notes = readFileSync(notesFile, 'utf8').trim() || notes
}

const r2Base = (process.env.R2_PUBLIC_BASE || '').replace(/\/+$/, '')
if (!r2Base) {
  console.error('R2_PUBLIC_BASE env var required')
  process.exit(1)
}

const ghRepo = process.env.GITHUB_REPOSITORY || 'Marigold1122/melody-singer'
const ghReleaseBase = `https://github.com/${ghRepo}/releases/download/v${version}`

if (!existsSync(artifactsDir)) {
  console.error(`No artifacts dir: ${artifactsDir}`)
  process.exit(1)
}

const mergedPlatforms = {}
let pubDate = new Date().toISOString()

for (const jobDir of readdirSync(artifactsDir)) {
  const jsonPath = path.join(artifactsDir, jobDir, 'latest.json')
  if (!existsSync(jsonPath)) continue
  const obj = JSON.parse(readFileSync(jsonPath, 'utf8'))
  if (obj.pub_date) pubDate = obj.pub_date
  if (obj.platforms) {
    for (const [platKey, platVal] of Object.entries(obj.platforms)) {
      mergedPlatforms[platKey] = platVal
    }
  }
}

if (Object.keys(mergedPlatforms).length === 0) {
  console.error('No platform entries found in artifacts/*/latest.json')
  process.exit(1)
}

function makeVariant(baseUrl) {
  const platforms = {}
  for (const [platKey, platVal] of Object.entries(mergedPlatforms)) {
    const fileName = path.posix.basename(platVal.url || '')
    platforms[platKey] = {
      signature: platVal.signature || '',
      url: `${baseUrl}/${fileName}`,
    }
  }
  return { version, notes, pub_date: pubDate, platforms }
}

mkdirSync(outputDir, { recursive: true })

const githubJson = makeVariant(ghReleaseBase)
writeFileSync(
  path.join(outputDir, 'latest.github.json'),
  JSON.stringify(githubJson, null, 2) + '\n',
)

const r2Json = makeVariant(r2Base)
writeFileSync(
  path.join(outputDir, 'latest.r2.json'),
  JSON.stringify(r2Json, null, 2) + '\n',
)

console.log(`✓ Composed latest.json for platforms: ${Object.keys(mergedPlatforms).join(', ')}`)
console.log(`  - ${outputDir}/latest.github.json  (→ ${ghReleaseBase}/)`)
console.log(`  - ${outputDir}/latest.r2.json      (→ ${r2Base}/)`)
