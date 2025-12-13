import { prisma } from '../db/client';
import { normalizeWhatsAppId } from '../utils/whatsapp';
import { sendWhatsAppTemplate, SendResult } from './whatsappMessageService';
import { serializeJson } from '../utils/json';
import { loadTemplateConfig, resolveTemplateVariables } from './templateService';
import { DEFAULT_TEMPLATE_GENERAL_FOLLOWUP, DEFAULT_TEMPLATE_INTERVIEW_INVITE } from './configService';

type Mode = 'RECRUIT' | 'INTERVIEW' | 'OFF';
type Status = 'NEW' | 'OPEN' | 'CLOSED';

export interface CreateAndSendParams {
  phoneE164: string;
  mode?: string | null;
  status?: string | null;
  sendTemplateNow?: boolean;
  variables?: string[];
  templateNameOverride?: string | null;
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
  if (normalized === 'OFF' || normalized === 'MANUAL') return 'OFF';
  return 'RECRUIT';
}

function normalizeStatus(value?: string | null): Status {
  const normalized = (value || '').toUpperCase();
  if (normalized === 'OPEN') return 'OPEN';
  if (normalized === 'CLOSED') return 'CLOSED';
  return 'NEW';
}

export async function createConversationAndMaybeSend(
  params: CreateAndSendParams
): Promise<CreateAndSendResult> {
  const waId = normalizeWhatsAppId(params.phoneE164);
  if (!waId) {
    throw new Error('Número inválido');
  }
  const mode = normalizeMode(params.mode);
  const status = normalizeStatus(params.status);

  const contact = await prisma.contact.upsert({
    where: { waId },
    update: { phone: waId },
    create: { waId, phone: waId }
  });

  let conversation = await prisma.conversation.findFirst({
    where: { contactId: contact.id, isAdmin: false },
    orderBy: { updatedAt: 'desc' }
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
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
    const templates = await loadTemplateConfig();
    const templateName =
      params.templateNameOverride ||
      (mode === 'INTERVIEW'
        ? templates.templateInterviewInvite || DEFAULT_TEMPLATE_INTERVIEW_INVITE
        : templates.templateGeneralFollowup || DEFAULT_TEMPLATE_GENERAL_FOLLOWUP);
    const finalVariables = resolveTemplateVariables(templateName, params.variables, templates);

    sendResult = await sendWhatsAppTemplate(waId, templateName, finalVariables);
    templateUsed = templateName;
    variablesUsed = finalVariables;

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
