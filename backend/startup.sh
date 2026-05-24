#!/bin/bash
# Startup command usato da Azure App Service Python managed.
# Configurato in: az webapp config set --startup-file "startup.sh"

# Azure App Service espone la porta su WEBSITES_PORT, default 8000
PORT=${WEBSITES_PORT:-8000}

# === DEBUG MODE ===
# Questa configurazione e' "minimalistica" per troubleshooting di startup
# falliti su Azure App Service:
#  - 1 worker (invece di 2): meno memoria, meno race condition
#  - timeout 300: piu' tempo per importare i moduli
#  - NO --preload: master non carica il codice; il worker lo fa per primo
#    in modo isolato, cosi' se l'import esplode lo vediamo nei log del worker
#  - --log-level debug: massimo verbose
#  - --capture-output: redirige stdout/stderr al log
echo "[startup.sh] Avvio gunicorn con PYTHON=$(python --version 2>&1)"
echo "[startup.sh] PORT=$PORT"
echo "[startup.sh] PWD=$(pwd)"
echo "[startup.sh] Files in current dir:"
ls -la

exec gunicorn app:app \
    --worker-class uvicorn.workers.UvicornWorker \
    --workers 1 \
    --bind 0.0.0.0:$PORT \
    --timeout 300 \
    --graceful-timeout 30 \
    --log-level debug \
    --capture-output \
    --access-logfile - \
    --error-logfile -
