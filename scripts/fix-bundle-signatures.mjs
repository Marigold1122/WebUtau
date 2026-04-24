// 在 tauri build 之后运行：从内到外统一重签 .app 内所有 Mach-O 二进制。
//
// 背景：
//   - tauri build 会对 .app 做 `codesign --deep --force`，这会把我们想给
//     DiffSingerApi 加的 JIT entitlements 覆盖掉。结果就是公证能通过，但
//     用户启动后 .NET JIT 会因为 hardened runtime 缺 allow-jit 而 crash。
//   - 所以签名必须放在 tauri build 之后，从最深层的 binary 签起，逐层往
//     外走，最后把整个 .app 再签一遍。
//
// 流程：
//   1. 递归找 Contents/Resources 下所有 Mach-O，挨个签；JIT 可执行文件
//      附加 runtime-entitlements.plist
//   2. 签 Contents/MacOS/ 下的主可执行文件
//   3. 签整个 .app bundle
//   4. codesign --verify --deep --strict 验收

import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const entitlementsPath = path.join(rootDir, 'src-tauri', 'resources', 'runtime-entitlements.plist')

const signingIdentity = (process.env.APPLE_SIGNING_IDENTITY || '').trim()
if (!signingIdentity) {
  console.log('APPLE_SIGNING_IDENTITY 未设置，跳过 bundle 签名。')
  process.exit(0)
}

if (!existsSync(entitlementsPath)) {
  console.error('runtime-entitlements.plist 不存在:', entitlementsPath)
  process.exit(1)
}

// tauri build --target X 写到 target/{target}/release/bundle/macos；
// 不带 --target 时写到 target/release/bundle/macos。两处都要查。
function resolveBundleBase() {
  const candidates = [path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle', 'macos')]
  const targetRoot = path.join(rootDir, 'src-tauri', 'target')
  try {
    for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'release' || entry.name === 'debug') continue
      candidates.push(path.join(targetRoot, entry.name, 'release', 'bundle', 'macos'))
    }
  } catch {}
  return candidates.find((c) => existsSync(c))
}

const bundleBase = resolveBundleBase()
if (!bundleBase) {
  console.error('未找到 bundle 目录: src-tauri/target/**/release/bundle/macos')
  process.exit(1)
}
console.log(`Bundle base: ${path.relative(rootDir, bundleBase)}`)

const appBundles = readdirSync(bundleBase)
  .filter((name) => name.endsWith('.app'))
  .map((name) => path.join(bundleBase, name))

if (!appBundles.length) {
  console.error('未在 bundle 目录下找到 .app:', bundleBase)
  process.exit(1)
}

function isMachOBinary(filePath) {
  let fd
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(4)
    const bytesRead = readSync(fd, buf, 0, 4, 0)
    if (bytesRead < 4) return false
    const magic = buf.readUInt32BE(0)
    return (
      magic === 0xFEEDFACE ||  // MH_MAGIC
      magic === 0xFEEDFACF ||  // MH_MAGIC_64
      magic === 0xCEFAEDFE ||  // MH_CIGAM
      magic === 0xCFFAEDFE ||  // MH_CIGAM_64
      magic === 0xCAFEBABE ||  // FAT_MAGIC
      magic === 0xBEBAFECA     // FAT_CIGAM
    )
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// 需要 JIT entitlements 的可执行文件名。DiffSingerApi 是 .NET self-contained，
// .NET runtime 在 hardened runtime 下必须豁免 allow-jit。cloudflared 是 Go 静态
// 二进制，不需要。
const JIT_BINARY_NAMES = new Set(['DiffSingerApi'])

function needsJitEntitlements(filePath) {
  const name = path.basename(filePath)
  const ext = path.extname(name).toLowerCase()
  if (ext === '.node' || ext === '.dylib' || ext === '.so') return false
  if (!ext && JIT_BINARY_NAMES.has(name)) return true
  return false
}

function findAllNativeBinaries(dir) {
  const results = []
  function walk(currentDir) {
    let entries
    try {
      entries = readdirSync(currentDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      // Mach-O 通常是 .dylib / .so / .node / 无扩展名；用 magic number 兜底确认
      if (ext === '.dylib' || ext === '.so' || ext === '.node' || ext === '') {
        if (isMachOBinary(full)) results.push(full)
      }
    }
  }
  walk(dir)
  return results
}

function codesignOne(target, { withEntitlements = false, label } = {}) {
  const args = [
    '--force',
    '--options', 'runtime',
    '--timestamp',
    '--sign', signingIdentity,
  ]
  if (withEntitlements) args.push('--entitlements', entitlementsPath)
  args.push(target)

  try {
    execFileSync('codesign', args, { stdio: 'pipe' })
    console.log(`  ✓ ${label}${withEntitlements ? ' (JIT)' : ''}`)
  } catch (error) {
    const stderr = String(error.stderr || '').trim()
    const stdout = String(error.stdout || '').trim()
    console.error(`  ✗ ${label}`)
    if (stderr) console.error(`    stderr: ${stderr}`)
    if (stdout) console.error(`    stdout: ${stdout}`)
    process.exit(1)
  }
}

for (const appBundle of appBundles) {
  console.log(`\n签名 ${path.basename(appBundle)}...`)

  // 1. Resources 里所有 Mach-O（从深到浅）
  const resourcesDir = path.join(appBundle, 'Contents', 'Resources')
  const resourceBinaries = findAllNativeBinaries(resourcesDir)
    .sort((a, b) => b.length - a.length)  // 路径长的先签，保证内层先签
  console.log(`  Resources 下发现 ${resourceBinaries.length} 个 Mach-O`)

  for (const binary of resourceBinaries) {
    const relPath = path.relative(appBundle, binary)
    codesignOne(binary, {
      withEntitlements: needsJitEntitlements(binary),
      label: relPath,
    })
  }

  // 2. Contents/MacOS 下的所有可执行文件（主二进制及辅助工具）
  const macosDir = path.join(appBundle, 'Contents', 'MacOS')
  const macosBinaries = findAllNativeBinaries(macosDir)
  console.log(`  Contents/MacOS 下发现 ${macosBinaries.length} 个 Mach-O`)
  for (const binary of macosBinaries) {
    const relPath = path.relative(appBundle, binary)
    codesignOne(binary, {
      withEntitlements: needsJitEntitlements(binary),
      label: relPath,
    })
  }

  // 3. 整个 .app bundle（最后）
  codesignOne(appBundle, { label: path.basename(appBundle) })

  // 4. 验证
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle], {
    encoding: 'utf8',
    stdio: 'pipe',
  })
  if (verify.status === 0) {
    console.log(`  验证通过`)
  } else {
    console.error(`  验证失败:`)
    if (verify.stderr) console.error(`    ${verify.stderr.trim()}`)
    if (verify.stdout) console.error(`    ${verify.stdout.trim()}`)
    process.exit(1)
  }
}

console.log('\nBundle 签名完成。')
