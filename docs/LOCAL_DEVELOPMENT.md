# Desarrollo local de Hunter (ER-P14)

## 1) Requisitos
- macOS con `zsh`
- Node.js 20+
- npm 10+
- SQLite3 CLI (`sqlite3`)
- Acceso al repo local en:
  `/Users/cesar/Documents/dev/mangoro/app/hunter`

## 2) Scripts exactos
Desde la raíz del repo:

```bash
npm run dev:backend
```

```bash
npm run dev:frontend
```

```bash
npm run dev:local
```

Notas:
- `dev:local` levanta backend y frontend en paralelo.
- Para detener `dev:local`, usa `Ctrl+C` en la terminal donde corre.

## 3) URLs locales
- Frontend local: [http://localhost:5173](http://localhost:5173)
- Backend local: [http://localhost:4001](http://localhost:4001)
- Health check backend: [http://localhost:4001/api/health](http://localhost:4001/api/health)

## 4) Variables/env local
Base recomendada (`.env` en raíz):

```env
DATABASE_URL="file:../dev.db"
PORT=4001
JWT_SECRET=super-secret-key
OPENAI_API_KEY=<tu_key>
```

Opcional para separar estado local:

```env
HUNTER_STATE_DIR="/Users/cesar/Documents/dev/mangoro/app/hunter/tmp/local-state"
HUNTER_STATE_DB_PATH="/Users/cesar/Documents/dev/mangoro/app/hunter/tmp/local-state/dev.local.snapshot.db"
HUNTER_STATE_UPLOADS_PATH="/Users/cesar/Documents/dev/mangoro/app/hunter/tmp/local-state/uploads"
HUNTER_ASSETS_DIR="/Users/cesar/Documents/dev/mangoro/app/hunter/tmp/local-state/assets"
```

## 5) Levantar DB local y assets locales
1. Crear estructura local de state:

```bash
mkdir -p /Users/cesar/Documents/dev/mangoro/app/hunter/tmp/local-state/{uploads,assets}
```

2. Definir `DATABASE_URL` apuntando a DB local (snapshot o `dev.db` local).
3. Iniciar backend y verificar `GET /api/health`.
4. Iniciar frontend y validar login en `http://localhost:5173`.

## 6) Cargar dataset de prueba sin tocar producción
Usa script de sync con 2 modos:

```bash
./ops/sync_prod_state_to_local.sh
```

```bash
./ops/sync_prod_state_to_local.sh --execute
```

Comportamiento:
- modo por defecto (`--plan`): imprime plan y rutas.
- modo `--execute`: copia snapshot de DB + uploads/assets desde prod (solo lectura remota), y aplica hardening local:
  - `outboundPolicy=BLOCK_ALL`
  - limpia credenciales WhatsApp en `SystemConfig`
  - limpia `reviewEmailTo/reviewEmailFrom` para evitar correos reales.
- genera reporte en `tmp/local-state/last-sync-report.txt`.

## 7) Simulador QA local (tipo WhatsApp)
Ruta en app local:
- `Simulator` (vista QA local)

Capacidades:
- elegir workspace,
- crear conversación QA,
- enviar inbound simulado,
- adjuntar archivos de prueba (CV/carnet/licencia),
- ver respuesta del agente en chat,
- ver runtime debug,
- ejecutar `Reset QA state only` sin borrar mensajes.

## 8) Regla operativa
- Toda lógica nueva se valida primero en local.
- No deploy a `hunter-prod` hasta QA manual limpia aprobada.
- Producción queda en modo conservador (manual/híbrido) mientras se estabiliza local.
