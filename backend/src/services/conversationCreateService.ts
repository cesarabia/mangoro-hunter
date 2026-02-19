import { prisma } from '../db/client';
import { normalizeWhatsAppId } from '../utils/whatsapp';
import { sendWhatsAppTemplate, SendResult } from './whatsappMessageService';
import { serializeJson } from '../utils/json';
import { loadTemplateConfig, resolveTemplateVariables } from './templateService';
import { stableHash } from './agent/tools';
import {
  DEFAULT_TEMPLATE_GENERAL_FOLLOWUP,
  DEFAULT_TEMPLATE_INTERVIEW_INVITE,
  getAdminWaIdAllowlist,
  getSystemConfig
} from './configService';

type Mode = 'RECRUIT' | 'INTERVIEW' | 'SELLER' | 'OFF';
type Status = 'NEW' | 'OPEN' | 'CLOSED';

export interface CreateAndSendParams {
  phoneE164: string;
  contactName?: string | null;
  mode?: string | null;
  status?: string | null;
  sendTemplateNow?: boolean;
  variables?: string[];
  templateNameOverride?: string | null;
  templateLanguageCode?: string | null;
  workspaceId?: string | null;
  phoneLineId?: string | null;
  enforceSafeMode?: boolean;
}

export interface CreateAndSendResult {
  conversationId: string;
  contactId: string;
  sendResult?: SendResult | null;
  templateUsed?: string | null;
  variablesUsed?: string[];
}

function normalizeMode(value?: string | null): Mode {
  const normalized = (value || '').toUpperCase();
  if (normalized === 'INTERVIEW') return 'INTERVIEW';
  if (normalized === 'SELLER' || normalized === 'VENDEDOR' || normalized === 'VENDOR') return 'SELLER';
  if (normalized === 'OFF' || normalized === 'MANUAL') return 'OFF';
  return 'RECRUIT';
}

function normalizeStatus(value?: string | null): Status {
  const normalized = (value || '').toUpperCase();
  if (normalized === 'OPEN') return 'OPEN';
  if (normalized === 'CLOSED') return 'CLOSED';
  return 'NEW';
}

function normalizeManualName(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  if (cleaned.length < 2 || cleaned.length > 120) return null;
  if (/[:;{}<>]/.test(cleaned)) return null;
  return cleaned;
}

export async function createConversationAndMaybeSend(
  params: CreateAndSendParams
): Promise<CreateAndSendResult> {
  const workspaceId = typeof params.workspaceId === 'string' && params.workspaceId.trim() ? params.workspaceId.trim() : 'default';
  const waId = normalizeWhatsAppId(params.phoneE164);
  if (!waId) {
    throw new Error('Número inválido');
  }
  const config = await getSystemConfig();
  const adminWaIds = getAdminWaIdAllowlist(config);
  if (adminWaIds.includes(waId)) {
    throw new Error('No puedes crear una conversación de candidato para el número admin.');
  }
  const mode = normalizeMode(params.mode);
  const status = normalizeStatus(params.status);
  const manualName = normalizeManualName(params.contactName);

  const phoneLine = await (async () => {
    const explicit = typeof params.phoneLineId === 'string' && params.phoneLineId.trim() ? params.phoneLineId.trim() : null;
    if (explicit) {
      return prisma.phoneLine.findFirst({
        where: { id: explicit, workspaceId, archivedAt: null, isActive: true },
        select: { id: true, waPhoneNumberId: true, defaultProgramId: true }
      });
    }
    const first = await prisma.phoneLine.findFirst({
      where: { workspaceId, archivedAt: null, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, waPhoneNumberId: true, defaultProgramId: true }
    });
    return first;
  })();
  if (!phoneLine) {
    throw new Error('No hay un número WhatsApp (PhoneLine) activo configurado para este workspace.');
  }

  const contact = await prisma.contact.upsert({
    where: { workspaceId_waId: { workspaceId, waId } },
    update: {
      phone: waId,
      ...(manualName ? { candidateNameManual: manualName, displayName: manualName } : {}),
    },
    create: {
      workspaceId,
      waId,
      phone: waId,
      ...(manualName ? { candidateNameManual: manualName, displayName: manualName, name: manualName } : {}),
    }
  });

  let conversation = await prisma.conversation.findFirst({
    where: { workspaceId, phoneLineId: phoneLine.id, contactId: contact.id, isAdmin: false },
    orderBy: { updatedAt: 'desc' }
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        workspaceId,
        phoneLineId: phoneLine.id,
        programId: phoneLine.defaultProgramId || null,
        contactId: contact.id,
        status,
        channel: 'whatsapp',
        aiMode: mode
      }
    });
  } else {
    conversation = await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        phoneLineId: phoneLine.id,
        programId: conversation.programId || phoneLine.defaultProgramId || null,
        status,
        aiMode: mode,
        updatedAt: new Date()
      }
    });
  }

  let sendResult: SendResult | undefined;
  let templateUsed: string | null | undefined;
  let variablesUsed: string[] | undefined;

  if (params.sendTemplateNow !== false) {
    const templates = await loadTemplateConfig(undefined, workspaceId);
    const templateName =
      params.templateNameOverride ||
      (mode === 'INTERVIEW'
        ? templates.templateInterviewInvite || DEFAULT_TEMPLATE_INTERVIEW_INVITE
        : templates.templateGeneralFollowup || DEFAULT_TEMPLATE_GENERAL_FOLLOWUP);
    const finalVariables = resolveTemplateVariables(templateName, params.variables, templates, {
      interviewDay: conversation.interviewDay,
      interviewTime: conversation.interviewTime,
      interviewLocation: conversation.interviewLocation
    });

    sendResult = await sendWhatsAppTemplate(waId, templateName, finalVariables, {
      phoneNumberId: phoneLine.waPhoneNumberId,
      enforceSafeMode: params.enforceSafeMode !== false,
      languageCode: params.templateLanguageCode || null,
    });
    templateUsed = templateName;
    variablesUsed = finalVariables;

    if (sendResult.success) {
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction: 'OUTBOUND',
          text: `[TEMPLATE] ${templateName}`,
          rawPayload: serializeJson({
            template: templateName,
            variables: finalVariables || [],
            sendResult
          }),
          timestamp: new Date(),
          read: true
        }
      });
    }

    await prisma.outboundMessageLog
      .create({
        data: {
          workspaceId,
          conversationId: conversation.id,
          channel: 'WHATSAPP',
          type: 'TEMPLATE',
          templateName,
          dedupeKey: `create_and_send:${conversation.id}:${Date.now()}`,
          textHash: stableHash(`TEMPLATE:${templateName}:${serializeJson(finalVariables || [])}`),
          blockedReason: sendResult.success ? null : String(sendResult.error || 'SEND_FAILED'),
          waMessageId: sendResult.messageId || null,
        } as any,
      })
      .catch(() => {});

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() }
    });
  }

  return {
    conversationId: conversation.id,
    contactId: contact.id,
    sendResult,
    templateUsed: templateUsed ?? null,
    variablesUsed
  };
}
