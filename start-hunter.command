#!/bin/bash
# Script de arranque local para backend + frontend del CRM Hunter

set -euo pipefail

# Ir a la carpeta del proyecto (donde está este archivo)
cd "$(dirname "$0")"

# Levantar backend en una ventana de terminal
cd backend
npm run dev &
BACK_PID=$!

# Volver a raíz
cd ..

# Levantar frontend (Vite)
cd frontend
npm run dev &
FRONT_PID=$!

# Volver a raíz otra vez
cd ..

# Abrir el navegador en el frontend
open "http://localhost:5173"

# Mantener la ventana abierta mientras los procesos estén vivos
trap 'kill $BACK_PID $FRONT_PID 2>/dev/null || true' EXIT
wait $BACK_PID $FRONT_PID
