@echo off
setlocal
set ROOT=%~dp0
pushd "%ROOT%"

echo [1/5] db: docker compose up -d db
docker compose up -d db
if errorlevel 1 goto fail

echo [2/5] waiting for postgres...
for /l %%i in (1,1,20) do (
  for /f %%s in ('docker inspect -f "{{.State.Health.Status}}" rakko-db-1 2^>nul') do set DBSTATE=%%s
  if /i "%DBSTATE%"=="healthy" goto migrate
  ping -n 3 127.0.0.1 >nul
)
echo WARN: db state = %DBSTATE%, continuing anyway.

:migrate
echo [3/5] migrate + build
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b "DATABASE_URL=" .env`) do set "DATABASE_URL=%%b"
call pnpm --filter @rakko/server migrate
if errorlevel 1 goto fail
call pnpm build >nul
if errorlevel 1 goto fail

echo [4/5] start api on 8787
start "rakko-api" /min node --env-file=.env apps/server/dist/index.js

echo [5/5] start ui gateway on 8088
start "rakko-ui" /min node scripts\ui-gateway.mjs

ping -n 5 127.0.0.1 >nul
echo.
echo   UI     http://127.0.0.1:8088
echo   API    http://127.0.0.1:8787/health
echo.
echo Two minimized windows are the services. Close them to stop.
echo Stop database: pnpm stack:down
popd
exit /b 0

:fail
echo.
echo START FAILED - see the first error above.
popd
pause
exit /b 1
