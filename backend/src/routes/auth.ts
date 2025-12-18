import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { verifyPassword } from '../services/passwordService';
import { resolveWorkspaceAccess } from '../services/workspaceAuthService';

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post('/login', async (request, reply) => {
    try {
      const { email, password } = request.body as { email: string; password: string };

      if (!email || !password) {
        return reply.code(400).send({ error: 'Email and password are required' });
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.passwordHash) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      const isValid = await verifyPassword(password, user.passwordHash);
      if (!isValid) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      const token = app.jwt.sign({ userId: user.id, role: user.role });
      return { token };
    } catch (err) {
      app.log.error({ err }, 'Login failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  app.get('/me', { preValidation: [app.authenticate] }, async (request, reply) => {
    const userId = request.user?.userId ? String(request.user.userId) : null;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true },
    });
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });

    const access = await resolveWorkspaceAccess(request).catch(() => null);
    const workspaceId = access?.workspaceId ? String(access.workspaceId) : 'default';
    const workspace = await prisma.workspace
      .findUnique({
        where: { id: workspaceId },
        select: { id: true, name: true, isSandbox: true, archivedAt: true },
      })
      .catch(() => null);

    return {
      ok: true,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      workspace: {
        id: workspace?.id || workspaceId,
        name: workspace?.name || workspaceId,
        role: access?.role ? String(access.role) : null,
        assignedOnly: Boolean(access?.assignedOnly),
        isSandbox: Boolean(workspace?.isSandbox),
        archivedAt: workspace?.archivedAt ? workspace.archivedAt.toISOString() : null,
      },
    };
  });
}
