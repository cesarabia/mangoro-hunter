import { prisma } from '../db/client';
import { normalizeChilePhoneE164 } from '../utils/phone';
import { normalizeWhatsAppId } from '../utils/whatsapp';
import { coerceStageSlug, getWorkspaceDefaultStageSlug } from './workspaceStageService';
import { repairMojibake } from '../utils/textEncoding';

export type CandidateImportStatus = 'NUEVO' | 'CONTACTADO' | 'CITADO' | 'DESCARTADO';
export type CandidateJobRole = 'CONDUCTOR' | 'PEONETA';

type UpsertCandidateInput = {
  workspaceId: string;
  phoneRaw: string;
  name?: string | null;
  role?: string | null;
  jobRole?: CandidateJobRole | string | null;
  channel?: string | null;
  comuna?: string | null;
  ciudad?: string | null;
  email?: string | null;
  initialStatus?: CandidateImportStatus | string | null;
  preserveExistingConversationStage?: boolean;
  importBatchId?: string | null;
  importedByUserId?: string | null;
  sourceFileName?: string | null;
  sourceChannel?: string | null;
  roleProgramMap?: Partial<Record<CandidateJobRole, string | null>>;
};

type UpsertCandidateResult = {
  contactId: string;
  conversationId: string;
  createdContact: boolean;
  createdConversation: boolean;
  phoneE164: string;
  stageSlug: string;
  status: 'NEW' | 'OPEN' | 'CLOSED';
  jobRole: CandidateJobRole;
  programId: string | null;
};

type DerivedCandidateStatus = {
  candidateStatus: CandidateImportStatus;
  stageSlug: string;
  status: 'NEW' | 'OPEN' | 'CLOSED';
};

function normalizeText(value: unknown): string {
  return repairMojibake(value).trim();
}

