import { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { prisma } from '../db/client';
import { serializeJson } from '../utils/json';
import { executeAgentResponse, ExecutorTransportMode } from './agent/commandExecutorService';
import { runAgent } from './agent/agentRuntimeService';
import { resolveLocation, stableHash, stripAccents, validateRut } from './agent/tools';
import { createInAppNotification } from './notificationService';
import { getContactDisplayName } from '../utils/contactDisplay';
import { normalizeWhatsAppId } from '../utils/whatsapp';
import { ensurePartnerConversation, ensureStaffConversation } from './staffConversationService';
import { resolveWorkspaceProgramForKind } from './programRoutingService';
import { loadTemplateConfig, resolveTemplateVariables, selectTemplateForMode } from './templateService';
import { getAdminWaIdAllowlist, getSystemConfig } from './configService';
import { ensureAdminConversation, sendAdminReply } from './adminConversationService';
import { deriveCandidateStatusFromConversation, upsertCandidateAndCase } from './candidateService';
import { listWorkspaceTemplateCatalog } from './whatsappTemplateCatalogService';
import { sendWhatsAppTemplate, sendWhatsAppText } from './whatsappMessageService';
import { normalizeChilePhoneE164 } from '../utils/phone';
import { isKnownActiveStage, listWorkspaceStages } from './workspaceStageService';
import {
  attemptScheduleInterview,
  confirmActiveReservation,
  formatSlotHuman,
  releaseActiveReservation,
  resolveInterviewSlotFromDayTime,
} from './interviewSchedulerService';

type ProgramSummary = { id: string; name: string; slug: string };

const PROGRAM_MENU_PENDING_TAG = 'program_menu_pending';

function parseStageTagsValue(raw: unknown): string[] {
  if (!raw) return [];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => normalizeLoose(String(v))).filter(Boolean);
      }
    } catch {
      // ignore
    }
    return trimmed
      .split(/[,\n]/g)
      .map((v) => normalizeLoose(v))
      .filter(Boolean);
  }
  return [];
}

function serializeStageTags(tags: string[]): string | null {
  const unique: string[] = [];
  for (const tag of tags) {
    const t = normalizeLoose(tag);
    if (!t) continue;
    if (!unique.includes(t)) unique.push(t);
  }
  return unique.length > 0 ? JSON.stringify(unique) : null;
}

function buildConversationSummaryForAssignment(params: { conversation: any; programName?: string | null }): string {
  const contact = params.conversation?.contact;
  const display = contact ? getContactDisplayName(contact) : 'Contacto';
  const comuna = String(contact?.comuna || '').trim();
  const ciudad = String(contact?.ciudad || '').trim();
  const region = String(contact?.region || '').trim();
  const location = [comuna, ciudad, region].filter(Boolean).join(' · ');
  const availability = String((contact as any)?.availabilityText || '').trim();
  const programName = String(params.programName || '').trim();

  const lines: string[] = [];
  lines.push(`👤 ${display}`);
  if (programName) lines.push(`🧭 Servicio: ${programName}`);
  if (location) lines.push(`📍 Ubicación: ${location}`);
  if (availability) lines.push(`⏱️ Preferencia horaria: ${availability}`);
  return lines.join('\n');
}

async function listActivePrograms(workspaceId: string): Promise<ProgramSummary[]> {
  return prisma.program.findMany({
    where: { workspaceId, isActive: true, archivedAt: null },
    select: { id: true, name: true, slug: true },
    orderBy: { name: 'asc' },
  });
}

function isStaffLikeProgram(program: ProgramSummary): boolean {
  const text = normalizeLoose(`${program.name} ${program.slug}`);
  return /\bstaff\b/.test(text) || /\boperaci/.test(text) || /\benfermer/.test(text) || /\bcoordinad/.test(text);
}

function isPartnerLikeProgram(program: ProgramSummary): boolean {
  const text = normalizeLoose(`${program.name} ${program.slug}`);
  return /\bpartner\b/.test(text) || /\bproveedor/.test(text) || /\baliad/.test(text);
}

function normalizeLoose(value: string): string {
  return stripAccents(String(value || '')).toLowerCase().replace(/\s+/g, ' ').trim();
}

function repairMojibake(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/[ÃÂ�]/.test(raw)) return raw;
  try {
    const fixed = Buffer.from(raw, 'latin1').toString('utf8').trim();
    if (!fixed) return raw;
    if (fixed.includes('�')) return raw;
    return fixed;
  } catch {
    return raw;
  }
}

function mapCandidateStatus(stageRaw: string, statusRaw: string): 'Nuevo' | 'Contactado' | 'Citado' | 'Descartado' {
  const stage = String(stageRaw || '').toUpperCase();
  const status = String(statusRaw || '').toUpperCase();
  if (
    status === 'CLOSED' ||
    ['REJECTED', 'NO_CONTACTAR', 'DISQUALIFIED', 'CERRADO', 'ARCHIVED'].includes(stage)
  ) {
    return 'Descartado';
  }
  if (['INTERVIEW_PENDING', 'INTERVIEW_SCHEDULED', 'INTERVIEWED', 'AGENDADO', 'CONFIRMADO'].includes(stage)) {
    return 'Citado';
  }
  if (status === 'OPEN' || ['SCREENING', 'INFO', 'CALIFICADO', 'QUALIFIED', 'EN_COORDINACION', 'INTERESADO'].includes(stage)) {
    return 'Contactado';
  }
  return 'Nuevo';
}

function normalizeStageCandidate(rawStage: string): string {
  const raw = String(rawStage || '').trim();
  if (!raw) return '';
  const cleaned = stripAccents(raw)
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^\w\s-]/g, ' ')
    .trim();
  if (!cleaned) return '';
  const tokens = cleaned
    .split(/[\s-]+/g)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  if (tokens.length === 0) return '';
  const stopWords = new Set(['POR', 'FAVOR', 'EL', 'LA', 'LOS', 'LAS', 'STAGE', 'ETAPA', 'ESTADO']);
  const kept: string[] = [];
  for (const token of tokens) {
    if (stopWords.has(token) && kept.length > 0) break;
    kept.push(token);
    if (kept.length >= 4) break;
  }
  return kept.join('_');
}

function resolveProgramChoice(inboundText: string, programs: ProgramSummary[]): ProgramSummary | null {
  const normalized = normalizeLoose(inboundText);
  if (!normalized) return null;

  const numeric = normalized.match(/^(\d{1,2})\b/);
  if (numeric?.[1]) {
    const idx = parseInt(numeric[1], 10);
    if (Number.isFinite(idx) && idx >= 1 && idx <= programs.length) return programs[idx - 1];
  }

  const slugMatches = programs.filter((p) => normalized.includes(normalizeLoose(p.slug)));
  if (slugMatches.length === 1) return slugMatches[0];

  const nameMatches = programs.filter((p) => normalized.includes(normalizeLoose(p.name)));
  if (nameMatches.length === 1) return nameMatches[0];

  return null;
}

function isMenuCommand(inboundText: string | null | undefined): boolean {
  const normalized = normalizeLoose(String(inboundText || ''));
  if (!normalized) return false;
  if (normalized === 'menu') return true;
  if (normalized === 'programas') return true;
  if (normalized.includes('cambiar programa')) return true;
  if (normalized.includes('cambiar de programa')) return true;
  if (normalized.includes('menu de programas')) return true;
  if (normalized.includes('cambiar modo')) return true;
  return false;
}

function normalizeInboundMode(value: unknown): 'DEFAULT' | 'MENU' {
  const upper = String(value || '').trim().toUpperCase();
  return upper === 'MENU' ? 'MENU' : 'DEFAULT';
}

function pickHybridApprovalAdminWa(params: {
  workspaceAdminWaRaw: string | null | undefined;
  adminAllowlist: string[];
}): string | null {
  const allowlist = Array.isArray(params.adminAllowlist) ? params.adminAllowlist.map((v) => String(v).trim()).filter(Boolean) : [];
  if (allowlist.length === 0) return null;
  const preferred = normalizeWhatsAppId(String(params.workspaceAdminWaRaw || '').trim() || '');
  if (preferred && allowlist.includes(preferred)) return preferred;
  return allowlist[0] || null;
}

function looksLikeTechnicalFallback(text: string): boolean {
  const normalized = normalizeLoose(text);
  if (!normalized) return false;
  return (
    normalized.includes('problema tecnico') ||
    normalized.includes('invalid_semantics') ||
    normalized.includes('invalid_schema') ||
    normalized.includes('run_budget_exceeded') ||
    normalized.includes('tool_loop_exceeded') ||
    normalized.includes('ref ') && normalized.includes('error')
  );
}

function candidateSafeFallbackText(inboundText?: string | null): string {
  const inbound = String(inboundText || '').trim();
  if (inbound) {
    return `Hola, gracias por escribir. Ya revisé tu mensaje. Para avanzar, ¿me confirmas tu comuna y tu tipo de licencia?`;
  }
  return 'Hola, gracias por escribir. Para avanzar, ¿me confirmas tu comuna y tu tipo de licencia?';
}

async function enqueueHybridApprovalDrafts(params: {
  app: FastifyInstance;
  workspaceId: string;
  conversation: any;
  inboundMessageId?: string | null;
  inboundText?: string | null;
  agentRunId: string;
  sendCommands: Array<any>;
}): Promise<Array<{ draftId: string; status: string; adminConversationId?: string | null; reason?: string }>> {
  const conversation = params.conversation;
  const toWa = String(conversation?.contact?.waId || conversation?.contact?.phone || '').trim();
  if (!conversation?.id || !toWa) {
    return [{ draftId: '', status: 'ERROR', reason: 'missing_candidate_waid' }];
  }

  const config = await getSystemConfig().catch(() => null);
  const adminAllowlist = config ? getAdminWaIdAllowlist(config) : [];
  const workspace = await prisma.workspace
    .findUnique({
      where: { id: params.workspaceId },
      select: { hybridApprovalAdminWaId: true as any },
    })
    .catch(() => null);
  const adminWaNormalized = pickHybridApprovalAdminWa({
    workspaceAdminWaRaw: String((workspace as any)?.hybridApprovalAdminWaId || '').trim() || null,
    adminAllowlist,
  });
  if (!adminWaNormalized) {
    return [{ draftId: '', status: 'ERROR', reason: 'missing_admin_allowlist' }];
  }

  const adminThread = await ensureAdminConversation({
    workspaceId: params.workspaceId,
    waId: adminWaNormalized,
    phoneLineId: conversation.phoneLineId,
  }).catch((err) => {
    params.app.log.warn({ err, workspaceId: params.workspaceId }, 'Failed to ensure admin thread for hybrid approval');
    return null;
  });
  if (!adminThread?.conversation?.id) {
    return [{ draftId: '', status: 'ERROR', reason: 'admin_thread_unavailable' }];
  }

  const candidateName =
    getContactDisplayName(conversation.contact) ||
    String(conversation.contact?.phone || conversation.contact?.waId || 'Candidato');
  const inboundSnippet = String(params.inboundText || '').trim().slice(0, 280);

  const outputs: Array<{ draftId: string; status: string; adminConversationId?: string | null; reason?: string }> = [];
  for (const cmd of params.sendCommands) {
    const type = String(cmd?.type || '').toUpperCase();
    const textRaw =
      type === 'SESSION_TEXT'
        ? String(cmd?.text || '').trim()
        : type === 'TEMPLATE'
          ? `[TEMPLATE] ${String(cmd?.templateName || '').trim() || '(sin nombre)'}`.trim()
          : '';
    const text = looksLikeTechnicalFallback(textRaw) ? candidateSafeFallbackText(params.inboundText || null) : textRaw;
    if (!text) continue;
    const dedupeKey = String(cmd?.dedupeKey || '').trim() || `hybrid:${stableHash(`${params.agentRunId}:${text}`).slice(0, 12)}`;
    const existing = await prisma.hybridReplyDraft
      .findFirst({
        where: {
          workspaceId: params.workspaceId,
          conversationId: conversation.id,
          inboundMessageId: params.inboundMessageId || null,
          dedupeKey,
          status: { in: ['PENDING', 'APPROVED'] },
        },
        select: { id: true },
      })
      .catch(() => null);
    if (existing?.id) {
      outputs.push({ draftId: existing.id, status: 'DEDUPED', adminConversationId: adminThread.conversation.id });
      continue;
    }

    const created = await prisma.hybridReplyDraft.create({
      data: {
        workspaceId: params.workspaceId,
        conversationId: conversation.id,
        inboundMessageId: params.inboundMessageId || null,
        agentRunId: params.agentRunId,
        dedupeKey,
        targetWaId: toWa,
        proposedText: text,
        status: 'PENDING',
        metadataJson: serializeJson({
          commandType: type || null,
          templateName: type === 'TEMPLATE' ? String(cmd?.templateName || '').trim() || null : null,
          templateVars: type === 'TEMPLATE' ? (cmd?.templateVars || null) : null,
        }),
      } as any,
    });

    const shortId = String(created.id).slice(0, 8);
    const adminText = [
      `📝 Borrador ${shortId}`,
      `Candidato: ${candidateName} (+${toWa})`,
      inboundSnippet ? `Último mensaje: ${inboundSnippet}` : null,
      '',
      'Propuesta:',
      text,
      looksLikeTechnicalFallback(textRaw)
        ? '(Nota: el borrador técnico fue reemplazado por un mensaje humano seguro para evitar errores al candidato.)'
        : null,
      '',
      `Comandos: ENVIAR ${shortId} | EDITAR ${shortId}: <texto> | CANCELAR ${shortId}`,
    ]
      .filter(Boolean)
      .join('\n');

    await sendAdminReply({
      logger: params.app.log,
      conversationId: adminThread.conversation.id,
      waId: `+${adminWaNormalized}`,
      text: adminText,
      rawPayload: {
        hybridApproval: true,
        draftId: created.id,
        sourceConversationId: conversation.id,
      },
    }).catch((err) => {
      params.app.log.warn({ err, draftId: created.id }, 'Failed sending hybrid draft to admin');
    });

    await prisma.message
      .create({
        data: {
          conversationId: conversation.id,
          direction: 'OUTBOUND',
          text: `📝 Respuesta propuesta enviada a revisión (ID ${shortId}).`,
          rawPayload: serializeJson({
            system: true,
            hybridApproval: true,
            draftId: created.id,
            adminConversationId: adminThread.conversation.id,
            agentRunId: params.agentRunId,
          }),
          timestamp: new Date(),
          read: true,
        },
      })
      .catch(() => {});
    await prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } }).catch(() => {});

    outputs.push({ draftId: created.id, status: 'PENDING', adminConversationId: adminThread.conversation.id });
  }

  return outputs;
}

