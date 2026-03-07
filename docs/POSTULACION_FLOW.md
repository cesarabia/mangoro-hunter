# Postulación Flow (ER-P4)

## Objetivo
Flujo automático de WhatsApp para postulación hasta **OP_REVIEW** con pausa de IA, resumen interno y email a operación.

## Estados de aplicación (`conversation.applicationState`)
- `CHOOSE_ROLE`
- `COLLECT_MIN_INFO`
- `COLLECT_REQUIREMENTS`
- `REQUEST_CV`
- `CONFIRM_CONDITIONS`
- `REQUEST_OP_DOCS`
- `READY_FOR_OP_REVIEW`
- `WAITING_OP_RESULT`
- `OP_ACCEPTED`
- `OP_REJECTED`

## Roles de postulación (`conversation.applicationRole`)
- `PEONETA`
- `DRIVER_COMPANY`
- `DRIVER_OWN_VAN`

## Mapeo a stage visible
- `CHOOSE_ROLE` -> `NEW_INTAKE`
- `COLLECT_MIN_INFO`, `COLLECT_REQUIREMENTS`, `CONFIRM_CONDITIONS`, `REQUEST_CV` -> `SCREENING`
- `REQUEST_OP_DOCS` -> `DOCS_PENDING`
- `READY_FOR_OP_REVIEW`, `WAITING_OP_RESULT` -> `OP_REVIEW`
- `OP_ACCEPTED` -> `INTERVIEW_PENDING`
- `OP_REJECTED` -> `REJECTED`

## Reglas de negocio
- Mínimo Etapa 1: cargo + comuna + disponibilidad + experiencia.
- Si es conductor y falta CV: no avanzar a revisión, pedir CV.
- Etapa 2: carnet ambos lados + licencia B.
- Pagos:
  - Conductor empresa: CHEX $400, Vol $1.000, Mercado Libre $25.000/día, Falabella por definir.
  - Conductor vehículo propio: CHEX $800, Vol $2.000.
  - Peoneta: $15.000/día.
- Entrevista presencial en Providencia; dirección exacta solo al confirmar entrevista.

## Trigger OP_REVIEW
Al entrar a `READY_FOR_OP_REVIEW`:
1. Stage -> `OP_REVIEW`.
2. `conversation.aiPaused = true`.
3. `applicationState = WAITING_OP_RESULT`.
4. Se crea mensaje interno "RESUMEN INTERNO" en la conversación.
5. Se crea notificación in-app para OWNER/ADMIN.
6. Se intenta enviar email de revisión si está configurado.

## Configuración de email
En **Config -> Workspace -> Revisión de postulación (Email)**:
- `reviewEmailTo` (destinatario)
- `reviewEmailFrom` (remitente)

Si no hay configuración SMTP o correos del workspace:
- No se bloquea el flujo.
- Se registra `EmailOutboundLog` con estado `SKIPPED` / `ERROR`.

## Comandos staff (override manual)
En conversación STAFF:
- `resumen` -> regenera resumen interno y reintenta email para el caso más reciente.
- `marcar preseleccionado [id]` -> fuerza `REQUEST_OP_DOCS` + stage `DOCS_PENDING`.
- `aceptado [id]` -> `OP_ACCEPTED` + stage `INTERVIEW_PENDING`.
- `rechazado [id]` -> `OP_REJECTED` + stage `REJECTED`.

Si no se envía `id`, se usa el caso más reciente del workspace.

## Logs para validar
- `AgentRunLog`: comandos ejecutados por staff router y estado.
- `Message` interno: "RESUMEN INTERNO".
- `EmailOutboundLog`: `SENT|SKIPPED|ERROR` con metadata de la razón.
