import { FastifyInstance } from 'fastify';
import { resolveWorkspaceAccess } from '../services/workspaceAuthService';
import {
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
} from '../services/notificationService';

export async function registerNotificationRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const userId = request.user?.userId ? String(request.user.userId) : null;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const q = request.query as any;
    const limit = typeof q?.limit === 'string' ? parseInt(q.limit, 10) : undefined;
    const includeRead = String(q?.includeRead || '').toLowerCase() === 'true';

    const data = await listNotificationsForUser({
      workspaceId: access.workspaceId,
      userId,
      limit,
      includeRead,
    });
    return data;
  });

  app.patch('/:id/read', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const userId = request.user?.userId ? String(request.user.userId) : null;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = request.params as { id: string };
    await markNotificationRead({ workspaceId: access.workspaceId, userId, notificationId: id });
    return { ok: true };
  });

  app.post('/read-all', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const userId = request.user?.userId ? String(request.user.userId) : null;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const res = await markAllNotificationsRead({ workspaceId: access.workspaceId, userId });
    return res;
  });
}

