@echo off
setlocal
chcp 65001 >nul
title webUTAU - Dev Launcher

REM ========================================
REM Paths and defaults
REM ========================================
set "ROOT=%~dp0"
set "SELF=%~f0"
set "PROJECT=%ROOT%server\DiffSingerApi\DiffSingerApi.csproj"
set "OPENUTAU_CORE=%ROOT%OpenUtau\OpenUtau.Core\OpenUtau.Core.csproj"
set "BACKEND_RUNTIME_EXE=%ROOT%server\DiffSingerApi.exe"
set "BACKEND_RUNTIME_DLL=%ROOT%server\DiffSingerApi.dll"
set "BACKEND_RUNTIME_CONFIG=%ROOT%server\DiffSingerApi.runtimeconfig.json"
set "BACKEND_DEPS=%ROOT%server\DiffSingerApi.deps.json"
set "SEEDVC_APP=%ROOT%scripts\seedvc_service\app.py"
set "SEEDVC_ROOT=%ROOT%external\seed-vc"
set "SEEDVC_PYTHON=%SEEDVC_ROOT%\.venv\Scripts\python.exe"
set "DEFAULT_VOICEBANKS_DIR=%ROOT%server\voicebanks"

if defined MELODY_VOICEBANKS_DIR (
  set "VOICEBANKS_DIR=%MELODY_VOICEBANKS_DIR%"
) else (
  set "VOICEBANKS_DIR=%DEFAULT_VOICEBANKS_DIR%"
)

set "BACKEND_HEALTH_URL=http://127.0.0.1:5000/api/voicebanks"
set "SEEDVC_HEALTH_URL=http://127.0.0.1:5001/health"

if not defined MELODY_FRONTEND_PORT set "MELODY_FRONTEND_PORT=3000"
set "FRONTEND_PORT=%MELODY_FRONTEND_PORT%"

if not defined MELODY_BACKEND_START_TIMEOUT  set "MELODY_BACKEND_START_TIMEOUT=180"
if not defined MELODY_SEEDVC_START_TIMEOUT   set "MELODY_SEEDVC_START_TIMEOUT=60"
if not defined MELODY_FRONTEND_START_TIMEOUT set "MELODY_FRONTEND_START_TIMEOUT=90"

REM ========================================
REM Command dispatch
REM ========================================
set "COMMAND=%~1"
if "%COMMAND%"=="" set "COMMAND=all"

if /I "%COMMAND%"=="all"             goto cmd_all
if /I "%COMMAND%"=="full"            goto cmd_full
if /I "%COMMAND%"=="check"           goto cmd_check
if /I "%COMMAND%"=="backend"         goto cmd_backend
if /I "%COMMAND%"=="backend-runtime" goto cmd_backend_runtime
if /I "%COMMAND%"=="backend-source"  goto cmd_backend_source
if /I "%COMMAND%"=="seedvc"          goto cmd_seedvc
if /I "%COMMAND%"=="frontend"        goto cmd_frontend
if /I "%COMMAND%"=="help"            goto cmd_help
if /I "%COMMAND%"=="-h"              goto cmd_help
if /I "%COMMAND%"=="--help"          goto cmd_help

echo [error] unsupported command: %COMMAND%
goto cmd_help

REM ========================================
REM help
REM ========================================
:cmd_help
echo.
echo Usage:
echo   dev.bat                   Backend + Frontend
echo   dev.bat all               same; also starts SeedVC if available
echo   dev.bat full              force Backend + SeedVC + Frontend
echo   dev.bat check             check dev environment
echo   dev.bat backend           auto-pick runtime or source
echo   dev.bat backend-runtime   published runtime only
echo   dev.bat backend-source    source project only
echo   dev.bat seedvc            SeedVC service only
echo   dev.bat frontend [port]   frontend only, default 3000
echo   dev.bat help              show this help
echo.
echo Environment variables:
echo   MELODY_VOICEBANKS_DIR          voicebank dir (default .\server\voicebanks)
echo   MELODY_FRONTEND_PORT           frontend port (default 3000)
echo   MELODY_ONNX_PROVIDER           ONNX provider: Cuda (default) or DirectML
echo   MELODY_ONNX_RUNNER             runtime override: CUDA, DirectML, or CPU
echo   MELODY_BACKEND_START_TIMEOUT   backend health timeout seconds (default 180)
echo   MELODY_SEEDVC_START_TIMEOUT    seedvc health timeout seconds (default 60)
echo   MELODY_FRONTEND_START_TIMEOUT  frontend health timeout seconds (default 90)
echo.
goto end_ok

