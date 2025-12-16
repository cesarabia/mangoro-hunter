import crypto from 'node:crypto';

export function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function normalizeText(value: string): string {
  const raw = String(value || '');
  const noAccents = stripAccents(raw);
  const noEmoji = noAccents.replace(/[\p{Extended_Pictographic}]/gu, '');
  return noEmoji
    .replace(/[^\p{L}\p{N}\s/.,:-]/gu, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Canonical commune labels (with accents where applicable); matching is done accent-insensitive.
const RM_COMMUNES = [
  'Puente Alto',
  'Ñuñoa',
  'Providencia',
  'Santiago',
  'Las Condes',
  'La Florida',
  'Maipú',
  'Pudahuel',
  'Estación Central',
  'Quilicura',
  'Renca',
  'Peñalolén',
  'San Miguel',
  'La Reina',
  'Independencia',
  'Cerrillos',
  'Conchalí',
  'Quinta Normal',
  'Macul',
  'Recoleta',
  'San Joaquín',
  'Vitacura',
  'Lo Barnechea',
  'La Cisterna',
  'San Bernardo',
];

export type ResolvedLocation = {
  comuna: string | null;
  ciudad: string | null;
  region: string | null;
  country: string;
  confidence: number;
  normalized: string;
};

function titleCase(value: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return trimmed;
  return trimmed
    .split(' ')
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part))
    .join(' ');
}

function findCommune(normalized: string): string | null {
  const hay = stripAccents(normalized).toLowerCase();
  for (const raw of RM_COMMUNES) {
    const needle = stripAccents(raw).toLowerCase();
    if (!needle) continue;
    if (hay.includes(needle)) {
      return titleCase(raw);
    }
  }
  return null;
}

export function resolveLocation(text: string, country = 'CL'): ResolvedLocation {
  const normalized = normalizeText(text);
  if (country !== 'CL') {
    return { comuna: null, ciudad: null, region: null, country, confidence: 0, normalized };
  }

  const lower = stripAccents(normalized).toLowerCase();
  const region =
    /\b(region metropolitana|rm|metropolitana)\b/.test(lower) ? 'Región Metropolitana' : null;

  const hasSantiago = /\bsantiago\b/.test(lower);
  const comuna = findCommune(normalized);

  let ciudad: string | null = null;
  if (hasSantiago) ciudad = 'Santiago';
  if (!ciudad && comuna && region === 'Región Metropolitana') ciudad = 'Santiago';

  if (!comuna && !ciudad && !region) {
    return { comuna: null, ciudad: null, region: null, country: 'CL', confidence: 0, normalized };
  }

  const confidence = comuna ? 0.9 : ciudad ? 0.7 : 0.5;
  return { comuna, ciudad, region, country: 'CL', confidence, normalized };
}

export function normalizeRut(rutRaw: string): string | null {
  const raw = String(rutRaw || '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/\./g, '').replace(/-/g, '').toUpperCase();
  const body = cleaned.slice(0, -1).replace(/\D/g, '');
  const dv = cleaned.slice(-1);
  if (!/^\d{7,8}$/.test(body)) return null;
  if (!/^[0-9K]$/.test(dv)) return null;
  return `${body}-${dv}`;
}

export function validateRut(rutRaw: string): { valid: boolean; normalized: string | null } {
  const normalized = normalizeRut(rutRaw);
  if (!normalized) return { valid: false, normalized: null };
  const [body, dv] = normalized.split('-');
  let sum = 0;
  let multiplier = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += parseInt(body[i], 10) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const mod = 11 - (sum % 11);
  const expected = mod === 11 ? '0' : mod === 10 ? 'K' : String(mod);
  return { valid: expected === dv, normalized };
}

export function piiSanitizeText(value: string): string {
  let text = String(value || '');
  text = text.replace(
    /([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})/gi,
    (_m, user, domain) => `${String(user).slice(0, 2)}***@${domain}`,
  );
  text = text.replace(/\+?\d[\d\s]{7,}\d/g, (m) => m.replace(/\d/g, 'X'));
  text = text.replace(/\b\d{7,8}-[0-9K]\b/gi, (m) => m.replace(/[0-9K]/gi, 'X'));
  return text;
}

export function stableHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
