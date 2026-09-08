@echo off
REM INTISAT — arranca la sala de monitoreo web (ClickHouse + backend FastAPI).
REM No reemplaza main.py (la app PyQt5) — corren juntos. Arrancar esta app
REM DESPUES de tener este script corriendo para que el puente de telemetria
REM (Core/telemetry_publisher.py) tenga un backend escuchando en :5560.
REM
REM Primera vez: copiar .env.example a .env y poner una contrasena propia
REM              cd webapp\backend && pip install -r requirements.txt
REM              cd webapp\frontend && npm install && npm run build

cd /d "%~dp0"

if not exist ".env" (
    echo ERROR: falta .env — copiar .env.example a .env y poner una contrasena.
    pause
    exit /b 1
)
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"

echo Levantando ClickHouse (Docker)...
docker compose -f docker-compose.web.yml up -d
if errorlevel 1 (
    echo ERROR: no se pudo levantar ClickHouse. Verificar que Docker Desktop este corriendo.
    pause
    exit /b 1
)

echo Esperando a que ClickHouse este listo...
timeout /t 5 /nobreak >nul

echo Iniciando backend web en http://localhost:8000 ...
python -m uvicorn webapp.backend.main:app --host 0.0.0.0 --port 8000
