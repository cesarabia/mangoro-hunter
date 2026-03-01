import { prisma } from '../db/client';
import { normalizeChilePhoneE164 } from '../utils/phone';
import { normalizeWhatsAppId } from '../utils/whatsapp';
import { coerceStageSlug, getWorkspaceDefaultStageSlug } from './workspaceStageService';
import { repairMojibake } from '../utils/textEncoding';

export type CandidateImportStatus = 'NUEVO' | 'CONTACTADO' | 'CITADO' | 'DESCARTADO';

type UpsertCandidateInput = {
  workspaceId: string;
  phoneRaw: string;
  name?: string | null;
  role?: string | null;
  channel?: string | null;
  comuna?: string | null;
  ciudad?: string | null;
  email?: string | null;
  initialStatus?: CandidateImportStatus | string | null;
  preserveExistingConversationStage?: boolean;
};

type UpsertCandidateResult = {
  contactId: string;
  conversationId: string;
  createdContact: boolean;
  createdConversation: boolean;
  phoneE164: string;
  stageSlug: string;
  status: 'NEW' | 'OPEN' | 'CLOSED';
};

type DerivedCandidateStatus = {
  candidateStatus: CandidateImportStatus;
  stageSlug: string;
  status: 'NEW' | 'OPEN' | 'CLOSED';
};

function normalizeText(value: unknown): string {
  return repairMojibake(value).trim();
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

function buildImportMetadataNote(input: { role?: string | null; channel?: string | null }): string | null {
  const lines = [
    compactNoteLine('Rol postulación', String(input.role || '')),
    compactNoteLine('Canal origen', String(input.channel || '')),
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
  const metadataNote = buildImportMetadataNote({ role: input.role, channel: input.channel });

  const existingContact = await prisma.contact.findFirst({
    where: {
      workspaceId,
      OR: [{ waId }, { phone: waId }, { phone: phoneE164 }],
    },
    select: { id: true },
  });

  const contact = existingContact?.id
    ? await prisma.contact.update({
        where: { id: existingContact.id },
        data: {
          waId,
          phone: phoneE164,
          ...(name ? { candidateNameManual: name, displayName: name, name } : {}),
          ...(comuna ? { comuna } : {}),
          ...(ciudad ? { ciudad } : {}),
          ...(email ? { email } : {}),
          ...(metadataNote
            ? {
                notes: (() => {
                  const now = new Date().toISOString();
                  return `[IMPORT ${now}] ${metadataNote}`;
                })(),
              }
            : {}),
          updatedAt: new Date(),
        },
      })
    : await prisma.contact.create({
        data: {
          workspaceId,
          waId,
          phone: phoneE164,
          ...(name ? { candidateNameManual: name, displayName: name, name } : {}),
          ...(comuna ? { comuna } : {}),
          ...(ciudad ? { ciudad } : {}),
          ...(email ? { email } : {}),
          ...(metadataNote
            ? {
                notes: (() => {
                  const now = new Date().toISOString();
                  return `[IMPORT ${now}] ${metadataNote}`;
                })(),
              }
            : {}),
        },
      });

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
    const defaultProgramId = await resolveWorkspaceDefaultProgramId({ workspaceId, phoneLine: defaultPhoneLine });
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
  } else if (input.preserveExistingConversationStage !== true) {
    conversation = await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        status: resolvedStatus,
        conversationStage: stageSlug,
        stageChangedAt: new Date(),
        stageReason: 'import_initial_status',
        updatedAt: new Date(),
      } as any,
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