REM ========================================
REM Utility functions
REM ========================================

:port_is_listening
netstat -ano 2>nul | findstr "LISTENING" | findstr ":%~1 " >nul 2>nul
exit /b %ERRORLEVEL%

:http_is_ready
curl -fsS "%~1" >nul 2>nul
exit /b %ERRORLEVEL%

:wait_for_http
set "_wfh_name=%~1"
set "_wfh_url=%~2"
set "_wfh_max=%~3"
set "_wfh_i=0"
:wait_for_http_loop
if %_wfh_i% geq %_wfh_max% (
  echo [error] %_wfh_name% failed to start within %_wfh_max%s: %_wfh_url%
  exit /b 1
)
curl -fsS "%_wfh_url%" >nul 2>nul
if not errorlevel 1 exit /b 0
timeout /t 1 /nobreak >nul
set /a "_wfh_i+=1"
goto wait_for_http_loop

:pick_frontend_port
for /l %%P in (%~1,1,65535) do (
  call :port_is_listening %%P
  if errorlevel 1 (
    set "FRONTEND_PORT=%%P"
    exit /b 0
  )
  echo [hint] port %%P in use, trying next...
)
echo [error] no available frontend port found starting from %~1
exit /b 1

:warn_if_no_voicebanks
if not exist "%VOICEBANKS_DIR%" (
  echo [warn] voicebank dir not found: "%VOICEBANKS_DIR%"
  echo [hint] /api/voicebanks may return empty after backend starts.
  exit /b 0
)
set "_has_vb="
for /f %%I in ('dir /b /ad "%VOICEBANKS_DIR%" 2^>nul') do (
  set "_has_vb=1"
  goto _warn_vb_done
)
:_warn_vb_done
if not defined _has_vb (
  echo [warn] voicebank dir is empty: "%VOICEBANKS_DIR%"
  echo [hint] /api/voicebanks may return empty after backend starts.
)
exit /b 0

:resolve_dotnet
where dotnet >nul 2>nul
if not errorlevel 1 exit /b 0
echo [error] dotnet not found in PATH. Please install .NET 8 SDK.
exit /b 1

:backend_runtime_is_available
if not exist "%BACKEND_RUNTIME_CONFIG%" exit /b 1
if not exist "%BACKEND_DEPS%" exit /b 1
if exist "%BACKEND_RUNTIME_EXE%" exit /b 0
if exist "%BACKEND_RUNTIME_DLL%" exit /b 0
exit /b 1

:seedvc_is_available
if not exist "%SEEDVC_ROOT%" exit /b 1
if not exist "%SEEDVC_APP%" exit /b 1
if not exist "%SEEDVC_PYTHON%" exit /b 1
exit /b 0

:pick_backend_mode
call :backend_runtime_is_available
if not errorlevel 1 (
  set "RESOLVED_BACKEND_MODE=runtime"
  exit /b 0
)
if exist "%PROJECT%" if exist "%OPENUTAU_CORE%" (
  set "RESOLVED_BACKEND_MODE=source"
  exit /b 0
)
set "RESOLVED_BACKEND_MODE=source"
exit /b 0

REM ========================================
REM Prerequisites
REM ========================================

:ensure_backend_runtime_prereqs
call :backend_runtime_is_available
if errorlevel 1 (
  echo [error] published runtime files not found.
  echo [hint] use "dev.bat backend-source" or run dotnet publish first.
  exit /b 1
)
call :resolve_dotnet
if not errorlevel 1 exit /b 0
REM dotnet missing - self-contained exe does not need it
if exist "%BACKEND_RUNTIME_EXE%" exit /b 0
exit /b 1

:ensure_backend_source_prereqs
call :resolve_dotnet
if errorlevel 1 exit /b 1
if not exist "%PROJECT%" (
  echo [error] source project not found: "%PROJECT%"
  exit /b 1
)
if not exist "%OPENUTAU_CORE%" (
  echo [error] OpenUtau source not found: "%OPENUTAU_CORE%"
  echo [hint] place OpenUtau under repo root OpenUtau\
  exit /b 1
)
exit /b 0

:ensure_seedvc_prereqs
if not exist "%SEEDVC_ROOT%" (
  echo [error] SeedVC source dir not found: "%SEEDVC_ROOT%"
  exit /b 1
)
if not exist "%SEEDVC_APP%" (
  echo [error] SeedVC entry not found: "%SEEDVC_APP%"
  exit /b 1
)
if not exist "%SEEDVC_PYTHON%" (
  echo [error] SeedVC Python env not found: "%SEEDVC_PYTHON%"
  echo [hint] install external\seed-vc\.venv dependencies first.
  exit /b 1
)
exit /b 0

