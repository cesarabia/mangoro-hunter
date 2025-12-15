import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import {
  DEFAULT_ADMIN_NOTIFICATION_DETAIL_LEVEL,
  DEFAULT_ADMIN_NOTIFICATION_TEMPLATES,
  getSystemConfig
} from './configService';
import { sendWhatsAppText } from './whatsappMessageService';
import { serializeJson } from '../utils/json';
import { normalizeWhatsAppId } from '../utils/whatsapp';
import { getContactDisplayName } from '../utils/contactDisplay';

export type AdminEventType =
  | 'RECRUIT_READY'
  | 'INTERVIEW_SCHEDULED'
  | 'INTERVIEW_RESCHEDULED'
  | 'INTERVIEW_CONFIRMED'
  | 'INTERVIEW_CANCELLED'
  | 'INTERVIEW_ON_HOLD'
  | 'SELLER_DAILY_SUMMARY'
  | 'SELLER_WEEKLY_SUMMARY';

function formatInterviewSlot(day?: string | null, time?: string | null, location?: string | null): string {
  const dayText = (day || '').trim() || 'día por definir';
  const timeText = (time || '').trim() || 'hora por definir';
  const locationText = (location || '').trim();
  const when = `${dayText} ${timeText}`.trim();
  return locationText ? `${when}, ${locationText}` : when;
}

function safeJsonParse<T>(value: string | null | undefined): T | null {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return (template || '').replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key: string) => vars[key] ?? '');
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function parseRecruitSummary(summary: string | null | undefined): {
  location: string | null;
  rut: string | null;
  experience: string | null;
  availability: string | null;
  email: string | null;
} {
  const raw = (summary || '').trim();
  const pick = (label: string) => {
    const match = raw.match(new RegExp(`${label}\\s*:\\s*([^|\\n]+)`, 'i'));
    return match?.[1] ? match[1].trim() : null;
  };
  return {
    location: pick('Comuna/Ciudad') || pick('Comuna') || pick('Ciudad'),
    rut: pick('RUT'),
    experience: pick('Experiencia'),
    availability: pick('Disponibilidad'),
    email: pick('Email')
  };
}

function buildRecruitSummaryByDetail(params: {
  detailLevel: string;
  baseSummary: string | null | undefined;
  recommendation: string;
}): string {
  const detail = (params.detailLevel || DEFAULT_ADMIN_NOTIFICATION_DETAIL_LEVEL).toUpperCase();
  const fields = parseRecruitSummary(params.baseSummary);

  if (detail === 'SHORT') {
    const parts = [
      fields.location ? `Comuna/Ciudad: ${fields.location}` : null,
      fields.experience ? `Experiencia: ${fields.experience}` : null,
      fields.availability ? `Disponibilidad: ${fields.availability}` : null
    ].filter(Boolean) as string[];
    return truncate(parts.length > 0 ? parts.join(' | ') : (params.baseSummary || 'Datos mínimos recibidos.'), 420);
  }

  if (detail === 'DETAILED') {
    const base = truncate(params.baseSummary || 'Datos mínimos recibidos.', 900);
    return truncate(`${base}\nRecomendación: ${params.recommendation}`, 1100);
  }

  // MEDIUM (default)
  const parts = [
    fields.location ? `Comuna/Ciudad: ${fields.location}` : null,
    fields.rut ? `RUT: ${fields.rut}` : null,
    fields.experience ? `Experiencia: ${fields.experience}` : null,
    fields.availability ? `Disponibilidad: ${fields.availability}` : null,
    fields.email ? `Email: ${fields.email}` : null,
    `Recomendación: ${params.recommendation}`
  ].filter(Boolean) as string[];
  return truncate(parts.join(' | '), 850);
}

