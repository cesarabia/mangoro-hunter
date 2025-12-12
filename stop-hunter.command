#!/bin/bash
# Script para detener backend y frontend de Hunter

set -euo pipefail

# Matar procesos en los puertos típicos
lsof -ti tcp:4001 | xargs kill 2>/dev/null || true
lsof -ti tcp:5173 | xargs kill 2>/dev/null || true

echo "Procesos en puertos 4001 y 5173 detenidos (si existían)."
