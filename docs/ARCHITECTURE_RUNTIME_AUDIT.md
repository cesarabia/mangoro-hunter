# ER-P7 — Auditoría de arquitectura runtime (hunter-prod)

Fecha auditoría: 2026-03-07 (America/Santiago)
Ámbito: `hunter-prod` (`hunter.mangoro.app`), **sin tocar OLD**.

## 1) Flujo inbound real (fuente runtime)

```mermaid
flowchart TD
  A[WhatsApp Cloud Webhook] --> B[POST /whatsapp/webhook]
  B --> C[Resolver phoneLine por waPhoneNumberId]
  C -->|0 o ambiguo| C1[Log UNROUTED/AMBIGUOUS + 2xx sin responder]
  C -->|1 match| D[Upsert Contact + Conversation + Message INBOUND]
  D --> E[Marcar pendingInboundAiRunAt (debounce)]
  E --> F[Worker drain PLANNED]
  F --> G[runAutomations(event=INBOUND_MESSAGE)]
  G --> H[RUN_AGENT]
  H --> I[buildLLMContext]
  I --> J[Resolver Program efectivo]
  J --> K[OpenAI runtime]
  K --> L[Tool execution / command executor]
  L --> M[Outbound log + Message OUTBOUND]
  M --> N[WhatsApp send (policy + 24h + safe mode)]
```

Notas de control:
- Si existen automations `INBOUND_MESSAGE` habilitadas, se usa ruta Agent OS (`runAutomations` + `RUN_AGENT`).
- Si no existen automations o IA pausada, puede entrar fallback legacy (`whatsappInboundService`) que usa `SystemConfig.recruitJobSheet/defaultJobTitle/recruitFaq`.

## 2) Precedencia de fuentes de texto (runtime)

| Prioridad | Fuente | Dónde vive | Cuándo se usa | Estado actual |
|---|---|---|---|---|
| P1 | `Program.agentSystemPrompt` | DB tabla `Program` | Siempre que `RUN_AGENT` resuelve program | **Fuente principal activa** |
| P2 | `ProgramKnowledgeAsset` + permisos connectors | DB tablas `ProgramKnowledgeAsset`, `ProgramConnectorPermission` | Se inyecta en `buildLLMContext` | Activo |
| P3 | Estado conversacional (`applicationRole/state`, missing fields) | DB `Conversation` + `Contact` | Guía el siguiente paso, no debería contradecir prompt | Activo |
| P4 | Fallback legacy reclutamiento (`buildRecruit*`) | Código `whatsappInboundService` + `SystemConfig` | Solo si no entra RUN_AGENT | **Riesgo de copy legacy** |
| P5 | Plantillas WhatsApp | Meta + catálogo local | Mensajes template/manual/outside-24h | Activo |
| P6 | Mensajes históricos conversación | DB `Message` | Entran al contexto como historial real | Activo, puede contaminar si hilo viejo |

## 3) Evidencia: qué prompt usa realmente una conversación real

Caso auditado:
- `workspaceId`: `envio-rapido`
- `conversationId`: `cmlt1yjwq00xyvib18y2a7kk0`
- `AgentRunLog.id`: `cmmgrwtep00bq10z1mljcpnwn`
- `eventType`: `INBOUND_MESSAGE`
- `programId`: `cmlsh0ukw000txipwii3pr3l0`
- `programSlug`: `reclutamiento-conductores-envio-rapido`
- `programName`: `Reclutamiento — Conductores (Envio Rápido)`
- hash del prompt activo (`sha256[:16]`): `1f34b419d919dd80`

Conclusión:
- El runtime de Envío Rápido está resolviendo el Program correcto.
- Los textos viejos detectados (`$600.000`, `venta en terreno`) provienen principalmente de **historial antiguo en Message/AgentRunLog** y de **SystemConfig legacy** usado por fallback, no del `Program.agentSystemPrompt` actual.

## 4) Hallazgos de strings legacy (origen exacto)

Patrones auditados: `"$600.000"`, `"venta en terreno"`, `"Perfecto, te leo..."`.

Resumen de conteos en hunter-prod:
- `Message.text`: 33 (`$600.000`), 18 (`venta en terreno`), 14 (`Perfecto, te leo...`).
- `Message.rawPayload`: 16 (`venta en terreno`) por referrals/plantillas históricas.
- `SystemConfig`: 3 campos activos legacy:
  - `defaultJobTitle = Ejecutivo(a) de Venta en Terreno`
  - `recruitJobSheet` con copy de ventas en terreno
  - `recruitFaq` con copy de alarmas/ventas
- `AgentRunLog`: histórico contaminado por contexto previo (sin implicar prompt actual vigente).
- `HybridReplyDraft`: propuestas viejas con `$600.000`.

## 5) Integridad de archivos (assets + adjuntos)

Estado real en hunter-prod:
- `WorkspaceAsset`: 6 activos, **0 presentes**, **6 faltantes**.
- `Message` con `mediaPath`: 142; detectados **140 faltantes** en disco.
- Directorios persistentes existen pero vacíos:
  - `/opt/hunter/state/assets` (0 archivos)
  - `/opt/hunter/state/uploads` (0 archivos)

Impacto:
- La UI muestra registros, pero al descargar puede dar `Archivo no encontrado`.
- Se implementó señalización `missing/requiere re-subida` para no mostrar error crudo.

## 6) Restauración

- Se auditó backup local de hunter-prod: backups `dev.db` existen, pero `uploads.tar.gz/assets.tar.gz` recientes están vacíos (sin contenido útil para restaurar binarios históricos).
- Bajo restricción de esta iteración (**no tocar OLD**), no se restauraron archivos desde servidor antiguo.
- Resultado: archivos faltantes quedan marcados como `missing` y deben re-subirse.

## 7) Ambiente de prueba limpio (sin hilo contaminado)

Decisión recomendada para QA limpio:
- **Opción B (preferida):** crear un hilo QA nuevo dedicado (número de prueba) y validar ahí el flujo.
- Evitar usar hilos históricos con meses de mensajes para validar cambios nuevos.
- Si se necesita reset controlado: usar endpoint de reset de pruebas (archiva histórico, no borra), pero validando workspace/ruteo antes de ejecutar.

## 8) Acciones realizadas en ER-P7 (sin agregar features de negocio)

1. Observabilidad runtime en contexto de AgentRun:
   - `runtimeResolution.resolvedWorkspace`
   - `runtimeResolution.resolvedPhoneLine`
   - `runtimeResolution.resolvedProgram` (`id/slug/name/promptHash`)
   - `applicationRole`, `applicationState`, `missingFields` (ya presentes, mantenidos)

2. Integridad de archivos UX/API:
   - Assets API ahora retorna `missing`.
   - Descargas de assets/adjuntos devuelven mensaje claro con `requiresResubmission`.
   - Inbox/chat muestra cuando un adjunto está faltante.

3. Sanitización defensiva de `SystemConfig` legacy:
   - Si detecta copy heredado de “venta en terreno / alarmas”, vuelve a defaults neutros para evitar contradicción en fallback legacy.

## 9) Comandos usados para auditoría (referencia)

- Health runtime:
  - `curl -s http://127.0.0.1:4101/api/health`
- Conteos legacy en DB (scan por patrones):
  - script `hunter_er_p7_legacy_counts.py`
- Integridad storage:
  - script `hunter_er_p7_storage_audit.py`

