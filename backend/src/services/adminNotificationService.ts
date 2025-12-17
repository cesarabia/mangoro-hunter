import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import {
  DEFAULT_ADMIN_NOTIFICATION_DETAIL_LEVEL,
  DEFAULT_ADMIN_NOTIFICATION_TEMPLATES,
  getAdminWaIdAllowlist,
  getSystemConfig
} from './configService';
import { sendWhatsAppText } from './whatsappMessageService';
import { serializeJson } from '../utils/json';
import { normalizeWhatsAppId } from '../utils/whatsapp';
import { getContactDisplayName } from '../utils/contactDisplay';
import { normalizeEscapedWhitespace } from '../utils/text';

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

function isValidChileRut(rutRaw: string | null | undefined): boolean {
  const raw = String(rutRaw || '').trim();
  if (!raw) return false;
  const cleaned = raw.replace(/\./g, '').replace(/-/g, '').toUpperCase();
  const body = cleaned.slice(0, -1).replace(/\D/g, '');
  const dv = cleaned.slice(-1);
  if (!/^\d{7,8}$/.test(body)) return false;
  if (!/^[0-9K]$/.test(dv)) return false;
  let sum = 0;
  let multiplier = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += parseInt(body[i], 10) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const mod = 11 - (sum % 11);
  const expected = mod === 11 ? '0' : mod === 10 ? 'K' : String(mod);
  return expected === dv;
}

function parseExperienceDetails(experienceRaw: string | null | undefined): {
  years: string | null;
  terrain: boolean;
  rubros: string[];
} {
  const exp = String(experienceRaw || '').trim();
  if (!exp) return { years: null, terrain: false, rubros: [] };

  const normalized = exp.toLowerCase();
  const yearsMatch = normalized.match(/\b(\d{1,2})\s*a[nñ]os\b/);
  const years = yearsMatch?.[1] ? yearsMatch[1] : null;

  const parentheses = exp.match(/\(([^)]+)\)/);
  const tokens = parentheses?.[1]
    ? parentheses[1]
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
    : [];
  const terrain =
    tokens.some(t => /terreno|p2p|puerta/.test(t.toLowerCase())) ||
    /terreno|p2p|puerta/.test(normalized);
  const rubros = tokens
    .map(t => t.replace(/\s+/g, ' ').trim())
    .filter(t => t && !/terreno|p2p|puerta/.test(t.toLowerCase()));

  return { years, terrain, rubros };
}

