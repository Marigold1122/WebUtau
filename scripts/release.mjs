// 本地一键发版：bump 版本号、归档更新日志、提交打 tag 并推送。
//
// 使用：
//   1. 在 notes/CHANGELOG-next.md 里写好这一版的更新日志（中文自由发挥）
//   2. 跑 `npm run release <version>` 例如 `npm run release 1.0.1`
//
// 它会：
//   1. 校验 semver 格式、工作区干净、当前分支是远端默认分支、已与远端同步
//   2. 改写 package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json 三处版本号
//   3. 跑 `npm install --package-lock-only` + `cargo generate-lockfile` 同步 lock
//   4. 把 notes/CHANGELOG-next.md 复制到 notes/v<version>.md，并重置为空模板
//   5. git add -A → commit "v<version>" → 打注解 tag（内容 = 更新日志） → push
//   6. tag push 会触发 .github/workflows/release.yml 的三平台并行构建 + 发版 + R2 镜像流水线
//
// 想演练不想真推？加 `--dry-run`：打印全部预期操作但不执行 git 写入。

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const notesDir = path.join(rootDir, 'notes')
const nextNotesPath = path.join(notesDir, 'CHANGELOG-next.md')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const rawVersion = args.find((arg) => !arg.startsWith('--'))

function fail(message) {
  console.error(`\n❌ ${message}\n`)
  process.exit(1)
}

function info(message) {
  console.log(`→ ${message}`)
}

function run(cmd, options = {}) {
  info(`$ ${cmd}`)
  if (dryRun) return ''
  try {
    return execSync(cmd, {
      cwd: rootDir,
      stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      encoding: 'utf8',
    })
  } catch (err) {
    fail(`命令失败: ${cmd}\n${err.message}`)
  }
}

// ---------- 1. 校验参数 ----------

if (!rawVersion) {
  fail('用法: npm run release <version>  例如 npm run release 1.0.1')
}

const version = rawVersion.replace(/^v/, '')
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  fail(`版本号格式不对: ${version}（期望 semver，如 1.0.1 或 1.0.1-beta.1）`)
}

const tagName = `v${version}`

// ---------- 2. 校验工作区 ----------

const gitStatus = execSync('git status --porcelain', { cwd: rootDir, encoding: 'utf8' })
if (gitStatus.trim() && !dryRun) {
  const dirty = gitStatus
    .split('\n')
    .filter(Boolean)
    .filter((line) => !line.endsWith('notes/CHANGELOG-next.md'))
  if (dirty.length > 0) {
    fail(`工作区有未提交改动，请先 commit 或 stash：\n${dirty.join('\n')}`)
  }
}

const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
  cwd: rootDir,
  encoding: 'utf8',
}).trim()

