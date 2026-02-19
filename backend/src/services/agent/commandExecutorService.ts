import { FastifyInstance } from 'fastify';
import { prisma } from '../../db/client';
import { serializeJson } from '../../utils/json';
import { AgentCommand, AgentResponse } from './commandSchema';
import { computeOutboundBlockReason } from './guardrails';
import { stableHash, stripAccents } from './tools';
import { sendWhatsAppTemplate, sendWhatsAppText, SendResult } from '../whatsappMessageService';
import { attemptScheduleInterview, formatInterviewExactAddress } from '../interviewSchedulerService';
import { getEffectiveOutboundAllowlist, getOutboundPolicy, getSystemConfig } from '../configService';
import { sendAdminNotification } from '../adminNotificationService';
import { getContactDisplayName } from '../../utils/contactDisplay';
import { normalizeWhatsAppId } from '../../utils/whatsapp';
import { coerceStageSlug, isKnownActiveStage, normalizeStageSlug } from '../workspaceStageService';
import { runAutomations } from '../automationRunnerService';
import { loadTemplateConfig, resolveTemplateVariables, selectTemplateForMode } from '../templateService';

export type ExecutorTransportMode = 'REAL' | 'NULL';

export type ExecuteResult = {
  ok: boolean;
  blocked?: boolean;
  blockedReason?: string;
  details?: any;
};

type WhatsAppWindowStatus = 'IN_24H' | 'OUTSIDE_24H';

function safeJsonParse(value: string | null | undefined): any {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

type StaffActor = {
  membershipId: string;
  userId: string;
  email: string;
  role: string;
  staffWhatsAppE164: string | null;
};

function roleRank(roleRaw: string): number {
  const role = String(roleRaw || '').toUpperCase().trim();
  if (role === 'OWNER') return 4;
  if (role === 'ADMIN') return 3;
  if (role === 'MEMBER') return 2;
  if (role === 'VIEWER') return 1;
  return 0;
}

function normalizeForNameChecks(value: string): string {
  return stripAccents(String(value || '')).toLowerCase().replace(/\s+/g, ' ').trim();
}

function isSuspiciousCandidateName(value?: string | null): boolean {
  if (!value) return true;
  const lower = normalizeForNameChecks(value);
  if (!lower) return true;
  const patterns = [
    'hola',
    'buenas',
    'postular',
    'mas informacion',
    'más informacion',
    'mas info',
    'más info',
    'informacion',
    'info',
    'confirmo',
    'gracias',
    'tengo disponibilidad',
    'disponibilidad inmediata',
    'cancelar la hora',
    'cancelar',
    'reagendar',
    'cambiar hora',
    'tengo cv',
    'adjunto cv',
    'curriculum',
    'cv',
    'pdf',
    'word',
    'docx',
  ];
  if (patterns.some((p) => lower.includes(normalizeForNameChecks(p)))) return true;
  if (/\b\d{1,2}:\d{2}\b/.test(lower)) return true;
  return false;
}

function safeOutboundBlockedReason(params: {
  toWaId: string;
  config: Awaited<ReturnType<typeof getSystemConfig>>;
}): string | null {
  const toWaId = String(params.toWaId || '').trim();
  if (!toWaId) return 'SAFE_OUTBOUND_BLOCKED:UNKNOWN:INVALID_TO';
  if (toWaId === 'sandbox') return null;

  const policy = getOutboundPolicy(params.config);
  if (policy === 'ALLOW_ALL') return null;
  if (policy === 'BLOCK_ALL') return `SAFE_OUTBOUND_BLOCKED:${policy}:BLOCK_ALL`;

  const normalized = normalizeWhatsAppId(toWaId);
  if (!normalized) return `SAFE_OUTBOUND_BLOCKED:${policy}:INVALID_TO`;
  const allowlist = getEffectiveOutboundAllowlist(params.config);
  if (allowlist.includes(normalized)) return null;
  return `SAFE_OUTBOUND_BLOCKED:${policy}:NOT_IN_ALLOWLIST`;
}

async function computeWhatsAppWindowStatus(conversationId: string): Promise<WhatsAppWindowStatus> {
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const lastInbound = await prisma.message.findFirst({
    where: { conversationId, direction: 'INBOUND' },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true },
  });
  if (!lastInbound?.timestamp) return 'IN_24H';
  const delta = Date.now() - new Date(lastInbound.timestamp).getTime();
  return delta <= WINDOW_MS ? 'IN_24H' : 'OUTSIDE_24H';
}

async function computeWhatsAppWindowStatusStrict(conversationId: string): Promise<WhatsAppWindowStatus> {
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const lastInbound = await prisma.message.findFirst({
    where: { conversationId, direction: 'INBOUND' },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true },
  });
  if (!lastInbound?.timestamp) return 'OUTSIDE_24H';
  const delta = Date.now() - new Date(lastInbound.timestamp).getTime();
  return delta <= WINDOW_MS ? 'IN_24H' : 'OUTSIDE_24H';
}

function toTemplateVarsRecord(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  values.forEach((value, idx) => {
    out[`var${idx + 1}`] = String(value || '');
  });
  return out;
}

async function buildOutside24hTemplateFallback(params: {
  conversation: any;
  preferredText?: string | null;
}): Promise<{ templateName: string; templateVars: Record<string, string>; mode: 'RECRUIT' | 'INTERVIEW' }> {
  const templates = await loadTemplateConfig();
  const preferred = String(params.preferredText || '').toLowerCase();
  const stage = String((params.conversation as any)?.conversationStage || '').toUpperCase();
  const shouldUseInterview =
    /\b(entrevista|agendar|agenda|reagendar|confirmar entrevista|interview)\b/.test(preferred) ||
    stage.includes('INTERVIEW');
  const mode: 'RECRUIT' | 'INTERVIEW' = shouldUseInterview ? 'INTERVIEW' : 'RECRUIT';
  const templateName = selectTemplateForMode(mode, templates);
  const values = resolveTemplateVariables(templateName, undefined, templates, {
    interviewDay: String((params.conversation as any)?.interviewDay || '').trim() || null,
    interviewTime: String((params.conversation as any)?.interviewTime || '').trim() || null,
    interviewLocation:
      String((params.conversation as any)?.interviewLocation || '').trim() ||
      String((params.conversation as any)?.defaultInterviewLocation || '').trim() ||
      null,
    jobTitle: String((params.conversation as any)?.program?.name || '').trim() || null,
  });
  return { templateName, templateVars: toTemplateVarsRecord(values), mode };
}

async function resolveCaseConversationId(params: {
  workspaceId: string;
  ref: string | null | undefined;
  relatedConversationId?: string | null;
}): Promise<string | null> {
  const direct = String(params.ref || '').trim();
  if (!direct) return params.relatedConversationId ? String(params.relatedConversationId) : null;

  const exact = await prisma.conversation
    .findFirst({
      where: {
        id: direct,
        workspaceId: params.workspaceId,
        archivedAt: null,
        isAdmin: false,
      } as any,
      select: { id: true },
    })
    .catch(() => null);
  if (exact?.id) return exact.id;

  const byPrefix = await prisma.conversation
    .findMany({
      where: {
        id: { startsWith: direct },
        workspaceId: params.workspaceId,
        archivedAt: null,
        isAdmin: false,
      } as any,
      select: { id: true },
      orderBy: { updatedAt: 'desc' },
      take: 2,
    })
    .catch(() => []);
  if (byPrefix.length === 1 && byPrefix[0]?.id) return byPrefix[0].id;

  return params.relatedConversationId ? String(params.relatedConversationId) : null;
}

