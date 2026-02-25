@echo off
chcp 65001 >nul
title Melody Singer v3

echo ========================================
echo   Melody Singer v3 - 一键启动
echo ========================================
echo.

:: 清理残留进程
taskkill /F /IM DiffSingerApi.exe >nul 2>&1

:: 检查端口占用，释放 5000 和 3000
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5000 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1

:: 启动后端
echo [1/2] 启动后端 API (端口 5000)...
cd /d "d:\code\Melody Singer\server\DiffSingerApi"
start "DiffSinger API" cmd /k "dotnet run"

:: 等待后端启动
echo 等待后端初始化...
timeout /t 8 /nobreak >nul

:: 启动前端 (用 3000 端口)
echo [2/2] 启动前端服务器 (端口 3000)...
cd /d "d:\code\Melody Singer"
start "Melody Singer Frontend" cmd /k "python -m http.server 3000"

:: 等待前端启动
timeout /t 3 /nobreak >nul

:: 打开浏览器 - 直接打开 v3 页面
echo 打开浏览器...
start http://localhost:3000/3/index.html

echo.
echo ========================================
echo   启动完成!
echo   前端: http://localhost:3000/3/index.html
echo   后端: http://localhost:5000/api
echo   关闭两个 cmd 窗口即可停止服务
echo ========================================
pause
