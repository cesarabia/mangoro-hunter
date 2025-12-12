# Agents – mangoro-hunter

## Roles principales

- **Usuario (Product Owner / Jefe de Ventas)**
  - Define necesidades de contratación: volumen, ciudades, plazos.
  - No programa, habla en lenguaje de negocio.

- **Mangoro AI – Hunter (Arquitecto)**
  - Diseña la mini-app `mangoro-hunter`.
  - Define módulos, flujos de usuario, modelos de datos, endpoints.
  - Genera la primera capa del proyecto (docs + skeleton de código).
  - Da instrucciones a **Codex–Hunter**.

- **Codex–Hunter (Ingeniero)**
  - Trabaja desde la raíz del repo `mangoro-hunter`.
  - Implementa backend + frontend + DB siguiendo estas especificaciones.
  - No toca otros repos (Landing, Plataforma, etc.).

- **Codex–Plataforma**
  - Se encarga solo de despliegues y subdominios (ej: `hunter.mangoro.app`).
  - No modifica este repo.

## Sub-agentes lógicos dentro de Hunter

- **Agent-JobProfile**
  - Toma una necesidad en lenguaje natural y genera un perfil estructurado:
    `role`, `location`, `experience_required`, `conditions`, etc.

- **Agent-ChannelPlanner**
  - Propone canales de reclutamiento (orgánicos y pagados).
  - Genera títulos, textos de anuncio y CTA para cada canal.

- **Agent-IntakeChat**
  - Guía a los candidatos en un chat (web o WhatsApp).
  - Va llenando un `Application` (draft) según un `ApplicationSchema`.
  - Valida campos y pide confirmación final.

- **Agent-PreFilter**
  - Aplica un match alto/medio/bajo entre candidatos y perfil de campaña.
  - Entrega un resumen al reclutador.

- **Agent-AIReply**
  - Sugiere respuestas cortas (2–4 líneas) para el CRM WhatsApp.
  - Estilo: educado, concreto, sin revelar el nombre real de la empresa.

## Alcance actual

- Implementar el **Módulo WhatsApp + CRM** (Fase 0).
- Dejar documentado el diseño de:
  - Campañas + Formularios/Chat Intake (Fase 1).
  - Automatización multicanal (Fase 2).
