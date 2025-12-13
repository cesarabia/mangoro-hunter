# STATE – mangoro-hunter

## Hecho (12 Dic 2025)

- Admin IA natural operativa: comandos slash siguen disponibles pero la conversación admin se guarda y la IA responde en lenguaje natural usando herramientas (`admin_stats`, `admin_list_conversations`, etc.).
- Configuración y SystemConfig estabilizados: nuevas columnas (admin/interview prompts, plantillas) migradas; endpoints `/api/config/*` toleran faltantes y muestran los valores reales.
- Modo Entrevista completo:
  - `aiMode` por conversación (Reclutamiento / Entrevista / Manual) visible en el CRM y editable desde el panel.
  - Auto-respuesta usa el prompt correcto o se silencia en modo Manual; el botón “Sugerir” también cambia según modo.
  - Control ventana 24h + envío de plantillas cuando expira la ventana.
- Nombres de contactos persistentes:
  - Se captura `profile.name` desde el webhook.
  - Si el candidato escribe “me llamo …”, se extrae y se guarda en `Contact.name`.
  - La lista de conversaciones muestra Nombre (línea 1) + número en la línea 2.
- Deploy automatizado vía git (`deploy_hunter.sh`) y repositorio público https://github.com/cesarabia/mangoro-hunter sincronizado.

## Pendiente próximo sprint

1. Diseño de agenda/slots para coordinar entrevista (flujo de confirmación posterior al modo Entrevista).
2. Historias de plantillas adicionales (follow-up general) y carga de variables desde UI.
3. Limpieza de pm2/env (asegurar que siempre lee `/opt/hunter/.env` solo para SERVER y `.backend/.env` para Prisma).
4. Tests automatizados básicos (unitarios para extractores de nombres y 24h window).
5. Revisión de métricas/admin dashboard (mostrar stats en frontend).

## Decisiones

- **Base de datos**: PostgreSQL en producción, SQLite opcional en desarrollo.
- **Framework backend**: Fastify por rendimiento y simplicidad.
- **Frontend**: React + Vite (SPA).
- **Auth**: JWT sencillo (email + passwordHash).
- **Estilo**: prioridad legibilidad y simplicidad; sin dependencias mágicas.
- **Legalidad**:
  - Nada de scraping agresivo ni bots que violen TOS.
  - Solo uso de APIs oficiales o flujos semi-manuales.
