const UPSERT_PATCH_KEYS = [
  'candidateName',
  'email',
  'rut',
  'comuna',
  'ciudad',
  'region',
  'experienceYears',
  'terrainExperience',
  'availabilityText',
] as const;

type PatchKey = (typeof UPSERT_PATCH_KEYS)[number];

function normalizeString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeInt(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeBool(value: unknown): boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (['si', 'sí', 's', 'true', 'yes', 'y', '1'].includes(v)) return true;
  if (['no', 'false', '0'].includes(v)) return false;
  return undefined;
}

function pickPatchValue(key: PatchKey, value: unknown): any {
  if (key === 'experienceYears') return normalizeInt(value);
  if (key === 'terrainExperience') return normalizeBool(value);
  return normalizeString(value);
}

function buildPatchFromSources(sources: any[]): Record<string, any> {
  const patch: Record<string, any> = {};
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const key of UPSERT_PATCH_KEYS) {
      if (!(key in source)) continue;
      const normalized = pickPatchValue(key, (source as any)[key]);
      if (typeof normalized === 'undefined') continue;
      patch[key] = normalized;
    }
  }
  return patch;
}

/**
 * Repairs common LLM mistakes BEFORE schema validation.
 * This keeps the backend deterministic while being resilient to small schema drifts
 * (e.g. UPSERT_PROFILE_FIELDS missing "patch" but providing fields elsewhere).
 */
export function repairAgentResponseBeforeValidation(value: any): any {
  if (!value || typeof value !== 'object' || !Array.isArray((value as any).commands)) return value;
  const out: any = { ...(value as any) };
  out.commands = (value as any).commands.map((cmd: any) => {
    if (!cmd || typeof cmd !== 'object') return cmd;
    if (String(cmd.command || '') !== 'UPSERT_PROFILE_FIELDS') return cmd;

    const next: any = { ...cmd };
    const patchOk = next.patch && typeof next.patch === 'object' && !Array.isArray(next.patch);
    if (!patchOk) {
      const sources = [next.patch, next.parameters, next.fields, next.profile, next.data, next];
      next.patch = buildPatchFromSources(sources);
    }

    if (!next.confidenceByField && next.confidence && typeof next.confidence === 'object') {
      next.confidenceByField = next.confidence;
    }
    return next;
  });
  return out;
}

