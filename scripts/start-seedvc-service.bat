@echo off
chcp 65001 >nul
title webUTAU - Local SeedVC Service

set "ROOT=%~dp0.."
set "SEED_VC_ROOT=%ROOT%\external\seed-vc"

echo [SeedVC] 启动本地音色转换服务...
echo [SeedVC] 服务地址: http://localhost:5001
echo.

cd /d "%ROOT%\scripts\seedvc_service"
"%SEED_VC_ROOT%\.venv\Scripts\python.exe" app.py

pause
