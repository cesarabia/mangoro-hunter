import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { serializeJson } from '../utils/json';
import { resolveWorkspaceAccess, isWorkspaceAdmin } from '../services/workspaceAuthService';

function slugify(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function safeParseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function safeJsonParse(value: string | null | undefined): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function registerConnectorRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const connectors = await prisma.workspaceConnector.findMany({
      where: { workspaceId: access.workspaceId, archivedAt: null },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        actionsJson: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return connectors.map((c) => ({
      ...c,
      actions: safeParseStringArray(safeJsonParse(c.actionsJson)),
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  });

  app.post('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const body = request.body as {
      name?: string;
      slug?: string;
      description?: string | null;
      isActive?: boolean;
      actions?: string[] | null;
    };

    const name = String(body?.name || '').trim();
    if (!name) return reply.code(400).send({ error: '"name" es requerido.' });

    const slug = slugify(body?.slug ? String(body.slug) : name);
    if (!slug) return reply.code(400).send({ error: '"slug" inválido.' });

    const actions = safeParseStringArray(body?.actions ?? []);

    const created = await prisma.workspaceConnector.create({
      data: {
        workspaceId: access.workspaceId,
        name,
        slug,
        description: body?.description ? String(body.description).trim() : null,
        isActive: typeof body?.isActive === 'boolean' ? body.isActive : true,
        actionsJson: actions.length > 0 ? serializeJson(actions) : null,
      },
      select: { id: true, name: true, slug: true, description: true, actionsJson: true, isActive: true, createdAt: true, updatedAt: true },
    });

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId: request.user?.userId || null,
          type: 'CONNECTOR_CREATED',
          beforeJson: null,
          afterJson: serializeJson({ connectorId: created.id, slug: created.slug }),
        },
      })
      .catch(() => {});

    return {
      ...created,
      actions: safeParseStringArray(safeJsonParse(created.actionsJson)),
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  });

  app.patch('/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string;
      slug?: string;
      description?: string | null;
      isActive?: boolean;
      actions?: string[] | null;
      archivedAt?: string | null;
    };

    const existing = await prisma.workspaceConnector.findFirst({
      where: { id, workspaceId: access.workspaceId },
      select: { id: true, name: true, slug: true, description: true, actionsJson: true, isActive: true, archivedAt: true },
    });
    if (!existing) return reply.code(404).send({ error: 'No encontrado' });

    const data: Record<string, any> = {};
    if (typeof body.name === 'string') data.name = body.name.trim();
    if (typeof body.slug === 'string') data.slug = slugify(body.slug);
    if (typeof body.description !== 'undefined') data.description = body.description ? String(body.description).trim() : null;
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive;
    if (typeof body.actions !== 'undefined') {
      const actions = safeParseStringArray(body.actions ?? []);
      data.actionsJson = actions.length > 0 ? serializeJson(actions) : null;
    }
    if (typeof body.archivedAt !== 'undefined') {
      data.archivedAt = body.archivedAt ? new Date(body.archivedAt) : null;
    }

    const updated = await prisma.workspaceConnector.update({
      where: { id },
      data,
      select: { id: true, name: true, slug: true, description: true, actionsJson: true, isActive: true, archivedAt: true, createdAt: true, updatedAt: true },
    });

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId: request.user?.userId || null,
          type: 'CONNECTOR_UPDATED',
          beforeJson: serializeJson({ id: existing.id, name: existing.name, slug: existing.slug, isActive: existing.isActive, archivedAt: existing.archivedAt }),
          afterJson: serializeJson({ id: updated.id, name: updated.name, slug: updated.slug, isActive: updated.isActive, archivedAt: updated.archivedAt }),
        },
      })
      .catch(() => {});

    return {
      ...updated,
      actions: safeParseStringArray(safeJsonParse(updated.actionsJson)),
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
      archivedAt: updated.archivedAt ? updated.archivedAt.toISOString() : null,
    };
  });
}

