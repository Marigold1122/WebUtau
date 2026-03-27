@echo off
echo ========================================
echo   正在启动 Melody Singer 后端...
echo   启动后请勿关闭此窗口
echo ========================================
echo.

cd /d "%~dp0server"
DiffSingerApi.exe

pause
