import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import {
  getAdminWaIdAllowlist,
  getEffectiveOutboundAllowlist,
  getOutboundAllowlist,
  getOutboundPolicy,
  getSystemConfig,
  getTestWaIdAllowlist,
  updateOutboundSafetyConfig,
} from './configService';
import { archiveConversation } from './conversationArchiveService';
import { loadWorkflowRules, matchRule, WorkflowStage, getWorkflowArchiveDays, getWorkflowInactivityDays } from './workflowService';

function normalizeStage(raw: string | null | undefined): WorkflowStage {
  const value = String(raw || '').trim().toUpperCase();
  const allowed: WorkflowStage[] = [
    'NEW_INTAKE',
    'WAITING_CANDIDATE',
    'RECRUIT_COMPLETE',
    'DISQUALIFIED',
    'STALE_NO_RESPONSE',
    'ARCHIVED'
  ];
  return (allowed.find((s) => s === value) as WorkflowStage) || 'NEW_INTAKE';
}

export function startWorkflowSchedulers(app: FastifyInstance) {
  const intervalMs = 60 * 60 * 1000; // hourly
  setInterval(() => {
    runInactivityWorkflow(app).catch((err) => {
      app.log.warn({ err }, 'Inactivity workflow failed');
    });
  }, intervalMs).unref();

  // TEMP_OFF auto-revert: limpia outboundAllowAllUntil expirado y deja auditoría.
  const tempOffIntervalMs = 60 * 1000; // 1 min
  setInterval(() => {
    runOutboundTempOffExpiry(app).catch((err) => {
      app.log.warn({ err }, 'Outbound TEMP_OFF expiry check failed');
    });
  }, tempOffIntervalMs).unref();

  // Kick once on boot.
  runInactivityWorkflow(app).catch((err) => {
    app.log.warn({ err }, 'Inactivity workflow initial run failed');
  });
  runOutboundTempOffExpiry(app).catch((err) => {
    app.log.warn({ err }, 'Outbound TEMP_OFF expiry initial run failed');
  });
}

export async function runInactivityWorkflow(app: FastifyInstance): Promise<{ evaluated: number; updated: number }> {
  const config = await getSystemConfig();
  const rules = loadWorkflowRules(config);
  const inactivityDaysThreshold = getWorkflowInactivityDays(config);
  const archiveDaysThreshold = getWorkflowArchiveDays(config);

  const candidates = await prisma.conversation.findMany({
    where: {
      isAdmin: false,
      status: { in: ['NEW', 'OPEN'] },
      conversationStage: { in: ['NEW_INTAKE', 'WAITING_CANDIDATE', 'STALE_NO_RESPONSE'] }
    },
    select: { id: true, conversationStage: true, updatedAt: true }
  });
  if (candidates.length === 0) return { evaluated: 0, updated: 0 };

  const ids = candidates.map((c) => c.id);
  const lastInbound = await prisma.message.groupBy({
    by: ['conversationId'],
    where: { conversationId: { in: ids }, direction: 'INBOUND' },
    _max: { timestamp: true }
  });
  const lastInboundMap = lastInbound.reduce<Record<string, Date>>((acc, row) => {
    const ts = (row as any)._max?.timestamp as Date | null;
    if (ts) acc[row.conversationId] = ts;
    return acc;
  }, {});

  const now = Date.now();
  let updated = 0;

  for (const convo of candidates) {
    const stage = normalizeStage(convo.conversationStage);
    if (stage === 'ARCHIVED') continue;

    const lastAt = lastInboundMap[convo.id]?.getTime() ?? convo.updatedAt.getTime();
    const days = Math.floor((now - lastAt) / (24 * 60 * 60 * 1000));

    for (const rule of rules) {
      const effectiveDaysGte =
        rule.id === 'stale_no_response'
          ? inactivityDaysThreshold
          : rule.id === 'auto_archive'
            ? archiveDaysThreshold
            : rule.conditions.inactivityDaysGte;

      const matched = matchRule({
        rule: {
          ...rule,
          conditions: { ...rule.conditions, inactivityDaysGte: effectiveDaysGte }
        },
        trigger: 'onInactivity',
        stage,
        minimumComplete: false,
        missingFields: [],
        inactivityDays: days
      });
      if (!matched) continue;

      const nextStage = rule.actions.setStage ? normalizeStage(rule.actions.setStage) : stage;
      if (nextStage === stage) break;

      if (nextStage === 'ARCHIVED') {
        await archiveConversation({
          conversationId: convo.id,
          reason: `INACTIVITY_${days}D`,
          tags: ['INACTIVITY'],
          summary: `Archivado por inactividad (${days} días).`
        });
        updated += 1;
        break;
      }

      await prisma.conversation.update({
        where: { id: convo.id },
        data: {
          conversationStage: nextStage,
          stageReason: `RULE:${rule.id}`,
          updatedAt: new Date()
        }
      });
      updated += 1;
      break;
    }
  }

  if (updated > 0) {
    app.log.info({ updated }, 'Inactivity workflow updated conversations');
  }

  return { evaluated: candidates.length, updated };
}

export async function runOutboundTempOffExpiry(app: FastifyInstance): Promise<{ cleared: boolean; previousUntil: string | null }> {
  const cfg = await getSystemConfig().catch(() => null);
  if (!cfg) return { cleared: false, previousUntil: null };

  const untilRaw = (cfg as any).outboundAllowAllUntil as Date | string | null | undefined;
  if (!untilRaw) return { cleared: false, previousUntil: null };

  const until = untilRaw instanceof Date ? untilRaw : new Date(String(untilRaw));
  if (!Number.isFinite(until.getTime())) {
    // Valor inválido: limpiamos para evitar quedar en estado raro.
    await updateOutboundSafetyConfig({ outboundAllowAllUntil: null }).catch(() => {});
    return { cleared: true, previousUntil: null };
  }

  if (until.getTime() > Date.now()) {
    return { cleared: false, previousUntil: until.toISOString() };
  }

  const snapshot = (config: any) =>
    config
      ? {
          outboundPolicyStored: (config as any).outboundPolicy || null,
          outboundPolicyEffective: getOutboundPolicy(config),
          outboundAllowlist: getOutboundAllowlist(config),
          outboundAllowAllUntil: (config as any).outboundAllowAllUntil
            ? new Date((config as any).outboundAllowAllUntil).toISOString()
            : null,
          effectiveAllowlist: getEffectiveOutboundAllowlist(config),
          adminNumbers: getAdminWaIdAllowlist(config),
          testNumbers: getTestWaIdAllowlist(config),
        }
      : null;

  const before = snapshot(cfg);
  const updated = await updateOutboundSafetyConfig({ outboundAllowAllUntil: null }).catch(() => null);
  if (!updated) return { cleared: false, previousUntil: until.toISOString() };
  const after = snapshot(updated);

  // ConfigChangeLog es por workspace; usamos "default" como workspace base (sistema).
  await prisma.configChangeLog
    .create({
      data: {
        workspaceId: 'default',
        userId: null,
        type: 'OUTBOUND_SAFETY_TEMP_OFF_EXPIRED',
        beforeJson: before ? JSON.stringify(before) : null,
        afterJson: after ? JSON.stringify(after) : null,
      },
    })
    .catch((err) => {
      app.log.warn({ err }, 'Failed to log OUTBOUND_SAFETY_TEMP_OFF_EXPIRED');
    });

  app.log.info({ previousUntil: until.toISOString() }, 'Outbound TEMP_OFF expired; SAFE MODE restored');
  return { cleared: true, previousUntil: until.toISOString() };
}
