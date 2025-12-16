import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { resolveWorkspaceAccess, isWorkspaceAdmin } from '../services/workspaceAuthService';

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export async function registerProgramRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request) => {
    const access = await resolveWorkspaceAccess(request);
    const programs = await prisma.program.findMany({
      where: { workspaceId: access.workspaceId, archivedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        isActive: true,
        agentSystemPrompt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return programs.map((p) => ({
      ...p,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }));
  });

  app.post('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as {
      name?: string;
      slug?: string;
      description?: string | null;
      isActive?: boolean;
      agentSystemPrompt?: string;
    };

    const name = String(body.name || '').trim();
    if (!name) return reply.code(400).send({ error: '"name" es requerido.' });

    const slug = body.slug ? slugify(String(body.slug)) : slugify(name);
    if (!slug) return reply.code(400).send({ error: '"slug" inválido.' });

    const agentSystemPrompt = String(body.agentSystemPrompt || '').trim();
    if (!agentSystemPrompt) return reply.code(400).send({ error: '"agentSystemPrompt" es requerido.' });

    const created = await prisma.program.create({
      data: {
        workspaceId: access.workspaceId,
        name,
        slug,
        description: body.description ? String(body.description).trim() : null,
        isActive: typeof body.isActive === 'boolean' ? body.isActive : true,
        agentSystemPrompt,
      },
    });

    return {
      ...created,
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
    const body = request.body as {
      name?: string;
      slug?: string;
      description?: string | null;
      isActive?: boolean;
      agentSystemPrompt?: string;
      archivedAt?: string | null;
    };

    const existing = await prisma.program.findFirst({
      where: { id, workspaceId: access.workspaceId },
      select: { id: true, archivedAt: true },
    });
    if (!existing) return reply.code(404).send({ error: 'No encontrado' });

    const data: Record<string, any> = {};
    if (typeof body.name === 'string') data.name = body.name.trim();
    if (typeof body.slug === 'string') data.slug = slugify(body.slug);
    if (typeof body.description !== 'undefined') data.description = body.description ? String(body.description).trim() : null;
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive;
    if (typeof body.agentSystemPrompt === 'string') data.agentSystemPrompt = body.agentSystemPrompt;
    if (typeof body.archivedAt !== 'undefined') {
      data.archivedAt = body.archivedAt ? new Date(body.archivedAt) : null;
    }

    const updated = await prisma.program.update({ where: { id }, data });
    return {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
      archivedAt: updated.archivedAt ? updated.archivedAt.toISOString() : null,
    };
  });
}

