@echo off
setlocal
chcp 65001 >nul
title webUTAU - Source Dev Launcher

set "ROOT=%~dp0"
set "BACKEND_SOURCE_DIR=%ROOT%server\DiffSingerApi"
set "BACKEND_PROJECT=%BACKEND_SOURCE_DIR%\DiffSingerApi.csproj"

if not exist "%BACKEND_PROJECT%" (
  echo [错误] 未找到后端源码工程: "%BACKEND_PROJECT%"
  pause
  exit /b 1
)

if not defined MELODY_ONNX_PROVIDER set "MELODY_ONNX_PROVIDER=Cuda"
echo [info] ONNX provider: %MELODY_ONNX_PROVIDER%

echo [1/2] 启动后端源码工程 (DiffSingerApi, port 38510)...
start "Backend-Source" /d "%BACKEND_SOURCE_DIR%" dotnet run -p:OnnxProvider=%MELODY_ONNX_PROVIDER%

echo [2/2] 启动前端 (Vite, port 3000)...
timeout /t 2 /nobreak >nul
start "Frontend" /d "%ROOT%" npm run dev

echo.
echo 后端源码: %BACKEND_SOURCE_DIR%
echo 前端: http://localhost:3000
echo.
if "%MELODY_DEV_NO_PAUSE%"=="1" exit /b 0
pause