:ensure_frontend_prereqs
where npm >nul 2>nul
if errorlevel 1 (
  echo [error] npm not found. Please install Node.js.
  exit /b 1
)
if not exist "%ROOT%node_modules" (
  echo [error] node_modules not found. Run npm install first.
  exit /b 1
)
exit /b 0

REM ========================================
REM check
REM ========================================
:cmd_check
echo [check] validating dev environment...
echo.

set "_check_ok=1"

where dotnet >nul 2>nul
if errorlevel 1 (
  echo dotnet:    not installed
  set "_check_ok="
) else (
  for /f "delims=" %%V in ('dotnet --version 2^>nul') do echo dotnet:    %%V
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm:       not installed
  set "_check_ok="
) else (
  for /f "delims=" %%V in ('npm --version 2^>nul') do echo npm:       %%V
)

if exist "%ROOT%node_modules" (
  echo modules:   ok
) else (
  echo modules:   node_modules missing
  set "_check_ok="
)

call :warn_if_no_voicebanks

call :backend_runtime_is_available
if not errorlevel 1 (
  echo backend:   published runtime available
  echo mode:      runtime
) else (
  if exist "%PROJECT%" if exist "%OPENUTAU_CORE%" (
    echo backend:   runtime not found, source project available
    echo mode:      source
  ) else (
    echo backend:   neither runtime nor source available
    set "_check_ok="
  )
)