function resolveDefaultBranch() {
  try {
    const ref = execSync('git symbolic-ref --short refs/remotes/origin/HEAD', {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim()
    const parts = ref.split('/')
    if (parts.length >= 2) return parts.slice(1).join('/')
  } catch {}
  try {
    const raw = execSync('git ls-remote --symref origin HEAD', {
      cwd: rootDir,
      encoding: 'utf8',
    })
    const match = raw.match(/^ref:\s*refs\/heads\/(\S+)\s+HEAD/m)
    if (match) return match[1]
  } catch {}
  return currentBranch
}

const defaultBranch = resolveDefaultBranch()
info(`检测到远端默认分支：${defaultBranch}`)

if (currentBranch !== defaultBranch && !dryRun) {
  fail(`当前分支是 ${currentBranch}，发版必须在 ${defaultBranch} 上。`)
}

if (!dryRun) {
  info(`拉取远端确认同步（origin/${defaultBranch}）...`)
  execSync(`git fetch origin ${defaultBranch}`, { cwd: rootDir, stdio: 'inherit' })
  const behindAhead = execSync(
    `git rev-list --left-right --count HEAD...origin/${defaultBranch}`,
    { cwd: rootDir, encoding: 'utf8' },
  ).trim()
  const [ahead, behind] = behindAhead.split(/\s+/).map(Number)
  if (behind > 0) fail(`本地落后远端 ${behind} 个 commit，先 git pull。`)
  if (ahead > 0) info(`本地领先远端 ${ahead} 个 commit（它们会随本次 release commit 一起推）`)
}

// ---------- 3. 校验 CHANGELOG-next.md ----------

if (!existsSync(nextNotesPath)) {
  fail(`没有 ${nextNotesPath}。请先创建并写入本版更新日志，再跑这个脚本。`)
}

const changelogContent = readFileSync(nextNotesPath, 'utf8').trim()
const nonBlankLines = changelogContent
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('<!--'))
if (nonBlankLines.length === 0) {
  fail(`${nextNotesPath} 是空的——先写本版的更新日志再来。`)
}

// ---------- 4. Bump 版本号 ----------

function bumpJsonVersion(filePath) {
  const raw = readFileSync(filePath, 'utf8')
  const obj = JSON.parse(raw)
  const oldVersion = obj.version
  obj.version = version
  const serialized = JSON.stringify(obj, null, 2) + '\n'
  if (!dryRun) writeFileSync(filePath, serialized)
  info(`${path.relative(rootDir, filePath)}: ${oldVersion} → ${version}`)
}

function bumpTomlVersion(filePath) {
  const raw = readFileSync(filePath, 'utf8')
  const replaced = raw.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${version}"`)
  if (replaced === raw) fail(`在 ${filePath} 里找不到可替换的 version 行。`)
  if (!dryRun) writeFileSync(filePath, replaced)
  info(`${path.relative(rootDir, filePath)} 的 version → ${version}`)
}

bumpJsonVersion(path.join(rootDir, 'package.json'))
bumpJsonVersion(path.join(rootDir, 'src-tauri', 'tauri.conf.json'))
bumpTomlVersion(path.join(rootDir, 'src-tauri', 'Cargo.toml'))

// ---------- 5. 同步 lock 文件 ----------

info('同步 package-lock.json...')
run('npm install --package-lock-only --ignore-scripts')

info('同步 Cargo.lock...')
run('cd src-tauri && cargo generate-lockfile')

// ---------- 6. 归档更新日志 ----------

mkdirSync(notesDir, { recursive: true })
const archivedNotesPath = path.join(notesDir, `${tagName}.md`)
if (!dryRun) {
  copyFileSync(nextNotesPath, archivedNotesPath)
  const template = [
    '<!-- 在这里写下一个版本的更新日志，中文自由发挥 -->',
    '<!-- 发版时会自动归档到 notes/v<version>.md 并作为 GitHub Release Notes 与 latest.json 的 notes 字段 -->',
    '',
    '',
  ].join('\n')
  writeFileSync(nextNotesPath, template)
}
info(`更新日志归档到 notes/${tagName}.md；CHANGELOG-next.md 已重置`)

// ---------- 7. Git commit + tag + push ----------

info('准备 git commit...')
run('git add -A')
run(`git commit -m "${tagName}"`)

info(`打注解 tag ${tagName}（注解内容 = 更新日志）`)
if (!dryRun) {
  // --cleanup=verbatim 保留 Markdown 标题——git 默认的 strip 模式会把所有以 # 开头的行
  // 当注释删掉，导致 ## / ### 全军覆没（v1.1.2 release 就是这么丢的小标题）
  const result = spawnSync('git', ['tag', '-a', tagName, '--cleanup=verbatim', '-F', archivedNotesPath], {
    cwd: rootDir,
    stdio: 'inherit',
  })
  if (result.status !== 0) fail('git tag 失败')
}

info(`推送 ${defaultBranch} + tag 到 origin...`)
run(`git push origin ${defaultBranch}`)
run(`git push origin ${tagName}`)

console.log(`
✅ 发版触发成功：${tagName}

下一步：
  1. 打开 https://github.com/Marigold1122/melody-singer/actions 观察 release workflow
  2. 首次运行会停在 "Waiting for review" — 到 Actions 页面点 Approve 进入构建
  3. 构建成功后 GitHub Releases + R2 公域会同步出现 ${tagName}
${dryRun ? '\n⚠️ 本次是 --dry-run，以上命令未实际执行。\n' : ''}`)
