// CI 用：把这一版所有发布产物（installer、sig、updater tarball、latest.r2.json）
// 同步上传到 Cloudflare R2。安装包文件名带版本号 = 永久缓存；latest.json 覆盖。
//
// 输入：
//   artifacts/<job>/*.dmg / *.msi / *.exe / *.tar.gz / *.sig   ← 各平台产物
//   dist-release/latest.r2.json                                 ← 合并后的 R2 版索引
//
// 环境变量：
//   R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
//   VERSION（仅用于日志）
//
// 用法：node scripts/ci-upload-r2.mjs

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const artifactsDir = path.join(rootDir, 'artifacts')
const releaseDir = path.join(rootDir, 'dist-release')

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  VERSION = 'unknown',
} = process.env

for (const [key, val] of Object.entries({
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
})) {
  if (!val) {
    console.error(`Missing env: ${key}`)
    process.exit(1)
  }
}

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
})

const uploads = []

if (existsSync(artifactsDir)) {
  for (const jobDir of readdirSync(artifactsDir)) {
    const base = path.join(artifactsDir, jobDir)
    if (!statSync(base).isDirectory()) continue
    for (const entry of readdirSync(base)) {
      const full = path.join(base, entry)
      if (!statSync(full).isFile()) continue
      if (entry === 'latest.json') continue
      if (entry.startsWith('.')) continue
      const ext = entry.toLowerCase()
      if (
        ext.endsWith('.dmg') ||
        ext.endsWith('.msi') ||
        ext.endsWith('.exe') ||
        ext.endsWith('.tar.gz') ||
        ext.endsWith('.nsis.zip') ||
        ext.endsWith('.sig') ||
        ext.endsWith('.appimage')
      ) {
        uploads.push({
          key: entry,
          filePath: full,
          cacheControl: 'public, max-age=31536000, immutable',
        })
      }
    }
  }
}

const latestR2 = path.join(releaseDir, 'latest.r2.json')
if (existsSync(latestR2)) {
  uploads.push({
    key: 'latest.json',
    filePath: latestR2,
    cacheControl: 'public, max-age=60, must-revalidate',
  })
}

if (uploads.length === 0) {
  console.error('No files to upload.')
  process.exit(1)
}

const uniqueUploads = []
const seen = new Set()
for (const u of uploads) {
  if (seen.has(u.key)) continue
  seen.add(u.key)
  uniqueUploads.push(u)
}

function contentType(name) {
  if (name.endsWith('.json')) return 'application/json'
  if (name.endsWith('.dmg')) return 'application/x-apple-diskimage'
  if (name.endsWith('.msi')) return 'application/x-msi'
  if (name.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable'
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) return 'application/gzip'
  if (name.endsWith('.zip')) return 'application/zip'
  if (name.endsWith('.appimage')) return 'application/octet-stream'
  if (name.endsWith('.sig')) return 'text/plain'
  return 'application/octet-stream'
}

console.log(`Uploading ${uniqueUploads.length} file(s) to R2 bucket ${R2_BUCKET} (v${VERSION})...`)

let failed = 0
for (const upload of uniqueUploads) {
  const body = readFileSync(upload.filePath)
  const size = body.length
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: upload.key,
        Body: body,
        ContentType: contentType(upload.key),
        CacheControl: upload.cacheControl,
      }),
    )
    const sizeMb = (size / 1024 / 1024).toFixed(1)
    console.log(`  ✓ ${upload.key}  (${sizeMb} MB)`)
  } catch (err) {
    failed += 1
    console.error(`  ✗ ${upload.key}: ${err.message}`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} upload(s) failed.`)
  process.exit(1)
}

console.log(`\n✓ R2 sync complete.`)