call :seedvc_is_available
if not errorlevel 1 (
  echo seedvc:    ready (optional)
) else (
  echo seedvc:    not ready (optional, won't block startup)
)

echo.
if defined _check_ok (
  echo [pass] dev environment is ready.
) else (
  echo [fail] missing dependencies, see hints above.
)
goto end_ok

REM ========================================
REM backend (auto)
REM ========================================
:cmd_backend
call :pick_backend_mode
call :warn_if_no_voicebanks
echo [mode] backend using %RESOLVED_BACKEND_MODE%
if "%RESOLVED_BACKEND_MODE%"=="runtime" goto _run_backend_runtime
goto _run_backend_source

REM ========================================
REM backend-runtime
REM ========================================
:cmd_backend_runtime
call :ensure_backend_runtime_prereqs
if errorlevel 1 goto end_fail
call :warn_if_no_voicebanks
goto _run_backend_runtime

:_run_backend_runtime
if exist "%BACKEND_RUNTIME_EXE%" (
  echo [start] backend (exe runtime)
  cd /d "%ROOT%server"
  "%BACKEND_RUNTIME_EXE%"
) else (
  echo [start] backend (dll runtime)
  cd /d "%ROOT%server"
  dotnet "%BACKEND_RUNTIME_DLL%"
)
goto end_ok

REM ========================================
REM backend-source
REM ========================================
:cmd_backend_source
call :ensure_backend_source_prereqs
if errorlevel 1 goto end_fail
call :warn_if_no_voicebanks
goto _run_backend_source

:_run_backend_source
echo [start] backend (source)
echo [info] voicebanks: "%VOICEBANKS_DIR%"
if not defined MELODY_ONNX_PROVIDER set "MELODY_ONNX_PROVIDER=Cuda"
echo [info] ONNX provider: %MELODY_ONNX_PROVIDER%
cd /d "%ROOT%server\DiffSingerApi"
dotnet run -p:OnnxProvider=%MELODY_ONNX_PROVIDER% -- --VoicebanksPath="%VOICEBANKS_DIR%"
goto end_ok

REM ========================================
REM seedvc
REM ========================================
:cmd_seedvc
call :ensure_seedvc_prereqs
if errorlevel 1 goto end_fail
echo [start] SeedVC service
cd /d "%ROOT%scripts\seedvc_service"
"%SEEDVC_PYTHON%" app.py
goto end_ok

REM ========================================
REM frontend
REM ========================================
:cmd_frontend
call :ensure_frontend_prereqs
if errorlevel 1 goto end_fail
set "_fe_port=%~2"
if "%_fe_port%"=="" set "_fe_port=%FRONTEND_PORT%"
echo [start] frontend on port %_fe_port%
cd /d "%ROOT%"
npm run dev -- --host 127.0.0.1 --port %_fe_port%
goto end_ok

REM ========================================
REM all / full
REM ========================================
:cmd_all
set "_seedvc_mode=auto"
goto _run_all

:cmd_full
set "_seedvc_mode=always"
goto _run_all

:_run_all
call :pick_backend_mode

if "%RESOLVED_BACKEND_MODE%"=="runtime" goto _all_check_runtime
goto _all_check_source

:_all_check_runtime
call :ensure_backend_runtime_prereqs
if errorlevel 1 goto end_fail
goto _all_backend_prereqs_ok

:_all_check_source
call :ensure_backend_source_prereqs
if errorlevel 1 goto end_fail

:_all_backend_prereqs_ok
call :ensure_frontend_prereqs
if errorlevel 1 goto end_fail

call :warn_if_no_voicebanks

set "_start_seedvc=0"
if "%_seedvc_mode%"=="always" goto _all_seedvc_always
if "%_seedvc_mode%"=="auto" goto _all_seedvc_auto
goto _all_seedvc_decided

:_all_seedvc_always
call :ensure_seedvc_prereqs
if errorlevel 1 goto end_fail
set "_start_seedvc=1"
goto _all_seedvc_decided

:_all_seedvc_auto
call :seedvc_is_available
if not errorlevel 1 set "_start_seedvc=1"
goto _all_seedvc_decided

:_all_seedvc_decided
call :pick_frontend_port %FRONTEND_PORT%

REM ---- launch backend ----
call :http_is_ready "%BACKEND_HEALTH_URL%"
if not errorlevel 1 (
  echo [reuse] backend already running: http://127.0.0.1:5000
  goto _all_backend_ready
)
call :port_is_listening 5000
if not errorlevel 1 (
  echo [error] port 5000 in use but not a valid DiffSinger backend.
  goto end_fail
)

echo [mode] backend using %RESOLVED_BACKEND_MODE%
if "%RESOLVED_BACKEND_MODE%"=="runtime" goto _all_start_backend_runtime
goto _all_start_backend_source

:_all_start_backend_runtime
start "Backend" /d "%ROOT%" "%SELF%" backend-runtime
goto _all_wait_backend

:_all_start_backend_source
start "Backend" /d "%ROOT%" "%SELF%" backend-source

:_all_wait_backend
echo [wait] backend health check...
call :wait_for_http "Backend" "%BACKEND_HEALTH_URL%" %MELODY_BACKEND_START_TIMEOUT%
if errorlevel 1 goto end_fail
echo [ready] backend: http://127.0.0.1:5000

:_all_backend_ready

REM ---- launch seedvc ----
if "%_start_seedvc%"=="0" (
  echo [skip] SeedVC not configured, skipping.
  goto _all_seedvc_done
)

call :http_is_ready "%SEEDVC_HEALTH_URL%"
if not errorlevel 1 (
  echo [reuse] SeedVC already running: http://127.0.0.1:5001
  goto _all_seedvc_done
)
call :port_is_listening 5001
if not errorlevel 1 (
  echo [error] port 5001 in use but not a valid SeedVC service.
  goto end_fail
)

start "SeedVC" /d "%ROOT%" "%SELF%" seedvc

echo [wait] SeedVC health check...
call :wait_for_http "SeedVC" "%SEEDVC_HEALTH_URL%" %MELODY_SEEDVC_START_TIMEOUT%
if errorlevel 1 goto _all_seedvc_warn
echo [ready] SeedVC: http://127.0.0.1:5001
goto _all_seedvc_done

:_all_seedvc_warn
echo [warn] SeedVC startup timed out, continuing without it.

:_all_seedvc_done

REM ---- launch frontend ----
start "Frontend" /d "%ROOT%" "%SELF%" frontend %FRONTEND_PORT%

echo [wait] frontend health check...
call :wait_for_http "Frontend" "http://127.0.0.1:%FRONTEND_PORT%" %MELODY_FRONTEND_START_TIMEOUT%
if errorlevel 1 goto end_fail
echo [ready] frontend: http://127.0.0.1:%FRONTEND_PORT%

REM ---- summary ----
echo.
echo ========================================
echo   All services launched:
echo   Backend:  http://127.0.0.1:5000
if "%_start_seedvc%"=="1" echo   SeedVC:   http://127.0.0.1:5001
echo   Frontend: http://127.0.0.1:%FRONTEND_PORT%
echo ========================================
echo.
echo Closing this window will NOT stop the launched services.
goto end_ok

REM ========================================
REM Exit
REM ========================================
:end_fail
echo.
if "%MELODY_DEV_NO_PAUSE%"=="1" exit /b 1
pause
exit /b 1

:end_ok
if "%MELODY_DEV_NO_PAUSE%"=="1" exit /b 0
pause
