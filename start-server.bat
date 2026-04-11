@echo off
setlocal
chcp 65001 >nul
title webUTAU - Backend Launcher

set "ROOT=%~dp0"
set "SERVER_DIR=%ROOT%server"
set "BACKEND_EXE=%SERVER_DIR%\DiffSingerApi.exe"
set "BACKEND_RUNTIMECONFIG=%SERVER_DIR%\DiffSingerApi.runtimeconfig.json"
set "BACKEND_DEPS=%SERVER_DIR%\DiffSingerApi.deps.json"
set "BACKEND_PROJECT=%SERVER_DIR%\DiffSingerApi\DiffSingerApi.csproj"
set "DEFAULT_VOICEBANKS_DIR=%SERVER_DIR%\voicebanks"

if defined MELODY_VOICEBANKS_DIR (
  set "VOICEBANKS_DIR=%MELODY_VOICEBANKS_DIR%"
) else (
  set "VOICEBANKS_DIR=%DEFAULT_VOICEBANKS_DIR%"
)

echo ========================================
echo   Starting webUTAU backend...
echo   Keep this window open while developing
echo ========================================
echo.

if not exist "%VOICEBANKS_DIR%" (
  echo [error] voicebank directory not found: "%VOICEBANKS_DIR%"
  echo [hint] prepare DiffSinger singers before launching the backend
  goto fail
)

set "USE_SOURCE_BACKEND="
if /I not "%VOICEBANKS_DIR%"=="%DEFAULT_VOICEBANKS_DIR%" (
  set "USE_SOURCE_BACKEND=1"
)
if not exist "%BACKEND_EXE%" (
  set "USE_SOURCE_BACKEND=1"
)
if not exist "%BACKEND_RUNTIMECONFIG%" (
  set "USE_SOURCE_BACKEND=1"
)
if not exist "%BACKEND_DEPS%" (
  set "USE_SOURCE_BACKEND=1"
)

if defined USE_SOURCE_BACKEND (
  if not exist "%BACKEND_PROJECT%" (
    echo [error] backend project not found: "%BACKEND_PROJECT%"
    goto fail
  )

  where dotnet >nul 2>nul
  if errorlevel 1 (
    echo [error] published runtime files are incomplete and dotnet was not found.
    echo [hint] install .NET 8 SDK or publish the backend into server\
    goto fail
  )

  echo [info] published backend files are incomplete, falling back to source mode.
  echo [info] voicebanks: "%VOICEBANKS_DIR%"
  if not defined MELODY_ONNX_PROVIDER set "MELODY_ONNX_PROVIDER=Cuda"
  echo [info] ONNX provider: %MELODY_ONNX_PROVIDER%
  cd /d "%SERVER_DIR%\DiffSingerApi"
  dotnet run -p:OnnxProvider=%MELODY_ONNX_PROVIDER% -- --VoicebanksPath="%VOICEBANKS_DIR%"
  goto end
)

echo [info] starting published backend.
cd /d "%SERVER_DIR%"
"%BACKEND_EXE%"
goto end

:fail
echo.
if "%MELODY_DEV_NO_PAUSE%"=="1" exit /b 1
pause
exit /b 1

:end
if "%MELODY_DEV_NO_PAUSE%"=="1" exit /b 0
pause
