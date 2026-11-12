@echo off
setlocal EnableDelayedExpansion
title LinkHub One-Click Launcher

rem ===========================================================================
rem  LinkHub one-click launcher for Windows.
rem
rem  ASCII-only on purpose: cmd.exe reads .bat with the OEM code page, so
rem  non-ASCII text here gets garbled on some locales. Chinese instructions
rem  live in README.md (section: Windows one-click start).
rem
rem    start.bat                  local mode : backend port from .env SERVER_PORT
rem                               (default 3001) + frontend :5173
rem    start.bat mock             same, but force all 4 platforms to MOCK (offline)
rem    start.bat accounts         open unimsg-connector\.env for editing
rem    start.bat doctor           read-only account / credential self-check
rem    start.bat docker           Docker mode: one container, host port from HOST_PORT (default 3001)
rem    start.bat stop             end the processes owning backend port / 5173
rem    start.bat stopdocker       docker compose down
rem    start-docker.bat           double-click shortcut for Docker mode
rem    setup-accounts.bat         double-click shortcut for account setup
rem
rem  Backend port = SERVER_PORT in unimsg-connector\.env, default 3001.
rem  Frontend port stays 5173 (Vite default). "stop" ends whoever OWNS those
rem  ports, which may be an unrelated program - it is not project-scoped.
rem
rem  Double-click = local mode. No admin rights, no global pnpm required.
rem  NOTE: .env is git-ignored on purpose. Cloning/syncing the repo never
rem  brings platform credentials over - copy .env manually when switching
rem  machines, or run "start.bat accounts" to create/fill it.
rem ===========================================================================

set "ROOT=%~dp0"
set "APP=%ROOT%unimsg-connector"

if not exist "%APP%\package.json" (
  echo [ERROR] Cannot find unimsg-connector\package.json next to this script.
  echo         Keep start.bat in the repository root folder.
  goto :fail
)

rem Backend port follows SERVER_PORT in unimsg-connector\.env (default 3001).
rem Resolved HERE, before the mode dispatch, so every entry point sees it:
rem :LOCAL, :MOCK (which jumps to :LOCAL) and a direct "start.bat stop".
rem scripts\env-read.mjs mirrors dotenv semantics (BOM / spaces / inline # comments /
rem quotes / case), and invalid ports fall back to 3001 instead of leaking "abc".
set "BACKEND_PORT=3001"
set "DOCKER_PORT=3001"
set "ENV_TOKEN="
set "ENV_ACCT="
where node >nul 2>nul
if not errorlevel 1 (
  for /f "usebackq tokens=1,* delims==" %%A in (`node "%APP%\scripts\env-read.mjs" all`) do (
    if "%%A"=="PORT"      set "BACKEND_PORT=%%B"
    if "%%A"=="HOST_PORT" set "DOCKER_PORT=%%B"
    if "%%A"=="TOKEN"     set "ENV_TOKEN=%%B"
    if "%%A"=="ACCOUNTS"  set "ENV_ACCT=%%B"
  )
)
if not defined ENV_TOKEN set "ENV_TOKEN=dev-token"
if not defined ENV_ACCT set "ENV_ACCT=0"

set "MODE=%~1"
if "%MODE%"=="" set "MODE=local"
if /i "%MODE%"=="local"       goto :LOCAL
if /i "%MODE%"=="mock"        goto :MOCK
if /i "%MODE%"=="accounts"    goto :ACCOUNTS
if /i "%MODE%"=="doctor"      goto :DOCTOR
if /i "%MODE%"=="docker"      goto :DOCKER
if /i "%MODE%"=="stop"        goto :STOP
if /i "%MODE%"=="stopdocker"  goto :STOPDOCKER
echo [ERROR] Unknown mode: %MODE%
echo         Use: local / mock / accounts / doctor / docker / stop / stopdocker
goto :fail


rem ---------------------------------------------------------------------------
:LOCAL
rem ---------------------------------------------------------------------------
echo.
echo  LinkHub - local mode  ^(backend :%BACKEND_PORT% + frontend :5173^)
echo  ---------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 20+ from https://nodejs.org
  goto :fail
)

rem pnpm may not be installed globally; Node 20+ ships corepack.
set "PNPM=pnpm"
where pnpm >nul 2>nul
if errorlevel 1 (
  where corepack >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Neither pnpm nor corepack found. Reinstall Node.js 20+.
    goto :fail
  )
  set "PNPM=corepack pnpm"
)
echo [env ] package runner: !PNPM!

rem Refuse to start twice. PowerShell exits with the number of busy ports,
rem so cmd can read it straight from errorlevel (no findstr quoting issues).
powershell -NoProfile -Command "exit @(Get-NetTCPConnection -LocalPort %BACKEND_PORT%,5173 -State Listen -ErrorAction SilentlyContinue).Count"
if errorlevel 1 (
  echo [ERROR] Port %BACKEND_PORT% or 5173 is already in use by another program.
  echo         Edit SERVER_PORT in unimsg-connector\.env to use a different
  echo         backend port, or close the program that owns it.
  echo         For 5173, close the "LinkHub Web" console window instead.
  echo         "start.bat stop" kills whoever owns those ports - possibly an
  echo         unrelated program - so it is not the safe first choice.
  goto :fail
)
echo [env ] ports %BACKEND_PORT% / 5173 are free.

