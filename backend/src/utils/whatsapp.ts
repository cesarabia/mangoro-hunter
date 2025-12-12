export function normalizeWhatsAppId(value?: string | null): string | null {
  if (!value) return null;
  let normalized = value.trim();
  if (!normalized) return null;
  const atIndex = normalized.indexOf('@');
  if (atIndex >= 0) {
    normalized = normalized.slice(0, atIndex);
  }
  normalized = normalized.replace(/[^0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
}

export function buildWaIdCandidates(value?: string | null): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  const normalized = normalizeWhatsAppId(trimmed);
  const candidates = new Set<string>();
  candidates.add(trimmed);
  if (trimmed.startsWith('+')) {
    candidates.add(trimmed.slice(1));
  }
  if (normalized) {
    candidates.add(normalized);
    candidates.add(`+${normalized}`);
  }
  return Array.from(candidates).filter(Boolean);
}
