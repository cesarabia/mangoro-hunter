# Media Recovery Plan (Adjuntos/Assets históricos)

## Estado conocido (última ejecución de restore)
Fuente: `/tmp/hunter_restore_missing_media_2026-03-07_22-43-17.report.txt`

- Total referencias revisadas: **172**
- Ya presentes: **3**
- Restaurados: **83**
- Restaurados (assets): **0**
- Siguen faltando: **86**
  - Mensajes/adjuntos faltantes: **80**
  - Assets faltantes: **6**

## Objetivo
Recuperar binarios faltantes sin borrar ni sobrescribir datos existentes.

## Alcance y restricciones
- No modificar ni borrar registros de BD.
- No sobrescribir archivos ya presentes.
- Solo copiar faltantes desde rutas legacy/OLD cuando existan.
- Mantener trazabilidad por archivo (origen, destino, resultado).

## Rutas de referencia
- NEW (prod):
  - `/opt/hunter/state/uploads`
  - `/opt/hunter/state/assets`
- OLD (solo lectura):
  - `/opt/hunter/backend/uploads`
  - `/opt/hunter/backend/assets` (si existe)
  - rutas legacy detectadas por `mediaPath` / `storagePath`

## Plan de ejecución (PLAN ONLY)
1. Ejecutar backup ER-P3 (DB + uploads + assets).
2. Ejecutar script seguro:
   - `ops/hunter_restore_missing_media_from_old.sh`
3. Revisar reporte generado por corrida con:
   - restaurados
   - ya presentes
   - siguen faltando
4. Verificar descarga de muestra (3-5 archivos restaurados).
5. Para faltantes no recuperables:
   - conservar flag `missing=true`
   - mostrar CTA "Re-subir archivo" en UI

## Criterio de cierre
- Sin sobrescrituras.
- Sin pérdidas de archivos existentes.
- Reporte final con conteo actualizado y lista de no recuperables.