rem [1/4] dependencies -------------------------------------------------------
if exist "%APP%\packages\server\node_modules\.bin\tsx.cmd" (
  echo [1/4] Dependencies already installed - skip.
) else (
  echo [1/4] Installing dependencies ^(first run only, please wait^) ...
  pushd "%APP%"
  call %PNPM% install --frozen-lockfile
  if errorlevel 1 (
    popd
    echo [ERROR] Dependency install failed.
    goto :fail
  )
  popd
)

rem [2/4] account status + point the frontend at the local backend ----------
rem Counts come from scripts\env-read.mjs (same uppercase MAIL_<KEY>_AUTH_CODE
rem rule as the server). Credential VALUES are never printed.
set "DEMO_TOKEN=%ENV_TOKEN%"
set "ACCT=%ENV_ACCT%"
if defined FORCED_MOCK (
  echo [acct] %ACCT% credential group^(s^) in .env, but all platforms FORCED to MOCK.
  echo        No real platform API will be called in this run.
) else (
  if "%ACCT%"=="0" (
    echo [acct] NO credentials in .env - all 4 platforms run in MOCK mode.
    echo        Run "start.bat accounts" to configure real platform accounts.
  ) else (
    echo [acct] %ACCT% credential group^(s^) found in .env - real/auto channel.
    echo        Verify anytime with "start.bat doctor".
  )
)

rem This is derived config owned by the launcher: rewrite on every start so
rem VITE_API_TOKEN can never drift away from the server API_TOKEN (401 cause).
rem A custom VITE_API_BASE (e.g. remote backend) is respected and untouched.
rem Any 127.0.0.1 port counts as launcher-owned, so changing SERVER_PORT also
rem refreshes a previously written base instead of leaving it pointing at the
rem old port. A non-loopback base is still treated as custom and kept.
set "WEBENV=%APP%\packages\web\.env"
set "CUSTOM_WEBENV="
if exist "%WEBENV%" (
  findstr /i /r /c:"^VITE_API_BASE=http://127\.0\.0\.1:[0-9][0-9]*" "%WEBENV%" >nul
  if errorlevel 1 set "CUSTOM_WEBENV=1"
)
if defined CUSTOM_WEBENV (
  echo [2/4] Custom VITE_API_BASE detected - kept as is ^(not overwritten^).
) else (
  >  "%WEBENV%" echo VITE_API_BASE=http://127.0.0.1:%BACKEND_PORT%
  >> "%WEBENV%" echo VITE_API_TOKEN=%DEMO_TOKEN%
  echo [2/4] Synced packages\web\.env ^(token matches API_TOKEN^).
)

rem [3/4] backend ------------------------------------------------------------
rem Pin SERVER_PORT to the validated value so a malformed .env cannot make the
rem server bind a different port than the health check / Web URL below.
set "SERVER_PORT=%BACKEND_PORT%"
echo [3/4] Starting backend on :%BACKEND_PORT% ...
start "LinkHub Server :%BACKEND_PORT%" /D "%APP%" cmd /k "%PNPM% --filter @unimsg/server start"

set "READY="
for /L %%i in (1,1,40) do (
  if not defined READY (
    curl -sf http://127.0.0.1:%BACKEND_PORT%/api/health >nul 2>nul
    if not errorlevel 1 set "READY=1"
    if not defined READY ping -n 2 127.0.0.1 >nul
  )
)
if not defined READY (
  echo [WARN] Backend did not answer within ~40s. Check the "LinkHub Server" window.
) else (
  echo       Backend ready.
)

rem [4/4] frontend -----------------------------------------------------------
echo [4/4] Starting frontend on :5173 ...
start "LinkHub Web :5173" /D "%APP%" cmd /k "%PNPM% --filter @unimsg/web dev"

set "READY="
for /L %%i in (1,1,40) do (
  if not defined READY (
    curl -sf http://127.0.0.1:5173/ >nul 2>nul
    if not errorlevel 1 set "READY=1"
    if not defined READY ping -n 2 127.0.0.1 >nul
  )
)
if not defined READY (
  echo [WARN] Frontend did not answer within ~40s. Check the "LinkHub Web" window.
) else (
  echo       Frontend ready - opening browser ...
  start "" http://127.0.0.1:5173
)

echo.
echo  ===============================================================
echo   LinkHub is running
echo     Web      http://127.0.0.1:5173
echo     API      http://127.0.0.1:%BACKEND_PORT%/api/health
rem 不打印完整令牌：启动器窗口常被截图/投屏，完整值见 unimsg-connector/.env 的 API_TOKEN
set "TOKEN_MASK=%DEMO_TOKEN:~0,4%******"
echo     Token    %TOKEN_MASK%  ^(full value: unimsg-connector\.env API_TOKEN^)
echo     Accounts %ACCT% credential group^(s^) in .env  ^(0 = all MOCK^)
if defined FORCED_MOCK echo     Channel  FORCED MOCK ^(offline, no real API calls^)
echo.
echo   Accounts: start.bat accounts   ^|   Self-check: start.bat doctor
echo   Two console windows stay open (server + web).
echo   Close them, or run "start.bat stop", to stop everything.
echo  ===============================================================
echo.
echo Press any key to close THIS launcher window (services keep running).
pause >nul
exit /b 0


