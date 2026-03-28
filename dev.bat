@echo off
setlocal
chcp 65001 >nul
title Melody Singer - Dev Launcher

set "ROOT=%~dp0"
set "SERVER_DIR=%ROOT%server"
set "BACKEND_EXE=%SERVER_DIR%\DiffSingerApi.exe"
set "VOICEBANKS_DIR=%SERVER_DIR%\voicebanks"
set "SEEDVC_SCRIPT=%ROOT%scripts\start-seedvc-service.bat"
set "SEED_VC_ROOT=%ROOT%external\seed-vc"
set "SEEDVC_PYTHON=%SEED_VC_ROOT%\.venv\Scripts\python.exe"

echo [检查] 开发环境启动前检查...

if not exist "%BACKEND_EXE%" (
  echo [错误] 未找到后端程序: "%BACKEND_EXE%"
  echo [提示] 请先从 GitHub Releases 下载后端压缩包并解压到项目根目录下的 server\ 文件夹。
  pause
  exit /b 1
)

if not exist "%VOICEBANKS_DIR%" (
  echo [错误] 未找到声库目录: "%VOICEBANKS_DIR%"
  echo [提示] 请先创建 server\voicebanks\ 并放入至少一个可用的 DiffSinger 声库。
  pause
  exit /b 1
)

set "HAS_VOICEBANK="
for /f %%I in ('dir /b /ad "%VOICEBANKS_DIR%" 2^>nul') do (
  set "HAS_VOICEBANK=1"
  goto voicebank_ok
)

if not defined HAS_VOICEBANK (
  echo [错误] 当前没有可用声库: "%VOICEBANKS_DIR%"
  echo [提示] 请将歌手模型按 server\voicebanks\歌手名\... 的结构放入后再重试。
  pause
  exit /b 1
)

:voicebank_ok

if not exist "%SEEDVC_SCRIPT%" (
  echo [错误] 未找到 SeedVC 启动脚本: "%SEEDVC_SCRIPT%"
  pause
  exit /b 1
)

if not exist "%SEED_VC_ROOT%" (
  echo [错误] 未找到 SeedVC 代码目录: "%SEED_VC_ROOT%"
  echo [提示] 请先按照 README 克隆 Seed-VC 到 external\seed-vc\ 目录。
  pause
  exit /b 1
)

if not exist "%SEED_VC_ROOT%\seed_vc_wrapper.py" (
  echo [错误] SeedVC 目录不完整，缺少 seed_vc_wrapper.py
  echo [提示] 请检查 external\seed-vc\ 是否为正确的 Seed-VC 仓库内容。
  pause
  exit /b 1
)

if not exist "%SEEDVC_PYTHON%" (
  echo [错误] 未找到 SeedVC Python 环境: "%SEEDVC_PYTHON%"
  echo [提示] 请先在 external\seed-vc\ 中创建 .venv 并安装 README 里的依赖。
  pause
  exit /b 1
)

echo [1/3] 启动后端 ^(DiffSingerApi, port 5000^)...
start "Backend" /d "%SERVER_DIR%" cmd /k DiffSingerApi.exe

echo [2/3] 启动本地 SeedVC 服务 ^(port 5001^)...
timeout /t 1 /nobreak >nul
start "SeedVC" /d "%ROOT%scripts" cmd /k start-seedvc-service.bat

echo [3/3] 启动前端 ^(Vite, port 3000^)...
timeout /t 2 /nobreak >nul
start "Frontend" /d "%ROOT%" cmd /k npm run dev

echo.
echo 所有服务已发起启动:
echo 后端:  http://localhost:5000
echo SeedVC: http://localhost:5001
echo 前端:  http://localhost:3000
echo.
echo 关闭此窗口不会影响已启动的服务。
if "%MELODY_DEV_NO_PAUSE%"=="1" exit /b 0
pause
