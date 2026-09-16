@echo off
setlocal
cd /d "%~dp0"
title Video Cutter PRO
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js topilmadi. Node.js 20+ o'rnating.
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo Birinchi ishga tushirish: paketlar o'rnatilmoqda...
  call npm install
  if errorlevel 1 pause & exit /b 1
)
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
call npm start
pause
