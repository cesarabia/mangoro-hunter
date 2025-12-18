export function looksLikeSecretOrToken(value: string): boolean {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^EAAB/i.test(raw)) return true;
  if (/[A-Za-z]/.test(raw)) return true;
  // Heuristic: long opaque strings (tokens) often include underscores/dashes.
  if (raw.length >= 30 && /[A-Za-z0-9_-]{30,}/.test(raw)) return true;
  return false;
}

export function normalizeChilePhoneE164(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let raw = value.trim();
  if (!raw) return null;

  if (looksLikeSecretOrToken(raw)) {
    throw new Error('phoneE164 parece un token/credencial. Debe ser un número en formato E.164 (ej: +56994830202).');
  }

  raw = raw.replace(/[()\s-]+/g, '');
  if (/^\d+$/.test(raw)) raw = `+${raw}`;

  if (!/^\+56\d{9}$/.test(raw)) {
    throw new Error('phoneE164 inválido. Usa formato E.164 Chile: +56 seguido de 9 dígitos (ej: +56994830202).');
  }
  return raw;
}

