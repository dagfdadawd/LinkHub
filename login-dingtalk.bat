@echo off
title LinkHub - DingTalk login

set "APP=%~dp0unimsg-connector"
set "DWS_DATA=D:\LinkHub-push\dws-data"
set "DWS_CONFIG_DIR=%DWS_DATA%"

if not exist "%APP%\tools\dws.exe" goto nodws
if not exist "%DWS_DATA%" mkdir "%DWS_DATA%" >nul 2>&1

echo.
echo ============================================================
echo   DingTalk login
echo   config dir: %DWS_DATA%
echo ============================================================
echo.

echo [1/3] check environment
whoami /groups | findstr /i "Mandatory"
reg add "HKCU\Software\LinkHubDwsProbe" /v probe /d 1 /f >nul 2>&1
if errorlevel 1 goto regfail
echo       registry OK
reg delete "HKCU\Software\LinkHubDwsProbe" /f >nul 2>&1
goto step2

:regfail
echo       registry DENIED - run this script as Administrator

:step2
echo.
echo [2/3] login (browser will open)
echo ------------------------------------------------------------
cd /d "%APP%"

set "PROFILE_RAW="
for /f "tokens=1,* delims=:" %%a in ('findstr /c:"currentProfile" "%DWS_DATA%\profiles.json" 2^>nul') do set "PROFILE_RAW=%%b"
if not defined PROFILE_RAW goto plain
set "PROFILE_RAW=%PROFILE_RAW: =%"
set "PROFILE_RAW=%PROFILE_RAW:,=%"
set "PROFILE_RAW=%PROFILE_RAW:"=%"
if "%PROFILE_RAW%"=="" goto plain
echo       re-authorizing existing profile
tools\dws.exe auth login --profile "%PROFILE_RAW%"
set "RC=%ERRORLEVEL%"
goto after_login

:plain
tools\dws.exe auth login
set "RC=%ERRORLEVEL%"

:after_login
echo ------------------------------------------------------------
if "%RC%"=="0" goto check
echo.
echo       browser login failed - fallback to device code
echo ------------------------------------------------------------
tools\dws.exe auth login --device
set "RC=%ERRORLEVEL%"

:check
echo.
echo [3/3] verify
tools\dws.exe auth status -f json
echo.

if "%RC%"=="0" goto ok

echo ============================================================
echo   LOGIN FAILED exit=%RC%
echo   1 code expired - rerun
echo   2 not confirmed in DingTalk
echo   3 registry denied - run as Administrator
echo ============================================================
goto done

:ok
echo ============================================================
echo   LOGIN OK
echo   backend auto-detects this dir, no .env change needed
echo   restart start.bat
echo ============================================================
goto done

:nodws
echo [ERROR] missing %APP%\tools\dws.exe

:done
echo.
pause
