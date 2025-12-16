export type ContactDisplaySource = {
  candidateNameManual?: string | null;
  candidateName?: string | null;
  displayName?: string | null;
  name?: string | null;
  waId?: string | null;
  phone?: string | null;
};

function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function isGarbageDisplayName(value?: string | null): boolean {
  if (!value) return true;
  const lower = stripAccents(String(value)).toLowerCase();
  if (!lower.trim()) return true;
  const patterns = [
    'hola quiero postular',
    'quiero postular',
    'postular',
    'hola',
    'buenas',
    'mas informacion',
    'más informacion',
    'mas info',
    'más info',
    'informacion',
    'info',
    'confirmo',
    'gracias',
    'tengo disponibilidad',
  ];
  if (patterns.some((p) => lower.includes(stripAccents(p)))) return true;
  if (/\b(cancelar|cancelaci[oó]n|reagend|reprogram|cambiar|modificar|mover)\b/i.test(lower)) return true;
  if (/\b(cv|cb|curric|curr[íi]cul|vitae|adjunt|archivo|documento|imagen|foto|pdf|word|docx)\b/i.test(lower)) return true;
  if (/\b\d{1,2}:\d{2}\b/.test(lower)) return true;
  return false;
}

export function getContactDisplayName(contact: ContactDisplaySource | null | undefined): string {
  if (!contact) return 'Sin nombre';
  const manual = (contact.candidateNameManual || '').trim();
  if (manual) return manual;
  const candidate = (contact.candidateName || '').trim();
  if (candidate) return candidate;
  const display = (contact.displayName || '').trim();
  if (display && !isGarbageDisplayName(display)) return display;
  const name = (contact.name || '').trim();
  if (name && !isGarbageDisplayName(name)) return name;
  return (contact.waId || contact.phone || 'Sin nombre').toString();
}
