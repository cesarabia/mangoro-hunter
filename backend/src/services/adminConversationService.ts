import { FastifyBaseLogger } from 'fastify';
import { prisma } from '../db/client';
import { serializeJson } from '../utils/json';
import { normalizeWhatsAppId } from '../utils/whatsapp';
import { sendWhatsAppText, SendResult } from './whatsappMessageService';

type EnsureAdminConversationParams = {
  workspaceId: string;
  waId: string;
  phoneLineId: string;
};

export async function ensureAdminConversation(params: EnsureAdminConversationParams): Promise<{
  contact: any;
  conversation: any;
  normalizedAdminWaId: string;
}> {
  const normalized = normalizeWhatsAppId(params.waId) || normalizeWhatsAppId(String(params.waId || '').replace(/^\+/, ''));
  if (!normalized) {
    throw new Error('admin_waid_invalid');
  }

  let contact = await prisma.contact.findFirst({
    where: {
      workspaceId: params.workspaceId,
      OR: [{ waId: normalized }, { phone: normalized }, { phone: `+${normalized}` }],
    },
  });

  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        workspaceId: params.workspaceId,
        waId: normalized,
        phone: `+${normalized}`,
        name: 'Administrador',
      },
    });
  } else if (!contact.waId) {
    contact = await prisma.contact.update({
      where: { id: contact.id },
      data: { waId: normalized },
    });
  }

  let conversation = await prisma.conversation.findFirst({
    where: {
      workspaceId: params.workspaceId,
      phoneLineId: params.phoneLineId,
      contactId: contact.id,
      isAdmin: true,
    },
    orderBy: { updatedAt: 'desc' },
  });

  if (!conversation) {
    const adminProgram = await prisma.program
      .findFirst({
        where: { workspaceId: params.workspaceId, slug: 'admin', archivedAt: null },
        select: { id: true },
      })
      .catch(() => null);

    conversation = await prisma.conversation.create({
      data: {
        workspaceId: params.workspaceId,
        phoneLineId: params.phoneLineId,
        programId: adminProgram?.id || null,
        contactId: contact.id,
        status: 'OPEN',
        channel: 'admin',
        isAdmin: true,
        aiMode: 'OFF',
        conversationKind: 'ADMIN',
      } as any,
    });
  }

  return { contact, conversation, normalizedAdminWaId: normalized };
}

export async function logAdminMessage(params: {
  conversationId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  text: string;
  rawPayload?: any;
}): Promise<void> {
  await prisma.message.create({
    data: {
      conversationId: params.conversationId,
      direction: params.direction,
      text: params.text,
      rawPayload: serializeJson(params.rawPayload ?? { admin: true }),
      timestamp: new Date(),
      read: params.direction === 'OUTBOUND',
    },
  });

  await prisma.conversation
    .update({
      where: { id: params.conversationId },
      data: { updatedAt: new Date() },
    })
    .catch(() => {});
}

export async function sendAdminReply(params: {
  logger: FastifyBaseLogger;
  conversationId: string;
  waId: string;
  text: string;
  rawPayload?: any;
}): Promise<SendResult> {
  const convo = await prisma.conversation
    .findUnique({
      where: { id: params.conversationId },
      select: { phoneLine: { select: { id: true, waPhoneNumberId: true } } },
    })
    .catch(() => null);
  const phoneNumberId = convo?.phoneLine?.waPhoneNumberId || null;
  const sendResult = await sendWhatsAppText(params.waId, params.text, { phoneNumberId });

  if (!sendResult.success) {
    params.logger.warn({ conversationId: params.conversationId, error: sendResult.error }, 'Admin reply send failed');
  }

  await logAdminMessage({
    conversationId: params.conversationId,
    direction: 'OUTBOUND',
    text: params.text,
    rawPayload: {
      adminReply: true,
      sendResult: {
        success: sendResult.success,
        messageId: 'messageId' in sendResult ? sendResult.messageId ?? null : null,
        error: 'error' in sendResult ? sendResult.error ?? null : null,
      },
      ...(params.rawPayload || {}),
    },
  });

  if (sendResult.success && convo?.phoneLine?.id) {
    await prisma.phoneLine
      .update({ where: { id: convo.phoneLine.id }, data: { lastOutboundAt: new Date() } })
      .catch(() => {});
  }

  return sendResult;
}
