@echo off
title LinkHub - environment check

echo.
echo ============================================================
echo   environment check
echo ============================================================
echo.

echo [1] current user
%SystemRoot%\System32\whoami.exe
echo.

echo [2] integrity level
%SystemRoot%\System32\whoami.exe /groups | findstr /i "Mandatory"
echo.

echo [3] elevated? (no error = elevated)
net session >nul 2>&1
if errorlevel 1 (echo   NOT elevated) else (echo   ELEVATED)

echo [4] HKCU registry write test
reg add "HKCU\Software\LinkHubEnvProbe" /v probe /d 1 /f >nul 2>&1
if errorlevel 1 (echo   HKCU REGISTRY: DENIED) else (echo   HKCU REGISTRY: OK)
reg delete "HKCU\Software\LinkHubEnvProbe" /f >nul 2>&1
echo.

echo [5] dws config dir write test
set "T=D:\LinkHub-push\dws-data"
if not exist "%T%" mkdir "%T%" >nul 2>&1
echo probe>"%T%\probe.txt" 2>nul
if exist "%T%\probe.txt" (echo   DWS DATA DIR: OK) else (echo   DWS DATA DIR: DENIED)
del "%T%\probe.txt" >nul 2>&1
echo.

echo [6] user profile write test
echo probe>"%USERPROFILE%\linkhub-probe.txt" 2>nul
if exist "%USERPROFILE%\linkhub-probe.txt" (echo   USERPROFILE: OK) else (echo   USERPROFILE: DENIED)
del "%USERPROFILE%\linkhub-probe.txt" >nul 2>&1
echo.

echo [7] dws login state
set "DWS_CONFIG_DIR=D:\LinkHub-push\dws-data"
cd /d "%~dp0unimsg-connector"
tools\dws.exe auth status -f json 2>&1 | findstr /i "authenticated failed"
echo.
pause
