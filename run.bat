@echo off
color 0b
echo ===========================================
echo       Iniciando XRP Analytics Dashboard
echo ===========================================
echo.
node --version
echo 1. Arrancando el backend local en Node.js...
echo 2. Abriendo el navegador...
echo.

:: Abre la pagina y delega el link al navegador predeterminado
start http://localhost:3000

:: V2.3: si este Node soporta el flag de SQLite nativo, usarlo (activa dashboard.db).
:: Si no lo soporta, arrancar normal — lib/db.js decide solo (SQLite sin flag en
:: Node 23.4+, o fallback JSON en Node antiguos). Nunca impide arrancar.
node --experimental-sqlite -e "process.exit(0)" >nul 2>&1
if %errorlevel%==0 (
    node --experimental-sqlite server.js
) else (
    node server.js
)

pause
