# ER-P7 — Repo & Backup Status

Fecha: 2026-03-07

## 1) Repositorio Git (código)

Remote actual:

```bash
git remote -v
origin  git@github.com:cesarabia/mangoro-hunter.git (fetch)
origin  git@github.com:cesarabia/mangoro-hunter.git (push)
```

Branch de trabajo:
- `main`

Notas:
- Git respalda **código y docs**.
- Git **no** respalda datos runtime (`dev.db`, `uploads`, `assets`).

## 2) Tags de respaldo (ER-P7)

Se deben mantener dos tags de control:
- `hunter-prod-pre-er-p7`
- `hunter-prod-post-er-p7`

Estado actual:
- `hunter-prod-pre-er-p7` → `096736b`
- `hunter-prod-post-er-p7` → `9c1e527`

Uso:
- `pre`: referencia estable antes de aplicar ER-P7.
- `post`: referencia de código luego de auditoría/instrumentación ER-P7.

## 3) Backups de datos (app state)

Rutas en hunter-prod:
- DB: `/opt/hunter/state/dev.db`
- Uploads: `/opt/hunter/state/uploads/`
- Assets: `/opt/hunter/state/assets/`
- Backups: `/opt/hunter/backups/YYYY-MM-DD_HH-mm-ss/`

Formato backup esperado (ER-P3):
- `dev.db`
- `uploads.tar.gz`
- `assets.tar.gz`
- `manifest.txt`
- `SHA256SUMS.txt`

## 4) Estado observado en esta auditoría

- Backups de `dev.db`: presentes (múltiples snapshots).
- Backups recientes de `uploads/assets`: generados pero vacíos (sin binarios históricos para restauración).
- Storage runtime actual (`state/uploads`, `state/assets`): existe pero sin archivos históricos.

## 5) Recordatorio operativo

- Antes de cada deploy en PROD:
  1. ejecutar backup ER-P3,
  2. verificar manifest/checksums,
  3. validar conteos mínimos (`Conversation`, `Message`) y tamaño DB,
  4. recién después reiniciar `hunter-backend`.