async function resolveStaffActorForConversation(params: {
  workspaceId: string;
  staffConversation: any;
}): Promise<StaffActor | null> {
  const convo = params.staffConversation;
  const contact = convo?.contact;
  const waIdRaw = String(contact?.waId || contact?.phone || '').trim();
  const waId = normalizeWhatsAppId(waIdRaw) || null;
  if (!waId) return null;

  const memberships = await prisma.membership
    .findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        OR: [{ staffWhatsAppE164: { not: null } }, { staffWhatsAppExtraE164sJson: { not: null } as any }],
      } as any,
      include: { user: { select: { id: true, email: true, name: true } } },
      take: 50,
    })
    .catch(() => []);
  const matches = memberships.filter((m) => {
    const primary = normalizeWhatsAppId(String((m as any).staffWhatsAppE164 || '')) === waId;
    if (primary) return true;
    const extraRaw = String((m as any).staffWhatsAppExtraE164sJson || '').trim();
    if (!extraRaw) return false;
    try {
      const parsed = JSON.parse(extraRaw);
      if (Array.isArray(parsed)) {
        return parsed.some((v) => normalizeWhatsAppId(String(v || '')) === waId);
      }
    } catch {
      // ignore
    }
    return extraRaw
      .split(/[,\n]/g)
      .map((v) => normalizeWhatsAppId(String(v || '')) || '')
      .filter(Boolean)
      .includes(waId);
  });
  if (matches.length === 0) return null;
  const match = [...matches].sort((a: any, b: any) => {
    const roleDiff = roleRank(String((b as any).role || '')) - roleRank(String((a as any).role || ''));
    if (roleDiff !== 0) return roleDiff;
    const bUpdated = (b as any).updatedAt ? new Date((b as any).updatedAt).getTime() : 0;
    const aUpdated = (a as any).updatedAt ? new Date((a as any).updatedAt).getTime() : 0;
    return bUpdated - aUpdated;
  })[0];
  if (!match?.id || !match.user?.id) return null;
  return {
    membershipId: match.id,
    userId: match.user.id,
    email: match.user.email,
    role: String((match as any).role || ''),
    staffWhatsAppE164: String((match as any).staffWhatsAppE164 || '').trim() || null,
  };
}

function detectAskedFields(text: string): string[] {
  const lower = normalizeForNameChecks(text);
  const fields: string[] = [];
  const add = (f: string) => {
    if (!fields.includes(f)) fields.push(f);
  };
  if (/\bnombre\b/.test(lower)) add('candidateName');
  if (/\b(apellido|nombre y apellido)\b/.test(lower)) add('candidateName');
  if (/\bcomuna\b/.test(lower) || /\bciudad\b/.test(lower)) add('location');
  if (/\brut\b/.test(lower)) add('rut');
  if (/\bemail\b/.test(lower) || /\bcorreo\b/.test(lower)) add('email');
  if (/\bexperienc\b/.test(lower)) add('experience');
  if (/\bdisponibil\b/.test(lower)) add('availability');
  return fields;
}

function buildLoopBreakerQuestion(params: { field: string; contact: any }): string {
  const contact = params.contact || {};
  const candidateName = String(contact.candidateName || '').trim();
  const comuna = String((contact as any).comuna || '').trim();
  const ciudad = String((contact as any).ciudad || '').trim();
  const rut = String((contact as any).rut || '').trim();
  const email = String((contact as any).email || '').trim();
  const experienceYearsRaw = (contact as any).experienceYears;
  const experienceYears =
    typeof experienceYearsRaw === 'number' && Number.isFinite(experienceYearsRaw)
      ? experienceYearsRaw
      : null;
  const availabilityText = String((contact as any).availabilityText || '').trim();

  if (params.field === 'candidateName') {
    if (candidateName) {
      return `Confirmación rápida: ¿Tu nombre es ${candidateName}?\n1) Sí\n2) No (escríbelo completo)`;
    }
    return 'Para avanzar necesito tu nombre y apellido (escríbelo en una sola línea).';
  }
  if (params.field === 'location') {
    if (comuna) {
      return `Confirmación rápida: ¿Tu comuna es ${comuna}?\n1) Sí\n2) No (escríbela)`;
    }
    if (ciudad) {
      return `Confirmación rápida: ¿Tu ciudad es ${ciudad}?\n1) Sí\n2) No (escríbela)`;
    }
    return 'Para avanzar necesito tu comuna y ciudad (Chile). Responde así: Comuna: ___, Ciudad: ___.';
  }
  if (params.field === 'rut') {
    if (rut) {
      return `Confirmación rápida: ¿Tu RUT es ${rut}?\n1) Sí\n2) No (escríbelo)`;
    }
    return 'Para avanzar necesito tu RUT (ej: 12.345.678-9).';
  }
  if (params.field === 'email') {
    if (email) {
      return `Confirmación rápida: ¿Tu email es ${email}?\n1) Sí\n2) No (escríbelo)`;
    }
    return '¿Me indicas tu email? (opcional; si no tienes, escribe “no tengo”).';
  }
  if (params.field === 'experience') {
    if (experienceYears !== null) {
      return `Confirmación rápida: ¿Tienes ${experienceYears} años de experiencia?\n1) Sí\n2) No (cuéntame años y rubros)`;
    }
    return '¿Cuánta experiencia tienes en ventas? (años y rubros; si hiciste terreno, indícalo).';
  }
  if (params.field === 'availability') {
    if (availabilityText) {
      return `Confirmación rápida: ¿Tu disponibilidad es “${availabilityText}”?\n1) Sí\n2) No (indícala)`;
    }
    return '¿Cuál es tu disponibilidad para empezar?';
  }
  return '¿Me confirmas ese dato, por favor?';
}

async function bumpAskedField(conversationId: string, field: string, askedHash: string) {
  const now = new Date();
  await prisma.conversationAskedField.upsert({
    where: { conversationId_field: { conversationId, field } },
    create: {
      conversationId,
      field,
      askCount: 1,
      lastAskedAt: now,
      lastAskedHash: askedHash,
      updatedAt: now,
    },
    update: {
      askCount: { increment: 1 },
      lastAskedAt: now,
      lastAskedHash: askedHash,
      updatedAt: now,
    },
  });
}

async function logOutbound(params: {
  workspaceId: string;
  conversationId: string;
  agentRunId?: string | null;
  type: string;
  templateName?: string | null;
  dedupeKey: string;
  textHash: string;
  blockedReason?: string | null;
  waMessageId?: string | null;
  relatedConversationId?: string | null;
}) {
  await prisma.outboundMessageLog.create({
    data: {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      relatedConversationId: params.relatedConversationId || null,
      agentRunId: params.agentRunId || null,
      channel: 'WHATSAPP',
      type: params.type,
      templateName: params.templateName || null,
      dedupeKey: params.dedupeKey,
      textHash: params.textHash,
      blockedReason: params.blockedReason || null,
      waMessageId: params.waMessageId || null,
    },
  });
}

