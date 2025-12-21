import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { serializeJson } from '../utils/json';
import { executeAgentResponse, ExecutorTransportMode } from './agent/commandExecutorService';
import { runAgent } from './agent/agentRuntimeService';
import { stableHash, stripAccents } from './agent/tools';

type ProgramSummary = { id: string; name: string; slug: string };

async function listActivePrograms(workspaceId: string): Promise<ProgramSummary[]> {
  return prisma.program.findMany({
    where: { workspaceId, isActive: true, archivedAt: null },
    select: { id: true, name: true, slug: true },
    orderBy: { name: 'asc' },
  });
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

  const programsAll = await listActivePrograms(params.workspaceId);
  const programs = params.conversation.isAdmin
    ? programsAll
    : programsAll.filter((p) => normalizeLoose(p.slug) !== 'admin');
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
    return { handled: false, selectedProgramId: choice.id };
  }

  // If we can't resolve, ask a short menu and stop here.
  const menuLines = programs.map((p, idx) => `${idx + 1}) ${p.name}`).join('\n');
  const menuText =
    `¿Sobre qué programa necesitas ayuda?\nResponde con el número:\n${menuLines}`.trim();

  const agentRun = await prisma.agentRunLog.create({
    data: {
      workspaceId: params.workspaceId,
      conversationId: params.conversation.id,
      programId: null,
      phoneLineId: params.conversation.phoneLineId || null,
      eventType: 'PROGRAM_SELECTION',
      status: 'RUNNING',
      inputContextJson: serializeJson({
        reason: 'programId_missing',
        inboundMessageId: params.inboundMessageId || null,
        inboundText: inbound || null,
        programs: programs.map((p) => ({ id: p.id, name: p.name, slug: p.slug })),
      }),
      commandsJson: serializeJson({
        agent: 'system_program_selector',
        version: 1,
        commands: [
          {
            command: 'SET_CONVERSATION_STAGE',
            conversationId: params.conversation.id,
            stage: 'PROGRAM_SELECTION',
            reason: 'awaiting_program_choice',
          },
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
          command: 'SET_CONVERSATION_STAGE',
          conversationId: params.conversation.id,
          stage: 'PROGRAM_SELECTION',
          reason: 'awaiting_program_choice',
        } as any,
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

  return { handled: true };
}

type ConditionRow = { field: string; op: string; value?: any };
type ActionRow =
  | { type: 'RUN_AGENT'; agent?: string }
  | { type: 'SET_STATUS'; status: 'NEW' | 'OPEN' | 'CLOSED' }
  | { type: 'ADD_NOTE'; note: string }
  | { type: 'ASSIGN_TO_NURSE_LEADER'; note?: string };

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
    include: { contact: true },
  });
  if (!conversation) return;
  if (conversation.workspaceId !== params.workspaceId) return;

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
          }

          const label = leaderUser.name || leaderUser.email || leaderEmailRaw;
          const noteText = String((action as any).note || '').trim();
          const systemText = noteText
            ? `👩‍⚕️ Asignación automática: ${label}\n${noteText}`
            : `👩‍⚕️ Asignación automática: ${label}`;
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

          outputs.push({
            action: 'ASSIGN_TO_NURSE_LEADER',
            ok: true,
            assignedToUserId: leaderUser.id,
            email: leaderUser.email,
            role: membership.role,
          });
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
