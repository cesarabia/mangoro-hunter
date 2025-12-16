import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { serializeJson } from '../utils/json';
import { executeAgentResponse, ExecutorTransportMode } from './agent/commandExecutorService';
import { runAgent } from './agent/agentRuntimeService';
import { stripAccents } from './agent/tools';

type ConditionRow = { field: string; op: string; value?: any };
type ActionRow =
  | { type: 'RUN_AGENT'; agent?: string }
  | { type: 'SET_STATUS'; status: 'NEW' | 'OPEN' | 'CLOSED' }
  | { type: 'ADD_NOTE'; note: string };

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
    if (field === 'conversation.programId') return params.conversation.programId;
    if (field === 'conversation.phoneLineId') return params.conversation.phoneLineId;
    if (field === 'contact.noContactar') return Boolean(params.contact.noContact);
    if (field === 'whatsapp.windowStatus') return params.windowStatus;
    if (field === 'inbound.textContains') return normalize(params.inboundText || '');
    return undefined;
  };

  const fieldValue = getFieldValue();

  if (field === 'inbound.textContains') {
    if (op !== 'contains') return false;
    const hay = String(fieldValue || '');
    const needle = normalize(String(rawValue || ''));
    if (!needle) return false;
    return hay.includes(needle);
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

