# PACK_RESUMEN - Runbook

## Local setup (dev)
Prereqs: Node.js, npm, Prisma CLI (via npm), SQLite default.

1) Install dependencies
- backend: `cd backend && npm install`
- frontend: `cd frontend && npm install`

2) Env vars
Create `.env` at repo root from `.env.example`:
- DATABASE_URL="file:../dev.db"
- PORT=4001
- JWT_SECRET=super-secret-key
- OPENAI_API_KEY= (optional; can be set in UI Config)

3) Database (dev)
- `npx prisma migrate dev --name init`

4) Run dev servers
- Backend: `cd backend && npm run dev` (port 4001)
- Frontend: `cd frontend && npm run dev` (Vite 5173)

5) Optional macOS helper
- `start-hunter.command` starts backend + frontend.
- `stop-hunter.command` stops ports 4001/5173.

## Build + tests
- Backend tests: `cd backend && npm test`
  - Runs `npm run build` then node --test for dist/**/*.test.js
- Frontend build: `cd frontend && npm run build`
- Frontend preview: `cd frontend && npm run preview`

## Health check
- GET /api/health (from backend) returns build info.

## WhatsApp webhook (local)
- Endpoint: POST /webhook/whatsapp
- Use simulator or curl for basic testing.

## Deploy notes (DEV)
- `deploy_hunter.sh` (root) is used for DEV deploys.
- SAFE MODE is expected to be ALLOWLIST_ONLY in DEV.

## If something is missing
- SMTP/email delivery is not required in dev; invite flow supports copy link.
- If OpenAI key is missing, Copilot should fallback to deterministic navigation.

