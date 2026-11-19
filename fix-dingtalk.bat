@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title LinkHub - fix DingTalk connection

set "ROOT=%~dp0"
set "APP=%ROOT%unimsg-connector"
set "PORT=3001"

echo.
echo ============================================================
echo   LinkHub DingTalk connector repair
echo ============================================================
echo.

if not exist "%APP%\tools\dws.exe" (
  echo [ERROR] not found: %APP%\tools\dws.exe
  echo         Run start.bat once first, then re-run this script.
  pause
  exit /b 1
)

echo [1/4] Checking port %PORT% ...
set "COUNT=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% "') do (
  if not "%%p"=="0" (
    taskkill /PID %%p /F >nul 2>&1
    set /a COUNT+=1
  )
)
if !COUNT! gtr 0 (
  echo       requested stop for !COUNT! listener entries on port %PORT%
) else (
  echo       port is free.
)
ping -n 3 127.0.0.1 >nul

echo [2/4] Cleaning dws lock file ...
set "LOCK=%USERPROFILE%\.dws\.data.lock"
if exist "%LOCK%" del /f /q "%LOCK%" >nul 2>&1
if exist "%LOCK%" (
  echo       still locked - resetting ACL on .dws
  takeown /F "%USERPROFILE%\.dws" /R /D Y >nul 2>&1
  icacls "%USERPROFILE%\.dws" /reset /T /C >nul 2>&1
  if exist "%LOCK%" del /f /q "%LOCK%" >nul 2>&1
)
if exist "%LOCK%" (
  echo       still locked - switching to project-local config dir
  set "DWS_CONFIG_DIR=%APP%\.dws-data"
  setx DWS_CONFIG_DIR "%APP%\.dws-data" >nul 2>&1
  if not exist "%APP%\.dws-data" mkdir "%APP%\.dws-data" >nul 2>&1
  echo       DWS_CONFIG_DIR=%APP%\.dws-data
) else (
  echo       lock file removed.
)

echo.
echo [3/4] dws login - confirm in browser / device code ...
echo.
pushd "%APP%"
tools\dws.exe auth login
set "LOGIN_EXIT=!ERRORLEVEL!"
popd
echo.
if "!LOGIN_EXIT!"=="0" (
  echo       login command returned OK.
) else (
  echo       [WARN] login exit code = !LOGIN_EXIT!
)

echo.
echo [4/4] Restarting LinkHub ...
start "" "%ROOT%start.bat"

echo.
echo ============================================================
echo   Done. Open http://127.0.0.1:5173
echo   Check Accounts page: DingTalk should show "connected".
echo ============================================================
echo.
pause