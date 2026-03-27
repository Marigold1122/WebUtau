@echo off
chcp 65001 >nul
title Melody Singer - Source Dev Launcher

echo [1/2] 启动外部后端源码工程 (DiffSingerApi, port 5000)...
start "Backend-Source" cmd /k "cd /d D:\code\Melody Singer\server\DiffSingerApi && dotnet run"

echo [2/2] 启动前端 (Vite, port 3000)...
timeout /t 2 /nobreak >nul
start "Frontend" cmd /k "cd /d %~dp0 && npm run dev"

echo.
echo 后端源码: D:\code\Melody Singer\server\DiffSingerApi
echo 前端: http://localhost:3000
echo.
echo 这个脚本只在你需要调试外部后端源码时使用。
pause
