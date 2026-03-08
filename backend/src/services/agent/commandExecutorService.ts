import { FastifyInstance } from 'fastify';
import { prisma } from '../../db/client';
import { serializeJson } from '../../utils/json';
import { AgentCommand, AgentResponse } from './commandSchema';
import { computeOutboundBlockReason } from './guardrails';
import { resolveLocation, stableHash, stripAccents } from './tools';
import { sendWhatsAppDocumentByLink, sendWhatsAppTemplate, sendWhatsAppText, SendResult } from '../whatsappMessageService';
import { attemptScheduleInterview, formatInterviewExactAddress } from '../interviewSchedulerService';
import { getEffectiveOutboundAllowlist, getOutboundPolicy, getSystemConfig } from '../configService';
import { sendAdminNotification } from '../adminNotificationService';
import { getContactDisplayName } from '../../utils/contactDisplay';
import { normalizeWhatsAppId } from '../../utils/whatsapp';
import { coerceStageSlug, isKnownActiveStage, normalizeStageSlug } from '../workspaceStageService';
import { runAutomations } from '../automationRunnerService';
import { loadTemplateConfig, resolveTemplateVariables, selectTemplateForMode } from '../templateService';
import { buildWorkspaceAssetPublicUrl } from '../workspaceAssetService';
import {
  mapRoleToContactJobRole,
  normalizeApplicationRole,
  normalizeApplicationState,
  resolveStageForApplicationState,
} from '../postulacionFlowService';
import { triggerReadyForOpReview } from '../postulacionReviewService';

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

function extractInboundTextFromRunContext(agentRunContext: any): string {
  if (!agentRunContext || typeof agentRunContext !== 'object') return '';
  const direct = String((agentRunContext as any).inboundText || '').trim();
  if (direct) return direct;
  const ev = (agentRunContext as any).event;
  if (ev && typeof ev === 'object') {
    const fromEvent = String((ev as any).inboundText || '').trim();
    if (fromEvent) return fromEvent;
  }
  return '';
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

function roleToRecruitmentProgramSlug(role: string | null): string | null {
  const normalized = String(role || '').trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === 'PEONETA') return 'reclutamiento-peonetas-envio-rapido';
  if (normalized === 'DRIVER_COMPANY' || normalized === 'CONDUCTOR') return 'reclutamiento-conductores-envio-rapido';
  if (normalized === 'DRIVER_OWN_VAN' || normalized === 'CONDUCTOR_FLOTA') return 'reclutamiento-conductores-flota-envio-rapido';
  return null;
}

async function resolveProgramIdBySlug(workspaceId: string, slug: string): Promise<string | null> {
  const normalizedWorkspace = String(workspaceId || '').trim();
  const normalizedSlug = String(slug || '').trim();
  if (!normalizedWorkspace || !normalizedSlug) return null;
  const row = await prisma.program
    .findFirst({
      where: {
        workspaceId: normalizedWorkspace,
        slug: normalizedSlug,
        archivedAt: null,
        isActive: true,
      },
      select: { id: true },
    })
    .catch(() => null);
  return row?.id || null;
}

function normalizeForNameChecks(value: string): string {
  return stripAccents(String(value || '')).toLowerCase().replace(/\s+/g, ' ').trim();
}

function isSimpleGreeting(value: string): boolean {
  const normalized = normalizeForNameChecks(value);
  if (!normalized) return false;
  return (
    normalized === 'hola' ||
    normalized.startsWith('hola ') ||
    normalized === 'holaa' ||
    normalized === 'holaaa' ||
    normalized === 'buenas' ||
    normalized.startsWith('buenas ') ||
    normalized === 'buenos dias' ||
    normalized === 'buenas tardes' ||
    normalized === 'buenas noches' ||
    normalized === 'hi' ||
    normalized === 'hello' ||
    normalized === 'hey'
  );
}

function isMilestoneNotifyEvent(cmd: { eventType?: unknown; text?: unknown }): boolean {
  const eventType = normalizeForNameChecks(String(cmd.eventType || ''));
  const text = normalizeForNameChecks(String(cmd.text || ''));
  if (eventType.includes('needs_human') || eventType.includes('needshuman')) return true;
  if (eventType.includes('cv') || eventType.includes('curriculum')) return true;
  if (eventType.includes('doc') || eventType.includes('licencia') || eventType.includes('carnet')) return true;
  if (text.includes('cv') || text.includes('curriculum')) return true;
  if (text.includes('licencia') || text.includes('carnet') || text.includes('documento')) return true;
  if (text.includes('needs_human')) return true;
  return false;
}

