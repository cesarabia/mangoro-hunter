import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { resolveWorkspaceAccess, isWorkspaceAdmin } from '../services/workspaceAuthService';

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
        program: { select: { id: true, name: true } },
        phoneLine: { select: { id: true, alias: true } },
      },
    });

    return runs.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      workspaceId: r.workspaceId,
      conversationId: r.conversationId,
      program: r.program ? { id: r.program.id, name: r.program.name } : null,
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
}