function normalizeLoose(value: unknown): string {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function hasAnyKeyword(value: string, keywords: string[]): boolean {
  return keywords.some((k) => value.includes(k));
}

export function normalizeCandidateJobRole(value: unknown, fallback: CandidateJobRole = 'CONDUCTOR'): CandidateJobRole {
  const raw = normalizeLoose(value);
  if (!raw) return fallback;
  if (hasAnyKeyword(raw, ['peoneta', 'peonetas', 'ayudante', 'cargador', 'carga y descarga'])) return 'PEONETA';
  if (hasAnyKeyword(raw, ['conductor', 'conductores', 'chofer', 'driver', 'repartidor', 'reparto'])) return 'CONDUCTOR';
  return fallback;
}

export function inferCandidateJobRoleFromProgram(program: { slug?: string | null; name?: string | null } | null | undefined): CandidateJobRole {
  const source = normalizeLoose(`${program?.slug || ''} ${program?.name || ''}`);
  return normalizeCandidateJobRole(source, 'CONDUCTOR');
}

function normalizeCandidateStatus(value: unknown): CandidateImportStatus {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return 'NUEVO';
  if (raw.includes('cita') || raw.includes('agend')) return 'CITADO';
  if (raw.includes('descart') || raw.includes('rechaz') || raw.includes('no califica') || raw.includes('reject')) {
    return 'DESCARTADO';
  }
  if (raw.includes('contact') || raw.includes('seguim') || raw.includes('proceso')) return 'CONTACTADO';
  return 'NUEVO';
}

function mapInitialStatusToStage(status: CandidateImportStatus): { stageSlug: string; status: 'NEW' | 'OPEN' | 'CLOSED' } {
  if (status === 'CONTACTADO') return { stageSlug: 'SCREENING', status: 'OPEN' };
  if (status === 'CITADO') return { stageSlug: 'INTERVIEW_PENDING', status: 'OPEN' };
  if (status === 'DESCARTADO') return { stageSlug: 'REJECTED', status: 'CLOSED' };
  return { stageSlug: 'NEW_INTAKE', status: 'NEW' };
}

function compactNoteLine(label: string, value: string): string | null {
  const v = normalizeText(value);
  if (!v) return null;
  return `${label}: ${v}`;
}

function buildImportMetadataNote(input: { role?: string | null; channel?: string | null; jobRole?: CandidateJobRole | null }): string | null {
  const lines = [
    compactNoteLine('Rol postulación', String(input.role || '')),
    compactNoteLine('Canal origen', String(input.channel || '')),
    compactNoteLine('Puesto', String(input.jobRole || '')),
  ].filter(Boolean) as string[];
  if (lines.length === 0) return null;
  return lines.join(' | ');
}

async function resolveWorkspaceDefaultProgramId(params: {
  workspaceId: string;
  phoneLine: { defaultProgramId?: string | null };
}): Promise<string | null> {
  if (params.phoneLine.defaultProgramId) return params.phoneLine.defaultProgramId;
  const ws = await prisma.workspace
    .findUnique({
      where: { id: params.workspaceId },
      select: { clientDefaultProgramId: true as any },
    })
    .catch(() => null);
  const id = String((ws as any)?.clientDefaultProgramId || '').trim();
  return id || null;
}

export async function buildWorkspaceJobRoleProgramMap(workspaceId: string): Promise<Record<CandidateJobRole, string | null>> {
  const programs = await prisma.program
    .findMany({
      where: { workspaceId, archivedAt: null, isActive: true },
      select: { id: true, slug: true, name: true },
      orderBy: { createdAt: 'asc' },
    })
    .catch(() => [] as any[]);

  const pickByKeywords = (keywords: string[]): string | null => {
    for (const p of programs) {
      const key = normalizeLoose(`${p?.slug || ''} ${p?.name || ''}`);
      if (!key) continue;
      if (keywords.some((k) => key.includes(k))) return String(p.id);
    }
    return null;
  };

  const ws = await prisma.workspace
    .findUnique({ where: { id: workspaceId }, select: { clientDefaultProgramId: true as any } })
    .catch(() => null);
  const wsDefaultProgramId = String((ws as any)?.clientDefaultProgramId || '').trim() || null;

  const conductor =
    pickByKeywords(['conductor', 'conductores', 'chofer', 'driver', 'repartidor', 'reparto']) ||
    (wsDefaultProgramId && programs.some((p) => String(p.id) === wsDefaultProgramId) ? wsDefaultProgramId : null) ||
    (programs[0]?.id ? String(programs[0].id) : null);

  const peoneta =
    pickByKeywords(['peoneta', 'peonetas', 'ayudante', 'cargador']) ||
    conductor ||
    null;

  return {
    CONDUCTOR: conductor,
    PEONETA: peoneta,
  };
}

export async function upsertCandidateAndCase(input: UpsertCandidateInput): Promise<UpsertCandidateResult> {
  const workspaceId = normalizeText(input.workspaceId) || 'default';
  const phoneE164 = normalizeChilePhoneE164(input.phoneRaw);
  if (!phoneE164) throw new Error('Teléfono inválido');
  const waId = normalizeWhatsAppId(phoneE164);
  if (!waId) throw new Error('Teléfono inválido (waId)');

  const defaultPhoneLine = await prisma.phoneLine.findFirst({
    where: { workspaceId, archivedAt: null, isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, defaultProgramId: true },
  });
  if (!defaultPhoneLine?.id) {
    throw new Error('No hay PhoneLine activa en este workspace. Configúrala antes de importar candidatos.');
  }

  const requested = normalizeCandidateStatus(input.initialStatus);
  const mapped = mapInitialStatusToStage(requested);
  const stageSlug = await coerceStageSlug({ workspaceId, stageSlug: mapped.stageSlug }).catch(async () => {
    return getWorkspaceDefaultStageSlug(workspaceId);
  });
  const resolvedStatus: 'NEW' | 'OPEN' | 'CLOSED' = mapped.status;

  const name = normalizeText(input.name);
  const comuna = normalizeText(input.comuna);
  const ciudad = normalizeText(input.ciudad);
  const email = normalizeText(input.email);
  const jobRole = normalizeCandidateJobRole(input.jobRole || input.role || '', 'CONDUCTOR');
  const metadataNote = buildImportMetadataNote({ role: input.role, channel: input.channel, jobRole });

  const existingContact = await prisma.contact.findFirst({
    where: {
      workspaceId,
      OR: [{ waId }, { phone: waId }, { phone: phoneE164 }],
    },
    select: { id: true },
  });

  const importedAt = input.importBatchId ? new Date() : null;

  const contact = existingContact?.id
    ? await prisma.contact.update({
        where: { id: existingContact.id },
        data: {
          waId,
          phone: phoneE164,
          jobRole,
          ...(name ? { candidateNameManual: name, displayName: name, name } : {}),
          ...(comuna ? { comuna } : {}),
          ...(ciudad ? { ciudad } : {}),
          ...(email ? { email } : {}),
          ...(typeof input.sourceChannel === 'string' && input.sourceChannel.trim()
            ? { importSourceChannel: input.sourceChannel.trim() }
            : {}),
          ...(typeof input.sourceFileName === 'string' && input.sourceFileName.trim()
            ? { importSourceFileName: input.sourceFileName.trim() }
            : {}),
          ...(input.importBatchId
            ? {
                importBatchId: String(input.importBatchId).trim(),
                importedAt,
                importedByUserId: String(input.importedByUserId || '').trim() || null,
              }
            : {}),
          ...(metadataNote
            ? {
                notes: (() => {
                  const now = new Date().toISOString();
                  return `[IMPORT ${now}] ${metadataNote}`;
                })(),
              }
            : {}),
          updatedAt: new Date(),
        } as any,
      })
    : await prisma.contact.create({
        data: {
          workspaceId,
          waId,
          phone: phoneE164,
          jobRole,
          ...(name ? { candidateNameManual: name, displayName: name, name } : {}),
          ...(comuna ? { comuna } : {}),
          ...(ciudad ? { ciudad } : {}),
          ...(email ? { email } : {}),
          ...(typeof input.sourceChannel === 'string' && input.sourceChannel.trim()
            ? { importSourceChannel: input.sourceChannel.trim() }
            : {}),
          ...(typeof input.sourceFileName === 'string' && input.sourceFileName.trim()
            ? { importSourceFileName: input.sourceFileName.trim() }
            : {}),
          ...(input.importBatchId
            ? {
                importBatchId: String(input.importBatchId).trim(),
                importedAt,
                importedByUserId: String(input.importedByUserId || '').trim() || null,
              }
            : {}),
          ...(metadataNote
            ? {
                notes: (() => {
                  const now = new Date().toISOString();
                  return `[IMPORT ${now}] ${metadataNote}`;
                })(),
              }
            : {}),
        } as any,
      });

  const roleProgramMap = input.roleProgramMap || {};
  const mappedProgramId =
    (jobRole === 'PEONETA' ? roleProgramMap.PEONETA : roleProgramMap.CONDUCTOR) ||
    null;

  let conversation = await prisma.conversation.findFirst({
    where: {
      workspaceId,
      contactId: contact.id,
      isAdmin: false,
      archivedAt: null,
      conversationKind: 'CLIENT',
    } as any,
    orderBy: { updatedAt: 'desc' },
  });

  let createdConversation = false;
  if (!conversation?.id) {
    const defaultProgramId =
      mappedProgramId ||
      (await resolveWorkspaceDefaultProgramId({ workspaceId, phoneLine: defaultPhoneLine }));
    conversation = await prisma.conversation.create({
      data: {
        workspaceId,
        phoneLineId: defaultPhoneLine.id,
        programId: defaultProgramId,
        contactId: contact.id,
        status: resolvedStatus,
        conversationStage: stageSlug,
        stageChangedAt: new Date(),
        stageReason: 'import_initial_status',
        channel: 'whatsapp',
        conversationKind: 'CLIENT',
      } as any,
    });
    createdConversation = true;
  } else {
    const preserve = input.preserveExistingConversationStage === true;
    const data: Record<string, any> = { updatedAt: new Date() };
    if (!preserve) {
      data.status = resolvedStatus;
      data.conversationStage = stageSlug;
      data.stageChangedAt = new Date();
      data.stageReason = 'import_initial_status';
    }
    // Program mapping by puesto (jobRole) must stay consistent even when preserving stage/status.
    // Preserve only applies to funnel progression fields, not to role→program routing.
    if (mappedProgramId && String(conversation.programId || '') !== String(mappedProgramId)) {
      data.programId = mappedProgramId;
    }
    conversation = await prisma.conversation.update({
      where: { id: conversation.id },
      data: data as any,
    });
  }

  return {
    contactId: contact.id,
    conversationId: conversation.id,
    createdContact: !existingContact?.id,
    createdConversation,
    phoneE164,
    stageSlug: String((conversation as any).conversationStage || stageSlug),
    status: (conversation.status as any) || resolvedStatus,
    jobRole,
    programId: conversation.programId ? String(conversation.programId) : null,
  };
}

export function deriveCandidateStatusFromConversation(conversation: any): DerivedCandidateStatus {
  const stage = String(conversation?.conversationStage || '').toUpperCase();
  const status = String(conversation?.status || 'NEW').toUpperCase() as 'NEW' | 'OPEN' | 'CLOSED';

  if (
    ['REJECTED', 'NO_CONTACTAR', 'DISQUALIFIED', 'CERRADO', 'ARCHIVED'].includes(stage) ||
    status === 'CLOSED'
  ) {
    return { candidateStatus: 'DESCARTADO', stageSlug: stage || 'REJECTED', status: 'CLOSED' };
  }
  if (['INTERVIEW_PENDING', 'INTERVIEW_SCHEDULED', 'INTERVIEWED', 'AGENDADO', 'CONFIRMADO'].includes(stage)) {
    return { candidateStatus: 'CITADO', stageSlug: stage || 'INTERVIEW_PENDING', status };
  }
  if (status === 'OPEN' || ['SCREENING', 'INFO', 'CALIFICADO', 'QUALIFIED', 'EN_COORDINACION', 'INTERESADO'].includes(stage)) {
    return { candidateStatus: 'CONTACTADO', stageSlug: stage || 'SCREENING', status };
  }
  return { candidateStatus: 'NUEVO', stageSlug: stage || 'NEW_INTAKE', status: status || 'NEW' };
}
