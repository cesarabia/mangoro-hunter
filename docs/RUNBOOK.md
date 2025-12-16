# Hunter CRM — Runbook (Operación / QA rápida)

Este runbook está pensado para **personas no técnicas**: levantar el sistema, verificar que la UI no se rompe y validar Agent OS v1 en 10–15 minutos.

## 1) Levantar LOCAL (rápido)

### Paso 0 — Requisitos
- Tener Node.js instalado.
- Tener este repo clonado.

### Paso 1 — Backend (API)
1) En una terminal:
   - `cd backend`
   - `npm install`
2) (Solo si hubo cambios de DB) aplicar migraciones seguras:
   - `export DATABASE_URL="file:../dev.db"`
   - `npx prisma migrate deploy --schema ../prisma/schema.prisma`
   - `npx prisma generate --schema ../prisma/schema.prisma`
3) Levantar backend:
   - `npm run dev`
4) Validar health:
   - `http://localhost:4001/api/health` → debe responder OK.

### Paso 2 — Frontend (UI)
1) En otra terminal:
   - `cd frontend`
   - `npm install`
   - `npm run dev`
2) Abrir la UI (Vite suele usar):
   - `http://localhost:5173`

### Paso 3 — Validación visual mínima (sin adivinar)
1) La app **debe renderizar** (no pantalla blanca).
2) En la barra superior:
   - Navega **Inbox → Configuración → Simulador → Agenda**.
3) Ver indicador de seguridad (si aplica):
   - Si aparece **SAFE MODE: allowlist only**, significa que el sistema **bloquea envíos WhatsApp** a números fuera de allowlist (protección DEV).
3) Consola del navegador:
   - No debe aparecer “Rendered more hooks…” ni warnings de “order of Hooks”.

## 2) Validar Agent OS v1 en 10–15 min

> Importante: esto usa **Simulador** y/o **Sandbox**. No envía WhatsApp real.

### Validación express (recomendada): Scenario Runner
1) Ir a **Simulador**.
2) En “Run Scenario”, ejecutar:
   - **Loop comuna/ciudad (RM)**
3) Debe mostrar **PASS** y crear una sesión sandbox.

Qué esperar:
- El contacto queda con `comuna`/`ciudad` detectadas (ej: “Puente Alto / Santiago”).
- No hay loop repitiendo “me falta comuna/ciudad…”.

### Validación manual (si quieres ver el chat)
1) Ir a **Simulador** → “+ Nueva sesión”.
2) Enviar inbound:
   - `Hola`
3) Enviar inbound (caso loop comuna/ciudad):
   - `✅ PUENTE ALTO / REGION METROPOLITANA / RUT 12.345.678-9`
4) Revisa que el bot **no repita** la misma pregunta dos veces seguidas.

### Dónde ver logs (sin DB)
1) Ir a **Configuración → Logs → Agent Runs**
   - Abrir el run más reciente.
   - Ver:
     - `InputContext`
     - `Commands`
     - `Execution Results`
2) Ir a **Configuración → Logs → Automation Runs**
   - Ver ejecuciones del motor de reglas.

### Nota: Safe Outbound Mode (DEV)
Si estás en DEV y necesitas probar envíos reales a WhatsApp **solo para números de prueba**:
1) Ir a **Configuración → Workspace → SAFE OUTBOUND MODE**
2) Policy recomendado en DEV: `ALLOWLIST_ONLY`
3) Asegurar que la allowlist contiene **solo** admin + test (números autorizados).

## 3) Checklist PASS/FAIL (rápido)

| Paso | Qué hacer | PASS si… |
|---|---|---|
| UI render | Abrir `http://localhost:5173` | No hay pantalla blanca |
| Hooks | Revisar consola navegador | No aparece error de hooks |
| Navegación | Click: Inbox/Config/Simulador/Agenda | No se rompe |
| Health | Abrir `/api/health` | Responde OK |
| Scenario | Simulador → Run Scenario → Loop comuna/ciudad (RM) | Resultado PASS |
| Logs | Config → Logs → Agent Runs | Se ve el run y sus commands/results |
