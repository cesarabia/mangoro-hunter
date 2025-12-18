import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { resolveWorkspaceAccess, isWorkspaceAdmin } from '../services/workspaceAuthService';
import { normalizeChilePhoneE164 } from '../utils/phone';

export async function registerPhoneLineRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const includeArchivedRaw = (request.query as any)?.includeArchived;
    const includeArchived =
      includeArchivedRaw === true ||
      includeArchivedRaw === '1' ||
      includeArchivedRaw === 'true';
    const lines = await prisma.phoneLine.findMany({
      where: { workspaceId: access.workspaceId, ...(includeArchived ? {} : { archivedAt: null }) },
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
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return lines.map((l) => ({
      ...l,
      lastInboundAt: l.lastInboundAt ? l.lastInboundAt.toISOString() : null,
      lastOutboundAt: l.lastOutboundAt ? l.lastOutboundAt.toISOString() : null,
      archivedAt: l.archivedAt ? l.archivedAt.toISOString() : null,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
    }));
  });

  const assertWaPhoneNumberIdNotActiveElsewhere = async (params: {
    workspaceId: string;
    phoneLineId?: string;
    waPhoneNumberId: string;
  }) => {
    const found = await prisma.phoneLine.findFirst({
      where: {
        workspaceId: { not: params.workspaceId },
        waPhoneNumberId: params.waPhoneNumberId,
        isActive: true,
        archivedAt: null,
        ...(params.phoneLineId ? { id: { not: params.phoneLineId } } : {}),
      },
      select: { id: true, workspaceId: true, alias: true },
    });
    if (found?.id) {
      throw new Error(
        `waPhoneNumberId ya está activo en otro workspace (${found.workspaceId} / ${found.alias}). Desactívalo allí antes de activarlo aquí.`
      );
    }
  };

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
    const phoneE164Raw = typeof body.phoneE164 === 'string' ? body.phoneE164 : '';
    if (!alias) return reply.code(400).send({ error: '"alias" es requerido.' });
    if (!waPhoneNumberId) return reply.code(400).send({ error: '"waPhoneNumberId" es requerido.' });

    let phoneE164: string | null = null;
    try {
      phoneE164 = normalizeChilePhoneE164(phoneE164Raw);
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message || 'phoneE164 inválido.' });
    }

    const isActive = typeof body.isActive === 'boolean' ? body.isActive : true;
    if (isActive) {
      try {
        await assertWaPhoneNumberIdNotActiveElsewhere({
          workspaceId: access.workspaceId,
          waPhoneNumberId,
        });
      } catch (err: any) {
        return reply.code(409).send({ error: err?.message || 'waPhoneNumberId en uso en otro workspace.' });
      }
    }

    const created = await prisma.phoneLine.create({
      data: {
        workspaceId: access.workspaceId,
        alias,
        phoneE164,
        waPhoneNumberId,
        wabaId: body.wabaId ? String(body.wabaId).trim() : null,
        defaultProgramId: body.defaultProgramId ? String(body.defaultProgramId).trim() : null,
        isActive,
      },
    });
    return {
      ...created,
      lastInboundAt: created.lastInboundAt ? created.lastInboundAt.toISOString() : null,
      lastOutboundAt: created.lastOutboundAt ? created.lastOutboundAt.toISOString() : null,
      archivedAt: created.archivedAt ? created.archivedAt.toISOString() : null,
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
      archived?: boolean;
    };

    const existing = await prisma.phoneLine.findFirst({
      where: { id, workspaceId: access.workspaceId },
    });
    if (!existing) return reply.code(404).send({ error: 'No encontrado' });

    const data: Record<string, any> = {};
    if (typeof body.alias === 'string') data.alias = body.alias.trim();
    if (typeof body.phoneE164 !== 'undefined') {
      try {
        data.phoneE164 = normalizeChilePhoneE164(body.phoneE164 ?? '');
      } catch (err: any) {
        return reply.code(400).send({ error: err?.message || 'phoneE164 inválido.' });
      }
    }
    if (typeof body.waPhoneNumberId === 'string') data.waPhoneNumberId = body.waPhoneNumberId.trim();
    if (typeof body.wabaId !== 'undefined') data.wabaId = body.wabaId ? String(body.wabaId).trim() : null;
    if (typeof body.defaultProgramId !== 'undefined') data.defaultProgramId = body.defaultProgramId ? String(body.defaultProgramId).trim() : null;
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive;
    if (typeof body.archived === 'boolean') {
      data.archivedAt = body.archived ? new Date() : null;
      if (body.archived) data.isActive = false;
    }

    const nextWaPhoneNumberId = typeof data.waPhoneNumberId === 'string' ? String(data.waPhoneNumberId) : String(existing.waPhoneNumberId);
    const nextIsActive = typeof data.isActive === 'boolean' ? Boolean(data.isActive) : Boolean(existing.isActive);
    const nextArchivedAt = typeof data.archivedAt !== 'undefined' ? data.archivedAt : existing.archivedAt;
    if (nextIsActive && !nextArchivedAt) {
      try {
        await assertWaPhoneNumberIdNotActiveElsewhere({
          workspaceId: access.workspaceId,
          phoneLineId: existing.id,
          waPhoneNumberId: nextWaPhoneNumberId,
        });
      } catch (err: any) {
        return reply.code(409).send({ error: err?.message || 'waPhoneNumberId en uso en otro workspace.' });
      }
    }

    const updated = await prisma.phoneLine.update({
      where: { id },
      data,
    });
    return {
      ...updated,
      lastInboundAt: updated.lastInboundAt ? updated.lastInboundAt.toISOString() : null,
      lastOutboundAt: updated.lastOutboundAt ? updated.lastOutboundAt.toISOString() : null,
      archivedAt: updated.archivedAt ? updated.archivedAt.toISOString() : null,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  });
}
