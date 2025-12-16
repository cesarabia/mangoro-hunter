import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { resolveWorkspaceAccess, isWorkspaceAdmin } from '../services/workspaceAuthService';

export async function registerPhoneLineRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const lines = await prisma.phoneLine.findMany({
      where: { workspaceId: access.workspaceId, archivedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        alias: true,
        phoneE164: true,
        waPhoneNumberId: true,
        wabaId: true,
        defaultProgramId: true,
        isActive: true,
        lastInboundAt: true,
        lastOutboundAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return lines.map((l) => ({
      ...l,
      lastInboundAt: l.lastInboundAt ? l.lastInboundAt.toISOString() : null,
      lastOutboundAt: l.lastOutboundAt ? l.lastOutboundAt.toISOString() : null,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
    }));
  });

  app.post('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as {
      alias?: string;
      phoneE164?: string;
      waPhoneNumberId?: string;
      wabaId?: string | null;
      defaultProgramId?: string | null;
      isActive?: boolean;
    };

    const alias = String(body.alias || '').trim();
    const waPhoneNumberId = String(body.waPhoneNumberId || '').trim();
    const phoneE164 = typeof body.phoneE164 === 'string' ? body.phoneE164.trim() : '';
    if (!alias) return reply.code(400).send({ error: '"alias" es requerido.' });
    if (!waPhoneNumberId) return reply.code(400).send({ error: '"waPhoneNumberId" es requerido.' });

    const created = await prisma.phoneLine.create({
      data: {
        workspaceId: access.workspaceId,
        alias,
        phoneE164: phoneE164 || null,
        waPhoneNumberId,
        wabaId: body.wabaId ? String(body.wabaId).trim() : null,
        defaultProgramId: body.defaultProgramId ? String(body.defaultProgramId).trim() : null,
        isActive: typeof body.isActive === 'boolean' ? body.isActive : true,
      },
    });
    return {
      ...created,
      lastInboundAt: created.lastInboundAt ? created.lastInboundAt.toISOString() : null,
      lastOutboundAt: created.lastOutboundAt ? created.lastOutboundAt.toISOString() : null,
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
      alias?: string;
      phoneE164?: string | null;
      waPhoneNumberId?: string;
      wabaId?: string | null;
      defaultProgramId?: string | null;
      isActive?: boolean;
    };

    const existing = await prisma.phoneLine.findFirst({
      where: { id, workspaceId: access.workspaceId, archivedAt: null },
    });
    if (!existing) return reply.code(404).send({ error: 'No encontrado' });

    const data: Record<string, any> = {};
    if (typeof body.alias === 'string') data.alias = body.alias.trim();
    if (typeof body.phoneE164 !== 'undefined') data.phoneE164 = body.phoneE164 ? String(body.phoneE164).trim() : null;
    if (typeof body.waPhoneNumberId === 'string') data.waPhoneNumberId = body.waPhoneNumberId.trim();
    if (typeof body.wabaId !== 'undefined') data.wabaId = body.wabaId ? String(body.wabaId).trim() : null;
    if (typeof body.defaultProgramId !== 'undefined') data.defaultProgramId = body.defaultProgramId ? String(body.defaultProgramId).trim() : null;
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive;

    const updated = await prisma.phoneLine.update({
      where: { id },
      data,
    });
    return {
      ...updated,
      lastInboundAt: updated.lastInboundAt ? updated.lastInboundAt.toISOString() : null,
      lastOutboundAt: updated.lastOutboundAt ? updated.lastOutboundAt.toISOString() : null,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  });
}