function parseProgramMenuIdsJson(raw: unknown): string[] {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const item of parsed) {
      const id = String(item || '').trim();
      if (!id) continue;
      if (!out.includes(id)) out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

async function listSelectablePrograms(params: { workspaceId: string; conversation: any }): Promise<ProgramSummary[]> {
  const programsAll = await listActivePrograms(params.workspaceId);
  const kind = String((params.conversation as any)?.conversationKind || 'CLIENT').toUpperCase();
  let programs = params.conversation.isAdmin
    ? programsAll
    : programsAll.filter((p) => normalizeLoose(p.slug) !== 'admin');
  if (programs.length === 0) return [];

  const workspaceMenus = await prisma.workspace
    .findFirst({
      where: { id: params.workspaceId, archivedAt: null },
      select: {
        staffProgramMenuIdsJson: true as any,
        clientProgramMenuIdsJson: true as any,
        partnerProgramMenuIdsJson: true as any,
      },
    })
    .catch(() => null);
  const menuIdsRaw =
    kind === 'STAFF'
      ? (workspaceMenus as any)?.staffProgramMenuIdsJson
      : kind === 'PARTNER'
        ? (workspaceMenus as any)?.partnerProgramMenuIdsJson
        : (workspaceMenus as any)?.clientProgramMenuIdsJson;
  const allowedIdsFromWorkspace = parseProgramMenuIdsJson(menuIdsRaw);
  if (allowedIdsFromWorkspace.length > 0) {
    const filtered = programs.filter((p) => allowedIdsFromWorkspace.includes(p.id));
    if (filtered.length > 0) programs = filtered;
  } else if (kind === 'STAFF') {
    const filtered = programs.filter((p) => isStaffLikeProgram(p));
    if (filtered.length > 0) programs = filtered;
  } else if (kind === 'PARTNER') {
    const filtered = programs.filter((p) => isPartnerLikeProgram(p));
    if (filtered.length > 0) programs = filtered;
  }

  if (!params.conversation.isAdmin && kind === 'CLIENT' && params.conversation.phoneLineId) {
    const line = await prisma.phoneLine
      .findFirst({
        where: { id: params.conversation.phoneLineId, workspaceId: params.workspaceId, archivedAt: null },
        select: { inboundMode: true as any, programMenuIdsJson: true as any },
      })
      .catch(() => null);
    const inboundMode = normalizeInboundMode((line as any)?.inboundMode);
    if (inboundMode === 'MENU') {
      const allowedIds = parseProgramMenuIdsJson((line as any)?.programMenuIdsJson);
      if (allowedIds.length > 0) {
        const filtered = programs.filter((p) => allowedIds.includes(p.id));
        if (filtered.length > 0) programs = filtered;
      }
    }
  }

  return programs;
}

async function showProgramMenu(params: {
  app: FastifyInstance;
  workspaceId: string;
  conversation: any;
  inboundText: string | null;
  inboundMessageId?: string | null;
  windowStatus: string;
  transportMode: ExecutorTransportMode;
  reason: 'programId_missing' | 'menu_command' | 'awaiting_choice';
}): Promise<void> {
  const programs = await listSelectablePrograms({ workspaceId: params.workspaceId, conversation: params.conversation });
  if (programs.length === 0) return;

  const menuLines = programs.map((p, idx) => `${idx + 1}) ${p.name}`).join('\n');
  const menuText = `¿Sobre qué programa necesitas ayuda?\nResponde con el número:\n${menuLines}`.trim();

  const tags = parseStageTagsValue(params.conversation.stageTags);
  if (!tags.includes(PROGRAM_MENU_PENDING_TAG)) {
    tags.push(PROGRAM_MENU_PENDING_TAG);
    await prisma.conversation
      .update({
        where: { id: params.conversation.id },
        data: { stageTags: serializeStageTags(tags), updatedAt: new Date() },
      })
      .catch(() => {});
    params.conversation.stageTags = serializeStageTags(tags);
  }

  const agentRun = await prisma.agentRunLog.create({
    data: {
      workspaceId: params.workspaceId,
      conversationId: params.conversation.id,
      programId: params.conversation.programId || null,
      phoneLineId: params.conversation.phoneLineId || null,
      eventType: 'PROGRAM_SELECTION',
      status: 'RUNNING',
      inputContextJson: serializeJson({
        reason: params.reason,
        inboundMessageId: params.inboundMessageId || null,
        inboundText: String(params.inboundText || '').trim() || null,
        programs: programs.map((p) => ({ id: p.id, name: p.name, slug: p.slug })),
      }),
      commandsJson: serializeJson({
        agent: 'system_program_selector',
        version: 1,
        commands: [
          {
            command: 'SEND_MESSAGE',
            conversationId: params.conversation.id,
            channel: 'WHATSAPP',
            type: 'SESSION_TEXT',
            text: menuText,
            dedupeKey: `program_menu:${stableHash(`${params.conversation.id}:${menuText}`).slice(0, 12)}`,
          },
        ],
      }),
    },
  });

  await executeAgentResponse({
    app: params.app,
    workspaceId: params.workspaceId,
    agentRunId: agentRun.id,
    response: {
      agent: 'system_program_selector',
      version: 1,
      commands: [
        {
          command: 'SEND_MESSAGE',
          conversationId: params.conversation.id,
          channel: 'WHATSAPP',
          type: 'SESSION_TEXT',
          text: menuText,
          dedupeKey: `program_menu:${stableHash(`${params.conversation.id}:${menuText}`).slice(0, 12)}`,
        } as any,
      ],
    } as any,
    transportMode: params.transportMode,
  });
}

async function maybeHandleProgramMenuCommandOrPendingChoice(params: {
  app: FastifyInstance;
  workspaceId: string;
  conversation: any;
  inboundText: string | null;
  inboundMessageId?: string | null;
  windowStatus: string;
  transportMode: ExecutorTransportMode;
}): Promise<{ handled: boolean }> {
  if (!params.conversation) return { handled: false };
  if (params.conversation.isAdmin) return { handled: false };

  const inbound = String(params.inboundText || '').trim();
  const tags = parseStageTagsValue(params.conversation.stageTags);
  const awaiting = tags.includes(PROGRAM_MENU_PENDING_TAG);

  if (isMenuCommand(inbound)) {
    await showProgramMenu({
      app: params.app,
      workspaceId: params.workspaceId,
      conversation: params.conversation,
      inboundText: inbound,
      inboundMessageId: params.inboundMessageId || null,
      windowStatus: params.windowStatus,
      transportMode: params.transportMode,
      reason: 'menu_command',
    });
    return { handled: true };
  }

  if (!awaiting) return { handled: false };
  const programs = await listSelectablePrograms({ workspaceId: params.workspaceId, conversation: params.conversation });
  if (programs.length === 0) return { handled: false };

  const choice = inbound ? resolveProgramChoice(inbound, programs) : null;
  if (!choice) {
    await showProgramMenu({
      app: params.app,
      workspaceId: params.workspaceId,
      conversation: params.conversation,
      inboundText: inbound,
      inboundMessageId: params.inboundMessageId || null,
      windowStatus: params.windowStatus,
      transportMode: params.transportMode,
      reason: 'awaiting_choice',
    });
    return { handled: true };
  }

  const nextTags = tags.filter((t) => t !== PROGRAM_MENU_PENDING_TAG);
  await prisma.conversation
    .update({
      where: { id: params.conversation.id },
      data: { programId: choice.id, stageTags: serializeStageTags(nextTags), updatedAt: new Date() },
    })
    .catch(() => {});
  params.conversation.programId = choice.id;
  params.conversation.stageTags = serializeStageTags(nextTags);

  const confirmText = `Listo. Te atenderé con el programa: ${choice.name}.\n¿En qué te puedo ayudar?`;
  const agentRun = await prisma.agentRunLog.create({
    data: {
      workspaceId: params.workspaceId,
      conversationId: params.conversation.id,
      programId: choice.id,
      phoneLineId: params.conversation.phoneLineId || null,
      eventType: 'PROGRAM_SELECTION',
      status: 'RUNNING',
      inputContextJson: serializeJson({
        reason: 'program_selected',
        inboundMessageId: params.inboundMessageId || null,
        inboundText: inbound || null,
        selected: { id: choice.id, name: choice.name, slug: choice.slug },
      }),
      commandsJson: serializeJson({
        agent: 'system_program_selector',
        version: 1,
        commands: [
          { command: 'SET_CONVERSATION_PROGRAM', conversationId: params.conversation.id, programId: choice.id, reason: 'user_selected' },
          { command: 'ADD_CONVERSATION_NOTE', conversationId: params.conversation.id, visibility: 'SYSTEM', note: `🔀 Programa cambiado a: ${choice.name}` },
          {
            command: 'SEND_MESSAGE',
            conversationId: params.conversation.id,
            channel: 'WHATSAPP',
            type: 'SESSION_TEXT',
            text: confirmText,
            dedupeKey: `program_selected:${stableHash(`${params.conversation.id}:${choice.id}`).slice(0, 12)}`,
          },
        ],
      }),
    },
  });

  await executeAgentResponse({
    app: params.app,
    workspaceId: params.workspaceId,
    agentRunId: agentRun.id,
    response: {
      agent: 'system_program_selector',
      version: 1,
      commands: [
        { command: 'SET_CONVERSATION_PROGRAM', conversationId: params.conversation.id, programId: choice.id, reason: 'user_selected' } as any,
        { command: 'ADD_CONVERSATION_NOTE', conversationId: params.conversation.id, visibility: 'SYSTEM', note: `🔀 Programa cambiado a: ${choice.name}` } as any,
        {
          command: 'SEND_MESSAGE',
          conversationId: params.conversation.id,
          channel: 'WHATSAPP',
          type: 'SESSION_TEXT',
          text: confirmText,
          dedupeKey: `program_selected:${stableHash(`${params.conversation.id}:${choice.id}`).slice(0, 12)}`,
        } as any,
      ],
    } as any,
    transportMode: params.transportMode,
  });

  return { handled: true };
}

async function maybeHandleProgramSelection(params: {
  app: FastifyInstance;
  workspaceId: string;
  conversation: any;
  inboundText: string | null;
  inboundMessageId?: string | null;
  windowStatus: string;
  transportMode: ExecutorTransportMode;
}): Promise<{ handled: boolean; selectedProgramId?: string | null }> {
  if (!params.conversation) return { handled: false };
  if (params.conversation.programId) return { handled: false };

  let programs = await listSelectablePrograms({ workspaceId: params.workspaceId, conversation: params.conversation });
  if (programs.length === 0) return { handled: false };

  // Admin conversations should never show a program menu; default to the "admin" program when present.
  if (params.conversation.isAdmin) {
    const adminProgram = programs.find((p) => normalizeLoose(p.slug) === 'admin');
    if (adminProgram) {
      await prisma.conversation.update({
        where: { id: params.conversation.id },
        data: { programId: adminProgram.id, updatedAt: new Date() },
      });
      params.conversation.programId = adminProgram.id;
      return { handled: false, selectedProgramId: adminProgram.id };
    }
    return { handled: false };
  }

  if (programs.length === 1) {
    await prisma.conversation.update({
      where: { id: params.conversation.id },
      data: { programId: programs[0].id, updatedAt: new Date() },
    });
    params.conversation.programId = programs[0].id;
    return { handled: false, selectedProgramId: programs[0].id };
  }

  const inbound = String(params.inboundText || '').trim();
  const choice = inbound ? resolveProgramChoice(inbound, programs) : null;
  if (choice) {
    await prisma.conversation.update({
      where: { id: params.conversation.id },
      data: { programId: choice.id, updatedAt: new Date() },
    });
    params.conversation.programId = choice.id;
    await prisma.agentRunLog
      .create({
        data: {
          workspaceId: params.workspaceId,
          conversationId: params.conversation.id,
          programId: choice.id,
          phoneLineId: params.conversation.phoneLineId || null,
          eventType: 'PROGRAM_SELECTION',
          status: 'SUCCESS',
          inputContextJson: serializeJson({
            reason: 'program_selected_inline',
            inboundMessageId: params.inboundMessageId || null,
            inboundText: inbound || null,
          }),
          resultsJson: serializeJson({ selected: { id: choice.id, name: choice.name, slug: choice.slug } }),
        },
      })
      .catch(() => {});
    return { handled: false, selectedProgramId: choice.id };
  }

  // If we can't resolve, ask a short menu and stop here.
  await showProgramMenu({
    app: params.app,
    workspaceId: params.workspaceId,
    conversation: params.conversation,
    inboundText: inbound || null,
    inboundMessageId: params.inboundMessageId || null,
    windowStatus: params.windowStatus,
    transportMode: params.transportMode,
    reason: 'programId_missing',
  });
  return { handled: true };
}

type StaffRouterCommand =
  | { type: 'PENDING_COUNTS'; args: {} }
  | { type: 'HELP'; args: {} }
  | { type: 'LIST_DRAFTS'; args: {} }
  | { type: 'SEND_DRAFT'; args: { ref?: string | null } }
  | { type: 'EDIT_DRAFT'; args: { ref?: string | null; text: string } }
  | { type: 'CANCEL_DRAFT'; args: { ref?: string | null } }
  | { type: 'LIST_SLOTS'; args: { dayToken: string } }
  | {
      type: 'LIST_CASES';
      args: { stageSlug?: string; assignedToMe: boolean; limit: number; query?: string; includeSummary?: boolean };
    }
  | { type: 'GET_CASE_SUMMARY'; args: { ref: string } }
  | { type: 'SET_STAGE'; args: { ref: string; stageSlug: string; reason?: string } }
  | { type: 'ADD_NOTE'; args: { ref: string; text: string } }
  | { type: 'SEND_CUSTOMER_MESSAGE'; args: { ref: string; text: string } }
  | { type: 'SCHEDULE_INTERVIEW'; args: { ref: string; dayToken: string; time: string } }
  | { type: 'RESCHEDULE_INTERVIEW'; args: { ref: string; dayToken: string; time: string } }
  | { type: 'CANCEL_INTERVIEW'; args: { ref: string } }
  | { type: 'CONFIRM_INTERVIEW'; args: { ref: string } }
  | {
      type: 'CREATE_CANDIDATE';
      args: {
        phoneE164: string;
        name?: string;
        role?: string;
        channel?: string;
        comuna?: string;
        ciudad?: string;
      };
    }
  | {
      type: 'SEND_TEMPLATE';
      args: {
        ref: string;
        templateName: string;
      };
    }
  | {
      type: 'CREATE_CANDIDATE_AND_TEMPLATE';
      args: {
        phoneE164: string;
        name?: string;
        role?: string;
        channel?: string;
        comuna?: string;
        ciudad?: string;
        templateName: string;
      };
    }
  | {
      type: 'BULK_CONTACTADO';
      args: { refs: string[] };
    }
  | {
      type: 'BULK_MOVE_STAGE';
      args: { stageSlug: string; refs: string[] };
    };

const STAFF_COMMAND_HELP_TEXT = [
  'Comandos:',
  '• pendientes',
  '• listar nuevos N',
  '• buscar <telefono|nombre>',
  '• crear candidato <telefono> | <nombre> | <rol> | <canal> | <comuna>',
  '• mover <telefono|id> a <stage>',
  '• nota <telefono|id> <texto>',
  '• slots mañana',
  '• agendar <telefono|id> mañana HH:MM',
  '• reagendar <telefono|id> mañana HH:MM',
  '• cancelar entrevista <telefono|id>',
  '• confirmar entrevista <telefono|id>',
  '• plantilla <telefono|caseId> <templateName>',
  '• alta <telefono> | <nombre> | <rol> | <canal> | <comuna> | plantilla=<templateName>',
  '• bulk contactado <telefonos separados por espacio/coma>',
  '• bulk mover <stage> <telefonos|ids separados por espacio/coma>',
  '• borradores',
  '• ENVIAR [id] | EDITAR [id]: <texto> | CANCELAR [id]',
  '• ayuda',
].join('\n');

const STAFF_INTERVIEW_LOCATION_LABEL = 'Providencia';
const STAFF_INTERVIEW_EXACT_ADDRESS = 'Av. Salvador 1574, Providencia';
const STAFF_INTERVIEW_SLOT_MINUTES = 20;
const STAFF_INTERVIEW_WINDOW_START_MINUTES = 10 * 60;
const STAFF_INTERVIEW_WINDOW_END_MINUTES = 13 * 60;

const DAY_TOKEN_TO_WEEKDAY: Record<string, number> = {
  lunes: 1,
  martes: 2,
  miercoles: 3,
  miércoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  sábado: 6,
  domingo: 7,
};

function minutesToClock(minutes: number): string {
  const hh = Math.floor(minutes / 60)
    .toString()
    .padStart(2, '0');
  const mm = Math.floor(minutes % 60)
    .toString()
    .padStart(2, '0');
  return `${hh}:${mm}`;
}

function normalizeInterviewTime(raw: string): string | null {
  const trimmed = String(raw || '').trim();
  const m = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function buildStaffInterviewScheduleConfig(baseConfig: any): any {
  const tz = String((baseConfig as any)?.interviewTimezone || 'America/Santiago').trim() || 'America/Santiago';
  const weekly = {
    lunes: [{ start: '10:00', end: '13:00' }],
    martes: [{ start: '10:00', end: '13:00' }],
    miércoles: [{ start: '10:00', end: '13:00' }],
    jueves: [{ start: '10:00', end: '13:00' }],
    viernes: [{ start: '10:00', end: '13:00' }],
    sábado: [{ start: '10:00', end: '13:00' }],
    domingo: [{ start: '10:00', end: '13:00' }],
  };
  const locations = [
    {
      label: STAFF_INTERVIEW_LOCATION_LABEL,
      exactAddress: STAFF_INTERVIEW_EXACT_ADDRESS,
      instructions: 'Comparte dirección exacta solo cuando la entrevista esté confirmada.',
    },
  ];
  return {
    ...baseConfig,
    interviewTimezone: tz,
    interviewSlotMinutes: STAFF_INTERVIEW_SLOT_MINUTES,
    defaultInterviewLocation: STAFF_INTERVIEW_LOCATION_LABEL,
    interviewWeeklyAvailability: JSON.stringify(weekly),
    interviewLocations: JSON.stringify(locations),
  };
}

function normalizeWeekdayLabelEs(value: string): string {
  const low = normalizeLoose(value);
  if (low === 'miercoles') return 'Miércoles';
  if (low === 'sabado') return 'Sábado';
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function resolveDayTokenToWeekdayLabel(dayToken: string, timezone: string): string | null {
  const token = normalizeLoose(dayToken || '');
  const now = DateTime.now().setZone(timezone || 'America/Santiago');
  if (!token || token === 'manana' || token === 'mañana') {
    return normalizeWeekdayLabelEs(now.plus({ days: 1 }).setLocale('es-CL').toFormat('cccc'));
  }
  if (token === 'hoy') {
    return normalizeWeekdayLabelEs(now.setLocale('es-CL').toFormat('cccc'));
  }
  const weekday = DAY_TOKEN_TO_WEEKDAY[token];
  if (!weekday) return null;
  const daysAhead = (weekday - now.weekday + 7) % 7;
  const target = now.plus({ days: daysAhead === 0 ? 7 : daysAhead });
  return normalizeWeekdayLabelEs(target.setLocale('es-CL').toFormat('cccc'));
}

async function computeStaffDaySlots(params: {
  config: any;
  dayLabelEs: string;
  location: string;
}): Promise<{
  slots: Array<{ time: string; startAtIso: string; busy: boolean }>;
}> {
  const slotTimes: string[] = [];
  for (
    let minute = STAFF_INTERVIEW_WINDOW_START_MINUTES;
    minute + STAFF_INTERVIEW_SLOT_MINUTES <= STAFF_INTERVIEW_WINDOW_END_MINUTES;
    minute += STAFF_INTERVIEW_SLOT_MINUTES
  ) {
    slotTimes.push(minutesToClock(minute));
  }

  const resolved: Array<{ time: string; startAt: Date }>= [];
  for (const time of slotTimes) {
    const attempt = resolveInterviewSlotFromDayTime({
      day: params.dayLabelEs,
      time,
      location: params.location,
      config: params.config,
      now: new Date(),
    });
    if (!attempt.ok) continue;
    resolved.push({ time, startAt: attempt.slot.startAt });
  }
  const startAtList = resolved.map((r) => r.startAt);
  const [busyReservations, busyBlocks] = await prisma.$transaction([
    prisma.interviewReservation.findMany({
      where: {
        startAt: { in: startAtList },
        location: params.location,
        activeKey: 'ACTIVE',
      },
      select: { startAt: true },
    }),
    prisma.interviewSlotBlock.findMany({
      where: {
        startAt: { in: startAtList },
        location: params.location,
        archivedAt: null,
      },
      select: { startAt: true },
    }),
  ]);
  const busySet = new Set<string>([
    ...busyReservations.map((r) => new Date(r.startAt).toISOString()),
    ...busyBlocks.map((b) => new Date(b.startAt).toISOString()),
  ]);

  return {
    slots: resolved.map((item) => {
      const iso = item.startAt.toISOString();
      return {
        time: item.time,
        startAtIso: iso,
        busy: busySet.has(iso),
      };
    }),
  };
}

function parseBulkRefs(raw: string): string[] {
  const tokens = String(raw || '')
    .split(/[\s,\n;]+/g)
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const token of tokens) {
    const normalizedPhone = normalizeWhatsAppId(token) || normalizeWhatsAppId(normalizeChilePhoneE164(token) || '');
    const candidate = normalizedPhone || token;
    if (!candidate) continue;
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

async function listPendingHybridDraftsForWorkspace(workspaceId: string): Promise<any[]> {
  return prisma.hybridReplyDraft
    .findMany({
      where: {
        workspaceId,
        status: { in: ['PENDING', 'APPROVED'] },
      },
      include: {
        conversation: {
          include: {
            contact: true,
            phoneLine: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })
    .catch(() => []);
}

async function resolveHybridDraftByRefForStaff(params: {
  workspaceId: string;
  ref: string;
}): Promise<any | null> {
  const ref = String(params.ref || '').trim();
  if (!ref) return null;
  const byId = await prisma.hybridReplyDraft
    .findFirst({
      where: { workspaceId: params.workspaceId, id: ref },
      include: { conversation: { include: { contact: true, phoneLine: true } } },
    })
    .catch(() => null);
  if (byId?.id) return byId;
  const partial = await prisma.hybridReplyDraft
    .findMany({
      where: {
        workspaceId: params.workspaceId,
        id: { startsWith: ref },
      },
      include: { conversation: { include: { contact: true, phoneLine: true } } },
      orderBy: { createdAt: 'desc' },
      take: 2,
    })
    .catch(() => []);
  if (partial.length === 1) return partial[0];
  return null;
}

async function resolveDraftForStaffCommand(params: {
  workspaceId: string;
  ref?: string | null;
}): Promise<{ draft: any | null; listIfAmbiguous: any[] | null }> {
  const ref = String(params.ref || '').trim();
  if (ref) {
    const draft = await resolveHybridDraftByRefForStaff({ workspaceId: params.workspaceId, ref });
    return { draft, listIfAmbiguous: null };
  }
  const drafts = await listPendingHybridDraftsForWorkspace(params.workspaceId);
  if (drafts.length === 1) return { draft: drafts[0], listIfAmbiguous: null };
  if (drafts.length > 1) return { draft: null, listIfAmbiguous: drafts };
  return { draft: null, listIfAmbiguous: null };
}

async function listActiveWorkspaceStageSlugs(workspaceId: string): Promise<string[]> {
  const rows = await listWorkspaceStages({ workspaceId, includeArchived: false }).catch(() => []);
  return rows
    .filter((s: any) => Boolean(s?.isActive) && !s?.archivedAt)
    .map((s: any) => String(s?.slug || '').trim())
    .filter(Boolean);
}

function deriveCommandFromStaffNaturalText(rawText: string): string | null {
  const raw = String(rawText || '').trim();
  if (!raw) return null;
  const normalized = normalizeLoose(raw);

  // "envía la plantilla enviorapido_postulacion_inicio_v1 al 569..."
  const templateNatural =
    raw.match(/\bplantilla\b.*\b([a-zA-Z0-9_.-]+)\b.*\b(56?9\d{8})\b/i) ||
    raw.match(/\b(56?9\d{8})\b.*\bplantilla\b.*\b([a-zA-Z0-9_.-]+)\b/i);
  if (templateNatural) {
    const phone = String(templateNatural[2] || templateNatural[1] || '').trim();
    const templateName = String(templateNatural[1] || templateNatural[2] || '').trim();
    if (phone && templateName && templateName.toLowerCase().includes('enviorapido')) {
      return `plantilla ${phone} ${templateName}`;
    }
  }

  // "muévelo a entrevista pendiente" (último caso)
  const moveLatest = raw.match(/\b(mueve|mover|cambia|cambiar)\b.*\b(entrevista pendiente|screening|new intake|new_intake|qualified|interview pending|interview scheduled|rechazado|no contactar)\b/i);
  if (moveLatest?.[2]) {
    return `mover __latest__ a ${String(moveLatest[2]).trim()}`;
  }

  // "agenda 569... mañana 10:20" / "agenda mañana 10:20 para 569..."
  const scheduleNaturalA = raw.match(
    /\bagenda(?:r)?\b.*\b(56?9\d{8})\b.*\b(hoy|mañana|manana|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)\b.*\b(\d{1,2}:\d{2})\b/i,
  );
  if (scheduleNaturalA?.[1] && scheduleNaturalA?.[2] && scheduleNaturalA?.[3]) {
    return `agendar ${String(scheduleNaturalA[1]).trim()} ${String(scheduleNaturalA[2]).trim()} ${String(scheduleNaturalA[3]).trim()}`;
  }
  const scheduleNaturalB = raw.match(
    /\bagenda(?:r)?\b.*\b(hoy|mañana|manana|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)\b.*\b(\d{1,2}:\d{2})\b.*\b(56?9\d{8})\b/i,
  );
  if (scheduleNaturalB?.[1] && scheduleNaturalB?.[2] && scheduleNaturalB?.[3]) {
    return `agendar ${String(scheduleNaturalB[3]).trim()} ${String(scheduleNaturalB[1]).trim()} ${String(scheduleNaturalB[2]).trim()}`;
  }

  if (/\b(cuantos|cuántos)\b.*\bmensajes\b.*\baprobar\b/.test(normalized)) return 'borradores';
  if (/\b(lista|mostrar|muestrame|muéstrame)\b.*\bborradores\b/.test(normalized)) return 'borradores';
  return null;
}

function parseStaffRouterCommand(inboundText: string): StaffRouterCommand | null {
  const raw = String(inboundText || '').trim();
  if (!raw) return null;
  const normalized = normalizeLoose(raw);

  if (normalized === 'ayuda' || normalized === '/ayuda' || normalized === 'help' || normalized === '/help') {
    return { type: 'HELP', args: {} };
  }
  if (normalized === 'borradores' || normalized === '/borradores' || normalized === 'drafts') {
    return { type: 'LIST_DRAFTS', args: {} };
  }
  const sendDraftMatch = raw.match(/^\s*ENVIA(?:R)?(?:\s+([a-zA-Z0-9_-]{4,32}))?\s*$/i);
  if (sendDraftMatch) {
    return { type: 'SEND_DRAFT', args: { ref: sendDraftMatch?.[1] ? String(sendDraftMatch[1]).trim() : null } };
  }
  const editDraftWithId = raw.match(/^\s*EDITA(?:R)?\s+([a-zA-Z0-9_-]{4,32})\s*:\s*(.+)\s*$/i);
  if (editDraftWithId?.[1] && editDraftWithId?.[2]) {
    return {
      type: 'EDIT_DRAFT',
      args: { ref: String(editDraftWithId[1]).trim(), text: String(editDraftWithId[2]).trim() },
    };
  }
  const editDraftWithoutId = raw.match(/^\s*EDITA(?:R)?\s*:\s*(.+)\s*$/i) || raw.match(/^\s*EDITA(?:R)?\s+(.+)\s*$/i);
  if (editDraftWithoutId?.[1]) {
    return {
      type: 'EDIT_DRAFT',
      args: { ref: null, text: String(editDraftWithoutId[1]).trim() },
    };
  }
  const cancelDraftMatch = raw.match(/^\s*CANCELA(?:R)?(?:\s+([a-zA-Z0-9_-]{4,32}))?\s*$/i);
  if (cancelDraftMatch) {
    return { type: 'CANCEL_DRAFT', args: { ref: cancelDraftMatch?.[1] ? String(cancelDraftMatch[1]).trim() : null } };
  }

  if (normalized === 'pendientes' || normalized === '/pendientes' || normalized === 'mis pendientes') {
    return { type: 'PENDING_COUNTS', args: {} };
  }
  const slotsMatch = raw.match(/^\s*slots(?:\s+(.+))?\s*$/i);
  if (slotsMatch) {
    const dayToken = String(slotsMatch[1] || 'mañana').trim() || 'mañana';
    return { type: 'LIST_SLOTS', args: { dayToken } };
  }

  if (
    /\b(casos?|clientes?|postulantes?)\s+nuev/.test(normalized) ||
    /\blista(r)?\s+(de\s+)?(casos?|clientes?|postulantes?)\b/.test(normalized) ||
    /\b(que|cuales|cuáles)\s+(son\s+)?(los\s+)?(casos?|clientes?|postulantes?)\s+nuev/.test(normalized) ||
    /\bque\s+tengo\s+pendiente/.test(normalized) ||
    /\bque\s+me\s+llego\s+hoy/.test(normalized) ||
    normalized === 'nuevos' ||
    normalized === 'mis casos'
  ) {
    return { type: 'LIST_CASES', args: { stageSlug: 'NEW_INTAKE', assignedToMe: false, limit: 10 } };
  }
  const listarNuevosMatch = raw.match(/^\s*listar\s+nuevos(?:\s+(\d{1,2}))?\s*$/i);
  if (listarNuevosMatch) {
    const limit = Number(listarNuevosMatch[1] || 10);
    return {
      type: 'LIST_CASES',
      args: { stageSlug: 'NEW_INTAKE', assignedToMe: false, limit: Number.isFinite(limit) ? Math.min(30, Math.max(1, limit)) : 10 },
    };
  }
  if (
    /\b(resumen|detalle)\b.*\b(ultimo|último)\b.*\b(postulante|caso|cliente)\b/.test(normalized) ||
    /\b(ultimo|último)\b.*\b(postulante|caso|cliente)\b.*\b(resumen|detalle)\b/.test(normalized)
  ) {
    return { type: 'GET_CASE_SUMMARY', args: { ref: '__latest__' } };
  }
  if (/\b(dame|darme|muestrame|muéstrame)\s+resumen(\s+de\s+(los\s+)?(casos?|postulantes?))?/.test(normalized)) {
    return { type: 'LIST_CASES', args: { assignedToMe: false, limit: 5, includeSummary: true } };
  }
  const createMatch = raw.match(/^\s*crear\s+candidato\s+(.+)\s*$/i);
  if (createMatch?.[1]) {
    const parts = createMatch[1]
      .split('|')
      .map((p) => p.trim())
      .filter(Boolean);
    const phoneE164 = String(parts[0] || '').trim();
    if (phoneE164) {
      return {
        type: 'CREATE_CANDIDATE',
        args: {
          phoneE164,
          name: String(parts[1] || '').trim() || undefined,
          role: String(parts[2] || '').trim() || undefined,
          channel: String(parts[3] || '').trim() || undefined,
          comuna: String(parts[4] || '').trim() || undefined,
          ciudad: String(parts[5] || '').trim() || undefined,
        },
      };
    }
  }
  const altaMatch = raw.match(/^\s*alta\s+(.+)\s*$/i);
  if (altaMatch?.[1]) {
    const parts = altaMatch[1]
      .split('|')
      .map((p) => p.trim())
      .filter(Boolean);
    const phoneE164 = String(parts[0] || '').trim();
    if (phoneE164) {
      const templatePart = parts.find((p) => /^plantilla\s*=\s*/i.test(p));
      const templateName = templatePart ? String(templatePart.replace(/^plantilla\s*=\s*/i, '') || '').trim() : '';
      if (templateName) {
        return {
          type: 'CREATE_CANDIDATE_AND_TEMPLATE',
          args: {
            phoneE164,
            name: String(parts[1] || '').trim() || undefined,
            role: String(parts[2] || '').trim() || undefined,
            channel: String(parts[3] || '').trim() || undefined,
            comuna: String(parts[4] || '').trim() || undefined,
            ciudad: String(parts[5] || '').trim() || undefined,
            templateName,
          },
        };
      }
    }
  }
  const buscarMatch = raw.match(/^\s*buscar\s+(.+)\s*$/i);
  if (buscarMatch?.[1]) {
    return { type: 'LIST_CASES', args: { assignedToMe: false, limit: 10, query: buscarMatch[1].trim() } };
  }
  const bulkContactadoMatch = raw.match(/^\s*bulk\s+contactad[oa]\s+(.+)\s*$/i);
  if (bulkContactadoMatch?.[1]) {
    const refs = parseBulkRefs(bulkContactadoMatch[1]);
    if (refs.length > 0) return { type: 'BULK_CONTACTADO', args: { refs } };
  }
  const bulkMoverMatch = raw.match(/^\s*bulk\s+mover\s+([A-Za-z0-9 _-]+?)\s+(.+)\s*$/i);
  if (bulkMoverMatch?.[1] && bulkMoverMatch?.[2]) {
    const stageSlug = normalizeStageCandidate(bulkMoverMatch[1]);
    const refs = parseBulkRefs(bulkMoverMatch[2]);
    if (stageSlug && refs.length > 0) return { type: 'BULK_MOVE_STAGE', args: { stageSlug, refs } };
  }
  const templateMatch = raw.match(/^\s*plantilla\s+(.+?)\s+([a-zA-Z0-9_\-.]+)\s*$/i);
  if (templateMatch?.[1] && templateMatch?.[2]) {
    return {
      type: 'SEND_TEMPLATE',
      args: { ref: String(templateMatch[1] || '').trim(), templateName: String(templateMatch[2] || '').trim() },
    };
  }
  const resumenMatch = raw.match(/^\s*resumen\s+(.+)\s*$/i);
  if (resumenMatch?.[1]) {
    return { type: 'GET_CASE_SUMMARY', args: { ref: resumenMatch[1].trim() } };
  }
  const stageMatch = raw.match(/^\s*(?:cambiar\s+estado|mover)\s+(.+?)\s+a\s+(.+?)\s*$/i);
  if (stageMatch?.[1] && stageMatch?.[2]) {
    const stageCandidate = normalizeStageCandidate(stageMatch[2]);
    if (!stageCandidate) return null;
    return {
      type: 'SET_STAGE',
      args: {
        ref: stageMatch[1].trim(),
        stageSlug: stageCandidate,
        reason: 'staff_command_router',
      },
    };
  }
  const noteMatch = raw.match(/^\s*nota\s+(.+?)\s+(.+)\s*$/i);
  if (noteMatch?.[1] && noteMatch?.[2]) {
    return {
      type: 'ADD_NOTE',
      args: { ref: noteMatch[1].trim(), text: noteMatch[2].trim() },
    };
  }
  const sendMatch = raw.match(/^\s*enviar\s+msg\s+(.+?)\s+(.+)\s*$/i);
  if (sendMatch?.[1] && sendMatch?.[2]) {
    return {
      type: 'SEND_CUSTOMER_MESSAGE',
      args: { ref: sendMatch[1].trim(), text: sendMatch[2].trim() },
    };
  }
  const agendarMatch = raw.match(/^\s*agendar\s+(.+?)\s+(.+?)\s+(\d{1,2}:\d{2})\s*$/i);
  if (agendarMatch?.[1] && agendarMatch?.[2] && agendarMatch?.[3]) {
    const normalizedTime = normalizeInterviewTime(agendarMatch[3]);
    if (normalizedTime) {
      return {
        type: 'SCHEDULE_INTERVIEW',
        args: { ref: agendarMatch[1].trim(), dayToken: agendarMatch[2].trim(), time: normalizedTime },
      };
    }
  }
  const reagendarMatch = raw.match(/^\s*reagendar\s+(.+?)\s+(.+?)\s+(\d{1,2}:\d{2})\s*$/i);
  if (reagendarMatch?.[1] && reagendarMatch?.[2] && reagendarMatch?.[3]) {
    const normalizedTime = normalizeInterviewTime(reagendarMatch[3]);
    if (normalizedTime) {
      return {
        type: 'RESCHEDULE_INTERVIEW',
        args: { ref: reagendarMatch[1].trim(), dayToken: reagendarMatch[2].trim(), time: normalizedTime },
      };
    }
  }
  const cancelInterviewMatch = raw.match(/^\s*cancelar\s+entrevista\s+(.+)\s*$/i);
  if (cancelInterviewMatch?.[1]) {
    return {
      type: 'CANCEL_INTERVIEW',
      args: { ref: cancelInterviewMatch[1].trim() },
    };
  }
  const confirmInterviewMatch = raw.match(/^\s*confirmar\s+entrevista\s+(.+)\s*$/i);
  if (confirmInterviewMatch?.[1]) {
    return {
      type: 'CONFIRM_INTERVIEW',
      args: { ref: confirmInterviewMatch[1].trim() },
    };
  }

  return null;
}

function classifyCandidateBucket(stageRaw: string, statusRaw: string): 'NUEVO' | 'CONTACTADO' | 'CITADO' | 'DESCARTADO' {
  const stage = String(stageRaw || '').toUpperCase();
  const status = String(statusRaw || '').toUpperCase();
  if (
    status === 'CLOSED' ||
    ['REJECTED', 'NO_CONTACTAR', 'DISQUALIFIED', 'ARCHIVED', 'CERRADO'].includes(stage)
  ) {
    return 'DESCARTADO';
  }
  if (['INTERVIEW_PENDING', 'INTERVIEW_SCHEDULED', 'INTERVIEWED', 'AGENDADO', 'CONFIRMADO'].includes(stage)) {
    return 'CITADO';
  }
  if (status === 'OPEN' || ['SCREENING', 'INFO', 'CALIFICADO', 'QUALIFIED', 'EN_COORDINACION', 'INTERESADO'].includes(stage)) {
    return 'CONTACTADO';
  }
  return 'NUEVO';
}

async function resolveConversationByRefForStaff(params: {
  workspaceId: string;
  ref: string;
}): Promise<{ id: string; contactId: string; phoneLineId: string | null } | null> {
  const rawRef = String(params.ref || '').trim();
  if (!rawRef) return null;

  const directId = await prisma.conversation.findFirst({
    where: {
      workspaceId: params.workspaceId,
      archivedAt: null,
      isAdmin: false,
      OR: [{ id: rawRef }, { id: { startsWith: rawRef } }],
    } as any,
    select: { id: true, contactId: true, phoneLineId: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (directId?.id) return directId;

  const normalizedPhone = normalizeWhatsAppId(rawRef) || normalizeWhatsAppId(normalizeChilePhoneE164(rawRef) || '');
  if (normalizedPhone) {
    const byPhone = await prisma.conversation.findFirst({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        isAdmin: false,
        contact: {
          OR: [{ waId: normalizedPhone }, { phone: normalizedPhone }],
        },
      } as any,
      select: { id: true, contactId: true, phoneLineId: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (byPhone?.id) return byPhone;
  }

  const byName = await prisma.conversation.findMany({
    where: {
      workspaceId: params.workspaceId,
      archivedAt: null,
      isAdmin: false,
      contact: {},
    } as any,
    select: {
      id: true,
      contactId: true,
      phoneLineId: true,
      updatedAt: true,
      contact: {
        select: {
          candidateNameManual: true,
          candidateName: true,
          displayName: true,
          name: true,
        },
      },
    },
    take: 100,
    orderBy: { updatedAt: 'desc' },
  });
  const needle = normalizeLoose(rawRef);
  const ranked = byName
    .map((row) => {
      const label = normalizeLoose(
        String(
          row?.contact?.candidateNameManual ||
            row?.contact?.candidateName ||
            row?.contact?.displayName ||
            row?.contact?.name ||
            '',
        ),
      );
      const score = !needle
        ? 0
        : label === needle
          ? 3
          : label.startsWith(needle)
            ? 2
            : label.includes(needle)
              ? 1
              : 0;
      return { row, score };
    })
    .filter((it) => it.score > 0)
    .sort((a, b) => b.score - a.score || new Date((b.row as any).updatedAt).getTime() - new Date((a.row as any).updatedAt).getTime());
  const best = ranked[0]?.row as any;
  if (best?.id) return { id: best.id, contactId: best.contactId, phoneLineId: best.phoneLineId || null };
  return null;
}

async function listWorkspaceTemplatesForStaff(workspaceId: string): Promise<{
  entries: Array<{
    name: string;
    category: string | null;
    language: string | null;
    status: string | null;
    source: string;
    variableCount: number;
  }>;
  namesLower: Set<string>;
}> {
  const catalog = await listWorkspaceTemplateCatalog(workspaceId).catch(() => null);
  const entries = Array.isArray(catalog?.templates)
    ? catalog.templates.map((t) => ({
        name: String(t?.name || '').trim(),
        category: t?.category ? String(t.category) : null,
        language: t?.language ? String(t.language) : null,
        status: t?.status ? String(t.status) : null,
        source: String(t?.source || ''),
        variableCount: Number.isFinite(Number((t as any)?.variableCount)) ? Number((t as any).variableCount) : 0,
      }))
    : [];
  const namesLower = new Set(entries.map((e) => e.name.toLowerCase()).filter(Boolean));
  return { entries, namesLower };
}

function shortTemplateList(entries: Array<{ name: string; category: string | null; language: string | null; status: string | null }>): string {
  if (!entries.length) return 'No hay plantillas disponibles en catálogo.';
  const top = entries.slice(0, 12).map((t) => {
    const bits = [t.category, t.language, t.status].filter(Boolean).join(' · ');
    return `• ${t.name}${bits ? ` (${bits})` : ''}`;
  });
  return `Plantillas disponibles:\n${top.join('\n')}`;
}

async function createSystemConversationNote(conversationId: string, text: string, extra?: any): Promise<void> {
  await prisma.message
    .create({
      data: {
        conversationId,
        direction: 'OUTBOUND',
        text,
        rawPayload: serializeJson({ system: true, ...(extra || {}) }),
        timestamp: new Date(),
        read: true,
      },
    })
    .catch(() => {});
}

async function applyTemplateAutoStatus(params: {
  workspaceId: string;
  conversationId: string;
  templateName: string;
}): Promise<{ updatedStage?: string | null; updatedStatus?: string | null; candidateBucket?: string | null }> {
  const template = String(params.templateName || '').trim().toLowerCase();
  if (!template) return {};
  const conversation = await prisma.conversation.findFirst({
    where: { id: params.conversationId, workspaceId: params.workspaceId },
    include: { contact: true },
  });
  if (!conversation?.id) return {};
  const now = new Date();
  const updates: any = { updatedAt: now };
  let noteText = '';
  if (template === 'enviorapido_postulacion_inicio_v1') {
    const derived = deriveCandidateStatusFromConversation(conversation);
    if (derived.candidateStatus === 'NUEVO') {
      updates.status = 'OPEN';
      if (String(conversation.conversationStage || '').toUpperCase() === 'NEW_INTAKE') {
        updates.conversationStage = 'SCREENING';
        updates.stageChangedAt = now;
        updates.stageReason = 'template_inicio_enviada';
      }
    }
    noteText = `📨 Plantilla inicio enviada (${now.toLocaleString('es-CL')}).`;
  } else if (template === 'enviorapido_confirma_entrevista_v1') {
    updates.status = 'OPEN';
    updates.conversationStage = 'INTERVIEW_SCHEDULED';
    updates.stageChangedAt = now;
    updates.stageReason = 'template_confirmacion_entrevista';
    noteText = `📨 Plantilla confirmación entrevista enviada (${now.toLocaleString('es-CL')}).`;
  } else {
    noteText = `📨 Plantilla ${template} enviada (${now.toLocaleString('es-CL')}).`;
  }

  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: updates,
  });
  await createSystemConversationNote(conversation.id, noteText, {
    source: 'staff_template_manual',
    templateName: template,
  });
  const derivedNow = deriveCandidateStatusFromConversation(updated);
  return {
    updatedStage: String((updated as any)?.conversationStage || ''),
    updatedStatus: String(updated?.status || ''),
    candidateBucket: derivedNow.candidateStatus,
  };
}

function formatStaffError(ref: string, reason: string): string {
  const r = String(ref || '').trim() || stableHash(`${Date.now()}:${Math.random()}`).slice(0, 8);
  const clean = String(reason || 'Error desconocido').replace(/\s+/g, ' ').trim();
  return `No pude completar la acción (ref ${r}): ${clean}`;
}

function buildStaffRouterReply(command: StaffRouterCommand, toolExecResult: any): string {
  const toolResult = toolExecResult?.details?.result || null;
  const toolError = toolExecResult?.details?.error || null;
  if (command.type === 'HELP') return STAFF_COMMAND_HELP_TEXT;
  if (command.type === 'LIST_DRAFTS') {
    const drafts = Array.isArray(toolResult?.drafts) ? toolResult.drafts : [];
    if (drafts.length === 0) return `No hay borradores pendientes.\n\n${STAFF_COMMAND_HELP_TEXT}`;
    const lines = drafts.slice(0, 10).map((d: any) => {
      const idShort = String(d?.id || '').slice(0, 8);
      const who = String(d?.candidate || d?.waId || 'Candidato');
      const wa = String(d?.waId || '').trim();
      return `• ${idShort} · ${who}${wa ? ` (+${wa})` : ''}`;
    });
    return [`Borradores pendientes (${drafts.length}):`, ...lines, '', 'Comando: ENVIAR <id> | EDITAR <id>: ... | CANCELAR <id>'].join('\n');
  }
  if (command.type === 'SEND_DRAFT') {
    const result = toolResult?.details?.result || {};
    if (toolResult?.details?.errorCode === 'DRAFT_AMBIGUOUS') {
      const drafts = Array.isArray(result?.drafts) ? result.drafts : [];
      const lines = drafts.slice(0, 10).map((d: any) => {
        const idShort = String(d?.id || '').slice(0, 8);
        const who = String(d?.candidate || d?.waId || 'Candidato');
        const wa = String(d?.waId || '').trim();
        return `• ${idShort} · ${who}${wa ? ` (+${wa})` : ''}`;
      });
      return [`Hay más de un borrador pendiente (${drafts.length}).`, ...lines, '', 'Indica el id corto: ENVIAR <id>.'].join('\n');
    }
    if (!toolResult?.ok) return 'No pude enviar ese borrador. Revisa el id y vuelve a intentar.';
    return `✅ Enviado borrador ${String(result?.draftId || '').slice(0, 8)} al candidato +${String(result?.waId || '').trim()}.`;
  }
  if (command.type === 'EDIT_DRAFT') {
    const result = toolResult?.details?.result || {};
    if (toolResult?.details?.errorCode === 'DRAFT_AMBIGUOUS') {
      const drafts = Array.isArray(result?.drafts) ? result.drafts : [];
      const lines = drafts.slice(0, 10).map((d: any) => {
        const idShort = String(d?.id || '').slice(0, 8);
        const who = String(d?.candidate || d?.waId || 'Candidato');
        const wa = String(d?.waId || '').trim();
        return `• ${idShort} · ${who}${wa ? ` (+${wa})` : ''}`;
      });
      return [`Hay más de un borrador pendiente (${drafts.length}).`, ...lines, '', 'Indica el id corto: EDITAR <id>: <texto>.'].join('\n');
    }
    if (!toolResult?.ok) return 'No pude editar ese borrador. Revisa el id y vuelve a intentar.';
    return `✏️ Editado borrador ${String(result?.draftId || '').slice(0, 8)}. ¿Lo envío?`;
  }
  if (command.type === 'CANCEL_DRAFT') {
    const result = toolResult?.details?.result || {};
    if (toolResult?.details?.errorCode === 'DRAFT_AMBIGUOUS') {
      const drafts = Array.isArray(result?.drafts) ? result.drafts : [];
      const lines = drafts.slice(0, 10).map((d: any) => {
        const idShort = String(d?.id || '').slice(0, 8);
        const who = String(d?.candidate || d?.waId || 'Candidato');
        const wa = String(d?.waId || '').trim();
        return `• ${idShort} · ${who}${wa ? ` (+${wa})` : ''}`;
      });
      return [`Hay más de un borrador pendiente (${drafts.length}).`, ...lines, '', 'Indica el id corto: CANCELAR <id>.'].join('\n');
    }
    if (!toolResult?.ok) return 'No pude cancelar ese borrador. Revisa el id y vuelve a intentar.';
    return `🗑️ Cancelado borrador ${String(result?.draftId || '').slice(0, 8)}.`;
  }
  if (toolError) {
    if (command.type === 'SET_STAGE' && /stages? validos|stages? válidos|stageSlug desconocido/i.test(String(toolError))) {
      return `No pude mover el caso porque ese stage no existe. ${String(toolError).replace(/^.*?(\| stages? válidos?:?\s*)/i, 'Stages válidos: ')}`;
    }
    if (command.type === 'CREATE_CANDIDATE') {
      return `No pude crear/actualizar ese candidato (${toolError}). Revisa el formato: crear candidato <telefono> | <nombre> | <rol> | <canal> | <comuna>.`;
    }
    if (command.type === 'SEND_TEMPLATE') {
      return `No pude enviar la plantilla (${toolError}). Revisa template/caso y vuelve a intentar.`;
    }
    if (command.type === 'CREATE_CANDIDATE_AND_TEMPLATE') {
      return `No pude completar el alta con plantilla (${toolError}). Revisa formato: alta <telefono> | <nombre> | <rol> | <canal> | <comuna> | plantilla=<templateName>.`;
    }
    if (command.type === 'BULK_CONTACTADO') {
      return `No pude ejecutar el bulk (${toolError}).`;
    }
    if (command.type === 'LIST_SLOTS' || command.type === 'SCHEDULE_INTERVIEW' || command.type === 'RESCHEDULE_INTERVIEW') {
      return `No pude revisar la agenda (${toolError}). Intenta de nuevo con "slots mañana" o ajusta el horario.`;
    }
    if (command.type === 'CANCEL_INTERVIEW' || command.type === 'CONFIRM_INTERVIEW') {
      return `No pude actualizar la entrevista (${toolError}).`;
    }
    return `No pude consultar eso ahora (${toolError}). Intenta de nuevo en unos segundos y lo revisamos.`;
  }
  if (command.type === 'PENDING_COUNTS') {
    const counts = toolResult?.counts || {};
    const nuevo = Number(counts?.NUEVO || 0);
    const contactado = Number(counts?.CONTACTADO || 0);
    const citado = Number(counts?.CITADO || 0);
    const descartado = Number(counts?.DESCARTADO || 0);
    const total = Number(counts?.TOTAL || nuevo + contactado + citado + descartado);
    return [
      `Pendientes del workspace:`,
      `• Nuevo: ${nuevo}`,
      `• Contactado: ${contactado}`,
      `• Citado: ${citado}`,
      `• Descartado: ${descartado}`,
      `• Total: ${total}`,
    ].join('\n');
  }
  if (command.type === 'LIST_SLOTS') {
    const slots = Array.isArray(toolResult?.slots) ? toolResult.slots : [];
    const day = String(toolResult?.day || '').trim();
    const location = String(toolResult?.location || STAFF_INTERVIEW_LOCATION_LABEL).trim();
    if (slots.length === 0) {
      return `No encontré disponibilidad para ${day || 'ese día'} en ${location}. Prueba con "slots hoy" o "slots mañana".`;
    }
    const available = slots.filter((s: any) => !Boolean(s?.busy)).map((s: any) => String(s?.time || '').trim()).filter(Boolean);
    const busy = slots.filter((s: any) => Boolean(s?.busy)).map((s: any) => String(s?.time || '').trim()).filter(Boolean);
    const lines: string[] = [];
    lines.push(`Disponibilidad ${day || ''} (${location}, 20 min):`);
    lines.push(available.length > 0 ? `• Libres: ${available.join(', ')}` : '• Libres: sin cupos');
    if (busy.length > 0) lines.push(`• Ocupados: ${busy.join(', ')}`);
    lines.push('Comando: agendar <telefono|id> mañana HH:MM');
    return lines.join('\n');
  }
  if (command.type === 'LIST_CASES') {
    const cases = Array.isArray(toolResult?.cases) ? toolResult.cases : [];
    if (cases.length === 0) {
      return command.args.stageSlug
        ? 'No veo casos nuevos en etapas iniciales ahora. Si quieres, reviso los últimos 5 sin filtro o busco por nombre/comuna/id.'
        : 'No veo casos para ese filtro ahora. Si quieres, te busco por nombre/comuna/id o te muestro los últimos 5.';
    }
    if (command.args.includeSummary) {
      const lines = cases.slice(0, 5).map((c: any) => {
        const idShort = String(c?.id || '').slice(0, 8);
        const name = repairMojibake(c?.contactDisplay || 'Caso');
        const wa = String(c?.contactWaId || c?.contactPhone || '').trim();
        const stage = String(c?.stage || '—');
        const status = String(c?.status || '—');
        return `• ${name}${wa ? ` (+${wa})` : ''} (${stage}/${status}) · ID ${idShort}`;
      });
      return `Resumen rápido de casos recientes:\n${lines.join('\n')}\nSi quieres detalle de uno: "resumen <id>".`;
    }
    const lines = cases.slice(0, 10).map((c: any) => {
      const idShort = String(c?.id || '').slice(0, 8);
      const name = repairMojibake(c?.contactDisplay || 'Caso');
      const wa = String(c?.contactWaId || c?.contactPhone || '').trim();
      const stage = String(c?.stage || '—');
      const statusLabel = mapCandidateStatus(stage, String(c?.status || 'NEW'));
      return `• ${name}${wa ? ` (+${wa})` : ''} · ${statusLabel} · ${stage} · ${idShort}`;
    });
    return `Te dejo los más recientes (${Math.min(cases.length, 10)}):\n${lines.join('\n')}`;
  }
  if (command.type === 'GET_CASE_SUMMARY') {
    const c = toolResult?.case;
    if (!c) return 'No encontré ese caso. Pásame el ID (o prefijo) y lo reviso.';
    const name = repairMojibake(c?.contact?.displayName || 'Caso');
    const stage = String(c?.stage || '—');
    const location = [c?.contact?.comuna, c?.contact?.ciudad, c?.contact?.region].filter(Boolean).join(' · ');
    const availability = String(c?.contact?.availabilityText || '').trim();
    const lastInbound = Array.isArray(c?.lastMessages)
      ? [...c.lastMessages]
          .reverse()
          .find((m: any) => String(m?.direction || '').toUpperCase() === 'INBOUND' && String(m?.text || '').trim())
      : null;
    const lastInboundText = String(lastInbound?.text || '').trim();
    const nextStep = (() => {
      const normalizedStage = String(stage || '').toUpperCase();
      if (['NEW_INTAKE', 'SCREENING', 'INFO', 'NUEVO'].includes(normalizedStage)) return 'seguir levantando datos mínimos';
      if (['QUALIFIED', 'INTERVIEW_PENDING', 'EN_COORDINACION', 'INTERESADO'].includes(normalizedStage))
        return 'coordinar entrevista con horario exacto';
      if (['INTERVIEW_SCHEDULED', 'AGENDADO', 'CONFIRMED'].includes(normalizedStage))
        return 'confirmar asistencia y enviar recordatorio';
      if (['NO_CONTACTAR', 'REJECTED', 'CERRADO'].includes(normalizedStage)) return 'no contactar (caso cerrado)';
      return 'revisar y definir siguiente acción';
    })();
    const idShort = String(c?.id || '').slice(0, 8);
    return [
      `Resumen del último postulante (${idShort}):`,
      `• Nombre: ${name}`,
      `• Estado: ${stage}`,
      location ? `• Ubicación: ${location}` : null,
      availability ? `• Disponibilidad: ${availability}` : null,
      lastInboundText ? `• Último mensaje candidato: ${lastInboundText}` : null,
      `• Siguiente paso sugerido: ${nextStep}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (command.type === 'SET_STAGE') {
    const stage = String(toolResult?.stage || command.args.stageSlug || '').trim();
    return stage ? `Listo, ya dejé el caso en ${stage}.` : 'Listo, ya actualicé el estado del caso.';
  }
  if (command.type === 'ADD_NOTE') {
    const ok = Boolean(toolResult?.ok ?? true);
    return ok ? 'Listo, agregué la nota al caso.' : 'No pude guardar la nota ahora. ¿Lo intentamos de nuevo?';
  }
  if (command.type === 'SEND_CUSTOMER_MESSAGE') {
    if (toolExecResult?.blocked) {
      const reason = String(toolExecResult?.blockedReason || 'BLOCKED');
      return `No pude enviar el mensaje al candidato (bloqueado: ${reason}). Si quieres, veo contigo el motivo en Logs.`;
    }
    const ok = Boolean(toolResult?.sendResult?.success ?? true);
    if (ok) return 'Listo, mensaje enviado al candidato.';
    return `No pude enviar el mensaje (${String(toolResult?.sendResult?.error || 'error desconocido')}).`;
  }
  if (command.type === 'SCHEDULE_INTERVIEW' || command.type === 'RESCHEDULE_INTERVIEW') {
    const ok = Boolean(toolResult?.ok);
    if (!ok) {
      const msg = String(toolResult?.message || toolError || 'No se pudo agendar');
      const alternatives = Array.isArray(toolResult?.alternatives) ? toolResult.alternatives : [];
      const altText =
        alternatives.length > 0
          ? `\nOpciones sugeridas:\n${alternatives
              .map((a: any) => `- ${String(a?.day || '').trim()} ${String(a?.time || '').trim()} (${String(a?.location || STAFF_INTERVIEW_LOCATION_LABEL).trim()})`)
              .join('\n')}`
          : '';
      return `${msg}${altText}`;
    }
    const slot = toolResult?.slot || {};
    const action = command.type === 'RESCHEDULE_INTERVIEW' ? 'reagendada' : 'agendada';
    return `Listo, entrevista ${action} en HOLD para ${String(slot.day || '').trim()} ${String(slot.time || '').trim()} (${String(slot.location || STAFF_INTERVIEW_LOCATION_LABEL).trim()}).\nSiguiente paso: "confirmar entrevista ${String(toolResult?.refHint || '').trim() || '<id>'}" para enviar plantilla.`;
  }
  if (command.type === 'CANCEL_INTERVIEW') {
    if (Boolean(toolResult?.released)) return 'Listo, entrevista cancelada y liberé el cupo en Agenda.';
    return 'No había una entrevista activa para cancelar en ese caso.';
  }
  if (command.type === 'CONFIRM_INTERVIEW') {
    const templateSent = Boolean(toolResult?.templateSent);
    if (templateSent) {
      return `Listo, entrevista confirmada y plantilla enviada (${String(toolResult?.templateName || 'enviorapido_confirma_entrevista_v1')}).`;
    }
    return `Entrevista confirmada, pero no pude enviar la plantilla (${String(toolResult?.templateError || 'error desconocido')}).`;
  }
  if (command.type === 'CREATE_CANDIDATE') {
    const created = Boolean(toolResult?.createdConversation || toolResult?.createdContact);
    const phone = String(toolResult?.phoneE164 || command.args.phoneE164 || '').trim();
    const conversationId = String(toolResult?.conversationId || '').trim();
    const idShort = conversationId ? conversationId.slice(0, 8) : '';
    return created
      ? `Listo, candidato registrado para ${phone}${idShort ? ` (caso ${idShort})` : ''}.`
      : `Listo, actualicé el candidato ${phone}${idShort ? ` y quedó vinculado al caso ${idShort}` : ''}.`;
  }
  if (command.type === 'SEND_TEMPLATE') {
    const ok = Boolean(toolResult?.success);
    if (!ok) return `No pude enviar la plantilla.`;
    const phone = String(toolResult?.phoneE164 || '').trim();
    const caseShort = String(toolResult?.conversationId || '').slice(0, 8);
    const templateName = String(toolResult?.templateName || command.args.templateName || '').trim();
    return `Listo, enviada plantilla ${templateName} a +${phone}${caseShort ? ` (case ${caseShort})` : ''}.`;
  }
  if (command.type === 'CREATE_CANDIDATE_AND_TEMPLATE') {
    const phone = String(toolResult?.phoneE164 || '').trim();
    const caseShort = String(toolResult?.conversationId || '').slice(0, 8);
    const templateName = String(toolResult?.templateName || command.args.templateName || '').trim();
    return `Listo, alta completada para +${phone}${caseShort ? ` (case ${caseShort})` : ''} y plantilla ${templateName} enviada.`;
  }
  if (command.type === 'BULK_CONTACTADO') {
    const updated = Number(toolResult?.updated || 0);
    const unchanged = Number(toolResult?.unchanged || 0);
    const notFound = Number(toolResult?.notFound || 0);
    return [
      'Bulk CONTACTADO completado:',
      `• Actualizados (NUEVO -> CONTACTADO): ${updated}`,
      `• Sin cambio (ya CONTACTADO/CITADO/DESCARTADO): ${unchanged}`,
      `• No encontrados: ${notFound}`,
    ].join('\n');
  }
  if (command.type === 'BULK_MOVE_STAGE') {
    const updated = Number(toolResult?.updated || 0);
    const unchanged = Number(toolResult?.unchanged || 0);
    const notFound = Number(toolResult?.notFound || 0);
    const stage = String(toolResult?.stageSlug || command.args.stageSlug || '').trim();
    return [
      `Bulk mover a ${stage} completado:`,
      `• Actualizados: ${updated}`,
      `• Sin cambio: ${unchanged}`,
      `• No encontrados: ${notFound}`,
    ].join('\n');
  }
  return 'Listo.';
}

async function maybeHandleStaffDeterministicRouter(params: {
  app: FastifyInstance;
  workspaceId: string;
  conversation: any;
  inboundText: string | null;
  inboundMessageId?: string | null;
  transportMode: ExecutorTransportMode;
}): Promise<{ handled: boolean }> {
  const kind = String((params.conversation as any)?.conversationKind || '').toUpperCase();
  if (kind !== 'STAFF') return { handled: false };
  if (params.conversation?.isAdmin) return { handled: false };

  const inbound = String(params.inboundText || '').trim();
  if (!inbound) return { handled: false };
  const canonicalFromNatural = deriveCommandFromStaffNaturalText(inbound);
  const command = parseStaffRouterCommand(canonicalFromNatural || inbound);
  if (!command) {
    const helpRun = await prisma.agentRunLog.create({
      data: {
        workspaceId: params.workspaceId,
        conversationId: params.conversation.id,
        programId: params.conversation.programId || null,
        phoneLineId: params.conversation.phoneLineId || null,
        eventType: 'STAFF_COMMAND_ROUTER_HELP',
        status: 'RUNNING',
        inputContextJson: serializeJson({
          inboundMessageId: params.inboundMessageId || null,
          inboundText: inbound,
          deterministic: true,
          reason: 'unrecognized_command',
        }),
      },
    });
    await executeAgentResponse({
      app: params.app,
      workspaceId: params.workspaceId,
      agentRunId: helpRun.id,
      response: {
        agent: 'staff_command_router',
        version: 1,
        commands: [
          {
            command: 'SEND_MESSAGE',
            conversationId: params.conversation.id,
            channel: 'WHATSAPP',
            type: 'SESSION_TEXT',
            text: STAFF_COMMAND_HELP_TEXT,
            dedupeKey: `staff_help:${stableHash(`${params.conversation.id}:${params.inboundMessageId || inbound}:${Date.now()}`).slice(0, 16)}`,
          } as any,
        ],
      } as any,
      transportMode: params.transportMode,
    });
    await prisma.agentRunLog.update({
      where: { id: helpRun.id },
      data: {
        status: 'SUCCESS',
        resultsJson: serializeJson({ help: true }),
      },
    }).catch(() => {});
    return { handled: true };
  }

  try {
    const runCommand =
      command.type === 'HELP'
          ? ({ command: 'HELP' } as any)
          : command.type === 'LIST_DRAFTS'
            ? ({ command: 'LIST_DRAFTS' } as any)
            : command.type === 'SEND_DRAFT'
              ? ({ command: 'SEND_DRAFT', ...(command.args as any) } as any)
              : command.type === 'EDIT_DRAFT'
                ? ({ command: 'EDIT_DRAFT', ...(command.args as any) } as any)
                : command.type === 'CANCEL_DRAFT'
                  ? ({ command: 'CANCEL_DRAFT', ...(command.args as any) } as any)
            : command.type === 'LIST_SLOTS'
              ? ({ command: 'LIST_SLOTS', ...(command.args as any) } as any)
              : command.type === 'SCHEDULE_INTERVIEW'
                ? ({ command: 'SCHEDULE_INTERVIEW', ...(command.args as any) } as any)
                : command.type === 'RESCHEDULE_INTERVIEW'
                  ? ({ command: 'RESCHEDULE_INTERVIEW', ...(command.args as any) } as any)
                  : command.type === 'CANCEL_INTERVIEW'
                    ? ({ command: 'CANCEL_INTERVIEW', ...(command.args as any) } as any)
                    : command.type === 'CONFIRM_INTERVIEW'
                      ? ({ command: 'CONFIRM_INTERVIEW', ...(command.args as any) } as any)
              : command.type === 'SEND_TEMPLATE'
                ? ({ command: 'SEND_TEMPLATE', ...(command.args as any) } as any)
                : command.type === 'CREATE_CANDIDATE_AND_TEMPLATE'
                  ? ({ command: 'CREATE_CANDIDATE_AND_TEMPLATE', ...(command.args as any) } as any)
                  : command.type === 'BULK_CONTACTADO'
                  ? ({ command: 'BULK_CONTACTADO', ...(command.args as any) } as any)
                  : command.type === 'BULK_MOVE_STAGE'
                    ? ({ command: 'BULK_MOVE_STAGE', ...(command.args as any) } as any)
                  : command.type === 'PENDING_COUNTS'
                    ? ({ command: 'PENDING_COUNTS' } as any)
                    : command.type === 'GET_CASE_SUMMARY'
                      ? ({ command: 'RUN_TOOL', toolName: 'GET_CASE_SUMMARY', args: { conversationId: command.args.ref } } as any)
                      : command.type === 'SET_STAGE'
                        ? ({
                            command: 'RUN_TOOL',
                            toolName: 'SET_STAGE',
                            args: { conversationId: command.args.ref, stageSlug: command.args.stageSlug, reason: command.args.reason },
                          } as any)
                        : command.type === 'ADD_NOTE'
                          ? ({ command: 'RUN_TOOL', toolName: 'ADD_NOTE', args: { conversationId: command.args.ref, text: command.args.text } } as any)
                          : command.type === 'SEND_CUSTOMER_MESSAGE'
                            ? ({ command: 'RUN_TOOL', toolName: 'SEND_CUSTOMER_MESSAGE', args: { conversationId: command.args.ref, text: command.args.text } } as any)
                            : command.type === 'CREATE_CANDIDATE'
                              ? ({ command: 'CREATE_CANDIDATE', ...(command.args as any) } as any)
                              : ({ command: 'RUN_TOOL', toolName: command.type, args: command.args } as any);

    const toolRun = await prisma.agentRunLog.create({
      data: {
        workspaceId: params.workspaceId,
        conversationId: params.conversation.id,
        programId: params.conversation.programId || null,
        phoneLineId: params.conversation.phoneLineId || null,
        eventType: canonicalFromNatural ? 'STAFF_NL_INTENT' : 'STAFF_COMMAND_ROUTER',
        status: 'RUNNING',
        inputContextJson: serializeJson({
          inboundMessageId: params.inboundMessageId || null,
          inboundText: inbound,
          canonicalFromNatural: canonicalFromNatural || null,
          command,
          deterministic: true,
        }),
        commandsJson: serializeJson({
          agent: 'staff_command_router',
          version: 1,
          commands: [runCommand],
        }),
      },
    });

    let toolResult: any = null;
    if (command.type === 'HELP') {
      toolResult = { ok: true, details: { toolName: 'HELP', result: { help: true } } };
      await prisma.agentRunLog
        .update({
          where: { id: toolRun.id },
          data: {
            status: 'SUCCESS',
            resultsJson: serializeJson({ result: { help: true } }),
          },
        })
        .catch(() => {});
    } else if (command.type === 'LIST_DRAFTS') {
      try {
        const drafts = await listPendingHybridDraftsForWorkspace(params.workspaceId);
        const mapped = drafts.map((d) => ({
          id: d.id,
          status: d.status,
          waId: d.conversation?.contact?.waId || d.conversation?.contact?.phone || null,
          candidate:
            d.conversation?.contact?.candidateNameManual ||
            d.conversation?.contact?.candidateName ||
            d.conversation?.contact?.displayName ||
            d.conversation?.contact?.name ||
            null,
          createdAt: d.createdAt,
        }));
        toolResult = { ok: true, details: { toolName: 'LIST_DRAFTS', result: { drafts: mapped } } };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: {
              status: 'SUCCESS',
              resultsJson: serializeJson({ result: { count: mapped.length } }),
            },
          })
          .catch(() => {});
      } catch (err) {
        const errorText = err instanceof Error ? err.message : 'No se pudo listar borradores';
        toolResult = { ok: false, details: { toolName: 'LIST_DRAFTS', error: errorText } };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: { status: 'ERROR', error: errorText, resultsJson: serializeJson({ error: errorText }) },
          })
          .catch(() => {});
      }
    } else if (command.type === 'SEND_DRAFT' || command.type === 'EDIT_DRAFT' || command.type === 'CANCEL_DRAFT') {
      try {
        const resolved = await resolveDraftForStaffCommand({
          workspaceId: params.workspaceId,
          ref: (command.args as any)?.ref || null,
        });
        if (!resolved.draft?.id) {
          if (resolved.listIfAmbiguous && resolved.listIfAmbiguous.length > 1) {
            toolResult = {
              ok: false,
              details: {
                toolName: command.type,
                errorCode: 'DRAFT_AMBIGUOUS',
                result: {
                  drafts: resolved.listIfAmbiguous.map((d: any) => ({
                    id: d.id,
                    waId: d?.conversation?.contact?.waId || d?.conversation?.contact?.phone || null,
                    candidate:
                      d?.conversation?.contact?.candidateNameManual ||
                      d?.conversation?.contact?.candidateName ||
                      d?.conversation?.contact?.displayName ||
                      d?.conversation?.contact?.name ||
                      null,
                  })),
                },
              },
            };
            await prisma.agentRunLog
              .update({
                where: { id: toolRun.id },
                data: {
                  status: 'SUCCESS',
                  resultsJson: serializeJson({
                    result: { ambiguous: true, drafts: toolResult?.details?.result?.drafts || [] },
                  }),
                },
              })
              .catch(() => {});
          } else {
            throw new Error('No encontré borrador pendiente');
          }
        } else {
          const draft = resolved.draft;
          const draftIdShort = String(draft.id).slice(0, 8);
          const waId = String(draft?.conversation?.contact?.waId || draft?.conversation?.contact?.phone || '').trim();
          if (!waId) throw new Error(`Borrador ${draftIdShort} sin WhatsApp destino`);
          if (String(draft.status || '').toUpperCase() === 'SENT') {
            toolResult = {
              ok: true,
              details: { toolName: command.type, result: { draftId: draft.id, waId, alreadySent: true } },
            };
          } else if (command.type === 'CANCEL_DRAFT') {
            await prisma.hybridReplyDraft.update({
              where: { id: draft.id },
              data: {
                status: 'CANCELLED',
                cancelledByWaId: String(params.conversation?.contact?.waId || params.conversation?.contact?.phone || '').trim() || null,
                cancelledAt: new Date(),
                updatedAt: new Date(),
              } as any,
            });
            toolResult = {
              ok: true,
              details: { toolName: command.type, result: { draftId: draft.id, waId } },
            };
          } else if (command.type === 'EDIT_DRAFT') {
            const nextText = String(command.args.text || '').trim();
            if (!nextText) throw new Error('El texto EDITAR está vacío');
            await prisma.hybridReplyDraft.update({
              where: { id: draft.id },
              data: {
                status: 'APPROVED',
                finalText: nextText,
                approvedByWaId: String(params.conversation?.contact?.waId || params.conversation?.contact?.phone || '').trim() || null,
                approvedAt: new Date(),
                updatedAt: new Date(),
              } as any,
            });
            toolResult = {
              ok: true,
              details: { toolName: command.type, result: { draftId: draft.id, waId, text: nextText } },
            };
          } else {
            const finalText = String(draft.finalText || draft.proposedText || '').trim();
            if (!finalText) throw new Error(`Borrador ${draftIdShort} sin texto`);
            const send =
              params.transportMode === 'NULL'
                ? ({ success: true, messageId: `sim_draft_${draftIdShort}` } as any)
                : await sendWhatsAppText(waId, finalText, {
                    phoneNumberId: draft?.conversation?.phoneLine?.waPhoneNumberId || null,
                    enforceSafeMode: false,
                  }).catch((err) => ({
                    success: false,
                    error: err instanceof Error ? err.message : 'send_failed',
                  }));
            if (!(send as any).success) {
              await prisma.hybridReplyDraft
                .update({
                  where: { id: draft.id },
                  data: { status: 'ERROR', error: String((send as any).error || 'send_failed'), updatedAt: new Date() } as any,
                })
                .catch(() => {});
              throw new Error(`No pude enviar borrador ${draftIdShort}: ${String((send as any).error || 'send_failed')}`);
            }
            await prisma.hybridReplyDraft
              .update({
                where: { id: draft.id },
                data: {
                  status: 'SENT',
                  finalText,
                  sentAt: new Date(),
                  sentWaMessageId: (send as any).messageId || null,
                  approvedByWaId: String(params.conversation?.contact?.waId || params.conversation?.contact?.phone || '').trim() || null,
                  approvedAt: new Date(),
                  updatedAt: new Date(),
                } as any,
              })
              .catch(() => {});
            await prisma.message
              .create({
                data: {
                  conversationId: draft.conversationId,
                  direction: 'OUTBOUND',
                  text: finalText,
                  rawPayload: serializeJson({
                    hybridApproval: true,
                    draftId: draft.id,
                    sendResult: send,
                    source: 'staff_command_send_draft',
                  }),
                  timestamp: new Date(),
                  read: true,
                },
              })
              .catch(() => {});
            await prisma.outboundMessageLog
              .create({
                data: {
                  workspaceId: params.workspaceId,
                  conversationId: draft.conversationId,
                  relatedConversationId: draft.conversationId,
                  agentRunId: toolRun.id,
                  channel: 'WHATSAPP',
                  type: 'SESSION_TEXT',
                  dedupeKey: `hybrid_draft_send:${draft.id}`,
                  textHash: stableHash(`TEXT:${finalText}`),
                  blockedReason: null,
                  waMessageId: (send as any).messageId || null,
                } as any,
              })
              .catch(() => {});
            toolResult = {
              ok: true,
              details: {
                toolName: command.type,
                result: { draftId: draft.id, waId, sentWaMessageId: (send as any).messageId || null },
              },
            };
          }

          await prisma.agentRunLog
            .update({
              where: { id: toolRun.id },
              data: {
                status: 'SUCCESS',
                resultsJson: serializeJson({ result: toolResult?.details?.result || null }),
              },
            })
            .catch(() => {});
        }
      } catch (err) {
        const errorText = err instanceof Error ? err.message : 'No se pudo gestionar el borrador';
        toolResult = { ok: false, details: { toolName: command.type, error: errorText } };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: { status: 'ERROR', error: errorText, resultsJson: serializeJson({ error: errorText }) },
          })
          .catch(() => {});
      }
    } else if (command.type === 'PENDING_COUNTS') {
      try {
        const rows = await prisma.conversation.findMany({
          where: {
            workspaceId: params.workspaceId,
            archivedAt: null,
            isAdmin: false,
            conversationKind: 'CLIENT',
          } as any,
          select: { conversationStage: true, status: true },
        });
        const counts = { NUEVO: 0, CONTACTADO: 0, CITADO: 0, DESCARTADO: 0, TOTAL: rows.length };
        for (const row of rows) {
          const bucket = classifyCandidateBucket(String((row as any).conversationStage || ''), String(row.status || 'NEW'));
          counts[bucket] += 1;
        }
        toolResult = { ok: true, details: { toolName: 'PENDING_COUNTS', result: { counts } } };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: {
              status: 'SUCCESS',
              resultsJson: serializeJson({ result: { counts } }),
            },
          })
          .catch(() => {});
      } catch (err) {
        const errorText = err instanceof Error ? err.message : 'No se pudo calcular pendientes';
        toolResult = { ok: false, details: { toolName: 'PENDING_COUNTS', error: errorText } };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: { status: 'ERROR', error: errorText, resultsJson: serializeJson({ error: errorText }) },
          })
          .catch(() => {});
      }
    } else if (command.type === 'GET_CASE_SUMMARY') {
      try {
        const targetConversation =
          String(command.args.ref || '').trim() === '__latest__'
            ? await prisma.conversation.findFirst({
                where: {
                  workspaceId: params.workspaceId,
                  archivedAt: null,
                  isAdmin: false,
                  conversationKind: 'CLIENT',
                } as any,
                select: { id: true, contactId: true, phoneLineId: true },
                orderBy: { updatedAt: 'desc' },
              })
            : await resolveConversationByRefForStaff({
                workspaceId: params.workspaceId,
                ref: command.args.ref,
              });
        if (!targetConversation?.id) throw new Error(`No encontré el caso "${command.args.ref}"`);
        const convo = await prisma.conversation.findFirst({
          where: { id: targetConversation.id, workspaceId: params.workspaceId, archivedAt: null, isAdmin: false } as any,
          include: {
            contact: true,
            messages: {
              orderBy: { timestamp: 'desc' },
              take: 10,
              select: { id: true, direction: true, text: true, transcriptText: true, mediaType: true, timestamp: true },
            },
          },
        });
        if (!convo?.id) throw new Error(`No encontré el caso "${command.args.ref}"`);
        toolResult = {
          ok: true,
          details: {
            toolName: 'GET_CASE_SUMMARY',
            result: {
              case: {
                id: convo.id,
                stage: convo.conversationStage,
                status: convo.status,
                contact: {
                  displayName: repairMojibake(getContactDisplayName(convo.contact)),
                  waId: convo.contact?.waId || convo.contact?.phone || null,
                  comuna: convo.contact?.comuna || null,
                  ciudad: convo.contact?.ciudad || null,
                  region: convo.contact?.region || null,
                  availabilityText: convo.contact?.availabilityText || null,
                },
                lastMessages: (convo.messages || []).map((m: any) => ({
                  id: m.id,
                  direction: m.direction,
                  text: repairMojibake(m.transcriptText || m.text || ''),
                  mediaType: m.mediaType || null,
                  timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : null,
                })),
              },
            },
          },
        };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: {
              status: 'SUCCESS',
              resultsJson: serializeJson({ result: { caseId: convo.id, stage: convo.conversationStage } }),
            },
          })
          .catch(() => {});
      } catch (err) {
        const errorText = err instanceof Error ? err.message : 'No se pudo obtener resumen del caso';
        toolResult = { ok: false, details: { toolName: 'GET_CASE_SUMMARY', error: errorText } };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: { status: 'ERROR', error: errorText, resultsJson: serializeJson({ error: errorText }) },
          })
          .catch(() => {});
      }
    } else if (command.type === 'SET_STAGE') {
      try {
        const targetConversation = await resolveConversationByRefForStaff({
          workspaceId: params.workspaceId,
          ref: command.args.ref,
        });
        if (!targetConversation?.id) throw new Error(`No encontré el caso "${command.args.ref}"`);
        const stageSlug = normalizeStageCandidate(command.args.stageSlug);
        if (!stageSlug) throw new Error('Stage inválido');
        const known = await isKnownActiveStage(params.workspaceId, stageSlug).catch(() => false);
        if (!known) {
          const validStages = await listActiveWorkspaceStageSlugs(params.workspaceId);
          throw new Error(`stageSlug desconocido: ${stageSlug} | stages válidos: ${validStages.join(', ') || 'sin stages activos'}`);
        }
        await prisma.conversation.update({
          where: { id: targetConversation.id },
          data: {
            conversationStage: stageSlug,
            stageChangedAt: new Date(),
            stageReason: command.args.reason || 'staff_command_router',
            updatedAt: new Date(),
          } as any,
        });
        await createSystemConversationNote(
          targetConversation.id,
          `🏷️ Stage actualizado: ${stageSlug}.`,
          { source: 'staff_command_set_stage', stage: stageSlug },
        );
        toolResult = {
          ok: true,
          details: { toolName: 'SET_STAGE', result: { conversationId: targetConversation.id, stage: stageSlug } },
        };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: {
              status: 'SUCCESS',
              resultsJson: serializeJson({ result: { conversationId: targetConversation.id, stage: stageSlug } }),
            },
          })
          .catch(() => {});
      } catch (err) {
        const errorText = err instanceof Error ? err.message : 'No se pudo mover el stage';
        toolResult = { ok: false, details: { toolName: 'SET_STAGE', error: errorText } };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: { status: 'ERROR', error: errorText, resultsJson: serializeJson({ error: errorText }) },
          })
          .catch(() => {});
      }
    } else if (command.type === 'LIST_SLOTS') {
      try {
        const baseConfig = await getSystemConfig();
        const scheduleConfig = buildStaffInterviewScheduleConfig(baseConfig);
        const timezone = String((scheduleConfig as any).interviewTimezone || 'America/Santiago').trim() || 'America/Santiago';
        const dayLabel = resolveDayTokenToWeekdayLabel(command.args.dayToken, timezone);
        if (!dayLabel) throw new Error('No pude interpretar el día. Usa hoy, mañana o un día de semana.');
        const slotData = await computeStaffDaySlots({
          config: scheduleConfig,
          dayLabelEs: dayLabel,
          location: STAFF_INTERVIEW_LOCATION_LABEL,
        });
        toolResult = {
          ok: true,
          details: {
            toolName: 'LIST_SLOTS',
            result: {
              day: dayLabel,
              location: STAFF_INTERVIEW_LOCATION_LABEL,
              slots: slotData.slots,
            },
          },
        };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: {
              status: 'SUCCESS',
              resultsJson: serializeJson({
                result: { day: dayLabel, location: STAFF_INTERVIEW_LOCATION_LABEL, slots: slotData.slots },
              }),
            },
          })
          .catch(() => {});
      } catch (err) {
        const errorText = err instanceof Error ? err.message : 'No se pudo listar slots';
        toolResult = { ok: false, details: { toolName: 'LIST_SLOTS', error: errorText } };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: { status: 'ERROR', error: errorText, resultsJson: serializeJson({ error: errorText }) },
          })
          .catch(() => {});
      }
    } else if (command.type === 'SCHEDULE_INTERVIEW' || command.type === 'RESCHEDULE_INTERVIEW') {
      try {
        const targetConversation = await resolveConversationByRefForStaff({
          workspaceId: params.workspaceId,
          ref: command.args.ref,
        });
        if (!targetConversation?.id) throw new Error(`No encontré el caso "${command.args.ref}"`);
        const convo = await prisma.conversation.findFirst({
          where: { id: targetConversation.id, workspaceId: params.workspaceId },
          include: { contact: true },
        });
        if (!convo?.id) throw new Error('No encontré la conversación objetivo');

        const baseConfig = await getSystemConfig();
        const scheduleConfig = buildStaffInterviewScheduleConfig(baseConfig);
        const timezone = String((scheduleConfig as any).interviewTimezone || 'America/Santiago').trim() || 'America/Santiago';
        const dayLabel = resolveDayTokenToWeekdayLabel(command.args.dayToken, timezone);
        if (!dayLabel) throw new Error('No pude interpretar el día. Usa hoy, mañana o un día de semana.');

        const attempt = await attemptScheduleInterview({
          conversationId: convo.id,
          contactId: convo.contactId,
          day: dayLabel,
          time: command.args.time,
          location: STAFF_INTERVIEW_LOCATION_LABEL,
          config: scheduleConfig as any,
        });
        if (!attempt.ok) {
          toolResult = {
            ok: true,
            details: {
              toolName: command.type,
              result: {
                ok: false,
                reason: attempt.reason,
                message: attempt.message,
                alternatives: attempt.alternatives.map((a) => ({
                  day: a.day,
                  time: a.time,
                  location: a.location,
                })),
              },
            },
          };
          await prisma.agentRunLog
            .update({
              where: { id: toolRun.id },
              data: {
                status: 'SUCCESS',
                resultsJson: serializeJson({
                  result: {
                    ok: false,
                    reason: attempt.reason,
                    message: attempt.message,
                    alternatives: attempt.alternatives.map((a) => ({
                      day: a.day,
                      time: a.time,
                      location: a.location,
                    })),
                  },
                }),
              },
            })
            .catch(() => {});
        } else {
          const now = new Date();
          await prisma.conversation.update({
            where: { id: convo.id },
            data: {
              status: 'OPEN',
              conversationStage: 'INTERVIEW_PENDING',
              stageChangedAt: now,
              stageReason: command.type === 'RESCHEDULE_INTERVIEW' ? 'staff_reagenda_entrevista' : 'staff_agenda_entrevista',
              interviewDay: attempt.slot.day,
              interviewTime: attempt.slot.time,
              interviewLocation: attempt.slot.location,
              interviewStatus: 'PENDING',
              aiMode: 'INTERVIEW',
              updatedAt: now,
            } as any,
          });
          await createSystemConversationNote(
            convo.id,
            command.type === 'RESCHEDULE_INTERVIEW'
              ? `🔁 Entrevista reagendada (HOLD): ${formatSlotHuman(attempt.slot)}.`
              : `🗓️ Entrevista agendada (HOLD): ${formatSlotHuman(attempt.slot)}.`,
            {
              source: 'staff_command_schedule',
              reservationId: attempt.reservationId,
              kind: attempt.kind,
            },
          );
          toolResult = {
            ok: true,
            details: {
              toolName: command.type,
              result: {
                ok: true,
                refHint: convo.id.slice(0, 8),
                reservationId: attempt.reservationId,
                kind: attempt.kind,
                slot: {
                  day: attempt.slot.day,
                  time: attempt.slot.time,
                  location: attempt.slot.location,
                },
              },
            },
          };
          await prisma.agentRunLog
            .update({
              where: { id: toolRun.id },
              data: {
                status: 'SUCCESS',
                resultsJson: serializeJson({
                  result: {
                    ok: true,
                    conversationId: convo.id,
                    refHint: convo.id.slice(0, 8),
                    reservationId: attempt.reservationId,
                    kind: attempt.kind,
                    slot: {
                      day: attempt.slot.day,
                      time: attempt.slot.time,
                      location: attempt.slot.location,
                    },
                  },
                }),
              },
            })
            .catch(() => {});
        }
      } catch (err) {
        const errorText = err instanceof Error ? err.message : 'No se pudo agendar entrevista';
        toolResult = { ok: false, details: { toolName: command.type, error: errorText } };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: { status: 'ERROR', error: errorText, resultsJson: serializeJson({ error: errorText }) },
          })
          .catch(() => {});
      }
    } else if (command.type === 'CANCEL_INTERVIEW') {
      try {
        const targetConversation = await resolveConversationByRefForStaff({
          workspaceId: params.workspaceId,
          ref: command.args.ref,
        });
        if (!targetConversation?.id) throw new Error(`No encontré el caso "${command.args.ref}"`);
        const convo = await prisma.conversation.findFirst({
          where: { id: targetConversation.id, workspaceId: params.workspaceId },
          select: { id: true, interviewDay: true, interviewTime: true, interviewLocation: true },
        });
        if (!convo?.id) throw new Error('No encontré la conversación objetivo');
        const release = await releaseActiveReservation({ conversationId: convo.id, status: 'CANCELLED' });
        await prisma.conversation.update({
          where: { id: convo.id },
          data: {
            status: 'OPEN',
            conversationStage: 'INTERVIEW_PENDING',
            stageChangedAt: new Date(),
            stageReason: 'staff_cancel_interview',
            interviewStatus: 'CANCELLED',
            updatedAt: new Date(),
          } as any,
        });
        await createSystemConversationNote(
          convo.id,
          release.released
            ? '❌ Entrevista cancelada y cupo liberado.'
            : '❌ Entrevista marcada como cancelada (no había reserva activa).',
          {
            source: 'staff_command_cancel_interview',
            reservationId: release.reservationId,
          },
        );
        toolResult = {
          ok: true,
          details: { toolName: 'CANCEL_INTERVIEW', result: { released: release.released, reservationId: release.reservationId } },
        };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: {
              status: 'SUCCESS',
              resultsJson: serializeJson({ result: { released: release.released, reservationId: release.reservationId } }),
            },
          })
          .catch(() => {});
      } catch (err) {
        const errorText = err instanceof Error ? err.message : 'No se pudo cancelar entrevista';
        toolResult = { ok: false, details: { toolName: 'CANCEL_INTERVIEW', error: errorText } };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: { status: 'ERROR', error: errorText, resultsJson: serializeJson({ error: errorText }) },
          })
          .catch(() => {});
      }
    } else if (command.type === 'CONFIRM_INTERVIEW') {
      try {
        const refId = stableHash(`staff_confirm_interview:${params.workspaceId}:${params.conversation.id}:${Date.now()}`).slice(0, 8);
        const targetConversation = await resolveConversationByRefForStaff({
          workspaceId: params.workspaceId,
          ref: command.args.ref,
        });
        if (!targetConversation?.id) throw new Error(`No encontré el caso "${command.args.ref}"`);
        const convo = await prisma.conversation.findFirst({
          where: { id: targetConversation.id, workspaceId: params.workspaceId },
          include: { contact: true, phoneLine: true },
        });
        if (!convo?.id || !convo.contact?.waId) throw new Error('El caso no tiene WhatsApp válido');
        if (convo.contact.noContact) throw new Error('El contacto está en NO_CONTACTAR');

        const activeReservation = await prisma.interviewReservation.findFirst({
          where: { conversationId: convo.id, activeKey: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
          select: { id: true, startAt: true, timezone: true, location: true },
        });
        if (!activeReservation?.id) {
          throw new Error('No hay entrevista en HOLD para confirmar. Usa "agendar <tel|id> mañana HH:MM".');
        }
        const reservationUpdate = await confirmActiveReservation(convo.id);
        const scheduleConfig = buildStaffInterviewScheduleConfig(await getSystemConfig());
        const reservationTz =
          String(activeReservation.timezone || (scheduleConfig as any)?.interviewTimezone || 'America/Santiago').trim() ||
          'America/Santiago';
        const reservationStart = DateTime.fromJSDate(activeReservation.startAt).setZone(reservationTz);
        const reservationDay = reservationStart.setLocale('es-CL').toFormat('cccc');
        const reservationTime = reservationStart.toFormat('HH:mm');
        const normalizedLocation =
          String(activeReservation.location || convo.interviewLocation || '').trim() || STAFF_INTERVIEW_LOCATION_LABEL;
        const exactLocation =
          normalizedLocation.toLowerCase().includes('salvador')
            ? normalizedLocation
            : STAFF_INTERVIEW_EXACT_ADDRESS;
        await prisma.conversation.update({
          where: { id: convo.id },
          data: {
            status: 'OPEN',
            conversationStage: 'INTERVIEW_SCHEDULED',
            stageChangedAt: new Date(),
            stageReason: 'staff_confirm_interview',
            interviewStatus: 'CONFIRMED',
            interviewDay: reservationDay,
            interviewTime: reservationTime,
            interviewLocation: exactLocation,
            updatedAt: new Date(),
          } as any,
        });

        const templateName = 'enviorapido_confirma_entrevista_v1';
        const catalog = await listWorkspaceTemplatesForStaff(params.workspaceId);
        if (!catalog.namesLower.has(templateName.toLowerCase())) {
          throw new Error(`Plantilla "${templateName}" no existe en catálogo. ${shortTemplateList(catalog.entries)}`);
        }

        const templatesCfg = await loadTemplateConfig(undefined, params.workspaceId).catch(() => null as any);
        const templateMeta = catalog.entries.find((e) => String(e.name || '').toLowerCase() === templateName.toLowerCase()) || null;
        const candidateName =
          String(
            convo.contact?.candidateNameManual ||
              convo.contact?.candidateName ||
              convo.contact?.displayName ||
              convo.contact?.name ||
              convo.contact?.waId ||
              '',
          ).trim() || 'Postulante';
        let finalVariables = resolveTemplateVariables(templateName, undefined, templatesCfg || undefined, {
          interviewDay: reservationDay,
          interviewTime: reservationTime,
          interviewLocation: exactLocation,
          candidateName,
        });
        const variableCount = Number(templateMeta?.variableCount || 0);
        if (variableCount > 0) {
          const fallbackVars = [candidateName, reservationDay, reservationTime, exactLocation];
          if (!Array.isArray(finalVariables) || finalVariables.length < variableCount) {
            finalVariables = fallbackVars.slice(0, variableCount);
          } else {
            finalVariables = finalVariables.slice(0, variableCount).map((v, idx) => {
              const normalized = String(v || '').trim();
              if (normalized && !/por definir/i.test(normalized)) return normalized;
              return String(fallbackVars[idx] || '').trim() || normalized;
            });
          }
          finalVariables = finalVariables.slice(0, variableCount);
        }
        const hasPlaceholder = (finalVariables || []).some((v: any) => /por definir/i.test(String(v || '')));
        if (hasPlaceholder) {
          throw new Error('No pude completar variables de plantilla (quedó "Por definir"). Revisa la entrevista y vuelve a intentar.');
        }

        const sendResult =
          params.transportMode === 'NULL'
            ? ({ success: true, messageId: `sim_tpl_${stableHash(`${convo.id}:${templateName}`).slice(0, 12)}` } as any)
            : await sendWhatsAppTemplate(convo.contact.waId, templateName, finalVariables, {
                phoneNumberId: convo.phoneLine?.waPhoneNumberId || null,
                enforceSafeMode: false,
                languageCode: null,
              });
        if (!sendResult.success) {
          await prisma.outboundMessageLog
            .create({
              data: {
                workspaceId: params.workspaceId,
                conversationId: convo.id,
                relatedConversationId: convo.id,
                agentRunId: toolRun.id,
                channel: 'WHATSAPP',
                type: 'TEMPLATE',
                templateName,
                dedupeKey: `manual_staff_confirm_template_failed:${convo.id}:${Date.now()}`,
                textHash: stableHash(`TEMPLATE:${templateName}:${serializeJson(finalVariables || [])}`),
                blockedReason: `SEND_FAILED:${String(sendResult.error || 'unknown')}`,
                waMessageId: null,
              } as any,
            })
            .catch(() => {});
          throw new Error(`ref ${refId} · ${String(sendResult.error || 'Falló proveedor WhatsApp')}`);
        }

        await prisma.message.create({
          data: {
            conversationId: convo.id,
            direction: 'OUTBOUND',
            text: `[TEMPLATE] ${templateName}`,
            rawPayload: serializeJson({
              template: templateName,
              variables: finalVariables || [],
              sendResult,
              source: 'staff_command_confirm_interview',
            }),
            timestamp: new Date(),
            read: true,
          },
        });

        await prisma.outboundMessageLog
          .create({
            data: {
              workspaceId: params.workspaceId,
              conversationId: convo.id,
              relatedConversationId: convo.id,
              agentRunId: toolRun.id,
              channel: 'WHATSAPP',
              type: 'TEMPLATE',
              templateName,
              dedupeKey: `manual_staff_confirm_template:${convo.id}:${Date.now()}`,
              textHash: stableHash(`TEMPLATE:${templateName}:${serializeJson(finalVariables || [])}`),
              blockedReason: null,
              waMessageId: sendResult.messageId || null,
            } as any,
          })
          .catch(() => {});

        await createSystemConversationNote(
          convo.id,
          `✅ Entrevista confirmada. Dirección exacta enviada: ${STAFF_INTERVIEW_EXACT_ADDRESS}.`,
          {
            source: 'staff_command_confirm_interview',
            reservationId: reservationUpdate.reservationId,
            templateName,
            templateVariables: finalVariables,
          },
        );

        toolResult = {
          ok: true,
          details: {
            toolName: 'CONFIRM_INTERVIEW',
            result: {
              templateSent: true,
              templateName,
              reservationId: reservationUpdate.reservationId,
            },
          },
        };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: {
              status: 'SUCCESS',
              resultsJson: serializeJson({
                result: {
                  templateSent: true,
                  templateName,
                  reservationId: reservationUpdate.reservationId,
                },
              }),
            },
          })
          .catch(() => {});
      } catch (err) {
        const errText = err instanceof Error ? err.message : 'No se pudo confirmar entrevista';
        toolResult = { ok: false, details: { toolName: 'CONFIRM_INTERVIEW', error: errText } };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: {
              status: 'ERROR',
              error: errText,
              resultsJson: serializeJson({ error: errText }),
            },
          })
          .catch(() => {});
      }
    } else if (command.type === 'CREATE_CANDIDATE') {
      try {
        const created = await upsertCandidateAndCase({
          workspaceId: params.workspaceId,
          phoneRaw: command.args.phoneE164,
          name: command.args.name || null,
          role: command.args.role || null,
          channel: command.args.channel || null,
          comuna: command.args.comuna || null,
          ciudad: command.args.ciudad || null,
          initialStatus: 'NUEVO',
          preserveExistingConversationStage: true,
        });
        toolResult = { ok: true, details: { toolName: 'CREATE_CANDIDATE', result: created } };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: {
              status: 'SUCCESS',
              resultsJson: serializeJson({ result: created }),
            },
          })
          .catch(() => {});
      } catch (err) {
        const errorText = err instanceof Error ? err.message : 'No se pudo crear candidato';
        toolResult = { ok: false, details: { toolName: 'CREATE_CANDIDATE', error: errorText } };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: { status: 'ERROR', error: errorText, resultsJson: serializeJson({ error: errorText }) },
          })
          .catch(() => {});
      }
    } else if (command.type === 'SEND_TEMPLATE') {
      try {
        const refId = stableHash(`staff_template:${params.workspaceId}:${params.conversation.id}:${Date.now()}`).slice(0, 8);
        const targetConversation = await resolveConversationByRefForStaff({
          workspaceId: params.workspaceId,
          ref: command.args.ref,
        });
        if (!targetConversation?.id) {
          throw new Error(`No encontré el caso "${command.args.ref}"`);
        }
        const convo = await prisma.conversation.findFirst({
          where: { id: targetConversation.id, workspaceId: params.workspaceId },
          include: { contact: true, phoneLine: true },
        });
        if (!convo?.id || !convo.contact?.waId) {
          throw new Error('El caso no tiene WhatsApp válido');
        }
        if (convo.contact.noContact) {
          throw new Error('El contacto está en NO_CONTACTAR');
        }
        const catalog = await listWorkspaceTemplatesForStaff(params.workspaceId);
        const templateName = String(command.args.templateName || '').trim();
        if (!catalog.namesLower.has(templateName.toLowerCase())) {
          throw new Error(`Plantilla "${templateName}" no existe en catálogo. ${shortTemplateList(catalog.entries)}`);
        }

        const templatesCfg = await loadTemplateConfig(undefined, params.workspaceId).catch(() => null as any);
        const finalVariables = resolveTemplateVariables(templateName, undefined, templatesCfg || undefined, {
          interviewDay: (convo as any).interviewDay,
          interviewTime: (convo as any).interviewTime,
          interviewLocation: (convo as any).interviewLocation,
          candidateName:
            convo.contact?.candidateNameManual ||
            convo.contact?.candidateName ||
            convo.contact?.displayName ||
            convo.contact?.name ||
            convo.contact?.waId ||
            '',
        });

        const sendResult =
          params.transportMode === 'NULL'
            ? ({ success: true, messageId: `sim_tpl_${stableHash(`${convo.id}:${templateName}`).slice(0, 12)}` } as any)
            : await sendWhatsAppTemplate(convo.contact.waId, templateName, finalVariables, {
                phoneNumberId: convo.phoneLine?.waPhoneNumberId || null,
                enforceSafeMode: false,
                languageCode: null,
              });
        if (!sendResult.success) {
          await prisma.outboundMessageLog.create({
            data: {
              workspaceId: params.workspaceId,
              conversationId: convo.id,
              relatedConversationId: convo.id,
              agentRunId: toolRun.id,
              channel: 'WHATSAPP',
              type: 'TEMPLATE',
              templateName,
              dedupeKey: `manual_staff_template_failed:${convo.id}:${Date.now()}`,
              textHash: stableHash(`TEMPLATE:${templateName}:${serializeJson(finalVariables || [])}`),
              blockedReason: `SEND_FAILED:${String(sendResult.error || 'unknown')}`,
              waMessageId: null,
            } as any,
          }).catch(() => {});
          throw new Error(`ref ${refId} · ${String(sendResult.error || 'Falló proveedor WhatsApp')}`);
        }

        await prisma.message.create({
          data: {
            conversationId: convo.id,
            direction: 'OUTBOUND',
            text: `[TEMPLATE] ${templateName}`,
            rawPayload: serializeJson({
              template: templateName,
              variables: finalVariables || [],
              sendResult,
              source: 'staff_command_manual',
            }),
            timestamp: new Date(),
            read: true,
          },
        });

        await prisma.outboundMessageLog.create({
          data: {
            workspaceId: params.workspaceId,
            conversationId: convo.id,
            relatedConversationId: convo.id,
            agentRunId: toolRun.id,
            channel: 'WHATSAPP',
            type: 'TEMPLATE',
            templateName,
            dedupeKey: `manual_staff_template:${convo.id}:${Date.now()}`,
            textHash: stableHash(`TEMPLATE:${templateName}:${serializeJson(finalVariables || [])}`),
            blockedReason: null,
            waMessageId: sendResult.messageId || null,
          } as any,
        });

        const statusAfter = await applyTemplateAutoStatus({
          workspaceId: params.workspaceId,
          conversationId: convo.id,
          templateName,
        });
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: {
              status: 'SUCCESS',
              resultsJson: serializeJson({
                result: {
                  success: true,
                  conversationId: convo.id,
                  phoneE164: convo.contact.waId,
                  templateName,
                  statusAfter,
                  manual: true,
                },
              }),
            },
          })
          .catch(() => {});
        toolResult = {
          ok: true,
          details: {
            toolName: 'SEND_TEMPLATE',
            result: {
              success: true,
              conversationId: convo.id,
              phoneE164: convo.contact.waId,
              templateName,
              statusAfter,
            },
          },
        };
      } catch (err) {
        const errText = err instanceof Error ? err.message : 'No se pudo enviar plantilla';
        toolResult = { ok: false, details: { toolName: 'SEND_TEMPLATE', error: errText } };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: {
              status: 'ERROR',
              error: errText,
              resultsJson: serializeJson({ error: errText }),
            },
          })
          .catch(() => {});
      }
    } else if (command.type === 'CREATE_CANDIDATE_AND_TEMPLATE') {
      try {
        const created = await upsertCandidateAndCase({
          workspaceId: params.workspaceId,
          phoneRaw: command.args.phoneE164,
          name: command.args.name || null,
          role: command.args.role || null,
          channel: command.args.channel || null,
          comuna: command.args.comuna || null,
          ciudad: command.args.ciudad || null,
          initialStatus: 'NUEVO',
          preserveExistingConversationStage: true,
        });

        const convo = await prisma.conversation.findFirst({
          where: { id: created.conversationId, workspaceId: params.workspaceId },
          include: { contact: true, phoneLine: true },
        });
        if (!convo?.id || !convo.contact?.waId) {
          throw new Error('No pude preparar el caso para enviar plantilla');
        }
        if (convo.contact.noContact) {
          throw new Error('El contacto está en NO_CONTACTAR');
        }

        const catalog = await listWorkspaceTemplatesForStaff(params.workspaceId);
        const templateName = String(command.args.templateName || '').trim();
        if (!catalog.namesLower.has(templateName.toLowerCase())) {
          throw new Error(`Plantilla "${templateName}" no existe en catálogo. ${shortTemplateList(catalog.entries)}`);
        }
        const templatesCfg = await loadTemplateConfig(undefined, params.workspaceId).catch(() => null as any);
        const finalVariables = resolveTemplateVariables(templateName, undefined, templatesCfg || undefined, {
          interviewDay: (convo as any).interviewDay,
          interviewTime: (convo as any).interviewTime,
          interviewLocation: (convo as any).interviewLocation,
          candidateName:
            convo.contact?.candidateNameManual ||
            convo.contact?.candidateName ||
            convo.contact?.displayName ||
            convo.contact?.name ||
            convo.contact?.waId ||
            '',
        });
        const sendResult =
          params.transportMode === 'NULL'
            ? ({ success: true, messageId: `sim_tpl_${stableHash(`${convo.id}:${templateName}`).slice(0, 12)}` } as any)
            : await sendWhatsAppTemplate(convo.contact.waId, templateName, finalVariables, {
                phoneNumberId: convo.phoneLine?.waPhoneNumberId || null,
                enforceSafeMode: false,
                languageCode: null,
              });
        if (!sendResult.success) {
          await prisma.outboundMessageLog.create({
            data: {
              workspaceId: params.workspaceId,
              conversationId: convo.id,
              relatedConversationId: convo.id,
              agentRunId: toolRun.id,
              channel: 'WHATSAPP',
              type: 'TEMPLATE',
              templateName,
              dedupeKey: `manual_staff_alta_template_failed:${convo.id}:${Date.now()}`,
              textHash: stableHash(`TEMPLATE:${templateName}:${serializeJson(finalVariables || [])}`),
              blockedReason: `SEND_FAILED:${String(sendResult.error || 'unknown')}`,
              waMessageId: null,
            } as any,
          }).catch(() => {});
          throw new Error(String(sendResult.error || 'Falló envío de plantilla'));
        }

        await prisma.message.create({
          data: {
            conversationId: convo.id,
            direction: 'OUTBOUND',
            text: `[TEMPLATE] ${templateName}`,
            rawPayload: serializeJson({
              template: templateName,
              variables: finalVariables || [],
              sendResult,
              source: 'staff_command_manual_alta',
            }),
            timestamp: new Date(),
            read: true,
          },
        });

        await prisma.outboundMessageLog.create({
          data: {
            workspaceId: params.workspaceId,
            conversationId: convo.id,
            relatedConversationId: convo.id,
            agentRunId: toolRun.id,
            channel: 'WHATSAPP',
            type: 'TEMPLATE',
            templateName,
            dedupeKey: `manual_staff_alta_template:${convo.id}:${Date.now()}`,
            textHash: stableHash(`TEMPLATE:${templateName}:${serializeJson(finalVariables || [])}`),
            blockedReason: null,
            waMessageId: sendResult.messageId || null,
          } as any,
        });

        const statusAfter = await applyTemplateAutoStatus({
          workspaceId: params.workspaceId,
          conversationId: convo.id,
          templateName,
        });
        toolResult = {
          ok: true,
          details: {
            toolName: 'CREATE_CANDIDATE_AND_TEMPLATE',
            result: {
              ...created,
              templateName,
              statusAfter,
            },
          },
        };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: {
              status: 'SUCCESS',
              resultsJson: serializeJson({ result: toolResult?.details?.result || null }),
            },
          })
          .catch(() => {});
      } catch (err) {
        const errText = err instanceof Error ? err.message : 'No se pudo ejecutar alta + plantilla';
        toolResult = { ok: false, details: { toolName: 'CREATE_CANDIDATE_AND_TEMPLATE', error: errText } };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: { status: 'ERROR', error: errText, resultsJson: serializeJson({ error: errText }) },
          })
          .catch(() => {});
      }
    } else if (command.type === 'BULK_CONTACTADO') {
      try {
        let updated = 0;
        let unchanged = 0;
        let notFound = 0;
        for (const ref of command.args.refs) {
          const target = await resolveConversationByRefForStaff({
            workspaceId: params.workspaceId,
            ref,
          });
          if (!target?.id) {
            notFound += 1;
            continue;
          }
          const convo = await prisma.conversation.findFirst({
            where: { id: target.id, workspaceId: params.workspaceId },
            select: { id: true, conversationStage: true, status: true },
          });
          if (!convo?.id) {
            notFound += 1;
            continue;
          }
          const current = deriveCandidateStatusFromConversation(convo);
          if (current.candidateStatus !== 'NUEVO') {
            unchanged += 1;
            continue;
          }
          await prisma.conversation.update({
            where: { id: convo.id },
            data: {
              status: 'OPEN',
              conversationStage: String(convo.conversationStage || '').toUpperCase() === 'NEW_INTAKE' ? 'SCREENING' : convo.conversationStage,
              stageChangedAt: new Date(),
              stageReason: 'bulk_contactado',
              updatedAt: new Date(),
            } as any,
          });
          await createSystemConversationNote(
            convo.id,
            `📌 Estado candidato actualizado a CONTACTADO (${new Date().toLocaleString('es-CL')}).`,
            { source: 'staff_bulk_contactado' },
          );
          updated += 1;
        }
        toolResult = {
          ok: true,
          details: { toolName: 'BULK_CONTACTADO', result: { updated, unchanged, notFound } },
        };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: {
              status: 'SUCCESS',
              resultsJson: serializeJson({ result: { updated, unchanged, notFound } }),
            },
          })
          .catch(() => {});
      } catch (err) {
        const errText = err instanceof Error ? err.message : 'No se pudo ejecutar bulk contactado';
        toolResult = { ok: false, details: { toolName: 'BULK_CONTACTADO', error: errText } };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: { status: 'ERROR', error: errText, resultsJson: serializeJson({ error: errText }) },
          })
          .catch(() => {});
      }
    } else if (command.type === 'BULK_MOVE_STAGE') {
      try {
        const stageSlug = normalizeStageCandidate(command.args.stageSlug);
        if (!stageSlug) throw new Error('Stage inválido');
        const known = await isKnownActiveStage(params.workspaceId, stageSlug).catch(() => false);
        if (!known) {
          const validStages = await listActiveWorkspaceStageSlugs(params.workspaceId);
          throw new Error(`stageSlug desconocido: ${stageSlug} | stages válidos: ${validStages.join(', ') || 'sin stages activos'}`);
        }
        let updated = 0;
        let unchanged = 0;
        let notFound = 0;
        for (const ref of command.args.refs) {
          const target = await resolveConversationByRefForStaff({
            workspaceId: params.workspaceId,
            ref,
          });
          if (!target?.id) {
            notFound += 1;
            continue;
          }
          const current = await prisma.conversation.findFirst({
            where: { id: target.id, workspaceId: params.workspaceId },
            select: { id: true, conversationStage: true },
          });
          if (!current?.id) {
            notFound += 1;
            continue;
          }
          if (String(current.conversationStage || '').toUpperCase() === stageSlug) {
            unchanged += 1;
            continue;
          }
          await prisma.conversation.update({
            where: { id: current.id },
            data: {
              conversationStage: stageSlug,
              stageChangedAt: new Date(),
              stageReason: 'staff_bulk_move_stage',
              updatedAt: new Date(),
            } as any,
          });
          await createSystemConversationNote(
            current.id,
            `🏷️ Stage actualizado masivamente a ${stageSlug}.`,
            { source: 'staff_bulk_move_stage', stage: stageSlug },
          );
          updated += 1;
        }
        toolResult = {
          ok: true,
          details: { toolName: 'BULK_MOVE_STAGE', result: { stageSlug, updated, unchanged, notFound } },
          stageSlug,
          updated,
          unchanged,
          notFound,
        };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: {
              status: 'SUCCESS',
              resultsJson: serializeJson({ result: { stageSlug, updated, unchanged, notFound } }),
            },
          })
          .catch(() => {});
      } catch (err) {
        const errText = err instanceof Error ? err.message : 'No se pudo ejecutar bulk mover';
        toolResult = { ok: false, details: { toolName: 'BULK_MOVE_STAGE', error: errText } };
        await prisma.agentRunLog
          .update({
            where: { id: toolRun.id },
            data: { status: 'ERROR', error: errText, resultsJson: serializeJson({ error: errText }) },
          })
          .catch(() => {});
      }
    } else {
      const toolExec = await executeAgentResponse({
        app: params.app,
        workspaceId: params.workspaceId,
        agentRunId: toolRun.id,
        response: {
          agent: 'staff_command_router',
          version: 1,
          commands: [runCommand],
        } as any,
        transportMode: params.transportMode,
      });
      toolResult = Array.isArray(toolExec.results) && toolExec.results.length > 0 ? toolExec.results[0] : null;
    }
    const replyText = buildStaffRouterReply(command, toolResult);
    // Dedupe by inbound message when available so repeated staff commands
    // ("casos nuevos", "buscar ...") do not get muted by ANTI_LOOP_DEDUPE_KEY.
    const replyDedupeSeed = params.inboundMessageId
      ? `mid:${params.inboundMessageId}`
      : `toolRun:${toolRun.id}`;
    const replyDedupeKey = `staff_cmd_reply:${stableHash(`${params.conversation.id}:${replyDedupeSeed}`).slice(0, 16)}`;

    const replyRun = await prisma.agentRunLog.create({
      data: {
        workspaceId: params.workspaceId,
        conversationId: params.conversation.id,
        programId: params.conversation.programId || null,
        phoneLineId: params.conversation.phoneLineId || null,
        eventType: 'STAFF_COMMAND_ROUTER_REPLY',
        status: 'RUNNING',
        inputContextJson: serializeJson({
          sourceRunId: toolRun.id,
          command,
          toolResult,
        }),
        commandsJson: serializeJson({
          agent: 'staff_command_router',
          version: 1,
          commands: [
            {
              command: 'SEND_MESSAGE',
              conversationId: params.conversation.id,
              channel: 'WHATSAPP',
              type: 'SESSION_TEXT',
              text: replyText,
              dedupeKey: replyDedupeKey,
            },
          ],
        }),
      },
    });

    await executeAgentResponse({
      app: params.app,
      workspaceId: params.workspaceId,
      agentRunId: replyRun.id,
      response: {
        agent: 'staff_command_router',
        version: 1,
        commands: [
          {
            command: 'SEND_MESSAGE',
            conversationId: params.conversation.id,
            channel: 'WHATSAPP',
            type: 'SESSION_TEXT',
            text: replyText,
            dedupeKey: replyDedupeKey,
          } as any,
        ],
      } as any,
      transportMode: params.transportMode,
    });
    return { handled: true };
  } catch (err) {
    params.app.log.warn({ err, conversationId: params.conversation.id }, 'Staff deterministic router failed');
    const safeText =
      'No pude consultar casos ahora. Intenta de nuevo en unos segundos o abre Inbox y filtra por estado.';
    const safeRun = await prisma.agentRunLog.create({
      data: {
        workspaceId: params.workspaceId,
        conversationId: params.conversation.id,
        programId: params.conversation.programId || null,
        phoneLineId: params.conversation.phoneLineId || null,
        eventType: 'STAFF_COMMAND_ROUTER_FALLBACK',
        status: 'RUNNING',
        inputContextJson: serializeJson({ error: err instanceof Error ? err.message : 'unknown' }),
        commandsJson: serializeJson({
          agent: 'staff_command_router',
          version: 1,
          commands: [
            {
              command: 'SEND_MESSAGE',
              conversationId: params.conversation.id,
              channel: 'WHATSAPP',
              type: 'SESSION_TEXT',
              text: safeText,
              dedupeKey: `staff_cmd_fail:${stableHash(`${params.conversation.id}:${Date.now()}`).slice(0, 16)}`,
            },
          ],
        }),
      },
    });
    await executeAgentResponse({
      app: params.app,
      workspaceId: params.workspaceId,
      agentRunId: safeRun.id,
      response: {
        agent: 'staff_command_router',
        version: 1,
        commands: [
          {
            command: 'SEND_MESSAGE',
            conversationId: params.conversation.id,
            channel: 'WHATSAPP',
            type: 'SESSION_TEXT',
            text: safeText,
            dedupeKey: `staff_cmd_fail:${stableHash(`${params.conversation.id}:${Date.now()}`).slice(0, 16)}`,
          } as any,
        ],
      } as any,
      transportMode: params.transportMode,
    });
    return { handled: true };
  }
}

type ConditionRow = { field: string; op: string; value?: any };
type ActionRow =
  | { type: 'RUN_AGENT'; agent?: string }
  | { type: 'SET_STATUS'; status: 'NEW' | 'OPEN' | 'CLOSED' }
  | { type: 'ADD_NOTE'; note: string }
  | { type: 'ASSIGN_TO_NURSE_LEADER'; note?: string }
  | {
      type: 'NOTIFY_STAFF_WHATSAPP';
      // Backwards compatible:
      targetUserId?: string;
      targetEmail?: string;
      messageTemplate?: string;
      // v2.2:
      templateText?: string;
      recipients?: any;
      requireAvailability?: boolean;
      dedupePolicy?: string;
      dedupeKey?: string;
    }
  | {
      type: 'NOTIFY_PARTNER_WHATSAPP';
      templateText?: string;
      recipients?: any;
      requireAvailability?: boolean;
      dedupePolicy?: string;
      dedupeKey?: string;
    };

function renderSimpleTemplate(template: string, vars: Record<string, string>): string {
  return (template || '').replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key: string) => vars[key] ?? '');
}

async function computeWhatsAppWindowStatusStrict(conversationId: string): Promise<'IN_24H' | 'OUTSIDE_24H'> {
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

function safeJsonParse(value: string | null | undefined): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalize(value: string): string {
  return stripAccents(String(value || '')).toLowerCase().replace(/\s+/g, ' ').trim();
}

function safeJsonParseArray(value: any): string[] | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((v) => String(v));
  } catch {
    return null;
  }
}

function parseTagList(raw: any): string[] {
  if (!raw) return [];
  const fromJson = safeJsonParseArray(raw);
  const items = fromJson ?? String(raw).split(/[,\n]/g);
  const out: string[] = [];
  for (const item of items) {
    const t = normalize(String(item));
    if (!t) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function parseBoolean(value: any): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  if (typeof value === 'string') {
    const t = normalize(value);
    if (['true', '1', 'si', 'sí', 'yes'].includes(t)) return true;
    if (['false', '0', 'no'].includes(t)) return false;
  }
  return null;
}

function evaluateCondition(params: {
  condition: ConditionRow;
  conversation: any;
  contact: any;
  windowStatus: string;
  inboundText: string | null;
}): boolean {
  const { condition } = params;
  const field = String(condition.field || '').trim();
  const op = String(condition.op || '').trim();
  const rawValue = condition.value;

  const getFieldValue = (): any => {
    if (field === 'conversation.status') return params.conversation.status;
    if (field === 'conversation.stage') return params.conversation.conversationStage;
    if (field === 'conversation.stageTags') return parseTagList(params.conversation.stageTags);
    if (field === 'conversation.programId') return params.conversation.programId;
    if (field === 'conversation.phoneLineId') return params.conversation.phoneLineId;
    if (field === 'contact.noContactar') return Boolean(params.contact.noContact);
    if (field === 'contact.hasCandidateName') {
      const manual = String(params.contact.candidateNameManual || '').trim();
      const detected = String(params.contact.candidateName || '').trim();
      return Boolean(manual || detected);
    }
    if (field === 'contact.hasLocation') {
      const comuna = String(params.contact.comuna || '').trim();
      const ciudad = String(params.contact.ciudad || '').trim();
      const region = String(params.contact.region || '').trim();
      return Boolean(comuna || ciudad || region);
    }
    if (field === 'contact.hasRut') return Boolean(String(params.contact.rut || '').trim());
    if (field === 'contact.hasEmail') return Boolean(String(params.contact.email || '').trim());
    if (field === 'contact.hasAvailability') return Boolean(String(params.contact.availabilityText || '').trim());
    if (field === 'contact.hasExperience') {
      const years = (params.contact as any).experienceYears;
      if (typeof years === 'number' && Number.isFinite(years) && years > 0) return true;
      const terrain = (params.contact as any).terrainExperience;
      if (typeof terrain === 'boolean') return true;
      return false;
    }
    if (field === 'whatsapp.windowStatus') return params.windowStatus;
    if (field === 'inbound.textContains') return normalize(params.inboundText || '');
    return undefined;
  };

  const fieldValue = getFieldValue();
  if (typeof fieldValue === 'undefined') return false;

  if (field === 'inbound.textContains') {
    if (op !== 'contains') return false;
    const hay = String(fieldValue || '');
    const needle = normalize(String(rawValue || ''));
    if (!needle) return false;
    return hay.includes(needle);
  }

  if (field === 'conversation.stageTags') {
    const tags: string[] = Array.isArray(fieldValue) ? fieldValue : [];
    const needle = normalize(String(rawValue || ''));
    if (!needle) return false;
    if (op === 'contains') return tags.includes(needle) || tags.some((t) => t.includes(needle));
    if (op === 'equals') return tags.includes(needle);
    if (op === 'not_equals') return !tags.includes(needle);
    if (op === 'in') {
      const list = Array.isArray(rawValue)
        ? rawValue.map((v) => normalize(String(v)))
        : String(rawValue || '')
            .split(',')
            .map((v) => normalize(v))
            .filter(Boolean);
      return list.some((v) => tags.includes(v));
    }
    return false;
  }

  if (
    field === 'contact.noContactar' ||
    field.startsWith('contact.has')
  ) {
    const lhs = parseBoolean(fieldValue);
    const rhs = parseBoolean(rawValue);
    if (lhs === null || rhs === null) return false;
    if (op === 'equals') return lhs === rhs;
    if (op === 'not_equals') return lhs !== rhs;
    return false;
  }

  if (op === 'equals') {
    return String(fieldValue ?? '') === String(rawValue ?? '');
  }
  if (op === 'not_equals') {
    return String(fieldValue ?? '') !== String(rawValue ?? '');
  }
  if (op === 'contains') {
    const hay = normalize(String(fieldValue ?? ''));
    const needle = normalize(String(rawValue ?? ''));
    if (!needle) return false;
    return hay.includes(needle);
  }
  if (op === 'in') {
    const list = Array.isArray(rawValue)
      ? rawValue.map((v) => String(v))
      : String(rawValue || '')
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
    return list.includes(String(fieldValue ?? ''));
  }

  return false;
}

type RunAutomationsParams = {
  app: FastifyInstance;
  workspaceId: string;
  eventType: string;
  conversationId: string;
  inboundMessageId?: string | null;
  inboundText?: string | null;
  inboundBatchCount?: number;
  inboundDebounceMs?: number;
  lastInboundAt?: string | null;
  transportMode: ExecutorTransportMode;
};

type InboundDebounceState = {
  timer: NodeJS.Timeout | null;
  running: boolean;
  queue: Array<{ inboundMessageId: string | null; inboundText: string | null; at: Date }>;
  waiters: Array<() => void>;
  latestParams: RunAutomationsParams;
  debounceMs: number;
  lastInboundAt: Date;
};

const inboundDebounceByConversation = new Map<string, InboundDebounceState>();
const DEFAULT_INBOUND_DEBOUNCE_MS = 1800;
const MIN_INBOUND_DEBOUNCE_MS = 1500;
const MAX_INBOUND_DEBOUNCE_MS = 3000;

function clampInboundDebounceMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INBOUND_DEBOUNCE_MS;
  return Math.max(MIN_INBOUND_DEBOUNCE_MS, Math.min(MAX_INBOUND_DEBOUNCE_MS, Math.floor(value)));
}

function mergeInboundBatchText(batch: Array<{ inboundText: string | null }>): string | null {
  const chunks: string[] = [];
  for (const item of batch) {
    const text = String(item.inboundText || '').trim();
    if (!text) continue;
    chunks.push(text);
  }
  if (chunks.length === 0) return null;
  const unique: string[] = [];
  for (const chunk of chunks) {
    if (!unique.includes(chunk)) unique.push(chunk);
  }
  return unique.join('\n');
}

async function flushInboundDebounce(key: string): Promise<void> {
  const state = inboundDebounceByConversation.get(key);
  if (!state) return;
  if (state.running) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.queue.length === 0) {
    if (state.waiters.length === 0) inboundDebounceByConversation.delete(key);
    return;
  }

  state.running = true;
  const batch = state.queue.splice(0);
  const waiters = state.waiters.splice(0);
  const latest = state.latestParams;
  const mergedText = mergeInboundBatchText(batch);
  const latestInboundMessageId = [...batch]
    .reverse()
    .map((i) => String(i.inboundMessageId || '').trim())
    .find(Boolean) || null;
  const batchLastInboundAt = [...batch].reverse().find((i) => i.at)?.at || state.lastInboundAt;

  latest.app.log.info(
    {
      workspaceId: latest.workspaceId,
      conversationId: latest.conversationId,
      inboundBatchCount: batch.length,
      debounceMs: state.debounceMs,
      lastInboundAt: batchLastInboundAt.toISOString(),
    },
    'Inbound batch debounce flush (single RUN_AGENT execution)',
  );

  try {
    await runAutomationsImmediate({
      ...latest,
      inboundMessageId: latestInboundMessageId,
      inboundText: mergedText,
      inboundBatchCount: batch.length,
      inboundDebounceMs: state.debounceMs,
      lastInboundAt: batchLastInboundAt.toISOString(),
    });
  } finally {
    state.running = false;
    for (const done of waiters) done();
    if (state.queue.length > 0) {
      state.timer = setTimeout(() => {
        flushInboundDebounce(key).catch((err) => {
          latest.app.log.error({ err, key }, 'Inbound debounce flush failed');
        });
      }, state.debounceMs);
    } else if (state.waiters.length === 0) {
      inboundDebounceByConversation.delete(key);
    }
  }
}

async function runAutomationsWithInboundDebounce(params: RunAutomationsParams): Promise<void> {
  const key = `${params.workspaceId}:${params.conversationId}`;
  const now = new Date();
  const debounceMs = clampInboundDebounceMs(DEFAULT_INBOUND_DEBOUNCE_MS);

  const state =
    inboundDebounceByConversation.get(key) ||
    ({
      timer: null,
      running: false,
      queue: [],
      waiters: [],
      latestParams: params,
      debounceMs,
      lastInboundAt: now,
    } as InboundDebounceState);
  if (!inboundDebounceByConversation.has(key)) inboundDebounceByConversation.set(key, state);

  state.latestParams = params;
  state.debounceMs = debounceMs;
  state.lastInboundAt = now;
  state.queue.push({
    inboundMessageId: params.inboundMessageId ? String(params.inboundMessageId) : null,
    inboundText: params.inboundText ? String(params.inboundText) : null,
    at: now,
  });

  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    flushInboundDebounce(key).catch((err) => {
      params.app.log.error({ err, key }, 'Inbound debounce flush failed');
    });
  }, debounceMs);

  await new Promise<void>((resolve) => {
    state.waiters.push(resolve);
  });
}

async function runAutomationsImmediate(params: RunAutomationsParams): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: params.conversationId },
    include: { contact: true, program: { select: { id: true, name: true, slug: true } } },
  });
  if (!conversation) return;
  if (conversation.workspaceId !== params.workspaceId) return;

  // Data quality pre-pass (determinista): si el inbound trae comuna/ciudad o RUT válido, persistirlo antes del agente
  // para evitar loops (“me falta comuna/ciudad”) cuando ya lo enviaron.
  if (params.eventType === 'INBOUND_MESSAGE' && conversation.contact && typeof params.inboundText === 'string') {
    const inboundText = params.inboundText.trim();
    if (inboundText) {
      const contactUpdates: Record<string, any> = {};

      const loc = resolveLocation(inboundText, 'CL');
      if (loc.confidence >= 0.7) {
        if (!conversation.contact.comuna && loc.comuna) contactUpdates.comuna = loc.comuna;
        if (!conversation.contact.ciudad && loc.ciudad) contactUpdates.ciudad = loc.ciudad;
        if (!conversation.contact.region && loc.region) contactUpdates.region = loc.region;
      }

      if (!conversation.contact.rut) {
        const rut = validateRut(inboundText);
        if (rut.valid && rut.normalized) contactUpdates.rut = rut.normalized;
      }

      if (Object.keys(contactUpdates).length > 0) {
        await prisma.contact
          .update({ where: { id: conversation.contactId }, data: contactUpdates })
          .catch(() => null);
        Object.assign(conversation.contact as any, contactUpdates);
      }
    }
  }

  const lastInbound = await prisma.message.findFirst({
    where: { conversationId: conversation.id, direction: 'INBOUND' },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true },
  });
  const windowStatus = (() => {
    const WINDOW_MS = 24 * 60 * 60 * 1000;
    if (!lastInbound?.timestamp) return 'IN_24H';
    const delta = Date.now() - new Date(lastInbound.timestamp).getTime();
    return delta <= WINDOW_MS ? 'IN_24H' : 'OUTSIDE_24H';
  })();

  if (params.eventType === 'INBOUND_MESSAGE') {
    const forcedMenu = await maybeHandleProgramMenuCommandOrPendingChoice({
      app: params.app,
      workspaceId: params.workspaceId,
      conversation,
      inboundText: params.inboundText || null,
      inboundMessageId: params.inboundMessageId || null,
      windowStatus,
      transportMode: params.transportMode,
    });
    if (forcedMenu.handled) return;

    const selection = await maybeHandleProgramSelection({
      app: params.app,
      workspaceId: params.workspaceId,
      conversation,
      inboundText: params.inboundText || null,
      inboundMessageId: params.inboundMessageId || null,
      windowStatus,
      transportMode: params.transportMode,
    });
    if (selection.handled) return;

    const staffRouter = await maybeHandleStaffDeterministicRouter({
      app: params.app,
      workspaceId: params.workspaceId,
      conversation,
      inboundText: params.inboundText || null,
      inboundMessageId: params.inboundMessageId || null,
      transportMode: params.transportMode,
    });
    if (staffRouter.handled) return;
  }

  const rules = await prisma.automationRule.findMany({
    where: {
      workspaceId: params.workspaceId,
      enabled: true,
      archivedAt: null,
      trigger: params.eventType,
    },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });
  if (rules.length === 0) return;

  for (const rule of rules) {
    if (rule.scopePhoneLineId && rule.scopePhoneLineId !== conversation.phoneLineId) continue;
    if (rule.scopeProgramId && rule.scopeProgramId !== conversation.programId) continue;

    const conditions = safeJsonParse(rule.conditionsJson);
    const rows: ConditionRow[] = Array.isArray(conditions) ? (conditions as any) : [];
    const matches = rows.every((condition) =>
      evaluateCondition({
        condition,
        conversation,
        contact: conversation.contact,
        windowStatus,
        inboundText: params.inboundText || null,
      }),
    );
    if (!matches) continue;

    const runLog = await prisma.automationRunLog.create({
      data: {
        workspaceId: params.workspaceId,
        ruleId: rule.id,
        conversationId: conversation.id,
        eventType: params.eventType,
        status: 'RUNNING',
        inputJson: serializeJson({
          workspaceId: params.workspaceId,
          conversationId: conversation.id,
          inboundMessageId: params.inboundMessageId || null,
          inboundText: params.inboundText || null,
          inboundBatchCount:
            typeof params.inboundBatchCount === 'number' && Number.isFinite(params.inboundBatchCount)
              ? params.inboundBatchCount
              : null,
          inboundDebounceMs:
            typeof params.inboundDebounceMs === 'number' && Number.isFinite(params.inboundDebounceMs)
              ? params.inboundDebounceMs
              : null,
          lastInboundAt: params.lastInboundAt || null,
        }),
      },
    });

    try {
      const actionsRaw = safeJsonParse(rule.actionsJson);
      const actions: ActionRow[] = Array.isArray(actionsRaw) ? (actionsRaw as any) : [];

      const outputs: any[] = [];

      for (const action of actions) {
        if (!action || typeof action !== 'object') continue;
        if (action.type === 'SET_STATUS') {
          await prisma.conversation.update({
            where: { id: conversation.id },
            data: { status: action.status, updatedAt: new Date() },
          });
          outputs.push({ action: 'SET_STATUS', status: action.status });
          continue;
        }
        if (action.type === 'ADD_NOTE') {
          const note = String(action.note || '').trim();
          if (note) {
            await prisma.message.create({
              data: {
                conversationId: conversation.id,
                direction: 'OUTBOUND',
                text: note,
                rawPayload: serializeJson({ system: true, automationRuleId: rule.id }),
                timestamp: new Date(),
                read: true,
              },
            });
            await prisma.conversation.update({
              where: { id: conversation.id },
              data: { updatedAt: new Date() },
            });
          }
          outputs.push({ action: 'ADD_NOTE' });
          continue;
        }
        if (action.type === 'ASSIGN_TO_NURSE_LEADER') {
          if (conversation.isAdmin) {
            outputs.push({ action: 'ASSIGN_TO_NURSE_LEADER', ok: false, error: 'admin_conversation' });
            continue;
          }
          const workspace = await prisma.workspace
            .findUnique({
              where: { id: params.workspaceId },
              select: { ssclinicalNurseLeaderEmail: true as any },
            })
            .catch(() => null);
          const leaderEmailRaw = String((workspace as any)?.ssclinicalNurseLeaderEmail || '').trim().toLowerCase();
          if (!leaderEmailRaw) {
            outputs.push({ action: 'ASSIGN_TO_NURSE_LEADER', ok: false, error: 'missing_workspace_setting' });
            continue;
          }
          const leaderUser = await prisma.user
            .findUnique({ where: { email: leaderEmailRaw }, select: { id: true, email: true, name: true } })
            .catch(() => null);
          if (!leaderUser?.id) {
            outputs.push({ action: 'ASSIGN_TO_NURSE_LEADER', ok: false, error: `user_not_found:${leaderEmailRaw}` });
            continue;
          }
          const membership = await prisma.membership
            .findFirst({
              where: { workspaceId: params.workspaceId, userId: leaderUser.id, archivedAt: null },
              select: { id: true, role: true },
            })
            .catch(() => null);
          if (!membership?.id) {
            outputs.push({ action: 'ASSIGN_TO_NURSE_LEADER', ok: false, error: `membership_not_found:${leaderEmailRaw}` });
            continue;
          }

          const already = String(conversation.assignedToId || '') === String(leaderUser.id);
          if (!already) {
            await prisma.conversation.update({
              where: { id: conversation.id },
              data: { assignedToId: leaderUser.id, updatedAt: new Date() },
            });
            (conversation as any).assignedToId = leaderUser.id;
          }

          const label = leaderUser.name || leaderUser.email || leaderEmailRaw;
          const noteText = String((action as any).note || '').trim();
          const summary = buildConversationSummaryForAssignment({
            conversation,
            programName: conversation.program?.name || null,
          });
          const systemText = noteText
            ? `👩‍⚕️ Asignación automática: ${label}\n${noteText}\n\n${summary}`
            : `👩‍⚕️ Asignación automática: ${label}\n\n${summary}`;
          await prisma.message
            .create({
              data: {
                conversationId: conversation.id,
                direction: 'OUTBOUND',
                text: systemText,
                rawPayload: serializeJson({ system: true, automationRuleId: rule.id, assignment: 'AUTO', assignedToUserId: leaderUser.id }),
                timestamp: new Date(),
                read: true,
              },
            })
            .catch(() => {});
          await prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } }).catch(() => {});

          // In-app notification (idempotent).
          await createInAppNotification({
            workspaceId: params.workspaceId,
            userId: leaderUser.id,
            conversationId: conversation.id,
            type: 'CONVERSATION_ASSIGNED',
            title: `Nuevo caso asignado (${conversation.conversationStage || 'STAGE'})`,
            body: summary,
            data: { conversationId: conversation.id, stage: conversation.conversationStage, assignedToUserId: leaderUser.id },
            dedupeKey: `assign:auto:${conversation.id}:${leaderUser.id}:${String(conversation.conversationStage || '')}`,
          }).catch(() => {});

          outputs.push({
            action: 'ASSIGN_TO_NURSE_LEADER',
            ok: true,
            assignedToUserId: leaderUser.id,
            email: leaderUser.email,
            role: membership.role,
          });
          continue;
        }
        if (action.type === 'NOTIFY_STAFF_WHATSAPP') {
          if (conversation.isAdmin) {
            outputs.push({ action: 'NOTIFY_STAFF_WHATSAPP', ok: false, error: 'admin_conversation' });
            continue;
          }

          const stage = String(conversation.conversationStage || '').trim() || 'STAGE';
          const clientName = getContactDisplayName(conversation.contact);
          const programName = String(conversation.program?.name || '').trim();
          const comuna = String(conversation.contact?.comuna || '').trim();
          const ciudad = String(conversation.contact?.ciudad || '').trim();
          const region = String(conversation.contact?.region || '').trim();
          const location = [comuna, ciudad, region].filter(Boolean).join(' · ');
          const availability = (() => {
            const confirmedAtRaw = (conversation as any).availabilityConfirmedAt || null;
            const parsedRaw = String((conversation as any).availabilityParsedJson || '').trim();
            if (confirmedAtRaw && parsedRaw) {
              try {
                const parsed = JSON.parse(parsedRaw);
                const day = String((parsed as any)?.day || '').trim();
                const range = String((parsed as any)?.timeRange || (parsed as any)?.range || '').trim();
                const date = String((parsed as any)?.date || '').trim();
                const parts = [date || null, day || null, range || null].filter(Boolean);
                const label = parts.join(' ');
                if (label) return label;
              } catch {
                // ignore
              }
            }
            const raw = String((conversation as any).availabilityRaw || '').trim();
            if (raw) return raw;
            return String((conversation.contact as any)?.availabilityText || '').trim();
          })();
          const requireAvailability = Boolean((action as any).requireAvailability);
          if (requireAvailability && !availability) {
            outputs.push({ action: 'NOTIFY_STAFF_WHATSAPP', ok: true, skipped: true, reason: 'require_availability' });
            continue;
          }

          const vars: Record<string, string> = {
            clientName,
            service: programName,
            location,
            availability,
            stage,
            conversationId: conversation.id,
            conversationIdShort: String(conversation.id || '').slice(0, 10),
          };

          const templateRaw = String((action as any).templateText || (action as any).messageTemplate || '').trim();
          const defaultText = [
            `🔔 Caso actualizado: ${vars.stage}`,
            `👤 ${vars.clientName}`,
            vars.service ? `🧭 Servicio: ${vars.service}` : null,
            vars.location ? `📍 Ubicación: ${vars.location}` : null,
            vars.availability ? `⏱️ Preferencia horaria: ${vars.availability}` : null,
            `ID: ${vars.conversationIdShort}`,
            '',
            `Abre Hunter CRM y busca “${vars.clientName}” (o ID ${vars.conversationIdShort}).`,
          ]
            .filter(Boolean)
            .join('\n');
          const text = renderSimpleTemplate(templateRaw || defaultText, vars).trim();

          const dedupePolicy = String((action as any).dedupePolicy || 'DAILY').trim().toUpperCase();
          const today = new Date().toISOString().slice(0, 10);
          const stageChangedAtRaw = (conversation as any).stageChangedAt ? new Date((conversation as any).stageChangedAt) : null;
          const stageStamp = stageChangedAtRaw && Number.isFinite(stageChangedAtRaw.getTime()) ? stageChangedAtRaw.toISOString() : null;
          const defaultDedupeKey =
            dedupePolicy === 'PER_STAGE_CHANGE' && stageStamp
              ? `staff_whatsapp:${conversation.id}:${stage}:${stageStamp}`
              : `staff_whatsapp:${conversation.id}:${stage}:${today}`;
          const dedupeKey = String((action as any).dedupeKey || '').trim() || defaultDedupeKey;

          const resolveRecipientUserIds = async (): Promise<string[]> => {
            const legacyTargetUserIdRaw = String((action as any).targetUserId || '').trim();
            const legacyTargetEmailRaw = String((action as any).targetEmail || '').trim().toLowerCase();
            if (legacyTargetUserIdRaw) return [legacyTargetUserIdRaw];
            if (legacyTargetEmailRaw) {
              const u = await prisma.user.findUnique({ where: { email: legacyTargetEmailRaw }, select: { id: true } }).catch(() => null);
              return u?.id ? [u.id] : [];
            }

            const spec = (action as any).recipients;
            const specType = typeof spec === 'string' ? spec.trim().toUpperCase() : '';
            const objType =
              spec && typeof spec === 'object' && !Array.isArray(spec) ? String((spec as any).type || (spec as any).kind || '').trim().toUpperCase() : '';

            const pickAssigned = () => {
              const id = String(conversation.assignedToId || '').trim();
              return id ? [id] : [];
            };

            if (specType === 'ASSIGNED_TO' || specType === 'ASSIGNEDTO' || specType === 'ASSIGNED' || specType === 'ASSIGNED_TO_ME') {
              return pickAssigned();
            }
            if (specType === 'ALL_STAFF' || specType === 'ALLSTAFF') {
              const rows = await prisma.membership.findMany({
                where: { workspaceId: params.workspaceId, archivedAt: null, staffWhatsAppE164: { not: null } },
                select: { userId: true },
              });
              return rows.map((r) => r.userId);
            }
            if (specType.startsWith('ROLE:')) {
              const role = specType.split(':')[1] || '';
              const rows = await prisma.membership.findMany({
                where: { workspaceId: params.workspaceId, archivedAt: null, role: role.toUpperCase() },
                select: { userId: true },
              });
              return rows.map((r) => r.userId);
            }

            if (objType === 'USER_IDS' || objType === 'USERIDS') {
              const ids = Array.isArray((spec as any).userIds) ? (spec as any).userIds : [];
              return ids.map((v: any) => String(v).trim()).filter(Boolean);
            }
            if (objType === 'ROLE') {
              const role = String((spec as any).role || '').trim().toUpperCase();
              if (!role) return [];
              const rows = await prisma.membership.findMany({
                where: { workspaceId: params.workspaceId, archivedAt: null, role },
                select: { userId: true },
              });
              return rows.map((r) => r.userId);
            }
            if (objType === 'ALL_STAFF') {
              const rows = await prisma.membership.findMany({
                where: { workspaceId: params.workspaceId, archivedAt: null, staffWhatsAppE164: { not: null } },
                select: { userId: true },
              });
              return rows.map((r) => r.userId);
            }
            if (objType === 'ASSIGNED_TO') {
              return pickAssigned();
            }

            // Default: assignedTo (if any).
            return pickAssigned();
          };

          const recipientUserIds = Array.from(new Set((await resolveRecipientUserIds()).filter(Boolean)));
          if (recipientUserIds.length === 0) {
            outputs.push({ action: 'NOTIFY_STAFF_WHATSAPP', ok: false, error: 'no_recipients' });
            continue;
          }

          const staffDefaultProgramId = await resolveWorkspaceProgramForKind({
            workspaceId: params.workspaceId,
            kind: 'STAFF',
            phoneLineId: conversation.phoneLineId,
          })
            .then((r) => r.programId)
            .catch(() => null);

          const perRecipient: any[] = [];
          for (const userId of recipientUserIds) {
            const targetUser = await prisma.user
              .findUnique({ where: { id: userId }, select: { id: true, email: true, name: true } })
              .catch(() => null);
            if (!targetUser?.id) {
              perRecipient.push({ userId, ok: false, error: 'target_user_not_found' });
              continue;
            }

            const membership = await prisma.membership
              .findFirst({
                where: { workspaceId: params.workspaceId, userId: targetUser.id, archivedAt: null },
                select: { id: true, staffWhatsAppE164: true as any },
              })
              .catch(() => null);
            if (!membership?.id) {
              perRecipient.push({ userId: targetUser.id, ok: false, error: 'membership_not_found' });
              continue;
            }

            const staffE164 = String((membership as any).staffWhatsAppE164 || '').trim();
            if (!staffE164) {
              await createInAppNotification({
                workspaceId: params.workspaceId,
                userId: targetUser.id,
                conversationId: conversation.id,
                type: 'STAFF_WHATSAPP_MISSING',
                title: 'WhatsApp de notificaciones no configurado',
                body: 'Configura tu número WhatsApp en Config → Usuarios (formato +569...).',
                data: { conversationId: conversation.id, membershipId: membership.id },
                dedupeKey: `staff_wa_missing:${conversation.id}:${targetUser.id}`,
              }).catch(() => {});
              perRecipient.push({ userId: targetUser.id, ok: false, error: 'missing_staff_whatsapp_e164' });
              continue;
            }

            const staffWaId = normalizeWhatsAppId(staffE164);
            if (!staffWaId) {
              perRecipient.push({ userId: targetUser.id, ok: false, error: 'invalid_staff_whatsapp' });
              continue;
            }

            const staffLabel = String(targetUser.name || targetUser.email || 'Staff');
            const staffThread = await ensureStaffConversation({
              workspaceId: params.workspaceId,
              phoneLineId: conversation.phoneLineId,
              staffWaId,
              staffLabel,
              staffProgramId: staffDefaultProgramId,
            }).catch((err) => {
              params.app.log.warn({ err }, 'ensureStaffConversation failed');
              return null;
            });
            if (!staffThread?.conversation?.id) {
              perRecipient.push({ userId: targetUser.id, ok: false, error: 'staff_conversation_failed' });
              continue;
            }

            const existingOutbound = await prisma.outboundMessageLog
              .findFirst({
                where: { conversationId: staffThread.conversation.id, dedupeKey },
                select: { id: true },
              })
              .catch(() => null);
            if (existingOutbound?.id) {
              perRecipient.push({ userId: targetUser.id, ok: true, deduped: true });
              continue;
            }

            const strictWindow = await computeWhatsAppWindowStatusStrict(staffThread.conversation.id).catch(() => 'OUTSIDE_24H' as const);
            let notifyType: 'SESSION_TEXT' | 'TEMPLATE' = 'SESSION_TEXT';
            let notifyText: string | null = text;
            let notifyTemplateName: string | null = null;
            let notifyTemplateVars: Record<string, string> | null = null;
            if (strictWindow === 'OUTSIDE_24H') {
              const templates = await loadTemplateConfig(undefined, params.workspaceId).catch(() => null);
              const mode = stage.includes('INTERVIEW') ? 'INTERVIEW' : 'RECRUIT';
              const templateName = templates ? selectTemplateForMode(mode as any, templates) : '';
              const templateVarsArr =
                templates && templateName
                  ? resolveTemplateVariables(templateName, undefined, templates, {
                      interviewDay: String((conversation as any).interviewDay || '').trim() || null,
                      interviewTime: String((conversation as any).interviewTime || '').trim() || null,
                      interviewLocation: String((conversation as any).interviewLocation || '').trim() || null,
                      jobTitle: `Nuevo caso ${stage}`,
                    })
                  : [];
              if (!templateName) {
                const textHash = stableHash(`WINDOW:SESSION_TEXT:${text}`);
                await prisma.outboundMessageLog
                  .create({
                    data: {
                      workspaceId: params.workspaceId,
                      conversationId: staffThread.conversation.id,
                      relatedConversationId: conversation.id,
                      agentRunId: null,
                      channel: 'WHATSAPP',
                      type: 'SESSION_TEXT',
                      templateName: null,
                      dedupeKey,
                      textHash,
                      blockedReason: 'OUTSIDE_24H_REQUIRES_TEMPLATE',
                      waMessageId: null,
                    } as any,
                  })
                  .catch(() => {});
                await createInAppNotification({
                  workspaceId: params.workspaceId,
                  userId: targetUser.id,
                  conversationId: conversation.id,
                  type: 'STAFF_WHATSAPP_BLOCKED',
                  title: 'No se pudo enviar WhatsApp (fuera de ventana 24h)',
                  body: 'Configura una plantilla WhatsApp para notificaciones y vuelve a intentar.',
                  data: { blockedReason: 'OUTSIDE_24H_REQUIRES_TEMPLATE', to: staffE164, dedupeKey },
                  dedupeKey: `staff_wa_block:${conversation.id}:${stage}:${today}:${targetUser.id}`,
                }).catch(() => {});
                perRecipient.push({ userId: targetUser.id, ok: true, blocked: true, blockedReason: 'OUTSIDE_24H_REQUIRES_TEMPLATE' });
                continue;
              }
              notifyType = 'TEMPLATE';
              notifyText = null;
              notifyTemplateName = templateName;
              notifyTemplateVars = {};
              templateVarsArr.forEach((v, idx) => {
                (notifyTemplateVars as Record<string, string>)[`var${idx + 1}`] = String(v || '');
              });
            }

            const staffRun = await prisma.agentRunLog.create({
              data: {
                workspaceId: params.workspaceId,
                conversationId: staffThread.conversation.id,
                programId: staffThread.conversation.programId || null,
                phoneLineId: staffThread.conversation.phoneLineId || null,
                eventType: 'STAFF_WHATSAPP_NOTIFICATION',
                status: 'RUNNING',
                inputContextJson: serializeJson({
                  sourceConversationId: conversation.id,
                  automationRuleId: rule.id,
                  targetUserId: targetUser.id,
                  targetEmail: targetUser.email,
                  stage,
                  dedupeKey,
                }),
                commandsJson: serializeJson({
                  agent: 'system_staff_notifier',
                  version: 1,
                  commands: [
                    {
                      command: 'SEND_MESSAGE',
                      conversationId: staffThread.conversation.id,
                      channel: 'WHATSAPP',
                      type: notifyType,
                      ...(notifyType === 'TEMPLATE'
                        ? { templateName: notifyTemplateName || '', templateVars: notifyTemplateVars || {} }
                        : { text: notifyText || text }),
                      dedupeKey,
                    },
                  ],
                }),
              },
            });

            const exec = await executeAgentResponse({
              app: params.app,
              workspaceId: params.workspaceId,
              agentRunId: staffRun.id,
              response: {
                agent: 'system_staff_notifier',
                version: 1,
                commands: [
                  {
                    command: 'SEND_MESSAGE',
                    conversationId: staffThread.conversation.id,
                    channel: 'WHATSAPP',
                    type: notifyType,
                    ...(notifyType === 'TEMPLATE'
                      ? { templateName: notifyTemplateName || '', templateVars: notifyTemplateVars || {} }
                      : { text: notifyText || text }),
                    dedupeKey,
                  } as any,
                ],
              } as any,
              transportMode: params.transportMode,
            });

            const sendResult = exec.results?.[0] || null;
            const blockedReason = (sendResult as any)?.blockedReason || null;
            const blocked = Boolean((sendResult as any)?.blocked);
            const providerResult = (sendResult as any)?.details?.sendResult || null;
            const providerFailed = providerResult && providerResult.success === false;
            const notificationBlockedReason = blocked
              ? blockedReason || 'BLOCKED'
              : providerFailed
                ? `SEND_FAILED:${String(providerResult?.error || 'unknown')}`
                : null;
            const providerMessageId = providerResult && typeof providerResult === 'object' ? (providerResult as any).messageId || null : null;
            await prisma.notificationLog
              .create({
                data: {
                  workspaceId: params.workspaceId,
                  sourceConversationId: conversation.id,
                  targetConversationId: staffThread.conversation.id,
                  targetKind: 'STAFF',
                  targetE164: staffE164,
                  channel: 'WHATSAPP',
                  dedupeKey,
                  templateText: templateRaw || null,
                  renderedText: text,
                  varsJson: serializeJson(vars),
                  blockedReason: notificationBlockedReason,
                  waMessageId: providerMessageId,
                } as any,
              })
              .catch(() => {});

            if (blocked || providerFailed) {
              await createInAppNotification({
                workspaceId: params.workspaceId,
                userId: targetUser.id,
                conversationId: conversation.id,
                type: blocked ? 'STAFF_WHATSAPP_BLOCKED' : 'STAFF_WHATSAPP_FAILED',
                title: blocked ? 'No se pudo enviar WhatsApp al staff' : 'Falló el envío WhatsApp al staff',
                body: blocked
                  ? blockedReason
                    ? `Motivo: ${blockedReason}`
                    : 'Motivo: bloqueo'
                  : String(providerResult?.error || 'Error desconocido'),
                data: { blockedReason: blockedReason || null, to: staffE164, dedupeKey, sendError: providerResult?.error || null },
                dedupeKey: `staff_wa_block:${conversation.id}:${stage}:${today}:${targetUser.id}`,
              }).catch(() => {});
            }

            perRecipient.push({ userId: targetUser.id, ok: true, blocked, blockedReason });
          }

          outputs.push({ action: 'NOTIFY_STAFF_WHATSAPP', ok: true, dedupeKey, recipients: perRecipient });
          continue;
        }
        if (action.type === 'NOTIFY_PARTNER_WHATSAPP') {
          if (conversation.isAdmin) {
            outputs.push({ action: 'NOTIFY_PARTNER_WHATSAPP', ok: false, error: 'admin_conversation' });
            continue;
          }

          const stage = String(conversation.conversationStage || '').trim() || 'STAGE';
          const clientName = getContactDisplayName(conversation.contact);
          const programName = String(conversation.program?.name || '').trim();
          const comuna = String(conversation.contact?.comuna || '').trim();
          const ciudad = String(conversation.contact?.ciudad || '').trim();
          const region = String(conversation.contact?.region || '').trim();
          const location = [comuna, ciudad, region].filter(Boolean).join(' · ');
          const availability = (() => {
            const confirmedAtRaw = (conversation as any).availabilityConfirmedAt || null;
            const parsedRaw = String((conversation as any).availabilityParsedJson || '').trim();
            if (confirmedAtRaw && parsedRaw) {
              try {
                const parsed = JSON.parse(parsedRaw);
                const day = String((parsed as any)?.day || '').trim();
                const range = String((parsed as any)?.timeRange || (parsed as any)?.range || '').trim();
                const date = String((parsed as any)?.date || '').trim();
                const parts = [date || null, day || null, range || null].filter(Boolean);
                const label = parts.join(' ');
                if (label) return label;
              } catch {
                // ignore
              }
            }
            const raw = String((conversation as any).availabilityRaw || '').trim();
            if (raw) return raw;
            return String((conversation.contact as any)?.availabilityText || '').trim();
          })();
          const requireAvailability = Boolean((action as any).requireAvailability);
          if (requireAvailability && !availability) {
            outputs.push({ action: 'NOTIFY_PARTNER_WHATSAPP', ok: true, skipped: true, reason: 'require_availability' });
            continue;
          }

          const vars: Record<string, string> = {
            clientName,
            service: programName,
            location,
            availability,
            stage,
            conversationId: conversation.id,
            conversationIdShort: String(conversation.id || '').slice(0, 10),
          };

          const workspace = await prisma.workspace
            .findFirst({
              where: { id: params.workspaceId, archivedAt: null },
              select: { partnerPhoneE164sJson: true as any, partnerDefaultProgramId: true as any },
            })
            .catch(() => null);
          const partnerDefaultProgramId = (workspace as any)?.partnerDefaultProgramId || null;

          const parseRecipientsList = (raw: any): string[] => {
            const out: string[] = [];
            if (!raw) return out;
            if (Array.isArray(raw)) {
              for (const item of raw) {
                const t = String(item || '').trim();
                if (!t) continue;
                if (!out.includes(t)) out.push(t);
              }
              return out;
            }

            const rawText = String(raw || '').trim();
            if (!rawText) return out;
            const fromJson = safeJsonParseArray(rawText);
            const items = fromJson ?? rawText.split(/[,\n]/g);
            for (const item of items) {
              const t = String(item || '').trim();
              if (!t) continue;
              if (!out.includes(t)) out.push(t);
            }
            return out;
          };

          const resolveRecipients = (): string[] => {
            const spec = (action as any).recipients;
            if (spec === null || typeof spec === 'undefined') {
              return parseRecipientsList((workspace as any)?.partnerPhoneE164sJson ?? null);
            }
            if (typeof spec === 'string') {
              const upper = spec.trim().toUpperCase();
              if (upper === 'ALL_PARTNERS' || upper === 'ALLPARTNERS') {
                return parseRecipientsList((workspace as any)?.partnerPhoneE164sJson ?? null);
              }
            }
            return parseRecipientsList(spec);
          };

          const recipients = resolveRecipients();
          if (recipients.length === 0) {
            outputs.push({ action: 'NOTIFY_PARTNER_WHATSAPP', ok: false, error: 'no_recipients' });
            continue;
          }

          const templateRaw = String((action as any).templateText || '').trim();
          const defaultText = [
            `🔔 Caso actualizado: ${vars.stage}`,
            `👤 ${vars.clientName}`,
            vars.service ? `🧭 Servicio: ${vars.service}` : null,
            vars.location ? `📍 Ubicación: ${vars.location}` : null,
            vars.availability ? `⏱️ Preferencia horaria: ${vars.availability}` : null,
            `ID: ${vars.conversationIdShort}`,
          ]
            .filter(Boolean)
            .join('\n');
          const text = renderSimpleTemplate(templateRaw || defaultText, vars).trim();

          const dedupePolicy = String((action as any).dedupePolicy || 'DAILY').trim().toUpperCase();
          const today = new Date().toISOString().slice(0, 10);
          const stageChangedAtRaw = (conversation as any).stageChangedAt ? new Date((conversation as any).stageChangedAt) : null;
          const stageStamp = stageChangedAtRaw && Number.isFinite(stageChangedAtRaw.getTime()) ? stageChangedAtRaw.toISOString() : null;
          const defaultDedupeKey =
            dedupePolicy === 'PER_STAGE_CHANGE' && stageStamp
              ? `partner_whatsapp:${conversation.id}:${stage}:${stageStamp}`
              : `partner_whatsapp:${conversation.id}:${stage}:${today}`;
          const dedupeKey = String((action as any).dedupeKey || '').trim() || defaultDedupeKey;

          const perRecipient: any[] = [];
          for (const partnerE164Raw of recipients) {
            const partnerE164 = String(partnerE164Raw || '').trim();
            const partnerWaId = normalizeWhatsAppId(partnerE164);
            if (!partnerWaId) {
              perRecipient.push({ to: partnerE164, ok: false, error: 'invalid_partner_whatsapp' });
              continue;
            }

            const partnerLabel = 'Partner';
            const partnerThread = await ensurePartnerConversation({
              workspaceId: params.workspaceId,
              phoneLineId: conversation.phoneLineId,
              partnerWaId,
              partnerLabel,
              partnerProgramId: partnerDefaultProgramId,
            }).catch((err) => {
              params.app.log.warn({ err }, 'ensurePartnerConversation failed');
              return null;
            });
            if (!partnerThread?.conversation?.id) {
              perRecipient.push({ to: partnerE164, ok: false, error: 'partner_conversation_failed' });
              continue;
            }

            const existingOutbound = await prisma.outboundMessageLog
              .findFirst({
                where: { conversationId: partnerThread.conversation.id, dedupeKey },
                select: { id: true },
              })
              .catch(() => null);
            if (existingOutbound?.id) {
              perRecipient.push({ to: partnerE164, ok: true, deduped: true });
              continue;
            }

            const strictWindow = await computeWhatsAppWindowStatusStrict(partnerThread.conversation.id).catch(() => 'OUTSIDE_24H' as const);
            if (strictWindow === 'OUTSIDE_24H') {
              const textHash = stableHash(`WINDOW:SESSION_TEXT:${text}`);
              await prisma.outboundMessageLog
                .create({
                  data: {
                    workspaceId: params.workspaceId,
                    conversationId: partnerThread.conversation.id,
                    relatedConversationId: conversation.id,
                    agentRunId: null,
                    channel: 'WHATSAPP',
                    type: 'SESSION_TEXT',
                    templateName: null,
                    dedupeKey,
                    textHash,
                    blockedReason: 'OUTSIDE_24H_REQUIRES_TEMPLATE',
                    waMessageId: null,
                  } as any,
                })
                .catch(() => {});
              await prisma.notificationLog
                .create({
                  data: {
                    workspaceId: params.workspaceId,
                    sourceConversationId: conversation.id,
                    targetConversationId: partnerThread.conversation.id,
                    targetKind: 'PARTNER',
                    targetE164: partnerE164,
                    channel: 'WHATSAPP',
                    dedupeKey,
                    templateText: templateRaw || null,
                    renderedText: text,
                    varsJson: serializeJson(vars),
                    blockedReason: 'OUTSIDE_24H_REQUIRES_TEMPLATE',
                    waMessageId: null,
                  } as any,
                })
                .catch(() => {});
              if (conversation.assignedToId) {
                await createInAppNotification({
                  workspaceId: params.workspaceId,
                  userId: conversation.assignedToId,
                  conversationId: conversation.id,
                  type: 'PARTNER_WHATSAPP_BLOCKED',
                  title: 'No se pudo enviar WhatsApp al partner (fuera de ventana 24h)',
                  body: partnerE164,
                  data: { blockedReason: 'OUTSIDE_24H_REQUIRES_TEMPLATE', to: partnerE164, dedupeKey },
                  dedupeKey: `partner_wa_block:${conversation.id}:${stage}:${today}:${partnerE164}`,
                }).catch(() => {});
              }
              perRecipient.push({ to: partnerE164, ok: true, blocked: true, blockedReason: 'OUTSIDE_24H_REQUIRES_TEMPLATE' });
              continue;
            }

            const partnerRun = await prisma.agentRunLog.create({
              data: {
                workspaceId: params.workspaceId,
                conversationId: partnerThread.conversation.id,
                programId: partnerThread.conversation.programId || null,
                phoneLineId: partnerThread.conversation.phoneLineId || null,
                eventType: 'PARTNER_WHATSAPP_NOTIFICATION',
                status: 'RUNNING',
                inputContextJson: serializeJson({
                  sourceConversationId: conversation.id,
                  automationRuleId: rule.id,
                  targetE164: partnerE164,
                  stage,
                  dedupeKey,
                }),
                commandsJson: serializeJson({
                  agent: 'system_partner_notifier',
                  version: 1,
                  commands: [
                    {
                      command: 'SEND_MESSAGE',
                      conversationId: partnerThread.conversation.id,
                      channel: 'WHATSAPP',
                      type: 'SESSION_TEXT',
                      text,
                      dedupeKey,
                    },
                  ],
                }),
              },
            });

            const exec = await executeAgentResponse({
              app: params.app,
              workspaceId: params.workspaceId,
              agentRunId: partnerRun.id,
              response: {
                agent: 'system_partner_notifier',
                version: 1,
                commands: [
                  {
                    command: 'SEND_MESSAGE',
                    conversationId: partnerThread.conversation.id,
                    channel: 'WHATSAPP',
                    type: 'SESSION_TEXT',
                    text,
                    dedupeKey,
                  } as any,
                ],
              } as any,
              transportMode: params.transportMode,
            });

            const sendResult = exec.results?.[0] || null;
            const blockedReason = (sendResult as any)?.blockedReason || null;
            const blocked = Boolean((sendResult as any)?.blocked);
            const providerResult = (sendResult as any)?.details?.sendResult || null;
            const providerFailed = providerResult && providerResult.success === false;
            const notificationBlockedReason = blocked
              ? blockedReason || 'BLOCKED'
              : providerFailed
                ? `SEND_FAILED:${String(providerResult?.error || 'unknown')}`
                : null;
            const providerMessageId = providerResult && typeof providerResult === 'object' ? (providerResult as any).messageId || null : null;
            await prisma.notificationLog
              .create({
                data: {
                  workspaceId: params.workspaceId,
                  sourceConversationId: conversation.id,
                  targetConversationId: partnerThread.conversation.id,
                  targetKind: 'PARTNER',
                  targetE164: partnerE164,
                  channel: 'WHATSAPP',
                  dedupeKey,
                  templateText: templateRaw || null,
                  renderedText: text,
                  varsJson: serializeJson(vars),
                  blockedReason: notificationBlockedReason,
                  waMessageId: providerMessageId,
                } as any,
              })
              .catch(() => {});

            if ((blocked || providerFailed) && conversation.assignedToId) {
              await createInAppNotification({
                workspaceId: params.workspaceId,
                userId: conversation.assignedToId,
                conversationId: conversation.id,
                type: blocked ? 'PARTNER_WHATSAPP_BLOCKED' : 'PARTNER_WHATSAPP_FAILED',
                title: blocked ? 'No se pudo enviar WhatsApp al partner' : 'Falló el envío WhatsApp al partner',
                body: blocked
                  ? blockedReason
                    ? `Motivo: ${blockedReason}`
                    : 'Motivo: bloqueo'
                  : String(providerResult?.error || 'Error desconocido'),
                data: { blockedReason: blockedReason || null, to: partnerE164, dedupeKey, sendError: providerResult?.error || null },
                dedupeKey: `partner_wa_block:${conversation.id}:${stage}:${today}:${partnerE164}`,
              }).catch(() => {});
            }

            perRecipient.push({ to: partnerE164, ok: true, blocked, blockedReason });
          }

          outputs.push({ action: 'NOTIFY_PARTNER_WHATSAPP', ok: true, dedupeKey, recipients: perRecipient });
          continue;
        }
        if (action.type === 'RUN_AGENT') {
          const agentRun = await runAgent({
            workspaceId: params.workspaceId,
            conversationId: conversation.id,
            eventType: params.eventType,
            inboundMessageId: params.inboundMessageId || null,
          });
          const workspaceHybrid = await prisma.workspace
            .findUnique({
              where: { id: params.workspaceId },
              select: { hybridApprovalEnabled: true as any },
            })
            .catch(() => null);
          const hybridEnabled = Boolean((workspaceHybrid as any)?.hybridApprovalEnabled);
          const isClientInboundHybrid =
            hybridEnabled &&
            params.transportMode === 'REAL' &&
            params.eventType === 'INBOUND_MESSAGE' &&
            String((conversation as any)?.conversationKind || 'CLIENT').toUpperCase() === 'CLIENT' &&
            !conversation.isAdmin;

          if (!isClientInboundHybrid) {
            const exec = await executeAgentResponse({
              app: params.app,
              workspaceId: params.workspaceId,
              agentRunId: agentRun.runId,
              response: agentRun.response,
              transportMode: params.transportMode,
            });
            outputs.push({
              action: 'RUN_AGENT',
              agentRunId: agentRun.runId,
              results: exec.results,
            });
            continue;
          }

          const allCommands = Array.isArray((agentRun as any)?.response?.commands)
            ? ((agentRun as any).response.commands as any[])
            : [];
          const sendCommands = allCommands.filter((cmd: any) => String(cmd?.command || '').toUpperCase() === 'SEND_MESSAGE');
          const nonSendCommands = allCommands.filter((cmd: any) => String(cmd?.command || '').toUpperCase() !== 'SEND_MESSAGE');

          const nonSendExec =
            nonSendCommands.length > 0
              ? await executeAgentResponse({
                  app: params.app,
                  workspaceId: params.workspaceId,
                  agentRunId: agentRun.runId,
                  response: {
                    ...(agentRun.response as any),
                    commands: nonSendCommands,
                  } as any,
                  transportMode: params.transportMode,
                })
              : { results: [] as any[] };

          const drafts = await enqueueHybridApprovalDrafts({
            app: params.app,
            workspaceId: params.workspaceId,
            conversation,
            inboundMessageId: params.inboundMessageId || null,
            inboundText: params.inboundText || null,
            agentRunId: agentRun.runId,
            sendCommands,
          });

          outputs.push({
            action: 'RUN_AGENT',
            agentRunId: agentRun.runId,
            hybridApproval: true,
            drafts,
            results: nonSendExec.results,
          });
          continue;
        }
      }

      await prisma.automationRunLog.update({
        where: { id: runLog.id },
        data: { status: 'SUCCESS', outputJson: serializeJson({ outputs }) },
      });
    } catch (err) {
      const errorText = err instanceof Error ? err.message : 'unknown';
      await prisma.automationRunLog.update({
        where: { id: runLog.id },
        data: { status: 'ERROR', error: errorText },
      });
    }
  }
}

export async function runAutomations(params: RunAutomationsParams): Promise<void> {
  if (params.eventType === 'INBOUND_MESSAGE' && params.transportMode === 'REAL') {
    await runAutomationsWithInboundDebounce(params);
    return;
  }
  await runAutomationsImmediate(params);
}
