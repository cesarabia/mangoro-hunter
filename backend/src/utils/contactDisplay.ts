export type ContactDisplaySource = {
  candidateNameManual?: string | null;
  candidateName?: string | null;
  displayName?: string | null;
  name?: string | null;
  waId?: string | null;
  phone?: string | null;
};

export function getContactDisplayName(contact: ContactDisplaySource | null | undefined): string {
  if (!contact) return 'Sin nombre';
  const manual = (contact.candidateNameManual || '').trim();
  if (manual) return manual;
  const candidate = (contact.candidateName || '').trim();
  if (candidate) return candidate;
  const display = (contact.displayName || '').trim();
  if (display) return display;
  const name = (contact.name || '').trim();
  if (name) return name;
  return (contact.waId || contact.phone || 'Sin nombre').toString();
}

