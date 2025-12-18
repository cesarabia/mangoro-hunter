import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { resolveWorkspaceAccess, isWorkspaceAdmin } from '../services/workspaceAuthService';
import { serializeJson } from '../utils/json';

function safeJsonParse(value: any): any | null {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function registerAutomationRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return [];
    }
    const rules = await prisma.automationRule.findMany({
      where: { workspaceId: access.workspaceId, archivedAt: null },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });

    const ruleIds = rules.map((r) => r.id);
    const runs = ruleIds.length
      ? await prisma.automationRunLog.findMany({
          where: { workspaceId: access.workspaceId, ruleId: { in: ruleIds } },
          orderBy: { createdAt: 'desc' },
          select: { ruleId: true, status: true, createdAt: true },
        })
      : [];
    const lastRunByRule: Record<string, { status: string; at: string }> = {};
    for (const run of runs) {
      if (!run.ruleId) continue;
      if (lastRunByRule[run.ruleId]) continue;
      lastRunByRule[run.ruleId] = { status: run.status, at: run.createdAt.toISOString() };
    }

    return rules.map((r) => ({
      id: r.id,
      enabled: r.enabled,
      name: r.name,
      trigger: r.trigger,
      scopePhoneLineId: r.scopePhoneLineId,
      scopeProgramId: r.scopeProgramId,
      priority: r.priority,
      conditions: safeJsonParse(r.conditionsJson) ?? [],
      actions: safeJsonParse(r.actionsJson) ?? [],
      lastRunStatus: lastRunByRule[r.id]?.status || null,
      lastRunAt: lastRunByRule[r.id]?.at || null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  });

  app.post('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as {
      name?: string;
      enabled?: boolean;
      priority?: number;
      trigger?: string;
      scopePhoneLineId?: string | null;
      scopeProgramId?: string | null;
      conditions?: any;
      actions?: any;
      conditionsJson?: string;
      actionsJson?: string;
    };

    const name = String(body.name || '').trim();
    if (!name) return reply.code(400).send({ error: '"name" es requerido.' });

    const trigger = String(body.trigger || '').trim();
    if (!trigger) return reply.code(400).send({ error: '"trigger" es requerido.' });

    const conditionsJson =
      typeof body.conditionsJson === 'string'
        ? body.conditionsJson
        : serializeJson(body.conditions ?? []);
    const actionsJson =
      typeof body.actionsJson === 'string' ? body.actionsJson : serializeJson(body.actions ?? []);

    const priority = typeof body.priority === 'number' && Number.isFinite(body.priority) ? Math.floor(body.priority) : 100;

    const created = await prisma.automationRule.create({
      data: {
        workspaceId: access.workspaceId,
        name,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
        priority,
        trigger,
        scopePhoneLineId: body.scopePhoneLineId ? String(body.scopePhoneLineId) : null,
        scopeProgramId: body.scopeProgramId ? String(body.scopeProgramId) : null,
        conditionsJson,
        actionsJson,
      },
    });

    return {
      id: created.id,
      enabled: created.enabled,
      name: created.name,
      trigger: created.trigger,
      scopePhoneLineId: created.scopePhoneLineId,
      scopeProgramId: created.scopeProgramId,
      priority: created.priority,
      conditions: safeJsonParse(created.conditionsJson) ?? [],
      actions: safeJsonParse(created.actionsJson) ?? [],
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  });

  app.patch('/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const { id } = request.params as { id: string };

    const existing = await prisma.automationRule.findFirst({
      where: { id, workspaceId: access.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!existing) return reply.code(404).send({ error: 'No encontrado' });

    const body = request.body as any;
    const data: Record<string, any> = {};
    if (typeof body.name === 'string') data.name = body.name.trim();
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
    if (typeof body.priority === 'number' && Number.isFinite(body.priority)) data.priority = Math.floor(body.priority);
    if (typeof body.trigger === 'string') data.trigger = body.trigger.trim();
    if (typeof body.scopePhoneLineId !== 'undefined') data.scopePhoneLineId = body.scopePhoneLineId ? String(body.scopePhoneLineId) : null;
    if (typeof body.scopeProgramId !== 'undefined') data.scopeProgramId = body.scopeProgramId ? String(body.scopeProgramId) : null;
    if (typeof body.conditionsJson === 'string') data.conditionsJson = body.conditionsJson;
    if (typeof body.actionsJson === 'string') data.actionsJson = body.actionsJson;
    if (typeof body.conditions !== 'undefined' && typeof body.conditionsJson !== 'string') data.conditionsJson = serializeJson(body.conditions);
    if (typeof body.actions !== 'undefined' && typeof body.actionsJson !== 'string') data.actionsJson = serializeJson(body.actions);
    if (typeof body.archivedAt !== 'undefined') data.archivedAt = body.archivedAt ? new Date(body.archivedAt) : null;

    const updated = await prisma.automationRule.update({ where: { id }, data });
    return {
      id: updated.id,
      enabled: updated.enabled,
      name: updated.name,
      trigger: updated.trigger,
      scopePhoneLineId: updated.scopePhoneLineId,
      scopeProgramId: updated.scopeProgramId,
      priority: updated.priority,
      conditions: safeJsonParse(updated.conditionsJson) ?? [],
      actions: safeJsonParse(updated.actionsJson) ?? [],
      archivedAt: updated.archivedAt ? updated.archivedAt.toISOString() : null,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  });

  app.get('/:id/runs', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const { id } = request.params as { id: string };
    const limitRaw = (request.query as any)?.limit;
    const limit = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : 20;
    const take = Number.isFinite(limit) && limit > 0 && limit <= 100 ? limit : 20;

    const rule = await prisma.automationRule.findFirst({
      where: { id, workspaceId: access.workspaceId },
      select: { id: true },
    });
    if (!rule) return reply.code(404).send({ error: 'No encontrado' });

    const runs = await prisma.automationRunLog.findMany({
      where: { workspaceId: access.workspaceId, ruleId: id },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return runs.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      eventType: r.eventType,
      conversationId: r.conversationId,
      status: r.status,
      error: r.error,
      inputJson: safeJsonParse(r.inputJson) ?? r.inputJson,
      outputJson: safeJsonParse(r.outputJson) ?? r.outputJson,
    }));
  });
}