async function shouldBlockOutbound(params: {
  conversationId: string;
  dedupeKey: string;
  textHash: string;
  currentStageChangedAt?: Date | null;
}): Promise<string | null> {
  const since = new Date(Date.now() - 120_000);
  const recentLogs = await prisma.outboundMessageLog.findMany({
    where: {
      conversationId: params.conversationId,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { dedupeKey: true, textHash: true, blockedReason: true, createdAt: true },
  });
  let lastInboundAt: Date | null = null;
  const hasSameTextCandidate = recentLogs.some((l) => !l.blockedReason && l.textHash === params.textHash);
  if (hasSameTextCandidate) {
    const lastInbound = await prisma.message.findFirst({
      where: { conversationId: params.conversationId, direction: 'INBOUND' },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    });
    if (lastInbound?.timestamp) lastInboundAt = new Date(lastInbound.timestamp);
  }
  return computeOutboundBlockReason({
    recentLogs,
    dedupeKey: params.dedupeKey,
    textHash: params.textHash,
    lastInboundAt,
    stageChangedAt: params.currentStageChangedAt || null,
  });
}

function buildAntiLoopTextVariants(text: string): string[] {
  const clean = String(text || '').trim();
  if (!clean) return [];
  const variants = [
    `Recibido ✅ ${clean}`,
    `Perfecto, te leo ✅ ${clean}`,
    `Gracias por el detalle ✅ ${clean}`,
  ];
  const out: string[] = [];
  for (const v of variants) {
    const next = v.trim();
    if (!next || next === clean) continue;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

async function resolveOutboundWithAntiLoopFallback(params: {
  conversationId: string;
  dedupeKey: string;
  text: string;
  currentStageChangedAt?: Date | null;
}): Promise<{
  text: string;
  dedupeKey: string;
  textHash: string;
  blockReason: string | null;
  fallbackApplied: boolean;
}> {
  let text = String(params.text || '').trim();
  let dedupeKey = String(params.dedupeKey || '').trim();
  let textHash = stableHash(`TEXT:${text}`);
  let blockReason = await shouldBlockOutbound({
    conversationId: params.conversationId,
    dedupeKey,
    textHash,
    currentStageChangedAt: params.currentStageChangedAt || null,
  });
  if (blockReason !== 'ANTI_LOOP_SAME_TEXT' || !text) {
    return { text, dedupeKey, textHash, blockReason, fallbackApplied: false };
  }

  const variants = buildAntiLoopTextVariants(text);
  for (let i = 0; i < variants.length; i += 1) {
    const variant = variants[i];
    const variantDedupeKey = `${dedupeKey}:v${i + 1}`;
    const variantHash = stableHash(`TEXT:${variant}`);
    const variantBlock = await shouldBlockOutbound({
      conversationId: params.conversationId,
      dedupeKey: variantDedupeKey,
      textHash: variantHash,
      currentStageChangedAt: params.currentStageChangedAt || null,
    });
    if (!variantBlock) {
      return {
        text: variant,
        dedupeKey: variantDedupeKey,
        textHash: variantHash,
        blockReason: null,
        fallbackApplied: true,
      };
    }
  }

  return { text, dedupeKey, textHash, blockReason, fallbackApplied: false };
}

export async function executeAgentResponse(params: {
  app: FastifyInstance;
  workspaceId: string;
  agentRunId: string;
  response: AgentResponse;
  transportMode: ExecutorTransportMode;
}): Promise<{ results: ExecuteResult[] }> {
  const config = await getSystemConfig();
  const results: ExecuteResult[] = [];

  const agentRun = await prisma.agentRunLog
    .findUnique({
      where: { id: params.agentRunId },
      select: { conversationId: true, inputContextJson: true, eventType: true },
    })
    .catch(() => null);
  const agentRunContext = safeJsonParse(agentRun?.inputContextJson || null);
  const relatedConversationIdFromRun = (() => {
    if (!agentRunContext || typeof agentRunContext !== 'object') return null;
    if (typeof (agentRunContext as any).sourceConversationId === 'string') {
      const value = String((agentRunContext as any).sourceConversationId || '').trim();
      return value || null;
    }
    if (typeof (agentRunContext as any).relatedConversationId === 'string') {
      const value = String((agentRunContext as any).relatedConversationId || '').trim();
      return value || null;
    }
    const ev = (agentRunContext as any).event;
    if (ev && typeof ev === 'object' && typeof (ev as any).relatedConversationId === 'string') {
      const value = String((ev as any).relatedConversationId || '').trim();
      return value || null;
    }
    return null;
  })();

  const conversationIds = new Set(
    params.response.commands
      .filter((cmd) => (cmd as any).conversationId)
      .map((cmd) => String((cmd as any).conversationId)),
  );
  if (conversationIds.size > 1) {
    await prisma.agentRunLog.update({
      where: { id: params.agentRunId },
      data: { status: 'ERROR', error: 'Multi-conversation commands no soportado en v1' },
    });
    throw new Error('Multi-conversation commands no soportado en v1');
  }

  const conversationId =
    conversationIds.size === 1
      ? Array.from(conversationIds)[0]
      : agentRun?.conversationId
        ? String(agentRun.conversationId)
        : (null as any);

  const baseConversation = conversationId
    ? await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { contact: true, phoneLine: true },
      })
    : null;
  let currentStage = baseConversation ? String((baseConversation as any).conversationStage || '') : '';

  const askedFieldCounts = conversationId
    ? await prisma.conversationAskedField.findMany({
        where: { conversationId },
        select: { field: true, askCount: true },
      })
    : [];
  const askCountByField = new Map<string, number>();
  for (const row of askedFieldCounts) {
    askCountByField.set(row.field, row.askCount);
  }

  const windowStatus = conversationId
    ? await computeWhatsAppWindowStatus(conversationId)
    : ('IN_24H' as WhatsAppWindowStatus);

  for (const cmd of params.response.commands) {
    if (cmd.command === 'UPSERT_PROFILE_FIELDS') {
      const contact = await prisma.contact.findUnique({ where: { id: cmd.contactId } });
      if (!contact) {
        results.push({ ok: false, details: { error: 'contact_not_found', contactId: cmd.contactId } });
        continue;
      }

      const patch: Record<string, any> = { ...cmd.patch };
      if (patch.candidateName) {
        const manual = String((contact as any).candidateNameManual || '').trim();
        if (manual) {
          delete patch.candidateName;
        } else if (isSuspiciousCandidateName(patch.candidateName)) {
          delete patch.candidateName;
        }
      }

      await prisma.contact.update({
        where: { id: cmd.contactId },
        data: patch,
      });
      results.push({ ok: true });
      continue;
    }

    if (cmd.command === 'SET_CONVERSATION_STATUS') {
      await prisma.conversation.update({
        where: { id: cmd.conversationId },
        data: { status: cmd.status, updatedAt: new Date() },
      });
      results.push({ ok: true });
      continue;
    }

    if (cmd.command === 'SET_CONVERSATION_STAGE') {
      const nextStage = await coerceStageSlug({
        workspaceId: baseConversation?.workspaceId || params.workspaceId,
        stageSlug: cmd.stage,
      }).catch(() => String(cmd.stage));
      const stageChanged = String(nextStage || '') !== String(currentStage || '');
      const now = new Date();
      await prisma.conversation.update({
        where: { id: cmd.conversationId },
        data: {
          conversationStage: nextStage,
          stageReason: cmd.reason || null,
          stageChangedAt: stageChanged ? now : undefined,
          updatedAt: now,
        },
      });
      currentStage = String(nextStage || '');
      if (stageChanged) {
        // Trigger stage automations (e.g., SSClinical INTERESADO -> assign + notify).
        await runAutomations({
          app: params.app,
          workspaceId: baseConversation?.workspaceId || params.workspaceId,
          eventType: 'STAGE_CHANGED',
          conversationId: cmd.conversationId,
          transportMode: params.transportMode,
        }).catch((err) => {
          params.app.log.warn({ err, conversationId: cmd.conversationId }, 'STAGE_CHANGED automations failed (agent executor)');
        });
      }
      results.push({ ok: true });
      continue;
    }

    if (cmd.command === 'SET_CONVERSATION_PROGRAM') {
      await prisma.conversation.update({
        where: { id: cmd.conversationId },
        data: { programId: cmd.programId, updatedAt: new Date() },
      });
      results.push({ ok: true });
      continue;
    }

    if (cmd.command === 'ADD_CONVERSATION_NOTE') {
      await prisma.message.create({
        data: {
          conversationId: cmd.conversationId,
          direction: 'OUTBOUND',
          text: cmd.note,
          rawPayload: serializeJson({ system: true, visibility: cmd.visibility }),
          timestamp: new Date(),
          read: true,
        },
      });
      await prisma.conversation.update({
        where: { id: cmd.conversationId },
        data: { updatedAt: new Date() },
      });
      results.push({ ok: true });
      continue;
    }

    if (cmd.command === 'SET_NO_CONTACTAR') {
      await prisma.contact.update({
        where: { id: cmd.contactId },
        data: {
          noContact: cmd.value,
          noContactAt: cmd.value ? new Date() : null,
          noContactReason: cmd.value ? cmd.reason : null,
        },
      });
      results.push({ ok: true });
      continue;
    }

    if (cmd.command === 'SCHEDULE_INTERVIEW') {
      const convo = await prisma.conversation.findUnique({
        where: { id: cmd.conversationId },
        include: { contact: true },
      });
      if (!convo) {
        results.push({ ok: false, details: { error: 'conversation_not_found', conversationId: cmd.conversationId } });
        continue;
      }

      const fromIso = cmd.datetimeISO ? new Date(cmd.datetimeISO) : null;
      const day = cmd.day || (fromIso ? fromIso.toLocaleDateString('es-CL', { weekday: 'long' }) : null);
      const time = cmd.time || (fromIso ? fromIso.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false }) : null);
      const location = cmd.locationText || null;

      const attempt = await attemptScheduleInterview({
        conversationId: convo.id,
        contactId: convo.contactId,
        day: day ? String(day) : null,
        time: time ? String(time) : null,
        location,
        config,
      });
      results.push({ ok: attempt.ok, details: attempt });
      continue;
    }

    if (cmd.command === 'SEND_MESSAGE') {
      if (!baseConversation) {
        results.push({ ok: false, details: { error: 'missing_conversation_context' } });
        continue;
      }

      const contact = baseConversation.contact;
      const baseKind = String((baseConversation as any).conversationKind || 'CLIENT').toUpperCase();
      if (contact.noContact) {
        const textHash = stableHash(`NO_CONTACT:${cmd.type}:${cmd.text || ''}:${cmd.templateName || ''}`);
        await logOutbound({
          workspaceId: params.workspaceId,
          conversationId: baseConversation.id,
          agentRunId: params.agentRunId,
          type: cmd.type,
          templateName: cmd.type === 'TEMPLATE' ? cmd.templateName || null : null,
          dedupeKey: cmd.dedupeKey,
          textHash,
          blockedReason: 'NO_CONTACTAR',
          relatedConversationId: ['STAFF', 'PARTNER'].includes(baseKind) ? relatedConversationIdFromRun : null,
        });
        results.push({ ok: true, blocked: true, blockedReason: 'NO_CONTACTAR' });
        continue;
      }

      if (windowStatus === 'OUTSIDE_24H' && cmd.type === 'SESSION_TEXT') {
        const fallback = await buildOutside24hTemplateFallback({
          conversation: baseConversation,
          preferredText: cmd.text || '',
        }).catch(() => null);
        if (!fallback?.templateName) {
          const textHash = stableHash(`WINDOW:${cmd.type}:${cmd.text || ''}`);
          await logOutbound({
            workspaceId: params.workspaceId,
            conversationId: baseConversation.id,
            agentRunId: params.agentRunId,
            type: cmd.type,
            templateName: null,
            dedupeKey: cmd.dedupeKey,
            textHash,
            blockedReason: 'OUTSIDE_24H_REQUIRES_TEMPLATE',
            relatedConversationId: ['STAFF', 'PARTNER'].includes(baseKind) ? relatedConversationIdFromRun : null,
          });
          results.push({ ok: true, blocked: true, blockedReason: 'OUTSIDE_24H_REQUIRES_TEMPLATE' });
          continue;
        }

        const templateDedupeKey = `${cmd.dedupeKey}:outside24h_template`;
        const textHash = stableHash(`TEMPLATE:${fallback.templateName}:${serializeJson(fallback.templateVars)}`);
        const blockReason = await shouldBlockOutbound({
          conversationId: baseConversation.id,
          dedupeKey: templateDedupeKey,
          textHash,
          currentStageChangedAt: (baseConversation as any)?.stageChangedAt
            ? new Date((baseConversation as any).stageChangedAt)
            : null,
        });
        if (blockReason) {
          await logOutbound({
            workspaceId: params.workspaceId,
            conversationId: baseConversation.id,
            agentRunId: params.agentRunId,
            type: 'TEMPLATE',
            templateName: fallback.templateName,
            dedupeKey: templateDedupeKey,
            textHash,
            blockedReason: blockReason,
            relatedConversationId: ['STAFF', 'PARTNER'].includes(baseKind) ? relatedConversationIdFromRun : null,
          });
          results.push({ ok: true, blocked: true, blockedReason: blockReason });
          continue;
        }

        const toWaId = contact.waId || contact.phone || (params.transportMode === 'NULL' ? 'sandbox' : null);
        if (!toWaId) {
          results.push({ ok: false, details: { error: 'missing_contact_waid' } });
          continue;
        }
        const safetyBlock = safeOutboundBlockedReason({ toWaId, config });
        if (safetyBlock) {
          await logOutbound({
            workspaceId: params.workspaceId,
            conversationId: baseConversation.id,
            agentRunId: params.agentRunId,
            type: 'TEMPLATE',
            templateName: fallback.templateName,
            dedupeKey: templateDedupeKey,
            textHash,
            blockedReason: safetyBlock,
            relatedConversationId: ['STAFF', 'PARTNER'].includes(baseKind) ? relatedConversationIdFromRun : null,
          });
          results.push({ ok: true, blocked: true, blockedReason: safetyBlock });
          continue;
        }

        const phoneNumberId = baseConversation.phoneLine?.waPhoneNumberId || null;
        let sendResult: SendResult = { success: true, messageId: `null-${Date.now()}` };
        if (params.transportMode === 'REAL') {
          sendResult = await sendWhatsAppTemplate(
            toWaId,
            fallback.templateName,
            Object.values(fallback.templateVars),
            { phoneNumberId },
          );
        }
        await prisma.message.create({
          data: {
            conversationId: baseConversation.id,
            direction: 'OUTBOUND',
            text: `[TEMPLATE] ${fallback.templateName}`,
            rawPayload: serializeJson({
              system: true,
              agentRunId: params.agentRunId,
              dedupeKey: templateDedupeKey,
              sendResult,
              templateVars: fallback.templateVars,
              fallbackFromOutside24h: true,
            }),
            timestamp: new Date(),
            read: true,
          },
        });
        await prisma.conversation.update({
          where: { id: baseConversation.id },
          data: { updatedAt: new Date() },
        });
        await logOutbound({
          workspaceId: params.workspaceId,
          conversationId: baseConversation.id,
          agentRunId: params.agentRunId,
          type: 'TEMPLATE',
          templateName: fallback.templateName,
          dedupeKey: templateDedupeKey,
          textHash,
          blockedReason: sendResult.success ? null : `SEND_FAILED:${sendResult.error || 'unknown'}`,
          waMessageId: sendResult.messageId || null,
          relatedConversationId: ['STAFF', 'PARTNER'].includes(baseKind) ? relatedConversationIdFromRun : null,
        });
        results.push({
          ok: true,
          details: {
            sendResult,
            fallbackFromOutside24h: true,
            templateName: fallback.templateName,
            mode: fallback.mode,
          },
        });
        continue;
      }

      let effectiveText = cmd.text || '';
      let guardrailOverride: any = null;
      if (cmd.type === 'SESSION_TEXT' && effectiveText) {
        const askedFields = detectAskedFields(effectiveText);
        const loopField = askedFields.find((f) => (askCountByField.get(f) || 0) >= 2) || null;
        if (loopField) {
          effectiveText = buildLoopBreakerQuestion({ field: loopField, contact });
          guardrailOverride = { type: 'ASKED_FIELD_LOOP_BREAKER', field: loopField };
        }
      }

      let effectiveDedupeKey = cmd.dedupeKey;
      let payloadHash = stableHash(
        cmd.type === 'TEMPLATE'
          ? `TEMPLATE:${cmd.templateName || ''}:${serializeJson(cmd.templateVars || {})}`
          : `TEXT:${effectiveText}`,
      );
      let blockReason = await shouldBlockOutbound({
        conversationId: baseConversation.id,
        dedupeKey: effectiveDedupeKey,
        textHash: payloadHash,
        currentStageChangedAt: (baseConversation as any)?.stageChangedAt
          ? new Date((baseConversation as any).stageChangedAt)
          : null,
      });
      if (cmd.type === 'SESSION_TEXT' && blockReason === 'ANTI_LOOP_SAME_TEXT' && String(effectiveText || '').trim()) {
        const fallback = await resolveOutboundWithAntiLoopFallback({
          conversationId: baseConversation.id,
          dedupeKey: effectiveDedupeKey,
          text: effectiveText,
          currentStageChangedAt: (baseConversation as any)?.stageChangedAt
            ? new Date((baseConversation as any).stageChangedAt)
            : null,
        });
        if (!fallback.blockReason && fallback.fallbackApplied) {
          effectiveText = fallback.text;
          effectiveDedupeKey = fallback.dedupeKey;
          payloadHash = fallback.textHash;
          blockReason = null;
          guardrailOverride = {
            ...(guardrailOverride || {}),
            type: 'ANTI_LOOP_TEXT_VARIANT',
            sourceReason: 'ANTI_LOOP_SAME_TEXT',
          };
        } else {
          blockReason = fallback.blockReason;
        }
      }
      if (blockReason) {
        await logOutbound({
          workspaceId: params.workspaceId,
          conversationId: baseConversation.id,
          agentRunId: params.agentRunId,
          type: cmd.type,
          templateName: cmd.type === 'TEMPLATE' ? cmd.templateName || null : null,
          dedupeKey: effectiveDedupeKey,
          textHash: payloadHash,
          blockedReason: blockReason,
          relatedConversationId: ['STAFF', 'PARTNER'].includes(baseKind) ? relatedConversationIdFromRun : null,
        });
        results.push({ ok: true, blocked: true, blockedReason: blockReason });
        continue;
      }

      const toWaId =
        contact.waId || contact.phone || (params.transportMode === 'NULL' ? 'sandbox' : null);
      if (!toWaId) {
        results.push({ ok: false, details: { error: 'missing_contact_waid' } });
        continue;
      }

      const safetyBlock = safeOutboundBlockedReason({ toWaId, config });
      if (safetyBlock) {
        await logOutbound({
          workspaceId: params.workspaceId,
          conversationId: baseConversation.id,
          agentRunId: params.agentRunId,
          type: cmd.type,
          templateName: cmd.type === 'TEMPLATE' ? cmd.templateName || null : null,
          dedupeKey: effectiveDedupeKey,
          textHash: payloadHash,
          blockedReason: safetyBlock,
          relatedConversationId: ['STAFF', 'PARTNER'].includes(baseKind) ? relatedConversationIdFromRun : null,
        });
        results.push({ ok: true, blocked: true, blockedReason: safetyBlock });
        continue;
      }

      const phoneNumberId = baseConversation.phoneLine?.waPhoneNumberId || null;

      let sendResult: SendResult = { success: true, messageId: `null-${Date.now()}` };
      if (params.transportMode === 'REAL') {
        sendResult =
          cmd.type === 'TEMPLATE'
            ? await sendWhatsAppTemplate(
                toWaId,
                cmd.templateName || '',
                cmd.templateVars ? Object.values(cmd.templateVars) : undefined,
                { phoneNumberId },
              )
            : await sendWhatsAppText(toWaId, effectiveText, { phoneNumberId });
      }

      await prisma.message.create({
        data: {
          conversationId: baseConversation.id,
          direction: 'OUTBOUND',
          text:
            cmd.type === 'TEMPLATE'
              ? `[TEMPLATE] ${cmd.templateName || ''}`
              : effectiveText,
          rawPayload: serializeJson({
            system: true,
            agentRunId: params.agentRunId,
            dedupeKey: effectiveDedupeKey,
            sendResult,
            templateVars: cmd.templateVars || null,
            guardrailOverride,
          }),
          timestamp: new Date(),
          read: true,
        },
      });
      await prisma.conversation.update({
        where: { id: baseConversation.id },
        data: { updatedAt: new Date() },
      });

      await logOutbound({
        workspaceId: params.workspaceId,
        conversationId: baseConversation.id,
        agentRunId: params.agentRunId,
        type: cmd.type,
        templateName: cmd.type === 'TEMPLATE' ? cmd.templateName || null : null,
        dedupeKey: effectiveDedupeKey,
        textHash: payloadHash,
        blockedReason: sendResult.success ? null : `SEND_FAILED:${sendResult.error || 'unknown'}`,
        waMessageId: sendResult.messageId || null,
        relatedConversationId: ['STAFF', 'PARTNER'].includes(baseKind) ? relatedConversationIdFromRun : null,
      });

      if (params.transportMode === 'REAL' && baseConversation.phoneLineId) {
        await prisma.phoneLine
          .update({
            where: { id: baseConversation.phoneLineId },
            data: { lastOutboundAt: new Date() },
          })
          .catch(() => {});
      }

      const askedFields = cmd.type === 'SESSION_TEXT' ? detectAskedFields(effectiveText) : [];
      const askedHash = payloadHash;
      for (const field of askedFields) {
        await bumpAskedField(baseConversation.id, field, askedHash).catch(() => {});
        askCountByField.set(field, (askCountByField.get(field) || 0) + 1);
      }

      results.push({ ok: true, details: { sendResult } });
      continue;
    }

    if (cmd.command === 'NOTIFY_ADMIN') {
      if (!baseConversation) {
        results.push({ ok: false, details: { error: 'missing_conversation_context' } });
        continue;
      }

      // v1: reuse existing AdminNotificationService for WA + CRM logging.
      const contact = baseConversation.contact;
      const displayName = getContactDisplayName(contact);
      await sendAdminNotification({
        app: params.app,
        eventType: cmd.eventType as any,
        contact,
        workspaceId: baseConversation.workspaceId,
        phoneLineId: baseConversation.phoneLineId,
        summary: cmd.text || `Evento: ${cmd.eventType} para ${displayName}`,
      });
      results.push({ ok: true });
      continue;
    }

    if (cmd.command === 'RUN_TOOL') {
      const toolName = String((cmd as any).toolName || '').trim().toUpperCase();
      const args = (cmd as any).args || {};

      if (!baseConversation) {
        results.push({ ok: false, details: { error: 'missing_conversation_context', toolName } });
        continue;
      }

      const kind = String((baseConversation as any).conversationKind || 'CLIENT').toUpperCase();
      if (kind !== 'STAFF') {
        results.push({ ok: false, details: { error: 'tool_not_allowed:conversation_not_staff', toolName } });
        continue;
      }

      const staffActor = await resolveStaffActorForConversation({
        workspaceId: baseConversation.workspaceId,
        staffConversation: baseConversation,
      }).catch(() => null);

      if (!staffActor || roleRank(staffActor.role) < roleRank('MEMBER')) {
        results.push({ ok: false, details: { error: 'tool_not_allowed:staff_actor_missing_or_forbidden', toolName } });
        continue;
      }

      if (toolName === 'LIST_CASES') {
        const stageSlugRaw = typeof (args as any).stageSlug === 'string' ? (args as any).stageSlug : '';
        const stageSlug = stageSlugRaw ? normalizeStageSlug(stageSlugRaw) : '';
        const queryRaw = typeof (args as any).query === 'string' ? (args as any).query.trim() : '';
        const assignedToMe = Boolean((args as any).assignedToMe);
        const statusRaw = typeof (args as any).status === 'string' ? String((args as any).status).toUpperCase() : '';
        const status = statusRaw && ['NEW', 'OPEN', 'CLOSED'].includes(statusRaw) ? statusRaw : null;
        const limitRaw = Number((args as any).limit || 10);
        const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, Math.floor(limitRaw))) : 10;

        const cases = await prisma.conversation.findMany({
          where: {
            workspaceId: baseConversation.workspaceId,
            archivedAt: null,
            isAdmin: false,
            conversationKind: 'CLIENT',
            ...(status ? { status } : {}),
            ...(stageSlug ? { conversationStage: stageSlug } : {}),
            ...(assignedToMe ? { assignedToId: staffActor.userId } : {}),
          } as any,
          include: {
            contact: true,
            program: { select: { id: true, slug: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: queryRaw ? Math.max(limit * 4, 50) : limit,
        });

        const query = normalizeForNameChecks(queryRaw);
        const filtered = query
          ? cases.filter((c: any) => {
              const hay = normalizeForNameChecks(
                [
                  c.id,
                  c.contact?.displayName,
                  c.contact?.candidateName,
                  c.contact?.candidateNameManual,
                  c.contact?.phone,
                  c.contact?.waId,
                  c.contact?.comuna,
                  c.contact?.ciudad,
                  c.contact?.region,
                  c.conversationStage,
                ]
                  .filter(Boolean)
                  .join(' '),
              );
              return hay.includes(query);
            })
          : cases;

        const finalCases = filtered.slice(0, limit);

        results.push({
          ok: true,
          details: {
            toolName,
            result: {
              cases: finalCases.map((c: any) => ({
                id: c.id,
                stage: c.conversationStage,
                status: c.status,
                assignedToId: c.assignedToId || null,
                program: c.program ? { id: c.program.id, slug: c.program.slug, name: c.program.name } : null,
                contactDisplay: getContactDisplayName(c.contact),
                createdAt: c.createdAt ? new Date(c.createdAt).toISOString() : null,
                updatedAt: c.updatedAt ? new Date(c.updatedAt).toISOString() : null,
              })),
            },
          },
        });
        continue;
      }

      if (toolName === 'GET_CASE_SUMMARY') {
        const conversationIdArgRaw =
          typeof (args as any).conversationId === 'string' ? (args as any).conversationId.trim() : '';
        const conversationIdArg = await resolveCaseConversationId({
          workspaceId: baseConversation.workspaceId,
          ref: conversationIdArgRaw,
          relatedConversationId: relatedConversationIdFromRun || null,
        });
        if (!conversationIdArg) {
          results.push({
            ok: false,
            details: { error: 'conversationId requerido (o responde a una notificación del caso)', toolName },
          });
          continue;
        }

        const convo = await prisma.conversation.findFirst({
          where: { id: conversationIdArg, workspaceId: baseConversation.workspaceId, archivedAt: null, isAdmin: false } as any,
          include: {
            contact: true,
            program: { select: { id: true, slug: true, name: true } },
            messages: {
              orderBy: { timestamp: 'desc' },
              take: 10,
              select: { id: true, direction: true, text: true, transcriptText: true, mediaType: true, timestamp: true },
            },
          },
        });
        if (!convo?.id) {
          results.push({ ok: false, details: { error: 'case_not_found', conversationId: conversationIdArg, toolName } });
          continue;
        }

        const contact = convo.contact;
        const summary = {
          id: convo.id,
          stage: convo.conversationStage,
          status: convo.status,
          assignedToId: convo.assignedToId || null,
          program: convo.program ? { id: convo.program.id, slug: convo.program.slug, name: convo.program.name } : null,
          contact: {
            id: contact.id,
            displayName: getContactDisplayName(contact),
            waId: contact.waId || null,
            phone: contact.phone || null,
            comuna: (contact as any).comuna || null,
            ciudad: (contact as any).ciudad || null,
            region: (contact as any).region || null,
            availabilityText: (contact as any).availabilityText || null,
            noContact: Boolean((contact as any).noContact),
          },
          lastMessages: (convo.messages || [])
            .slice()
            .reverse()
            .map((m: any) => ({
              id: m.id,
              direction: m.direction,
              text: m.transcriptText || m.text,
              mediaType: m.mediaType || null,
              timestamp: m.timestamp.toISOString(),
            })),
        };

        results.push({ ok: true, details: { toolName, result: { case: summary } } });
        continue;
      }

      if (toolName === 'ADD_NOTE') {
        const conversationIdArgRaw =
          typeof (args as any).conversationId === 'string' ? (args as any).conversationId.trim() : '';
        const conversationIdArg = await resolveCaseConversationId({
          workspaceId: baseConversation.workspaceId,
          ref: conversationIdArgRaw,
          relatedConversationId: relatedConversationIdFromRun || null,
        });
        const textArg = typeof (args as any).text === 'string' ? (args as any).text.trim() : '';
        if (!conversationIdArg || !textArg) {
          results.push({ ok: false, details: { error: 'conversationId y text requeridos', toolName } });
          continue;
        }
        const convo = await prisma.conversation.findFirst({
          where: { id: conversationIdArg, workspaceId: baseConversation.workspaceId, archivedAt: null, isAdmin: false } as any,
          select: { id: true },
        });
        if (!convo?.id) {
          results.push({ ok: false, details: { error: 'case_not_found', conversationId: conversationIdArg, toolName } });
          continue;
        }
        await prisma.message.create({
          data: {
            conversationId: conversationIdArg,
            direction: 'OUTBOUND',
            text: textArg,
            rawPayload: serializeJson({
              system: true,
              toolName,
              staffActor: { userId: staffActor.userId, email: staffActor.email, role: staffActor.role },
              agentRunId: params.agentRunId,
            }),
            timestamp: new Date(),
            read: true,
          },
        });
        await prisma.conversation.update({ where: { id: conversationIdArg }, data: { updatedAt: new Date() } }).catch(() => {});
        results.push({ ok: true, details: { toolName, result: { ok: true } } });
        continue;
      }

      if (toolName === 'SET_STAGE') {
        const conversationIdArgRaw =
          typeof (args as any).conversationId === 'string' ? (args as any).conversationId.trim() : '';
        const conversationIdArg = await resolveCaseConversationId({
          workspaceId: baseConversation.workspaceId,
          ref: conversationIdArgRaw,
          relatedConversationId: relatedConversationIdFromRun || null,
        });
        const stageArg = typeof (args as any).stageSlug === 'string' ? (args as any).stageSlug.trim() : '';
        const reasonArg = typeof (args as any).reason === 'string' ? (args as any).reason.trim() : '';
        if (!conversationIdArg || !stageArg) {
          results.push({
            ok: false,
            details: { error: 'conversationId y stageSlug requeridos (o responde a una notificación del caso)', toolName },
          });
          continue;
        }
        const stageSlug = normalizeStageSlug(stageArg);
        if (!stageSlug) {
          results.push({ ok: false, details: { error: 'stageSlug inválido', toolName } });
          continue;
        }
        const stageOk = await isKnownActiveStage(baseConversation.workspaceId, stageSlug).catch(() => false);
        if (!stageOk) {
          results.push({ ok: false, details: { error: `stageSlug desconocido/inactivo: ${stageSlug}`, toolName } });
          continue;
        }
        const convo = await prisma.conversation.findFirst({
          where: { id: conversationIdArg, workspaceId: baseConversation.workspaceId, archivedAt: null, isAdmin: false } as any,
          select: { id: true, conversationStage: true },
        });
        if (!convo?.id) {
          results.push({ ok: false, details: { error: 'case_not_found', conversationId: conversationIdArg, toolName } });
          continue;
        }
        const previousStage = String((convo as any).conversationStage || '');
        const now = new Date();
        await prisma.conversation.update({
          where: { id: conversationIdArg },
          data: {
            conversationStage: stageSlug,
            stageReason: reasonArg ? reasonArg.slice(0, 140) : `staff:${staffActor.email}`,
            stageChangedAt: now,
            updatedAt: now,
          } as any,
        });
        await prisma.message
          .create({
            data: {
              conversationId: conversationIdArg,
              direction: 'OUTBOUND',
              text: `🏷️ Stage actualizado por staff: ${previousStage} → ${stageSlug}`,
              rawPayload: serializeJson({
                system: true,
                toolName,
                staffActor: { userId: staffActor.userId, email: staffActor.email, role: staffActor.role },
                agentRunId: params.agentRunId,
                previousStage,
                nextStage: stageSlug,
              }),
              timestamp: now,
              read: true,
            },
          } as any)
          .catch(() => {});

        await runAutomations({
          app: params.app,
          workspaceId: baseConversation.workspaceId,
          eventType: 'STAGE_CHANGED',
          conversationId: conversationIdArg,
          transportMode: params.transportMode,
        }).catch((err) => {
          params.app.log.warn({ err, conversationId: conversationIdArg }, 'STAGE_CHANGED automations failed (staff tool)');
        });

        results.push({ ok: true, details: { toolName, result: { ok: true, stage: stageSlug } } });
        continue;
      }

      if (toolName === 'SEND_CUSTOMER_MESSAGE') {
        const conversationIdArgRaw =
          typeof (args as any).conversationId === 'string' ? (args as any).conversationId.trim() : '';
        const conversationIdArg = await resolveCaseConversationId({
          workspaceId: baseConversation.workspaceId,
          ref: conversationIdArgRaw,
          relatedConversationId: relatedConversationIdFromRun || null,
        });
        const textArg = typeof (args as any).text === 'string' ? (args as any).text.trim() : '';
        if (!conversationIdArg || !textArg) {
          results.push({
            ok: false,
            details: { error: 'conversationId y text requeridos (o responde a una notificación del caso)', toolName },
          });
          continue;
        }
        if (textArg.length > 2000) {
          results.push({ ok: false, details: { error: 'text demasiado largo (max 2000)', toolName } });
          continue;
        }

        const customerConversation = await prisma.conversation.findFirst({
          where: { id: conversationIdArg, workspaceId: baseConversation.workspaceId, archivedAt: null, isAdmin: false } as any,
          include: { contact: true, phoneLine: true },
        });
        if (!customerConversation?.id) {
          results.push({ ok: false, details: { error: 'case_not_found', conversationId: conversationIdArg, toolName } });
          continue;
        }
        const customerContact = customerConversation.contact;

        let dedupeKey =
          typeof (args as any).dedupeKey === 'string' && String((args as any).dedupeKey).trim()
            ? String((args as any).dedupeKey).trim()
            : `staff_send_customer:${params.agentRunId}:${stableHash(textArg).slice(0, 10)}`;
        let effectiveText = textArg;
        let payloadHash = stableHash(`TEXT:${effectiveText}`);

        const window = await computeWhatsAppWindowStatusStrict(customerConversation.id).catch(() => 'OUTSIDE_24H' as WhatsAppWindowStatus);
        if (window === 'OUTSIDE_24H') {
          const fallback = await buildOutside24hTemplateFallback({
            conversation: customerConversation,
            preferredText: textArg,
          }).catch(() => null);
          if (!fallback?.templateName) {
            await logOutbound({
              workspaceId: baseConversation.workspaceId,
              conversationId: customerConversation.id,
              agentRunId: params.agentRunId,
              type: 'SESSION_TEXT',
              templateName: null,
              dedupeKey,
              textHash: payloadHash,
              blockedReason: 'OUTSIDE_24H_REQUIRES_TEMPLATE',
            });
            results.push({ ok: true, blocked: true, blockedReason: 'OUTSIDE_24H_REQUIRES_TEMPLATE' });
            continue;
          }
          dedupeKey = `${dedupeKey}:outside24h_template`;
          payloadHash = stableHash(`TEMPLATE:${fallback.templateName}:${serializeJson(fallback.templateVars)}`);

          const blockReason = await shouldBlockOutbound({
            conversationId: customerConversation.id,
            dedupeKey,
            textHash: payloadHash,
            currentStageChangedAt: (customerConversation as any)?.stageChangedAt
              ? new Date((customerConversation as any).stageChangedAt)
              : null,
          });
          if (blockReason) {
            await logOutbound({
              workspaceId: baseConversation.workspaceId,
              conversationId: customerConversation.id,
              agentRunId: params.agentRunId,
              type: 'TEMPLATE',
              templateName: fallback.templateName,
              dedupeKey,
              textHash: payloadHash,
              blockedReason: blockReason,
            });
            results.push({ ok: true, blocked: true, blockedReason: blockReason });
            continue;
          }

          const toWaId =
            customerContact.waId || customerContact.phone || (params.transportMode === 'NULL' ? 'sandbox' : null);
          if (!toWaId) {
            results.push({ ok: false, details: { error: 'missing_contact_waid', toolName } });
            continue;
          }

          const safetyBlock = safeOutboundBlockedReason({ toWaId, config });
          if (safetyBlock) {
            await logOutbound({
              workspaceId: baseConversation.workspaceId,
              conversationId: customerConversation.id,
              agentRunId: params.agentRunId,
              type: 'TEMPLATE',
              templateName: fallback.templateName,
              dedupeKey,
              textHash: payloadHash,
              blockedReason: safetyBlock,
            });
            results.push({ ok: true, blocked: true, blockedReason: safetyBlock });
            continue;
          }

          let sendResult: SendResult = { success: true, messageId: `null-${Date.now()}` };
          if (params.transportMode === 'REAL') {
            const phoneNumberId = customerConversation.phoneLine?.waPhoneNumberId || null;
            sendResult = await sendWhatsAppTemplate(
              toWaId,
              fallback.templateName,
              Object.values(fallback.templateVars),
              { phoneNumberId },
            );
          }
          await prisma.message.create({
            data: {
              conversationId: customerConversation.id,
              direction: 'OUTBOUND',
              text: `[TEMPLATE] ${fallback.templateName}`,
              rawPayload: serializeJson({
                system: true,
                toolName,
                staffActor: { userId: staffActor.userId, email: staffActor.email, role: staffActor.role },
                agentRunId: params.agentRunId,
                sendResult,
                templateVars: fallback.templateVars,
                fallbackFromOutside24h: true,
              }),
              timestamp: new Date(),
              read: true,
            },
          });
          await prisma.conversation.update({ where: { id: customerConversation.id }, data: { updatedAt: new Date() } }).catch(() => {});
          await logOutbound({
            workspaceId: baseConversation.workspaceId,
            conversationId: customerConversation.id,
            agentRunId: params.agentRunId,
            type: 'TEMPLATE',
            templateName: fallback.templateName,
            dedupeKey,
            textHash: payloadHash,
            blockedReason: sendResult.success ? null : `SEND_FAILED:${sendResult.error || 'unknown'}`,
            waMessageId: sendResult.messageId || null,
          });
          results.push({
            ok: true,
            details: { toolName, result: { sendResult, fallbackFromOutside24h: true, templateName: fallback.templateName } },
          });
          continue;
        }

        if ((customerContact as any).noContact) {
          await logOutbound({
            workspaceId: baseConversation.workspaceId,
            conversationId: customerConversation.id,
            agentRunId: params.agentRunId,
            type: 'SESSION_TEXT',
            templateName: null,
            dedupeKey,
            textHash: payloadHash,
            blockedReason: 'NO_CONTACTAR',
          });
          results.push({ ok: true, blocked: true, blockedReason: 'NO_CONTACTAR' });
          continue;
        }

        let blockReason = await shouldBlockOutbound({
          conversationId: customerConversation.id,
          dedupeKey,
          textHash: payloadHash,
          currentStageChangedAt: (customerConversation as any)?.stageChangedAt
            ? new Date((customerConversation as any).stageChangedAt)
            : null,
        });
        if (blockReason === 'ANTI_LOOP_SAME_TEXT') {
          const fallback = await resolveOutboundWithAntiLoopFallback({
            conversationId: customerConversation.id,
            dedupeKey,
            text: effectiveText,
            currentStageChangedAt: (customerConversation as any)?.stageChangedAt
              ? new Date((customerConversation as any).stageChangedAt)
              : null,
          });
          if (!fallback.blockReason && fallback.fallbackApplied) {
            dedupeKey = fallback.dedupeKey;
            payloadHash = fallback.textHash;
            effectiveText = fallback.text;
            blockReason = null;
          } else {
            blockReason = fallback.blockReason;
          }
        }
        if (blockReason) {
          await logOutbound({
            workspaceId: baseConversation.workspaceId,
            conversationId: customerConversation.id,
            agentRunId: params.agentRunId,
            type: 'SESSION_TEXT',
            templateName: null,
            dedupeKey,
            textHash: payloadHash,
            blockedReason: blockReason,
          });
          results.push({ ok: true, blocked: true, blockedReason: blockReason });
          continue;
        }

        const toWaId =
          customerContact.waId || customerContact.phone || (params.transportMode === 'NULL' ? 'sandbox' : null);
        if (!toWaId) {
          results.push({ ok: false, details: { error: 'missing_contact_waid', toolName } });
          continue;
        }

        const safetyBlock = safeOutboundBlockedReason({ toWaId, config });
        if (safetyBlock) {
          await logOutbound({
            workspaceId: baseConversation.workspaceId,
            conversationId: customerConversation.id,
            agentRunId: params.agentRunId,
            type: 'SESSION_TEXT',
            templateName: null,
            dedupeKey,
            textHash: payloadHash,
            blockedReason: safetyBlock,
          });
          results.push({ ok: true, blocked: true, blockedReason: safetyBlock });
          continue;
        }

        let sendResult: SendResult = { success: true, messageId: `null-${Date.now()}` };
        if (params.transportMode === 'REAL') {
          const phoneNumberId = customerConversation.phoneLine?.waPhoneNumberId || null;
          sendResult = await sendWhatsAppText(toWaId, effectiveText, { phoneNumberId });
        }

        await prisma.message.create({
          data: {
            conversationId: customerConversation.id,
            direction: 'OUTBOUND',
            text: effectiveText,
            rawPayload: serializeJson({
              system: true,
              toolName,
              staffActor: { userId: staffActor.userId, email: staffActor.email, role: staffActor.role },
              agentRunId: params.agentRunId,
              sendResult,
            }),
            timestamp: new Date(),
            read: true,
          },
        });
        await prisma.conversation.update({ where: { id: customerConversation.id }, data: { updatedAt: new Date() } }).catch(() => {});

        await logOutbound({
          workspaceId: baseConversation.workspaceId,
          conversationId: customerConversation.id,
          agentRunId: params.agentRunId,
          type: 'SESSION_TEXT',
          templateName: null,
          dedupeKey,
          textHash: payloadHash,
          blockedReason: sendResult.success ? null : `SEND_FAILED:${sendResult.error || 'unknown'}`,
          waMessageId: sendResult.messageId || null,
        });

        if (params.transportMode === 'REAL' && customerConversation.phoneLineId) {
          await prisma.phoneLine
            .update({
              where: { id: customerConversation.phoneLineId },
              data: { lastOutboundAt: new Date() },
            })
            .catch(() => {});
        }

        results.push({ ok: true, details: { toolName, result: { sendResult } } });
        continue;
      }

      results.push({ ok: false, details: { error: `toolName desconocido: ${toolName}`, toolName } });
      continue;
    }

    results.push({ ok: false, details: { error: 'unknown_command', command: (cmd as any).command } });
  }

  await prisma.agentRunLog.update({
    where: { id: params.agentRunId },
    data: { status: 'EXECUTED', resultsJson: serializeJson({ results }) },
  });

  return { results };
}
