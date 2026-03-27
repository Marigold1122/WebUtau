param(
  [string]$SourceRoot = 'D:\code\melody test 1',
  [string]$BackupRoot = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
  $timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  $parent = Split-Path -Parent $SourceRoot
  $name = Split-Path -Leaf $SourceRoot
  $BackupRoot = Join-Path $parent "${name}_full_backup_${timestamp}"
}

if (Test-Path $BackupRoot) {
  throw "备份目标已存在: $BackupRoot"
}

$excludeDirs = @(
  '.git',
  'server-build-check'
)

$excludeFiles = @(
  'vite.log'
)

$xdArgs = @()
foreach ($dir in $excludeDirs) {
  $xdArgs += Join-Path $SourceRoot $dir
}

$robocopyArgs = @(
  $SourceRoot,
  $BackupRoot,
  '/E',
  '/R:1',
  '/W:1',
  '/NFL',
  '/NDL',
  '/NJH',
  '/NJS',
  '/NP',
  '/XD'
) + $xdArgs + @('/XF') + $excludeFiles

Write-Host "Backing up:"
Write-Host "  Source: $SourceRoot"
Write-Host "  Target: $BackupRoot"

& robocopy @robocopyArgs | Out-Host
$exitCode = $LASTEXITCODE

if ($exitCode -ge 8) {
  throw "robocopy 失败，退出码: $exitCode"
}

Write-Host "Backup complete: $BackupRoot"
