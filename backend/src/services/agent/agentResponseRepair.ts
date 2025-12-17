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

const SEND_TEXT_KEYS = ['text', 'message', 'content', 'body', 'reply', 'value'] as const;
const SEND_TEMPLATE_NAME_KEYS = ['templateName', 'template', 'name'] as const;
const SEND_TEMPLATE_VARS_KEYS = ['templateVars', 'templateVariables', 'variables', 'vars'] as const;

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

function pickFirstString(sources: any[], keys: readonly string[]): string | undefined {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const raw = (source as any)?.[key];
      const normalized = normalizeString(raw);
      if (typeof normalized === 'string' && normalized) return normalized;
    }
  }
  return undefined;
}

function pickTemplateVars(sources: any[]): Record<string, string> | undefined {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of SEND_TEMPLATE_VARS_KEYS) {
      const raw = (source as any)?.[key];
      if (!raw) continue;
      if (typeof raw === 'object' && !Array.isArray(raw)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) out[String(k)] = typeof v === 'string' ? v : String(v);
        return out;
      }
      if (Array.isArray(raw)) {
        const out: Record<string, string> = {};
        raw.forEach((v, idx) => {
          if (typeof v === 'undefined' || v === null) return;
          out[String(idx + 1)] = typeof v === 'string' ? v : String(v);
        });
        return Object.keys(out).length > 0 ? out : undefined;
      }
    }
  }
  return undefined;
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
    const command = String(cmd.command || '');
    if (command !== 'UPSERT_PROFILE_FIELDS' && command !== 'SEND_MESSAGE') return cmd;

    const next: any = { ...cmd };

    if (command === 'UPSERT_PROFILE_FIELDS') {
      const patchOk = next.patch && typeof next.patch === 'object' && !Array.isArray(next.patch);
      if (!patchOk) {
        const sources = [next.patch, next.parameters, next.fields, next.profile, next.data, next];
        next.patch = buildPatchFromSources(sources);
      }

      if (!next.confidenceByField && next.confidence && typeof next.confidence === 'object') {
        next.confidenceByField = next.confidence;
      }
      return next;
    }

    // SEND_MESSAGE repairs
    const sources = [
      next,
      next.parameters,
      next.payload,
      next.message,
      next.data,
      next.content,
      next.body,
      (next as any)?.payload?.message,
    ];

    const currentText = typeof next.text === 'string' ? next.text.trim() : '';
    if (!currentText) {
      const found = pickFirstString(sources, SEND_TEXT_KEYS as any);
      if (found) next.text = found;
    }

    const currentTemplateName = typeof next.templateName === 'string' ? next.templateName.trim() : '';
    if (!currentTemplateName) {
      const found = pickFirstString(sources, SEND_TEMPLATE_NAME_KEYS as any);
      if (found) next.templateName = found;
    }

    if (!next.templateVars) {
      const vars = pickTemplateVars(sources);
      if (vars) next.templateVars = vars;
    }

    // Si viene TEMPLATE pero sin nombre, intenta usar templateName encontrado arriba. Si viene SESSION_TEXT sin text pero con templateName, cambia a TEMPLATE.
    const type = typeof next.type === 'string' ? next.type.trim().toUpperCase() : '';
    const repairedText = typeof next.text === 'string' ? next.text.trim() : '';
    const repairedTemplateName = typeof next.templateName === 'string' ? next.templateName.trim() : '';
    if (type === 'SESSION_TEXT' && !repairedText && repairedTemplateName) {
      next.type = 'TEMPLATE';
    }
    if (type === 'TEMPLATE' && repairedText && !repairedTemplateName) {
      // Si el modelo puso "text" pero marcó TEMPLATE, preferimos SESSION_TEXT.
      next.type = 'SESSION_TEXT';
    }

    return next;
  });
  return out;
}
