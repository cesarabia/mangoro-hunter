# Producción congelada (ER-P14)

Ámbito: `hunter-prod` (`hunter.mangoro.app`)

## Política de freeze
- No iterar lógica nueva directo en producción.
- Producción solo operación manual/semi-manual hasta validar en local.
- No hacer deploy de cambios funcionales hasta QA local limpia.

## Config recomendada durante freeze
- `candidateReplyMode`: `HYBRID` (o manual operativo equivalente)
- `adminNotifyMode`: `HITS_ONLY`
- Prompts/programs: no tocar vía bootstrap automático.

## Guardrails de operación
1. No ejecutar seeds/bootstrap que sobrescriban prompts en prod.
2. No cambiar programas/automatizaciones sin ticket de release aprobado.
3. Mantener backups ER-P3 antes de cualquier intervención.
4. Probar cambios primero en local (`http://localhost:5173`).

## Banner/nota interna sugerida
Texto sugerido para equipo:
> "Producción en modo conservador: cambios de lógica solo se validan en local y luego se promueven con QA aprobada."

## Criterio para levantar freeze
- Flujo Intake -> Program -> OP_REVIEW pasa QA local limpia.
- Simulador local cubre casos de candidato y staff sin errores de orden/copy interno.
- Checklist manual aprobado por Owner/Admin.
