# mangoro-hunter

Mini-app de Mangoro para reclutar vendedores y otros perfiles comerciales usando:

- WhatsApp Cloud API + CRM web.
- Landing de campañas con formulario / chat IA (futuro).
- Integración con otras mini-apps (CV Scanner Express, Form Checker Express).

## Módulo actual (Fase 0)

**WhatsApp + CRM**:

- Recibe mensajes de candidatos vía WhatsApp (número "Postulaciones").
- Guarda contactos, conversaciones y mensajes en la base de datos.
- Permite responder desde una app web tipo inbox.
- Sugiere respuestas con IA (OpenAI) para agilizar al reclutador.

## Estructura del proyecto

- `backend/` – API Fastify + Prisma + integración WhatsApp/OpenAI.
- `frontend/` – SPA React + Vite (CRM web).
- `prisma/` – modelo de datos.
- `docs/talent/` – documentación de estado y arquitectura.
- `Agents.md` – definición de agentes y roles.

## Setup rápido en local

1. Clonar el repo y entrar a la carpeta `mangoro-hunter`.

2. Crear archivo `.env` en la raíz copiando desde `.env.example` y ajustando:

   - `DATABASE_URL`
   - `PORT` (por defecto 4001 para backend)
   - `JWT_SECRET`
   - `OPENAI_API_KEY` (opcional; si no la pones aquí puedes cargarla desde Configuración).

   > La URL/phone_id/token de WhatsApp Cloud API y la clave de OpenAI también se pueden gestionar desde la pantalla **Configuración** dentro del CRM (solo usuarios ADMIN).

3. Instalar dependencias:

   ```bash
   # Backend
   cd backend
   npm install

   # Frontend
   cd ../frontend
   npm install
   ```

4. Inicializar base de datos (desde la raíz o desde `backend`):

   ```bash
   npx prisma migrate dev --name init
   ```

5. Crear un usuario demo en la base de datos (por ahora manual):

   - Tabla `User`:
     - `email`: `demo@example.com`
     - `passwordHash`: cualquier string (por ahora no se usa)
     - `role`: `AGENT`

6. Levantar backend (puerto 4001):

   ```bash
   cd backend
   npm run dev
   ```

7. Levantar frontend (Vite, por defecto en `http://localhost:5173`):

   ```bash
   cd ../frontend
   npm run dev
   ```

   El Vite dev server proxyará `/api` hacia `http://localhost:4001`.

## Arrancar el CRM en local (macOS)

1. En Finder, haz doble clic sobre `start-hunter.command` (está en la raíz del repo). Se abrirá una ventana de Terminal que ejecutará `npm run dev` en `backend/` y `frontend/` automáticamente.
2. El script abrirá el navegador en `http://localhost:5173`. Usa las credenciales demo (`demo@example.com` / password `demo`) o las que tengas configuradas.
3. Para detener todo, basta con cerrar la ventana de Terminal que lanzó el script o ejecutar `stop-hunter.command`, que mata cualquier proceso activo en los puertos 4001 y 5173.

### Ingreso inicial

- La primera vez que levantes el backend se auto-crea un usuario administrador:
  - Email: `admin@example.com`
  - Password: `admin123`
- Inicia sesión con esas credenciales, entra a **Configuración → Cuenta admin** y cámbialas por las tuyas de inmediato.

## Probar el webhook en local (sin WhatsApp real)

Simular un webhook de WhatsApp:

```bash
curl -X POST http://localhost:4001/webhook/whatsapp   -H "Content-Type: application/json"   -d '{"messages":[{"from":"56912345678","text":{"body":"Hola, vi su anuncio"},"timestamp": 1710000000}]}'
```

Luego:

- Entra a `http://localhost:5173`.
- Inicia sesión con el usuario demo (`demo@example.com` / password `demo`).
- Deberías ver una conversación nueva y poder responder desde el CRM.

## Notas de legalidad y ética

- No se implementa scraping agresivo ni bots que violen Términos de Servicio.
- Toda integración con portales externos se plantea vía APIs oficiales o flujos donde el humano hace el click final.
- El foco es reclutar de manera justa y transparente tanto para candidatos como para empresas.
