# STATE – mangoro-hunter

## Hecho

- Definida la visión unificada de la mini-app (Hunter Core + Chat Intake + WhatsApp+CRM).
- Elegido stack inicial:
  - Backend: Node.js + TypeScript + Fastify + Prisma + PostgreSQL.
  - Frontend: React + Vite (SPA).
- Diseñado modelo de datos base en `prisma/schema.prisma`.
- Definida arquitectura del módulo WhatsApp + CRM.
- Creado skeleton de proyecto (backend + frontend + docs).

## Pendiente (próximos pasos sugeridos)

1. Implementar en backend:
   - `/webhook/whatsapp` (recepción de mensajes).
   - `/api/auth/login` (JWT simple).
   - `/api/conversations` y `/api/conversations/:id/messages`.
   - `/api/conversations/:id/ai-suggest` (OpenAI).
2. Implementar en frontend:
   - Pantalla de login.
   - Vista de inbox con filtros por estado.
   - Vista de conversación con envío de mensajes y botón de sugerencia IA.
3. Probar flujo end-to-end en local con un JSON de ejemplo de webhook.
4. Diseñar e implementar endpoints mínimos para:
   - `Campaign`, `ApplicationSchema`, `Application`.
   - Landing `/jobs/:campaignSlug` (solo skeleton).
5. Integración futura con:
   - CV Scanner Express.
   - Form Checker Express.

## Decisiones

- **Base de datos**: PostgreSQL en producción, SQLite opcional en desarrollo.
- **Framework backend**: Fastify por rendimiento y simplicidad.
- **Frontend**: React + Vite (SPA).
- **Auth**: JWT sencillo (email + passwordHash).
- **Estilo**: prioridad legibilidad y simplicidad; sin dependencias mágicas.
- **Legalidad**:
  - Nada de scraping agresivo ni bots que violen TOS.
  - Solo uso de APIs oficiales o flujos semi-manuales.
