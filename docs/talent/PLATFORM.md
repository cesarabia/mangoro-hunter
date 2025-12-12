# PLATFORM – mangoro-hunter

## 1. Visión

Mini-app de Mangoro para:

- Definir campañas de contratación (Hunter Core).
- Captar candidatos mediante landing + formulario/Chat IA (Talent Chat Intake).
- Centralizar conversaciones y postulaciones vía WhatsApp + CRM.

## 2. Arquitectura general

- **Frontend (React + Vite)**
  - `/login` – login agentes.
  - `/inbox` – listado de conversaciones WhatsApp (CRM).
  - `/jobs/:campaignSlug` – landing de campaña para candidatos (futuro).

- **Backend (Fastify + Prisma)**
  - Auth:
    - `POST /api/auth/login`
  - WhatsApp Webhook:
    - `POST /webhook/whatsapp`
  - CRM:
    - `GET /api/conversations`
    - `GET /api/conversations/:id`
    - `POST /api/conversations/:id/messages`
    - `POST /api/conversations/:id/ai-suggest`
  - (Futuro) Campañas y postulaciones:
    - `GET/POST /api/campaigns`
    - `GET/POST /api/campaigns/:slug/applications`
    - `POST /api/intake/:applicationId/message`

- **WhatsApp On-Prem Server**
  - Configurado previamente por el usuario.
  - Envía webhooks a `POST /webhook/whatsapp`.
  - Recibe mensajes vía `/v1/messages`.

- **OpenAI**
  - Usado por `aiService.ts` para:
    - sugerir respuestas en CRM (Agent-AIReply),
    - más adelante, orquestar el chat de intake (Agent-IntakeChat).

## 3. Modelos de datos (resumen)

Se describen en detalle en `prisma/schema.prisma`:

- `User`, `Contact`, `Conversation`, `Message`
- `Campaign`, `ApplicationSchema`, `Application`

## 4. Variables de entorno esperadas (`.env`)

- `DATABASE_URL`
- `PORT`
- `JWT_SECRET`
- `OPENAI_API_KEY` (opcional, se puede configurar desde la UI si se deja vacío)

> Los datos sensibles de WhatsApp Cloud API (base URL, phone number id y access token) se guardan ahora en `SystemConfig` y se gestionan desde el módulo de Configuración del CRM.

## 5. WhatsApp Cloud API – Notas

- Base URL por defecto: `https://graph.facebook.com/v20.0`
- Los mensajes se envían vía `POST https://graph.facebook.com/v20.0/{PHONE_NUMBER_ID}/messages`
- Header: `Authorization: Bearer <ACCESS_TOKEN>`

### Envío de mensajes (pseudo-curl)

```sh
curl -X POST "https://graph.facebook.com/v20.0/<PHONE_NUMBER_ID>/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d '{
    "messaging_product": "whatsapp",
    "to": "<WA_ID_DESTINO>",
    "type": "text",
    "text": { "body": "Hola, gracias por escribir a Postulaciones 👋" }
  }'
```

> El `PHONE_NUMBER_ID` real del número “Postulaciones” debe configurarse desde la UI o por seed inicial (valor sugerido: `1511895116748404`).

## 6. Monetización (ideas iniciales)

- Plan por campaña:
  - X campañas activas simultáneas.
  - Límite de conversaciones / aplicaciones.
- Plan por volumen:
  - Cobro por número de candidaturas procesadas al mes.
- Plan “equipo pequeño” vs “equipo grande”:
  - Diferencias en nº de usuarios (agentes), campañas, features avanzadas.
