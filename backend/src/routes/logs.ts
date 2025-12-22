import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { resolveWorkspaceAccess, isWorkspaceAdmin } from '../services/workspaceAuthService';
import { listRecentNotificationEvents } from '../services/notificationService';

function safeJsonParse(value: string | null | undefined): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function registerLogRoutes(app: FastifyInstance) {
  app.get('/agent-runs', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const limitRaw = (request.query as any)?.limit;
    const limit = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : 50;
    const take = Number.isFinite(limit) && limit > 0 && limit <= 200 ? limit : 50;

    const runs = await prisma.agentRunLog.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        conversation: { select: { id: true, programId: true, phoneLineId: true } },
        program: { select: { id: true, name: true, slug: true } },
        phoneLine: { select: { id: true, alias: true } },
      },
    });

    return runs.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      workspaceId: r.workspaceId,
      conversationId: r.conversationId,
      program: r.program ? { id: r.program.id, name: r.program.name, slug: (r.program as any).slug } : null,
      phoneLine: r.phoneLine ? { id: r.phoneLine.id, alias: r.phoneLine.alias } : null,
      eventType: r.eventType,
      status: r.status,
      error: r.error,
    }));
  });

  app.get('/agent-runs/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const { id } = request.params as { id: string };

    const run = await prisma.agentRunLog.findFirst({
      where: { id, workspaceId: access.workspaceId },
      include: {
        toolCalls: { orderBy: { createdAt: 'asc' } },
        outboundLogs: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!run) return reply.code(404).send({ error: 'No encontrado' });

    return {
      id: run.id,
      createdAt: run.createdAt.toISOString(),
      workspaceId: run.workspaceId,
      conversationId: run.conversationId,
      programId: run.programId,
      phoneLineId: run.phoneLineId,
      eventType: run.eventType,
      status: run.status,
      error: run.error,
      inputContext: safeJsonParse(run.inputContextJson),
      commands: safeJsonParse(run.commandsJson),
      results: safeJsonParse(run.resultsJson),
      toolCalls: run.toolCalls.map((t) => ({
        id: t.id,
        createdAt: t.createdAt.toISOString(),
        toolName: t.toolName,
        args: safeJsonParse(t.argsJson),
        result: safeJsonParse(t.resultJson),
        error: t.error,
      })),
      outboundMessages: run.outboundLogs.map((o) => ({
        id: o.id,
        createdAt: o.createdAt.toISOString(),
        type: o.type,
        dedupeKey: o.dedupeKey,
        blockedReason: o.blockedReason,
      })),
    };
  });

  app.get('/automation-runs', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const limitRaw = (request.query as any)?.limit;
    const limit = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : 50;
    const take = Number.isFinite(limit) && limit > 0 && limit <= 200 ? limit : 50;

    const runs = await prisma.automationRunLog.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { createdAt: 'desc' },
      take,
    });

    return runs.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      workspaceId: r.workspaceId,
      ruleId: r.ruleId,
      conversationId: r.conversationId,
      eventType: r.eventType,
      status: r.status,
      error: r.error,
    }));
  });

  app.get('/outbound-messages', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const limitRaw = (request.query as any)?.limit;
    const limit = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : 50;
    const take = Number.isFinite(limit) && limit > 0 && limit <= 200 ? limit : 50;

    const conversationIdRaw = (request.query as any)?.conversationId;
    const conversationId = typeof conversationIdRaw === 'string' && conversationIdRaw.trim() ? conversationIdRaw.trim() : null;

    const logs = await prisma.outboundMessageLog.findMany({
      where: { workspaceId: access.workspaceId, ...(conversationId ? { conversationId } : {}) },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        createdAt: true,
        conversationId: true,
        channel: true,
        type: true,
        dedupeKey: true,
        blockedReason: true,
        waMessageId: true,
      },
    });

    return logs.map((o) => ({
      id: o.id,
      createdAt: o.createdAt.toISOString(),
      conversationId: o.conversationId,
      channel: o.channel,
      type: o.type,
      dedupeKey: o.dedupeKey,
      blockedReason: o.blockedReason,
      waMessageId: o.waMessageId,
    }));
  });

  app.get('/copilot-runs', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const limitRaw = (request.query as any)?.limit;
    const limit = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : 50;
    const take = Number.isFinite(limit) && limit > 0 && limit <= 200 ? limit : 50;

    const runs = await prisma.copilotRunLog.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        createdAt: true,
        userId: true,
        threadId: true as any,
        conversationId: true,
        view: true,
        status: true,
        error: true,
        inputText: true,
        responseText: true,
      } as any,
    });

    return runs.map((r: any) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      userId: r.userId,
      threadId: r.threadId || null,
      conversationId: r.conversationId,
      view: r.view,
      status: r.status,
      error: r.error,
      inputText: r.inputText,
      responseText: r.responseText,
    }));
  });

  app.get('/config-changes', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const limitRaw = (request.query as any)?.limit;
    const limit = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : 50;
    const take = Number.isFinite(limit) && limit > 0 && limit <= 200 ? limit : 50;

    const logs = await prisma.configChangeLog.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { createdAt: 'desc' },
      take,
      include: { user: { select: { id: true, email: true, name: true } } },
    });

    return logs.map((l) => ({
      id: l.id,
      createdAt: l.createdAt.toISOString(),
      workspaceId: l.workspaceId,
      user: l.user ? { id: l.user.id, email: l.user.email, name: l.user.name } : null,
      type: l.type,
      before: safeJsonParse(l.beforeJson),
      after: safeJsonParse(l.afterJson),
    }));
  });

  app.get('/notifications', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const limitRaw = (request.query as any)?.limit;
    const limit = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : 50;
    const take = Number.isFinite(limit) && limit > 0 && limit <= 200 ? limit : 50;

    const events = await listRecentNotificationEvents({ workspaceId: access.workspaceId, limit: take });
    return events;
  });

  app.get('/connector-calls', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const limitRaw = (request.query as any)?.limit;
    const limit = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : 50;
    const take = Number.isFinite(limit) && limit > 0 && limit <= 200 ? limit : 50;

    const logs = await prisma.connectorCallLog.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        connector: { select: { id: true, name: true, slug: true } },
        user: { select: { id: true, email: true, name: true } },
      },
    });

    return logs.map((l) => ({
      id: l.id,
      createdAt: l.createdAt.toISOString(),
      workspaceId: l.workspaceId,
      connector: l.connector ? { id: l.connector.id, name: l.connector.name, slug: l.connector.slug } : null,
      user: l.user ? { id: l.user.id, email: l.user.email, name: l.user.name } : null,
      kind: l.kind,
      action: l.action,
      ok: l.ok,
      statusCode: l.statusCode,
      error: l.error,
      request: safeJsonParse(l.requestJson),
      response: safeJsonParse(l.responseJson),
    }));
  });
}
