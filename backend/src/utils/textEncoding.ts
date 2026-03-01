export function repairMojibake(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/[ÃÂ�]/.test(raw)) return raw;
  try {
    const fixed = Buffer.from(raw, 'latin1').toString('utf8').trim();
    if (!fixed || fixed.includes('�')) return raw;
    return fixed;
  } catch {
    return raw;
  }
}

