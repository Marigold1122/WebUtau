import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const TARGET_DIR = path.join(ROOT, 'src')
const BASELINE_FILE = path.join(ROOT, 'scripts', 'max-lines-baseline.json')
const MAX_LINES = Number.parseInt(process.env.MAX_LINES || '300', 10)
const STRICT_MODE = process.env.MAX_LINES_STRICT === '1'
const TARGET_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])

async function collectSourceFiles(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(fullPath))
      continue
    }
    if (!entry.isFile()) continue
    if (!TARGET_EXTENSIONS.has(path.extname(entry.name))) continue
    files.push(fullPath)
  }

  return files
}

function countLines(content) {
  if (content.length === 0) return 0
  return content.split(/\r?\n/).length
}

function toRelativePath(absolutePath) {
  return path.relative(ROOT, absolutePath).replaceAll('\\', '/')
}

async function run() {
  const baseline = STRICT_MODE
    ? {}
    : await loadBaseline(BASELINE_FILE)
  const files = await collectSourceFiles(TARGET_DIR)
  const violations = []

  for (const absolutePath of files) {
    const content = await readFile(absolutePath, 'utf8')
    const lineCount = countLines(content)
    if (lineCount > MAX_LINES) {
      const relativePath = toRelativePath(absolutePath)
      const baselineMax = Number.isFinite(baseline[relativePath]) ? baseline[relativePath] : null
      if (baselineMax != null && lineCount <= baselineMax) {
        continue
      }
      violations.push({
        file: relativePath,
        lineCount,
        baselineMax,
      })
    }
  }

  if (violations.length === 0) {
    console.log(
      `[check-max-lines] Passed. Max lines per file: ${MAX_LINES}${STRICT_MODE ? ' (strict)' : ' (baseline aware)'}`,
    )
    return
  }

  console.error(
    `[check-max-lines] Failed. Max lines per file: ${MAX_LINES}${STRICT_MODE ? ' (strict)' : ' (baseline aware)'}`,
  )
  violations
    .sort((left, right) => right.lineCount - left.lineCount)
    .forEach((entry) => {
      if (entry.baselineMax == null) {
        console.error(` - ${entry.file}: ${entry.lineCount} (new violation)`)
      } else {
        console.error(` - ${entry.file}: ${entry.lineCount} (baseline: ${entry.baselineMax})`)
      }
    })
  process.exitCode = 1
}

async function loadBaseline(filePath) {
  try {
    const content = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch (_error) {
    return {}
  }
}

run().catch((error) => {
  console.error('[check-max-lines] Unexpected error:', error?.stack || error?.message || error)
  process.exitCode = 1
})
