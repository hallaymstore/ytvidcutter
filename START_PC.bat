@echo off
setlocal
cd /d "%~dp0"
title YT Video + AutoMix PRO v3.1

where node >nul 2>nul
if errorlevel 1 (
  echo [XATO] Node.js topilmadi. Node.js 22 yoki undan yangi versiyani o'rnating.
  echo https://nodejs.org/
  pause
  exit /b 1
)

for /f "tokens=*" %%P in ('powershell -NoProfile -Command "$p=(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue ^| Select-Object -First 1 -ExpandProperty OwningProcess); if($p){Write-Output $p}"') do (
  echo Eski localhost:3000 process topildi. To'xtatilmoqda: PID %%P
  taskkill /PID %%P /F >nul 2>nul
)

timeout /t 1 /nobreak >nul

if not exist "node_modules" (
  echo Birinchi ishga tushirish: paketlar o'rnatilmoqda...
  call npm install
  if errorlevel 1 (
    echo [XATO] npm install bajarilmadi.
    pause
    exit /b 1
  )
)

if not exist "workspace\input" mkdir "workspace\input"
if not exist "workspace\clips" mkdir "workspace\clips"
if not exist "workspace\audio" mkdir "workspace\audio"
if not exist "workspace\mixes" mkdir "workspace\mixes"

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
call npm start
pause
