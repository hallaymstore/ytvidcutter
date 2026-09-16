@echo off
setlocal
cd /d "%~dp0"
title YT Video Cutter PRO

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [XATO] Node.js topilmadi.
  echo Node.js 22 yoki undan yangi versiyasini o'rnating.
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%a in ('node -p "process.versions.node"') do set NODE_MAJOR=%%a
if %NODE_MAJOR% LSS 22 (
  echo.
  echo [XATO] Node.js %NODE_MAJOR% juda eski. Node.js 22+ kerak.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/2] Birinchi ishga tushirish: paketlar o'rnatilmoqda...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install xato berdi. Internetni tekshiring.
    pause
    exit /b 1
  )
)

echo [2/2] Server ishga tushmoqda...
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"
call npm start

echo.
echo Server to'xtadi.
pause