function isSuspiciousCandidateName(value?: string | null): boolean {
  if (!value) return true;
  const lower = normalizeForNameChecks(value);
  if (!lower) return true;
  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length < 2) return true;
  const patterns = [
    'hola',
    'holi',
    'wena',
    'wenas',
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
    'licencia',
    'clase b',
    'clase a',
    'conductor',
    'manejo',
  ];
  if (patterns.some((p) => lower.includes(normalizeForNameChecks(p)))) return true;
  if (/^soy\s+de\b/.test(lower) || /^soy\s+del\b/.test(lower) || /^soy\s+de\s+la\b/.test(lower)) return true;
  if (/^(vivo|resido)\s+en\b/.test(lower)) return true;
  if (/\b\d{1,2}:\d{2}\b/.test(lower)) return true;
  return false;
}

function humanizeOutboundText(raw: string): string {
  const text = String(raw || '').trim();
  if (!text) return text;
  let out = text;
  out = out.replace(/responde\s+as[ií]\s*:\s*/gi, '');
  out = out.replace(/escr[ií]belo?\s+en\s+una\s+sola\s+l[ií]nea/gi, 'escríbelo completo, como te salga natural');
  out = out.replace(/formato\s+obligatorio/gi, 'formato sugerido');
  // Tone guard: enforce professional Spanish by removing common slang/modismos.
  const slangRewrites: Array<[RegExp, string]> = [
    [/\bwena(s)?\b/gi, 'hola'],
    [/\bme\s+tinca\b/gi, 'me interesa'],
    [/\bbac[aá]n\b/gi, 'excelente'],
    [/\bcompa\b/gi, 'estimado'],
    [/\bbro\b/gi, 'estimado'],
    [/\bcachai\b/gi, '¿te parece?'],
    [/\bwe[oó]n\b/gi, 'persona'],
  ];
  for (const [pattern, replacement] of slangRewrites) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(/\bpo\b/gi, '').replace(/\s{2,}/g, ' ');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
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

function resolvePublicAppBaseUrl(): string {
  const candidate =
    String(process.env.HUNTER_PUBLIC_BASE_URL || '').trim() ||
    String(process.env.PUBLIC_BASE_URL || '').trim() ||
    'https://hunter.mangoro.app';
  return candidate.replace(/\/+$/, '');
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
  const templates = await loadTemplateConfig(undefined, String((params.conversation as any)?.workspaceId || '').trim() || undefined);
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
  const normalizedDirect = stripAccents(direct).toLowerCase().replace(/\s+/g, ' ').trim();
  const latestAliases = new Set([
    '__latest__',
    '__last__',
    'latest',
    'last',
    'ultimo',
    'último',
    'ultimo postulante',
    'último postulante',
    'ultimo caso',
    'último caso',
    'ultimo cliente',
    'último cliente',
  ]);
  if (!direct) return params.relatedConversationId ? String(params.relatedConversationId) : null;
  if (latestAliases.has(normalizedDirect)) {
    const latest = await prisma.conversation
      .findFirst({
        where: {
          workspaceId: params.workspaceId,
          archivedAt: null,
          isAdmin: false,
          conversationKind: 'CLIENT',
        } as any,
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      })
      .catch(() => null);
    if (latest?.id) return latest.id;
  }

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

  // Resolve by candidate phone / waId to make staff commands usable with human refs:
  // "mover +569... a STAGE", "nota 569... ..."
  const waLike = normalizeWhatsAppId(direct) || normalizeWhatsAppId(direct.replace(/[^\d]/g, ''));
  if (waLike) {
    const phoneCandidates = Array.from(
      new Set(
        [waLike, `+${waLike}`, direct]
          .map((v) => String(v || '').trim())
          .filter(Boolean),
      ),
    );
    const contact = await prisma.contact
      .findFirst({
        where: {
          workspaceId: params.workspaceId,
          archivedAt: null,
          OR: [{ waId: { in: phoneCandidates } }, { phone: { in: phoneCandidates } }],
        },
        select: { id: true },
        orderBy: { updatedAt: 'desc' },
      })
      .catch(() => null);
    if (contact?.id) {
      const convo = await prisma.conversation
        .findFirst({
          where: {
            workspaceId: params.workspaceId,
            contactId: contact.id,
            archivedAt: null,
            isAdmin: false,
          } as any,
          select: { id: true },
          orderBy: { updatedAt: 'desc' },
        })
        .catch(() => null);
      if (convo?.id) return convo.id;
    }
  }

  // Resolve by contact display/name when staff says "nota juan perez ..."
  const nameNeedle = normalizeForNameChecks(direct);
  if (nameNeedle.length >= 3) {
    const contactsByName = await prisma.contact
      .findMany({
        where: {
          workspaceId: params.workspaceId,
          archivedAt: null,
          OR: [
            { candidateName: { contains: direct } },
            { candidateNameManual: { contains: direct } },
            { displayName: { contains: direct } },
            { name: { contains: direct } },
          ],
        },
        select: { id: true, candidateName: true, candidateNameManual: true, displayName: true, name: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 8,
      })
      .catch(() => []);
    const best = contactsByName
      .map((c: any) => ({
        id: c.id,
        score: (() => {
          const hay = normalizeForNameChecks(
            [c.candidateNameManual, c.candidateName, c.displayName, c.name].filter(Boolean).join(' '),
          );
          if (!hay) return 0;
          if (hay === nameNeedle) return 4;
          if (hay.startsWith(nameNeedle)) return 3;
          if (hay.includes(nameNeedle)) return 2;
          return 0;
        })(),
      }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
    if (best.length === 1 || (best[0] && best[1] && best[0].score > best[1].score)) {
      const convo = await prisma.conversation
        .findFirst({
          where: {
            workspaceId: params.workspaceId,
            contactId: best[0].id,
            archivedAt: null,
            isAdmin: false,
          } as any,
          select: { id: true },
          orderBy: { updatedAt: 'desc' },
        })
        .catch(() => null);
      if (convo?.id) return convo.id;
    }
  }

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
  assetId?: string | null;
  assetSlug?: string | null;
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
      assetId: params.assetId || null,
      assetSlug: params.assetSlug || null,
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

function shouldEmitTransparentTechnicalMessage(blockReason: string | null): boolean {
  if (!blockReason) return false;
  return (
    blockReason === 'ANTI_LOOP_SAME_TEXT' ||
    blockReason === 'ANTI_LOOP_DEDUPE_KEY' ||
    blockReason === 'CONSECUTIVE_DUPLICATE'
  );
}

function buildTransparentTechnicalMessage(params: {
  conversationKind: string;
  runId: string;
  reason: string;
}): string {
  const ref = String(params.runId || '').slice(-8) || 'n/a';
  const reason = String(params.reason || 'UNKNOWN').toUpperCase();
  if (String(params.conversationKind || '').toUpperCase() === 'STAFF') {
    return `Tuve un problema técnico al procesar tu solicitud (ref ${ref}, ${reason}). ¿Me la repites en unos segundos?`;
  }
  return `Tuve un problema técnico para responderte ahora (ref ${ref}, ${reason}). ¿Me repites el último mensaje en unos segundos?`;
}

async function trySendTransparentTechnicalMessage(params: {
  workspaceId: string;
  conversation: any;
  agentRunId: string;
  reason: string;
  config: Awaited<ReturnType<typeof getSystemConfig>>;
  transportMode: ExecutorTransportMode;
  relatedConversationId?: string | null;
}) {
  const conversation = params.conversation;
  const contact = conversation?.contact;
  if (!conversation?.id || !contact) return;
  const text = buildTransparentTechnicalMessage({
    conversationKind: String((conversation as any)?.conversationKind || 'CLIENT'),
    runId: params.agentRunId,
    reason: params.reason,
  });
  const dedupeKey = `tech_err:${String(params.agentRunId || '').slice(-8)}:${stableHash(`${conversation.id}:${params.reason}`).slice(0, 8)}`;
  const textHash = stableHash(`TEXT:${text}`);

  const existing = await shouldBlockOutbound({
    conversationId: conversation.id,
    dedupeKey,
    textHash,
    currentStageChangedAt: (conversation as any)?.stageChangedAt ? new Date((conversation as any).stageChangedAt) : null,
  });
  if (existing) {
    await logOutbound({
      workspaceId: params.workspaceId,
      conversationId: conversation.id,
      agentRunId: params.agentRunId,
      type: 'SESSION_TEXT',
      templateName: null,
      dedupeKey,
      textHash,
      blockedReason: existing,
      relatedConversationId: params.relatedConversationId || null,
    });
    return;
  }

  const toWaId = contact.waId || contact.phone || (params.transportMode === 'NULL' ? 'sandbox' : null);
  if (!toWaId) return;
  const safetyBlock = safeOutboundBlockedReason({ toWaId, config: params.config });
  if (safetyBlock) {
    await logOutbound({
      workspaceId: params.workspaceId,
      conversationId: conversation.id,
      agentRunId: params.agentRunId,
      type: 'SESSION_TEXT',
      templateName: null,
      dedupeKey,
      textHash,
      blockedReason: safetyBlock,
      relatedConversationId: params.relatedConversationId || null,
    });
    return;
  }

  const phoneNumberId = conversation.phoneLine?.waPhoneNumberId || null;
  let sendResult: SendResult = { success: true, messageId: `null-${Date.now()}` };
  if (params.transportMode === 'REAL') {
    sendResult = await sendWhatsAppText(toWaId, text, { phoneNumberId });
  }

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: 'OUTBOUND',
      text,
      rawPayload: serializeJson({
        system: true,
        technicalError: true,
        reason: params.reason,
        agentRunId: params.agentRunId,
        dedupeKey,
        sendResult,
      }),
      timestamp: new Date(),
      read: true,
    },
  });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } }).catch(() => {});
  await logOutbound({
    workspaceId: params.workspaceId,
    conversationId: conversation.id,
    agentRunId: params.agentRunId,
    type: 'SESSION_TEXT',
    templateName: null,
    dedupeKey,
    textHash,
    blockedReason: sendResult.success ? null : `SEND_FAILED:${sendResult.error || 'unknown'}`,
    waMessageId: sendResult.messageId || null,
    relatedConversationId: params.relatedConversationId || null,
  });
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
      select: { conversationId: true, inputContextJson: true, eventType: true, resultsJson: true },
    })
    .catch(() => null);
  const agentRunContext = safeJsonParse(agentRun?.inputContextJson || null);
  const previousRunResults = safeJsonParse(agentRun?.resultsJson || null);
  const agentEventType = String(agentRun?.eventType || '')
    .trim()
    .toUpperCase();
  const inboundTextFromRunContext = extractInboundTextFromRunContext(agentRunContext);
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
        include: { contact: true, phoneLine: true, program: { select: { id: true, slug: true } } as any },
      })
    : null;
  const workspaceRuntime = baseConversation?.workspaceId
    ? await prisma.workspace
        .findUnique({
          where: { id: baseConversation.workspaceId },
          select: { candidateReplyMode: true as any, adminNotifyMode: true as any },
        })
        .catch(() => null)
    : null;
  const candidateReplyMode =
    String((workspaceRuntime as any)?.candidateReplyMode || '').trim().toUpperCase() === 'HYBRID' ? 'HYBRID' : 'AUTO';
  const adminNotifyMode =
    String((workspaceRuntime as any)?.adminNotifyMode || '').trim().toUpperCase() === 'EVERY_DRAFT'
      ? 'EVERY_DRAFT'
      : 'HITS_ONLY';
  const contextMissingFields = Array.isArray((agentRunContext as any)?.applicationFlow?.missingFields)
    ? ((agentRunContext as any).applicationFlow.missingFields as any[])
        .map((v) => String(v || '').trim())
        .filter(Boolean)
    : [];
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
      const normalizedJobRoleFromPatch = normalizeApplicationRole(patch.jobRole);
      if (patch.jobRole && !normalizedJobRoleFromPatch) {
        delete patch.jobRole;
      } else if (normalizedJobRoleFromPatch) {
        patch.jobRole = mapRoleToContactJobRole(normalizedJobRoleFromPatch);
      }
      const locationMissing =
        !String(patch.comuna || '').trim() &&
        !String(patch.ciudad || '').trim() &&
        !String(patch.region || '').trim();
      if (locationMissing && inboundTextFromRunContext) {
        const resolved = resolveLocation(inboundTextFromRunContext, 'CL');
        if (resolved.confidence >= 0.6) {
          if (resolved.comuna && !String(patch.comuna || '').trim()) patch.comuna = resolved.comuna;
          if (resolved.ciudad && !String(patch.ciudad || '').trim()) patch.ciudad = resolved.ciudad;
          if (resolved.region && !String(patch.region || '').trim()) patch.region = resolved.region;
        }
      }
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
      if (normalizedJobRoleFromPatch && conversationId) {
        await prisma.conversation
          .update({
            where: { id: conversationId },
            data: { applicationRole: normalizedJobRoleFromPatch, updatedAt: new Date() } as any,
          })
          .catch(() => {});
      }
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
      let targetProgramId = String((cmd as any).programId || '').trim() || null;
      const targetProgramSlug = String((cmd as any).programSlug || '').trim() || null;
      if (!targetProgramId && targetProgramSlug) {
        targetProgramId = await resolveProgramIdBySlug(baseConversation?.workspaceId || params.workspaceId, targetProgramSlug);
      }
      if (!targetProgramId) {
        results.push({
          ok: false,
          details: {
            error: 'program_not_found',
            programId: (cmd as any).programId || null,
            programSlug: targetProgramSlug,
          },
        });
        continue;
      }
      await prisma.conversation.update({
        where: { id: cmd.conversationId },
        data: { programId: targetProgramId, updatedAt: new Date() },
      });
      if (baseConversation) {
        (baseConversation as any).programId = targetProgramId;
        (baseConversation as any).program = targetProgramSlug
          ? ({ id: targetProgramId, slug: targetProgramSlug } as any)
          : (baseConversation as any).program;
      }
      results.push({ ok: true, details: { programId: targetProgramId, programSlug: targetProgramSlug } });
      continue;
    }

    if (cmd.command === 'SET_APPLICATION_FLOW') {
      const role = normalizeApplicationRole((cmd as any).applicationRole);
      const state = normalizeApplicationState((cmd as any).applicationState);
      if (!role && !state) {
        results.push({ ok: false, details: { error: 'missing_application_role_or_state' } });
        continue;
      }
      const updateData: Record<string, any> = { updatedAt: new Date() };
      if (role) updateData.applicationRole = role;
      if (state) updateData.applicationState = state;
      const nextStage = state
        ? await resolveStageForApplicationState({
            workspaceId: baseConversation?.workspaceId || params.workspaceId,
            role: role || normalizeApplicationRole((baseConversation as any)?.applicationRole),
            state,
          }).catch(() => null)
        : null;
      if (nextStage) {
        updateData.conversationStage = nextStage;
        updateData.stageReason = (cmd as any).reason || `STATE:${state}`;
        updateData.stageChangedAt = new Date();
      }
      if (state === 'READY_FOR_OP_REVIEW' || state === 'WAITING_OP_RESULT' || state === 'OP_REJECTED') {
        updateData.aiPaused = true;
      }
      if (state === 'OP_ACCEPTED') {
        updateData.aiPaused = false;
      }
      await prisma.conversation.update({
        where: { id: cmd.conversationId },
        data: updateData as any,
      });
      const roleProgramSlug = roleToRecruitmentProgramSlug(role);
      const currentProgramSlug = String((baseConversation as any)?.program?.slug || '')
        .trim()
        .toLowerCase();
      const currentProgramId = String((baseConversation as any)?.programId || '').trim();
      const shouldSwitchByRole =
        Boolean(roleProgramSlug) &&
        (currentProgramSlug === 'postulacion-intake-envio-rapido' || !currentProgramId);
      if (shouldSwitchByRole && roleProgramSlug) {
        const roleProgramId = await resolveProgramIdBySlug(baseConversation?.workspaceId || params.workspaceId, roleProgramSlug);
        if (roleProgramId) {
          await prisma.conversation
            .update({
              where: { id: cmd.conversationId },
              data: { programId: roleProgramId, updatedAt: new Date() } as any,
            })
            .catch(() => {});
          if (baseConversation) {
            (baseConversation as any).programId = roleProgramId;
            (baseConversation as any).program = { id: roleProgramId, slug: roleProgramSlug } as any;
          }
        }
      }
      if (role && baseConversation?.contactId) {
        const contactJobRole = mapRoleToContactJobRole(role);
        await prisma.contact
          .update({
            where: { id: baseConversation.contactId },
            data: { jobRole: contactJobRole || role } as any,
          })
          .catch(() => {});
      }
      if (state === 'READY_FOR_OP_REVIEW') {
        const review = await triggerReadyForOpReview({
          app: params.app,
          workspaceId: baseConversation?.workspaceId || params.workspaceId,
          conversationId: cmd.conversationId,
          reason: (cmd as any).reason || 'SET_APPLICATION_FLOW_READY_FOR_OP_REVIEW',
          actorUserId: null,
        }).catch((err) => ({
          ok: false,
          summary: '',
          email: { configured: false, sent: false, error: err instanceof Error ? err.message : 'review_failed' },
        }));
        results.push({
          ok: Boolean((review as any)?.ok),
          details: {
            applicationRole: role,
            applicationState: state,
            opReview: (review as any)?.email || null,
          },
        });
        continue;
      }
      results.push({ ok: true, details: { applicationRole: role, applicationState: state } });
      continue;
    }

    if (cmd.command === 'ADD_CONVERSATION_NOTE') {
      await prisma.message.create({
        data: {
          conversationId: cmd.conversationId,
          direction: 'OUTBOUND',
          text: cmd.note,
          rawPayload: serializeJson({ system: true, visibility: cmd.visibility }),
          isInternalEvent: true as any,
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
      const proactiveCandidateBlocked =
        baseKind === 'CLIENT' &&
        agentEventType !== 'INBOUND_MESSAGE' &&
        !Boolean((cmd as any).allowProactive);
      if (proactiveCandidateBlocked) {
        const textHash = stableHash(
          cmd.type === 'TEMPLATE'
            ? `PROACTIVE_BLOCK:TEMPLATE:${cmd.templateName || ''}:${serializeJson(cmd.templateVars || {})}`
            : `PROACTIVE_BLOCK:TEXT:${cmd.text || ''}`,
        );
        await logOutbound({
          workspaceId: params.workspaceId,
          conversationId: baseConversation.id,
          agentRunId: params.agentRunId,
          type: cmd.type,
          templateName: cmd.type === 'TEMPLATE' ? cmd.templateName || null : null,
          dedupeKey: cmd.dedupeKey,
          textHash,
          blockedReason: 'PROACTIVE_CANDIDATE_REPLY_DISABLED',
          relatedConversationId: ['STAFF', 'PARTNER'].includes(baseKind) ? relatedConversationIdFromRun : null,
        });
        results.push({
          ok: true,
          blocked: true,
          blockedReason: 'PROACTIVE_CANDIDATE_REPLY_DISABLED',
          details: { eventType: agentEventType || null },
        });
        continue;
      }
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

      let effectiveText = cmd.text ? humanizeOutboundText(String(cmd.text)) : '';
      let guardrailOverride: any = null;

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
      if (blockReason) {
        const shouldSendTransparent =
          cmd.type === 'SESSION_TEXT' &&
          String(baseKind || '').toUpperCase() !== 'CLIENT' &&
          shouldEmitTransparentTechnicalMessage(blockReason);
        if (shouldSendTransparent) {
          await trySendTransparentTechnicalMessage({
            workspaceId: params.workspaceId,
            conversation: baseConversation,
            agentRunId: params.agentRunId,
            reason: blockReason,
            config,
            transportMode: params.transportMode,
            relatedConversationId: ['STAFF', 'PARTNER'].includes(baseKind) ? relatedConversationIdFromRun : null,
          });
        }
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
        results.push({
          ok: true,
          blocked: true,
          blockedReason: blockReason,
          details: shouldSendTransparent ? { technicalMessageAttempted: true } : undefined,
        });
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
      const kind = String((baseConversation as any).conversationKind || 'CLIENT').toUpperCase();
      if (kind === 'CLIENT' && !isMilestoneNotifyEvent({ eventType: (cmd as any).eventType, text: (cmd as any).text })) {
        results.push({
          ok: true,
          blocked: true,
          blockedReason: 'NOTIFY_ADMIN_NON_MILESTONE_IGNORED',
          details: { eventType: (cmd as any).eventType || null },
        });
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
        const stageSlugSet =
          stageSlug === 'NEW_INTAKE'
            ? ['NEW_INTAKE', 'NUEVO', 'SCREENING', 'INFO', 'WAITING_CANDIDATE']
            : stageSlug
              ? [stageSlug]
              : [];
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
            ...(stageSlugSet.length > 1
              ? ({ conversationStage: { in: stageSlugSet } } as any)
              : stageSlugSet.length === 1
                ? ({ conversationStage: stageSlugSet[0] } as any)
                : {}),
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
                contactWaId: c.contact?.waId || null,
                contactPhone: c.contact?.phone || null,
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
            isInternalEvent: true as any,
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
          const validStages = await prisma.workspaceStage
            .findMany({
              where: { workspaceId: baseConversation.workspaceId, active: true, archivedAt: null } as any,
              select: { slug: true },
              orderBy: { order: 'asc' },
              take: 30,
            })
            .catch(() => []);
          const stageList = validStages
            .map((s: any) => String(s?.slug || '').trim())
            .filter(Boolean);
          const suffix = stageList.length > 0 ? ` | stages válidos: ${stageList.join(', ')}` : '';
          results.push({ ok: false, details: { error: `stageSlug desconocido/inactivo: ${stageSlug}${suffix}`, toolName } });
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
              isInternalEvent: true as any,
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
        let effectiveText = humanizeOutboundText(textArg);
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
        if (blockReason) {
          const shouldSendTransparent =
            String((customerConversation as any)?.conversationKind || '').toUpperCase() !== 'CLIENT' &&
            shouldEmitTransparentTechnicalMessage(blockReason);
          if (shouldSendTransparent) {
            await trySendTransparentTechnicalMessage({
              workspaceId: baseConversation.workspaceId,
              conversation: customerConversation,
              agentRunId: params.agentRunId,
              reason: blockReason,
              config,
              transportMode: params.transportMode,
              relatedConversationId: null,
            });
          }
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
          results.push({
            ok: true,
            blocked: true,
            blockedReason: blockReason,
            details: shouldSendTransparent ? { technicalMessageAttempted: true, toolName } : undefined,
          });
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

      if (toolName === 'SEND_PDF') {
        const conversationIdArgRaw =
          typeof (args as any).conversationId === 'string' ? (args as any).conversationId.trim() : '';
        const conversationIdArg = await resolveCaseConversationId({
          workspaceId: baseConversation.workspaceId,
          ref: conversationIdArgRaw,
          relatedConversationId: relatedConversationIdFromRun || null,
        });
        const assetSlug = String((args as any).assetSlug || '').trim();
        const caption = typeof (args as any).caption === 'string' ? String((args as any).caption).trim() : '';
        if (!conversationIdArg || !assetSlug) {
          results.push({
            ok: false,
            details: { error: 'conversationId y assetSlug requeridos (o responde a una notificación del caso)', toolName },
          });
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

        const asset = await prisma.workspaceAsset
          .findFirst({
            where: { workspaceId: baseConversation.workspaceId, slug: assetSlug, archivedAt: null },
            select: {
              id: true,
              slug: true,
              title: true,
              audience: true,
              mimeType: true,
              fileName: true,
              publicId: true,
            },
          })
          .catch(() => null);
        if (!asset?.id) {
          results.push({ ok: false, details: { error: `asset_not_found:${assetSlug}`, toolName } });
          continue;
        }
        if (String(asset.audience || '').toUpperCase() !== 'PUBLIC') {
          results.push({ ok: false, details: { error: 'FORBIDDEN_ASSET_INTERNAL', toolName, assetSlug } });
          continue;
        }
        if (String(asset.mimeType || '').toLowerCase() !== 'application/pdf') {
          results.push({ ok: false, details: { error: 'ASSET_NOT_PDF', toolName, assetSlug } });
          continue;
        }

        const dedupeKeyRaw =
          typeof (args as any).dedupeKey === 'string' && String((args as any).dedupeKey).trim()
            ? String((args as any).dedupeKey).trim()
            : `staff_send_pdf:${params.agentRunId}:${asset.id}:${customerConversation.id}`;
        const dedupeKey = dedupeKeyRaw.slice(0, 128);
        const payloadHash = stableHash(`DOCUMENT:${asset.id}:${caption || ''}`);

        const window = await computeWhatsAppWindowStatusStrict(customerConversation.id).catch(() => 'OUTSIDE_24H' as WhatsAppWindowStatus);
        if (window === 'OUTSIDE_24H') {
          await logOutbound({
            workspaceId: baseConversation.workspaceId,
            conversationId: customerConversation.id,
            agentRunId: params.agentRunId,
            type: 'DOCUMENT',
            templateName: null,
            dedupeKey,
            textHash: payloadHash,
            blockedReason: 'OUTSIDE_24H',
            assetId: asset.id,
            assetSlug: asset.slug,
          });
          results.push({
            ok: true,
            blocked: true,
            blockedReason: 'OUTSIDE_24H',
            details: {
              toolName,
              assetSlug: asset.slug,
              suggestedTemplate: 'enviorapido_postulacion_menu_v1',
            },
          });
          continue;
        }

        if ((customerContact as any).noContact) {
          await logOutbound({
            workspaceId: baseConversation.workspaceId,
            conversationId: customerConversation.id,
            agentRunId: params.agentRunId,
            type: 'DOCUMENT',
            templateName: null,
            dedupeKey,
            textHash: payloadHash,
            blockedReason: 'NO_CONTACTAR',
            assetId: asset.id,
            assetSlug: asset.slug,
          });
          results.push({ ok: true, blocked: true, blockedReason: 'NO_CONTACTAR' });
          continue;
        }

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
            type: 'DOCUMENT',
            templateName: null,
            dedupeKey,
            textHash: payloadHash,
            blockedReason: blockReason,
            assetId: asset.id,
            assetSlug: asset.slug,
          });
          results.push({ ok: true, blocked: true, blockedReason: blockReason, details: { toolName } });
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
            type: 'DOCUMENT',
            templateName: null,
            dedupeKey,
            textHash: payloadHash,
            blockedReason: safetyBlock,
            assetId: asset.id,
            assetSlug: asset.slug,
          });
          results.push({ ok: true, blocked: true, blockedReason: safetyBlock });
          continue;
        }

        const publicPath = buildWorkspaceAssetPublicUrl({ publicId: asset.publicId, fileName: asset.fileName });
        const documentUrl = `${resolvePublicAppBaseUrl()}${publicPath}`;
        let sendResult: SendResult = { success: true, messageId: `null-${Date.now()}` };
        if (params.transportMode === 'REAL') {
          const phoneNumberId = customerConversation.phoneLine?.waPhoneNumberId || null;
          sendResult = await sendWhatsAppDocumentByLink(
            toWaId,
            {
              url: documentUrl,
              filename: asset.fileName,
              caption: caption || null,
            },
            { phoneNumberId },
          );
        }

        await prisma.message.create({
          data: {
            conversationId: customerConversation.id,
            direction: 'OUTBOUND',
            text: caption || `[PDF] ${asset.title}`,
            mediaType: 'document',
            mediaMime: 'application/pdf',
            mediaPath: documentUrl,
            rawPayload: serializeJson({
              system: true,
              toolName,
              staffActor: { userId: staffActor.userId, email: staffActor.email, role: staffActor.role },
              agentRunId: params.agentRunId,
              sendResult,
              assetId: asset.id,
              assetSlug: asset.slug,
              assetUrl: documentUrl,
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
          type: 'DOCUMENT',
          templateName: null,
          dedupeKey,
          textHash: payloadHash,
          blockedReason: sendResult.success ? null : `SEND_FAILED:${sendResult.error || 'unknown'}`,
          waMessageId: sendResult.messageId || null,
          assetId: asset.id,
          assetSlug: asset.slug,
        });

        if (params.transportMode === 'REAL' && customerConversation.phoneLineId) {
          await prisma.phoneLine
            .update({
              where: { id: customerConversation.phoneLineId },
              data: { lastOutboundAt: new Date() },
            })
            .catch(() => {});
        }

        results.push({
          ok: true,
          details: {
            toolName,
            result: {
              sendResult,
              assetSlug: asset.slug,
              assetId: asset.id,
              documentUrl,
            },
          },
        });
        continue;
      }

      results.push({ ok: false, details: { error: `toolName desconocido: ${toolName}`, toolName } });
      continue;
    }

    results.push({ ok: false, details: { error: 'unknown_command', command: (cmd as any).command } });
  }

  const hasDeliveredReply = results.some((row) => {
    if (!row || typeof row !== 'object') return false;
    const direct = (row as any)?.details?.sendResult;
    const nested = (row as any)?.details?.result?.sendResult;
    return Boolean((direct && direct.success === true) || (nested && nested.success === true));
  });
  const inboundNormalized = normalizeForNameChecks(inboundTextFromRunContext || '');
  const applicationState = String((baseConversation as any)?.applicationState || '').trim().toUpperCase() || null;
  const fallbackReasonRaw =
    String((previousRunResults as any)?.fallbackReason || (previousRunResults as any)?.reason || '')
      .trim()
      .toUpperCase() || null;

  let replyDecision: string | null = null;
  let replyDecisionReason: string | null = null;

  if (agentEventType === 'INBOUND_MESSAGE') {
    if (hasDeliveredReply) {
      replyDecision = 'REPLY_SENT';
      replyDecisionReason = 'sendResult.success=true';
    } else if (String((baseConversation as any)?.conversationKind || 'CLIENT').toUpperCase() === 'CLIENT') {
      if (Boolean((baseConversation as any)?.aiPaused)) {
        replyDecision = 'NO_REPLY_AIPAUSED';
        replyDecisionReason = 'conversation.aiPaused=true';
      } else if (candidateReplyMode === 'HYBRID') {
        replyDecision = 'NO_REPLY_HYBRID';
        replyDecisionReason = 'candidateReplyMode=HYBRID';
      } else if (!String((baseConversation as any)?.programId || '').trim()) {
        replyDecision = 'NO_REPLY_NO_PROGRAM';
        replyDecisionReason = 'conversation.programId missing';
      } else if (
        fallbackReasonRaw &&
        (fallbackReasonRaw.includes('INVALID_') ||
          fallbackReasonRaw.includes('SCHEMA') ||
          fallbackReasonRaw.includes('SEMANTICS') ||
          fallbackReasonRaw.includes('VALIDATION'))
      ) {
        replyDecision = 'NO_REPLY_VALIDATION';
        replyDecisionReason = `fallbackReason=${fallbackReasonRaw}`;
      } else if (
        isSimpleGreeting(inboundNormalized) &&
        ['READY_FOR_OP_REVIEW', 'WAITING_OP_RESULT', 'OP_REJECTED', 'OP_ACCEPTED'].includes(
          String(applicationState || '').toUpperCase(),
        )
      ) {
        replyDecision = 'NO_REPLY_GREETING_RULE';
        replyDecisionReason = `state=${applicationState || 'UNKNOWN'} (sin auto-reply)`;
      } else {
        replyDecision = 'NO_REPLY_ERROR';
        replyDecisionReason = fallbackReasonRaw ? `fallbackReason=${fallbackReasonRaw}` : 'No SEND_MESSAGE exitoso en ejecución';
      }
    } else {
      replyDecision = hasDeliveredReply ? 'REPLY_SENT' : 'NO_REPLY_ERROR';
      replyDecisionReason = hasDeliveredReply ? 'sendResult.success=true' : 'Inbound no-client sin envío exitoso';
    }
  }

  const mergedResults = {
    ...(previousRunResults && typeof previousRunResults === 'object' ? previousRunResults : {}),
    results,
    replyDecision,
    replyDecisionReason,
    candidateReplyMode,
    adminNotifyMode,
    aiPaused: Boolean((baseConversation as any)?.aiPaused),
    applicationRole: String((baseConversation as any)?.applicationRole || '').trim() || null,
    applicationState: String((baseConversation as any)?.applicationState || '').trim() || null,
    missingFields: contextMissingFields,
    lastUserMessageNormalized: inboundNormalized || null,
  };

  await prisma.agentRunLog.update({
    where: { id: params.agentRunId },
    data: { status: 'EXECUTED', resultsJson: serializeJson(mergedResults) },
  });

  return { results };
}
