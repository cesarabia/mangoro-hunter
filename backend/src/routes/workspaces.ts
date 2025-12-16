import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';

export async function registerWorkspaceRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const userId = request.user?.userId as string | undefined;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const isAdmin = request.user?.role === 'ADMIN';
    if (isAdmin) {
      const workspaces = await prisma.workspace.findMany({
        where: { memberships: { some: { userId, archivedAt: null } } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, isSandbox: true, createdAt: true },
      });
      return workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        isSandbox: w.isSandbox,
        createdAt: w.createdAt.toISOString(),
      }));
    }

    const memberships = await prisma.membership.findMany({
      where: { userId, archivedAt: null },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      isSandbox: m.workspace.isSandbox,
      createdAt: m.workspace.createdAt.toISOString(),
      role: m.role,
    }));
  });
}

