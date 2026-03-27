@echo off
setlocal
chcp 65001 >nul
title Melody Singer - Dev Launcher

set "ROOT=%~dp0"
set "SERVER_DIR=%ROOT%server"
set "BACKEND_EXE=%SERVER_DIR%\DiffSingerApi.exe"
set "SEEDVC_SCRIPT=%ROOT%scripts\start-seedvc-service.bat"

echo [检查] 开发环境启动前检查...

if not exist "%BACKEND_EXE%" (
  echo [错误] 未找到后端程序: "%BACKEND_EXE%"
  pause
  exit /b 1
)

if not exist "%SEEDVC_SCRIPT%" (
  echo [错误] 未找到 SeedVC 启动脚本: "%SEEDVC_SCRIPT%"
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
