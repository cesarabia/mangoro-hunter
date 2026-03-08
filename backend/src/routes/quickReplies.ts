import { FastifyInstance } from 'fastify';
import { isWorkspaceAdmin, resolveWorkspaceAccess } from '../services/workspaceAuthService';
import { listWorkspaceQuickReplies, saveWorkspaceQuickReplies } from '../services/quickReplyService';
import { serializeJson } from '../utils/json';
import { prisma } from '../db/client';

export async function registerQuickReplyRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const includeInactive = String((request.query as any)?.includeInactive || 'false').trim().toLowerCase() === 'true';
    const rows = await listWorkspaceQuickReplies(access.workspaceId, includeInactive);
    return {
      workspaceId: access.workspaceId,
      quickReplies: rows.map((r) => ({
        id: r.id,
        title: r.title,
        jobRole: r.jobRole,
        stageKey: r.stageKey,
        text: r.text,
        sortOrder: r.sortOrder,
        isActive: r.isActive,
        updatedAt: r.updatedAt,
      })),
    };
  });

  app.put('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const body = (request.body || {}) as { items?: any[] };
    if (!Array.isArray(body.items)) {
      return reply.code(400).send({ error: 'items debe ser un arreglo.' });
    }
    const before = await listWorkspaceQuickReplies(access.workspaceId, true);
    const after = await saveWorkspaceQuickReplies(access.workspaceId, body.items);

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId: (request as any)?.user?.userId ? String((request as any).user.userId) : null,
          type: 'QUICK_REPLIES_UPDATED',
          beforeJson: serializeJson(before),
          afterJson: serializeJson(after),
        } as any,
      })
      .catch(() => {});

    return {
      ok: true,
      workspaceId: access.workspaceId,
      quickReplies: after.map((r) => ({
        id: r.id,
        title: r.title,
        jobRole: r.jobRole,
        stageKey: r.stageKey,
        text: r.text,
        sortOrder: r.sortOrder,
        isActive: r.isActive,
        updatedAt: r.updatedAt,
      })),
    };
  });
}
