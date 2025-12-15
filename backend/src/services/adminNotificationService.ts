import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { getSystemConfig } from './configService';
import { sendWhatsAppText } from './whatsappMessageService';
import { serializeJson } from '../utils/json';
import { normalizeWhatsAppId } from '../utils/whatsapp';

export type AdminEventType =
  | 'RECRUIT_READY'
  | 'INTERVIEW_SCHEDULED'
  | 'INTERVIEW_RESCHEDULED'
  | 'INTERVIEW_CONFIRMED'
  | 'INTERVIEW_CANCELLED'
  | 'INTERVIEW_ON_HOLD';

function formatInterviewSlot(day?: string | null, time?: string | null, location?: string | null): string {
  const dayText = (day || '').trim() || 'día por definir';
  const timeText = (time || '').trim() || 'hora por definir';
  const locationText = (location || '').trim();
  const when = `${dayText} ${timeText}`.trim();
  return locationText ? `${when}, ${locationText}` : when;
}

async function ensureAdminConversation(normalizedAdmin: string) {
  let contact = await prisma.contact.findUnique({ where: { waId: normalizedAdmin } });
  if (!contact) {
    contact = await prisma.contact.create({
      data: { waId: normalizedAdmin, phone: normalizedAdmin, name: 'Administrador' }
    });
  }
  let conversation = await prisma.conversation.findFirst({
    where: { contactId: contact.id, isAdmin: true },
    orderBy: { updatedAt: 'desc' }
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        contactId: contact.id,
        status: 'OPEN',
        channel: 'admin',
        isAdmin: true,
        aiMode: 'OFF'
      }
    });
  }
  return { contact, conversation };
}

async function logAdminMessage(
  conversationId: string,
  direction: 'INBOUND' | 'OUTBOUND',
  text: string,
  rawPayload?: any
) {
  await prisma.message.create({
    data: {
      conversationId,
      direction,
      text,
      rawPayload: serializeJson(rawPayload ?? { admin: true }),
      timestamp: new Date(),
      read: direction === 'OUTBOUND'
    }
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() }
  });
}

export async function sendAdminNotification(options: {
  app: FastifyInstance;
  eventType: AdminEventType;
  contact: any;
  reservationId?: string | null;
  interviewDay?: string | null;
  interviewTime?: string | null;
  interviewLocation?: string | null;
  summary?: string;
}): Promise<void> {
  const { app, eventType, contact, reservationId, interviewDay, interviewTime, interviewLocation, summary } = options;
  const config = await getSystemConfig();
  const adminWa = normalizeWhatsAppId(config.adminWaId || '');
  if (!adminWa) return;

  const { conversation } = await ensureAdminConversation(adminWa);
  const eventKey = `${eventType}:${contact?.id || contact?.waId || contact?.phone || ''}:${reservationId || ''}:${interviewDay || ''}:${interviewTime || ''}:${interviewLocation || ''}`;
  const existing = await prisma.message.findFirst({
    where: {
      conversationId: conversation.id,
      text: { contains: `[REF:${eventKey}]` }
    }
  });
  if (existing) return;

  let text = '';
  if (eventType === 'RECRUIT_READY') {
    text = `🟢 Reclutamiento listo: ${contact?.candidateName || contact?.displayName || contact?.waId}\nTel: +${contact?.waId}\nResumen: ${summary || 'Datos mínimos recibidos.'}\nPróximo paso: revisar y contactar.`;
  } else if (eventType === 'INTERVIEW_SCHEDULED') {
    text = `🗓️ Entrevista agendada: ${contact?.candidateName || contact?.displayName || contact?.waId}\nTel: +${contact?.waId}\n${formatInterviewSlot(interviewDay, interviewTime, interviewLocation)}\nEstado: PENDIENTE.`;
  } else if (eventType === 'INTERVIEW_RESCHEDULED') {
    text = `🔁 Entrevista reagendada: ${contact?.candidateName || contact?.displayName || contact?.waId}\nTel: +${contact?.waId}\n${formatInterviewSlot(interviewDay, interviewTime, interviewLocation)}\nEstado: PENDIENTE.`;
  } else if (eventType === 'INTERVIEW_CANCELLED') {
    text = `❌ Entrevista cancelada: ${contact?.candidateName || contact?.displayName || contact?.waId}\nTel: +${contact?.waId}\n${formatInterviewSlot(interviewDay, interviewTime, interviewLocation)}\nEstado: CANCELADA.`;
  } else if (eventType === 'INTERVIEW_ON_HOLD') {
    text = `⏸️ Entrevista en pausa: ${contact?.candidateName || contact?.displayName || contact?.waId}\nTel: +${contact?.waId}\n${formatInterviewSlot(interviewDay, interviewTime, interviewLocation)}\nEstado: EN PAUSA.`;
  } else {
    text = `✅ Entrevista confirmada: ${contact?.candidateName || contact?.displayName || contact?.waId}\nTel: +${contact?.waId}\n${formatInterviewSlot(interviewDay, interviewTime, interviewLocation)}.`;
  }

  const textWithRef = `${text}\n[REF:${eventKey}]`;
  let sendStatus: 'WA_SENT' | 'WA_FAILED' = 'WA_SENT';
  let sendError: string | null = null;
  try {
    const resp = await sendWhatsAppText(adminWa, textWithRef);
    if (!resp.success) {
      sendStatus = 'WA_FAILED';
      sendError = resp.error || 'Unknown error';
    }
  } catch (err: any) {
    sendStatus = 'WA_FAILED';
    sendError = err?.message || 'Unknown error';
    app.log.warn({ err }, 'Admin notification WA failed');
  }

  await logAdminMessage(conversation.id, 'OUTBOUND', textWithRef, {
    adminNotification: true,
    eventType,
    status: sendStatus,
    error: sendError,
    contactId: contact?.id || null
  });
}