rem ---------------------------------------------------------------------------
:MOCK
rem ---------------------------------------------------------------------------
rem Force every platform to the local Mock channel. dotenv never overrides an
rem existing process env var, so these win over credentials in .env.
set "FEISHU_MODE=mock"
set "DINGTALK_MODE=mock"
set "WECOM_MODE=mock"
set "MAIL_MODE=mock"
set "DINGTALK_STREAM=false"
set "MAIL_ENABLED=false"
set "FORCED_MOCK=1"
echo [env ] forced MOCK for all 4 platforms - fully offline, no real API calls.
goto :LOCAL


rem ---------------------------------------------------------------------------
:ACCOUNTS
rem ---------------------------------------------------------------------------
echo.
echo  LinkHub - platform account setup
echo  ---------------------------------------------------------------
if not exist "%APP%\.env" (
  copy /y "%APP%\.env.example" "%APP%\.env" >nul
  echo [1/2] Created unimsg-connector\.env from the template.
) else (
  echo [1/2] Existing .env found - kept untouched.
)
echo [2/2] Fill in FEISHU_* / DINGTALK_* / WECOM_* / MAIL_* then save.
echo.
echo  IMPORTANT: .env is git-ignored on purpose. Cloning or syncing the repo
echo  will NOT bring credentials over. Copy the file manually when you switch
echo  machines or workspaces, otherwise the app silently falls back to MOCK.
echo.
echo  Guide: docs\swap-accounts.md    Self-check: start.bat doctor
if not "%LINKHUB_NO_EDITOR%"=="1" start "" notepad "%APP%\.env"
echo.
echo Press any key to close this window after saving the file.
pause >nul
exit /b 0


rem ---------------------------------------------------------------------------
:DOCTOR
rem ---------------------------------------------------------------------------
echo.
echo  LinkHub - read-only account self-check
echo  ---------------------------------------------------------------
set "PNPM=pnpm"
where pnpm >nul 2>nul
if errorlevel 1 set "PNPM=corepack pnpm"
pushd "%APP%"
call %PNPM% --filter @unimsg/server run doctor
set "DOC_RC=!ERRORLEVEL!"
popd
echo.
echo Doctor exit code: %DOC_RC%  ^(0 = all checks passed^)
echo Press any key to close this window.
pause >nul
exit /b %DOC_RC%


rem ---------------------------------------------------------------------------
:DOCKER
rem ---------------------------------------------------------------------------
echo.
echo  LinkHub - Docker mode  ^(single container, host port %DOCKER_PORT%^)
echo  ---------------------------------------------------------------
where docker >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Docker not found. Install Docker Desktop and start its engine.
  goto :fail
)
pushd "%APP%"
docker compose up -d --build
if errorlevel 1 (
  popd
  echo [ERROR] docker compose failed. Is the Docker engine running?
  echo         See docs\deploy.md for offline docker save/load instructions.
  goto :fail
)
docker compose ps
popd
echo.
echo   Web      http://127.0.0.1:%DOCKER_PORT%
echo   Token    linkhub-local-demo-2026-change-me  ^(override: LINKHUB_DEPLOY_TOKEN^)
echo   Stop     start.bat stopdocker   or   docker compose down
start "" http://127.0.0.1:%DOCKER_PORT%
echo.
echo Press any key to close THIS launcher window (container keeps running).
pause >nul
exit /b 0


rem ---------------------------------------------------------------------------
:STOP
rem ---------------------------------------------------------------------------
echo.
echo  Stopping local services on ports %BACKEND_PORT% / 5173 ...
echo  Backend port = SERVER_PORT in unimsg-connector\.env, default 3001.
echo  WARNING: this ends the process that OWNS each listening port. If another
echo           program is using %BACKEND_PORT% or 5173, that program is killed
echo           too - this is not limited to LinkHub. When unsure, just close
echo           the "LinkHub Server" / "LinkHub Web" console windows instead.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort %BACKEND_PORT%,5173 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
echo  Done. The two console windows may now be closed.
echo.
echo  For the Docker stack run:  start.bat stopdocker
exit /b 0


rem ---------------------------------------------------------------------------
:STOPDOCKER
rem ---------------------------------------------------------------------------
echo.
echo  Stopping Docker stack ...
pushd "%APP%"
docker compose down
popd
exit /b 0


rem ---------------------------------------------------------------------------
:fail
rem ---------------------------------------------------------------------------
echo.
echo  Launch failed. See the messages above.
echo  Docs: README.md  /  docs\quickstart.md  /  docs\deploy.md
echo.
pause
exit /b 1
