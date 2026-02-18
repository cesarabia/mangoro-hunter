import { FastifyInstance } from 'fastify';
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

export async function runAutomations(params: {
  app: FastifyInstance;
  workspaceId: string;
  eventType: string;
  conversationId: string;
  inboundMessageId?: string | null;
  inboundText?: string | null;
  transportMode: ExecutorTransportMode;
}): Promise<void> {
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
            if (strictWindow === 'OUTSIDE_24H') {
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
                body: 'Para habilitar mensajes libres, pídele al staff que envíe “activar” al número de WhatsApp de SSClinical (abre ventana 24h).',
                data: { blockedReason: 'OUTSIDE_24H_REQUIRES_TEMPLATE', to: staffE164, dedupeKey },
                dedupeKey: `staff_wa_block:${conversation.id}:${stage}:${today}:${targetUser.id}`,
              }).catch(() => {});
              perRecipient.push({ userId: targetUser.id, ok: true, blocked: true, blockedReason: 'OUTSIDE_24H_REQUIRES_TEMPLATE' });
              continue;
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
              agentRunId: staffRun.id,
              response: {
                agent: 'system_staff_notifier',
                version: 1,
                commands: [
                  {
                    command: 'SEND_MESSAGE',
                    conversationId: staffThread.conversation.id,
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