async function ensureAdminConversation(normalizedAdmin: string) {
  let contact = await prisma.contact.findFirst({
    where: { OR: [{ waId: normalizedAdmin }, { phone: normalizedAdmin }, { phone: `+${normalizedAdmin}` }] }
  });
  if (!contact) {
    contact = await prisma.contact.create({
      data: { waId: normalizedAdmin, phone: `+${normalizedAdmin}`, name: 'Administrador' }
    });
  } else if (!contact.waId) {
    contact = await prisma.contact.update({
      where: { id: contact.id },
      data: { waId: normalizedAdmin }
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

  const displayName = getContactDisplayName(contact);
  const waId = normalizeWhatsAppId(contact?.waId || contact?.phone || '') || '';
  const phone = waId ? `+${waId}` : (contact?.phone || contact?.waId || '').toString();
  const when = formatInterviewSlot(interviewDay, interviewTime, interviewLocation);
  const interviewStatus =
    eventType === 'INTERVIEW_CONFIRMED'
      ? 'CONFIRMED'
      : eventType === 'INTERVIEW_CANCELLED'
        ? 'CANCELLED'
        : eventType === 'INTERVIEW_ON_HOLD'
          ? 'ON_HOLD'
          : 'PENDING';

  const templatesDefault = safeJsonParse<Record<string, string>>(DEFAULT_ADMIN_NOTIFICATION_TEMPLATES) || {};
  const templatesCustom = safeJsonParse<Record<string, string>>(config.adminNotificationTemplates) || {};
  const templates = { ...templatesDefault, ...templatesCustom };
  const detailLevel = (config.adminNotificationDetailLevel || DEFAULT_ADMIN_NOTIFICATION_DETAIL_LEVEL).toUpperCase();

  const recommendation = (() => {
    if (eventType !== 'RECRUIT_READY') return '';
    const fields = parseRecruitSummary(summary);
    const missing: string[] = [];
    if (!displayName || displayName === 'Sin nombre') missing.push('nombre');
    if (!fields.location) missing.push('comuna/ciudad');
    if (!fields.rut) missing.push('RUT');
    if (!fields.experience) missing.push('experiencia');
    if (!fields.availability) missing.push('disponibilidad');
    return missing.length === 0 ? 'contactar para coordinar entrevista.' : `pedir faltantes (${missing.join(', ')}) y luego contactar.`;
  })();

  const computedSummary =
    eventType === 'RECRUIT_READY'
      ? buildRecruitSummaryByDetail({ detailLevel, baseSummary: summary, recommendation })
      : truncate(summary || '', 3000);

  const vars: Record<string, string> = {
    eventType,
    name: displayName,
    phone,
    waId,
    when,
    interviewDay: (interviewDay || '').trim(),
    interviewTime: (interviewTime || '').trim(),
    interviewLocation: (interviewLocation || '').trim(),
    interviewStatus,
    summary: computedSummary,
    recommendation
  };

  const template = templates[eventType] || templatesDefault[eventType] || '';
  let text = renderTemplate(template, vars).trim();
  if (!text) {
    // Fallback to the legacy messages if template is empty/broken.
    if (eventType === 'RECRUIT_READY') {
      text = `🟢 Reclutamiento listo: ${displayName}\nTel: ${phone}\n${computedSummary}\nPróximo paso: revisar y contactar.`;
    } else if (eventType === 'INTERVIEW_SCHEDULED') {
      text = `🗓️ Entrevista agendada: ${displayName}\nTel: ${phone}\n${when}\nEstado: PENDIENTE.`;
    } else if (eventType === 'INTERVIEW_RESCHEDULED') {
      text = `🔁 Entrevista reagendada: ${displayName}\nTel: ${phone}\n${when}\nEstado: PENDIENTE.`;
    } else if (eventType === 'SELLER_DAILY_SUMMARY') {
      text = `📊 Resumen diario ventas: ${displayName}\nTel: ${phone}\n${computedSummary || 'Sin datos.'}`;
    } else if (eventType === 'SELLER_WEEKLY_SUMMARY') {
      text = `📈 Resumen semanal ventas: ${displayName}\nTel: ${phone}\n${computedSummary || 'Sin datos.'}`;
    } else if (eventType === 'INTERVIEW_CANCELLED') {
      text = `❌ Entrevista cancelada: ${displayName}\nTel: ${phone}\n${when}\nEstado: CANCELADA.`;
    } else if (eventType === 'INTERVIEW_ON_HOLD') {
      text = `⏸️ Entrevista en pausa: ${displayName}\nTel: ${phone}\n${when}\nEstado: EN PAUSA.`;
    } else {
      text = `✅ Entrevista confirmada: ${displayName}\nTel: ${phone}\n${when}.`;
    }
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
