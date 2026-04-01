@echo off
setlocal
chcp 65001 >nul
title Melody Singer - Dev Launcher

set "ROOT=%~dp0"
set "SERVER_DIR=%ROOT%server"
set "BACKEND_SCRIPT=%ROOT%start-server.bat"
set "DEFAULT_VOICEBANKS_DIR=%SERVER_DIR%\voicebanks"
set "SEEDVC_SCRIPT=%ROOT%scripts\start-seedvc-service.bat"
set "SEED_VC_ROOT=%ROOT%external\seed-vc"
set "SEEDVC_PYTHON=%SEED_VC_ROOT%\.venv\Scripts\python.exe"

if defined MELODY_VOICEBANKS_DIR (
  set "VOICEBANKS_DIR=%MELODY_VOICEBANKS_DIR%"
) else (
  set "VOICEBANKS_DIR=%DEFAULT_VOICEBANKS_DIR%"
)
set "MELODY_VOICEBANKS_DIR=%VOICEBANKS_DIR%"

echo [check] validating local dev environment...

if not exist "%BACKEND_SCRIPT%" (
  echo [error] backend launcher not found: "%BACKEND_SCRIPT%"
  pause
  exit /b 1
)

if not exist "%VOICEBANKS_DIR%" (
  echo [error] voicebank directory not found: "%VOICEBANKS_DIR%"
  echo [hint] put at least one DiffSinger singer under server\voicebanks\
  pause
  exit /b 1
)

set "HAS_VOICEBANK="
for /f %%I in ('dir /b /ad "%VOICEBANKS_DIR%" 2^>nul') do (
  set "HAS_VOICEBANK=1"
  goto voicebank_ok
)

if not defined HAS_VOICEBANK (
  echo [error] no singer directory found in: "%VOICEBANKS_DIR%"
  echo [hint] expected layout: server\voicebanks\SingerName\...
  pause
  exit /b 1
)

:voicebank_ok

if not exist "%SEEDVC_SCRIPT%" (
  echo [error] SeedVC launcher not found: "%SEEDVC_SCRIPT%"
  pause
  exit /b 1
)

if not exist "%SEED_VC_ROOT%" (
  echo [error] SeedVC repo not found: "%SEED_VC_ROOT%"
  echo [hint] clone Seed-VC into external\seed-vc first
  pause
  exit /b 1
)

if not exist "%SEED_VC_ROOT%\seed_vc_wrapper.py" (
  echo [error] SeedVC repo is incomplete: missing seed_vc_wrapper.py
  pause
  exit /b 1
)

if not exist "%SEEDVC_PYTHON%" (
  echo [error] SeedVC Python env not found: "%SEEDVC_PYTHON%"
  echo [hint] create external\seed-vc\.venv and install dependencies first
  pause
  exit /b 1
)

echo [1/3] starting backend on port 5000...
start "Backend" /d "%ROOT%" cmd /k start-server.bat

echo [2/3] starting local SeedVC service on port 5001...
timeout /t 1 /nobreak >nul
start "SeedVC" /d "%ROOT%scripts" cmd /k start-seedvc-service.bat

echo [3/3] starting frontend on port 3000...
timeout /t 2 /nobreak >nul
start "Frontend" /d "%ROOT%" cmd /k npm run dev

echo.
echo all services have been launched:
echo backend:  http://localhost:5000
echo SeedVC:   http://localhost:5001
echo frontend: http://localhost:3000
echo.
echo closing this window will not stop the launched services.
if "%MELODY_DEV_NO_PAUSE%"=="1" exit /b 0
pause