function buildRecruitSummaryByDetail(params: {
  detailLevel: string;
  baseSummary: string | null | undefined;
  recommendation: string;
  rutVigente: string | null;
  experienceYears: string | null;
  terrain: string | null;
  rubros: string | null;
  hasCv: string | null;
}): string {
  const detail = (params.detailLevel || DEFAULT_ADMIN_NOTIFICATION_DETAIL_LEVEL).toUpperCase();
  const fields = parseRecruitSummary(params.baseSummary);

  if (detail === 'SHORT') {
    const parts = [
      fields.location ? `Comuna/Ciudad: ${fields.location}` : null,
      params.experienceYears ? `Experiencia (años): ${params.experienceYears}` : fields.experience ? `Experiencia: ${fields.experience}` : null,
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
    fields.rut ? `RUT: ${fields.rut}${params.rutVigente ? ` (vigente: ${params.rutVigente})` : ''}` : null,
    params.experienceYears ? `Años exp: ${params.experienceYears}` : null,
    params.terrain ? `Terreno: ${params.terrain}` : null,
    params.rubros ? `Rubros: ${params.rubros}` : null,
    fields.availability ? `Disponibilidad: ${fields.availability}` : null,
    fields.email ? `Email: ${fields.email}` : null,
    params.hasCv ? `CV: ${params.hasCv}` : null,
    `Recomendación: ${params.recommendation}`
  ].filter(Boolean) as string[];
  return truncate(parts.join(' | '), 850);
}

async function ensureAdminConversation(params: { workspaceId: string; phoneLineId: string; normalizedAdmin: string }) {
  let contact = await prisma.contact.findFirst({
    where: {
      workspaceId: params.workspaceId,
      OR: [
        { waId: params.normalizedAdmin },
        { phone: params.normalizedAdmin },
        { phone: `+${params.normalizedAdmin}` }
      ]
    }
  });
  if (!contact) {
    contact = await prisma.contact.create({
      data: { workspaceId: params.workspaceId, waId: params.normalizedAdmin, phone: `+${params.normalizedAdmin}`, name: 'Administrador' }
    });
  } else if (!contact.waId) {
    contact = await prisma.contact.update({
      where: { id: contact.id },
      data: { waId: params.normalizedAdmin }
    });
  }
  let conversation = await prisma.conversation.findFirst({
    where: { contactId: contact.id, isAdmin: true, workspaceId: params.workspaceId, phoneLineId: params.phoneLineId },
    orderBy: { updatedAt: 'desc' }
  });
  if (!conversation) {
    const adminProgram = await prisma.program
      .findFirst({
        where: { workspaceId: params.workspaceId, slug: 'admin', archivedAt: null },
        select: { id: true }
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
  workspaceId?: string | null;
  phoneLineId?: string | null;
  reservationId?: string | null;
  interviewDay?: string | null;
  interviewTime?: string | null;
  interviewLocation?: string | null;
  summary?: string;
}): Promise<void> {
  const { app, eventType, contact, reservationId, interviewDay, interviewTime, interviewLocation, summary } = options;
  const workspaceId = String(options.workspaceId || contact?.workspaceId || 'default');
  const config = await getSystemConfig();
  const adminWaIds = getAdminWaIdAllowlist(config);
  if (adminWaIds.length === 0) return;

  const resolvedPhoneLineId = await (async () => {
    const explicit = typeof options.phoneLineId === 'string' && options.phoneLineId.trim() ? options.phoneLineId.trim() : null;
    if (explicit) return explicit;
    const first = await prisma.phoneLine.findFirst({
      where: { workspaceId, archivedAt: null, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true }
    });
    return first?.id || 'default';
  })();
  const phoneLine = await prisma.phoneLine
    .findFirst({ where: { id: resolvedPhoneLineId, workspaceId }, select: { waPhoneNumberId: true } })
    .catch(() => null);
  const phoneNumberId = phoneLine?.waPhoneNumberId || null;

  const enabledEventsParsed = safeJsonParse<unknown>(config.adminNotificationEnabledEvents);
  if (Array.isArray(enabledEventsParsed) && enabledEventsParsed.length > 0) {
    const enabledSet = new Set(enabledEventsParsed.map((v) => String(v)));
    if (!enabledSet.has(eventType)) return;
  }

  const eventKey = `${eventType}:${contact?.id || contact?.waId || contact?.phone || ''}:${reservationId || ''}:${interviewDay || ''}:${interviewTime || ''}:${interviewLocation || ''}`;

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
  const detailLevelsByEvent = safeJsonParse<Record<string, string>>(config.adminNotificationDetailLevelsByEvent) || {};
  const effectiveDetailLevel = detailLevelsByEvent[eventType] || config.adminNotificationDetailLevel || DEFAULT_ADMIN_NOTIFICATION_DETAIL_LEVEL;
  const detailLevel = effectiveDetailLevel.toUpperCase();

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

  const recruitFields = eventType === 'RECRUIT_READY' ? parseRecruitSummary(summary) : null;
  const rutVigente =
    eventType === 'RECRUIT_READY' && recruitFields?.rut
      ? isValidChileRut(recruitFields.rut)
        ? 'sí'
        : 'no'
      : null;
  const expDetails =
    eventType === 'RECRUIT_READY' ? parseExperienceDetails(recruitFields?.experience) : { years: null, terrain: false, rubros: [] as string[] };
  const experienceYears = eventType === 'RECRUIT_READY' ? expDetails.years : null;
  const terrain = eventType === 'RECRUIT_READY' ? (expDetails.terrain ? 'sí' : 'no') : null;
  const rubros = eventType === 'RECRUIT_READY' && expDetails.rubros.length > 0 ? expDetails.rubros.join(', ') : null;
  const hasCv =
    eventType === 'RECRUIT_READY' && contact?.id
      ? Boolean(
          await prisma.message.findFirst({
            where: {
              direction: 'INBOUND',
              mediaType: { in: ['image', 'document'] },
              transcriptText: { not: null },
              conversation: { contactId: contact.id }
            },
            select: { id: true }
          })
        )
      : null;
  const cv = eventType === 'RECRUIT_READY' && hasCv !== null ? (hasCv ? 'sí' : 'no') : null;

  const computedSummary =
    eventType === 'RECRUIT_READY'
      ? buildRecruitSummaryByDetail({
          detailLevel,
          baseSummary: summary,
          recommendation,
          rutVigente,
          experienceYears,
          terrain,
          rubros,
          hasCv: cv
        })
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
    recommendation,
    location: recruitFields?.location || '',
    rut: recruitFields?.rut || '',
    rutVigente: rutVigente || '',
    experience: recruitFields?.experience || '',
    experienceYears: experienceYears || '',
    experienceTerrain: terrain || '',
    experienceRubros: rubros || '',
    availability: recruitFields?.availability || '',
    email: recruitFields?.email || '',
    cv: cv || ''
  };

  const template = templates[eventType] || templatesDefault[eventType] || '';
  let text = normalizeEscapedWhitespace(renderTemplate(template, vars)).trim();
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

  const textWithRef = normalizeEscapedWhitespace(`${text}\n[REF:${eventKey}]`);

  for (const adminWa of adminWaIds) {
    const normalizedAdmin = normalizeWhatsAppId(adminWa);
    if (!normalizedAdmin) continue;
    const { conversation } = await ensureAdminConversation({
      workspaceId,
      phoneLineId: resolvedPhoneLineId,
      normalizedAdmin,
    });
    const existing = await prisma.message.findFirst({
      where: {
        conversationId: conversation.id,
        text: { contains: `[REF:${eventKey}]` }
      }
    });
    if (existing) continue;

    let sendStatus: 'WA_SENT' | 'WA_FAILED' = 'WA_SENT';
    let sendError: string | null = null;
    try {
      const resp = await sendWhatsAppText(adminWa, textWithRef, { phoneNumberId });
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
      contactId: contact?.id || null,
      adminWaId: adminWa
    });
  }
}
