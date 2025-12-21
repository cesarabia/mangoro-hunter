import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { resolveWorkspaceAccess, isWorkspaceAdmin, isWorkspaceOwner } from '../services/workspaceAuthService';
import { normalizeChilePhoneE164 } from '../utils/phone';
import { serializeJson } from '../utils/json';

export async function registerPhoneLineRoutes(app: FastifyInstance) {
  const isSandboxWorkspace = async (workspaceId: string): Promise<boolean> => {
    const ws = await prisma.workspace
      .findUnique({ where: { id: workspaceId }, select: { isSandbox: true } })
      .catch(() => null);
    return Boolean(ws?.isSandbox);
  };

  const assertNumericId = (value: string, label: string) => {
    const raw = String(value || '').trim();
    if (!raw) return;
    if (!/^\d+$/.test(raw)) {
      throw new Error(`${label} inválido. Debe ser numérico.`);
    }
  };

  const normalizeInboundMode = (value: unknown): 'DEFAULT' | 'MENU' => {
    const upper = String(value || '').trim().toUpperCase();
    return upper === 'MENU' ? 'MENU' : 'DEFAULT';
  };

  const parseProgramMenuIdsJson = (raw: unknown): string[] => {
    if (!raw || typeof raw !== 'string') return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const out: string[] = [];
      for (const item of parsed) {
        const id = String(item || '').trim();
        if (!id) continue;
        if (!out.includes(id)) out.push(id);
      }
      return out;
    } catch {
      return [];
    }
  };

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
        inboundMode: true as any,
        programMenuIdsJson: true as any,
        isActive: true,
        needsAttention: true,
        lastInboundAt: true,
        lastOutboundAt: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return lines.map((l) => ({
      ...l,
      inboundMode: normalizeInboundMode((l as any).inboundMode),
      programMenuIds: parseProgramMenuIdsJson((l as any).programMenuIdsJson),
      lastInboundAt: l.lastInboundAt ? l.lastInboundAt.toISOString() : null,
      lastOutboundAt: l.lastOutboundAt ? l.lastOutboundAt.toISOString() : null,
      archivedAt: l.archivedAt ? l.archivedAt.toISOString() : null,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
    }));
  });

  const findActiveWaPhoneNumberIdConflict = async (params: {
    workspaceId: string;
    phoneLineId?: string;
    waPhoneNumberId: string;
  }): Promise<{
    conflictWorkspaceId: string;
    conflictWorkspaceName: string | null;
    conflictPhoneLineId: string;
  } | null> => {
    const found = await prisma.phoneLine.findFirst({
      where: {
        workspaceId: { not: params.workspaceId },
        waPhoneNumberId: params.waPhoneNumberId,
        isActive: true,
        archivedAt: null,
        ...(params.phoneLineId ? { id: { not: params.phoneLineId } } : {}),
      },
      select: { id: true, workspaceId: true, alias: true, workspace: { select: { name: true } } },
    });
    if (found?.id) {
      return {
        conflictWorkspaceId: found.workspaceId,
        conflictWorkspaceName: found.workspace?.name || null,
        conflictPhoneLineId: found.id,
      };
    }
    return null;
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
      inboundMode?: string;
      programMenuIds?: string[] | null;
      isActive?: boolean;
    };

    const alias = String(body.alias || '').trim();
    const waPhoneNumberId = String(body.waPhoneNumberId || '').trim();
    const phoneE164Raw = typeof body.phoneE164 === 'string' ? body.phoneE164 : '';
    if (!alias) return reply.code(400).send({ error: '"alias" es requerido.' });
    if (!waPhoneNumberId) return reply.code(400).send({ error: '"waPhoneNumberId" es requerido.' });

    const sandbox = await isSandboxWorkspace(access.workspaceId);
    if (!sandbox) {
      try {
        assertNumericId(waPhoneNumberId, 'waPhoneNumberId');
        if (body.wabaId) assertNumericId(String(body.wabaId), 'wabaId');
      } catch (err: any) {
        return reply.code(400).send({ error: err?.message || 'IDs inválidos.' });
      }
    }

    let phoneE164: string | null = null;
    try {
      phoneE164 = normalizeChilePhoneE164(phoneE164Raw);
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message || 'phoneE164 inválido.' });
    }

    const isActive = typeof body.isActive === 'boolean' ? body.isActive : true;
    if (isActive) {
      const conflict = await findActiveWaPhoneNumberIdConflict({
        workspaceId: access.workspaceId,
        waPhoneNumberId,
      });
      if (conflict) {
        const name = conflict.conflictWorkspaceName || conflict.conflictWorkspaceId;
        return reply.code(409).send({
          error: `waPhoneNumberId ya está activo en otro workspace (${name}).`,
          ...conflict,
        });
      }
    }

    const inboundMode = normalizeInboundMode(body.inboundMode);
    let programMenuIds: string[] = [];
    if (inboundMode === 'MENU' && Array.isArray(body.programMenuIds)) {
      for (const raw of body.programMenuIds) {
        const id = String(raw || '').trim();
        if (!id) continue;
        if (!programMenuIds.includes(id)) programMenuIds.push(id);
      }
      programMenuIds = programMenuIds.slice(0, 20);
      if (programMenuIds.length > 0) {
        const valid = await prisma.program.findMany({
          where: { workspaceId: access.workspaceId, id: { in: programMenuIds }, archivedAt: null, isActive: true },
          select: { id: true },
        });
        const set = new Set(valid.map((p) => p.id));
        programMenuIds = programMenuIds.filter((id) => set.has(id));
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
        inboundMode,
        programMenuIdsJson: inboundMode === 'MENU' && programMenuIds.length > 0 ? serializeJson(programMenuIds) : null,
        isActive,
      },
    });
    return {
      ...created,
      inboundMode: normalizeInboundMode((created as any).inboundMode),
      programMenuIds: parseProgramMenuIdsJson((created as any).programMenuIdsJson),
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
      inboundMode?: string;
      programMenuIds?: string[] | null;
      isActive?: boolean;
      archived?: boolean;
    };

    const existing = await prisma.phoneLine.findFirst({
      where: { id, workspaceId: access.workspaceId },
    });
    if (!existing) return reply.code(404).send({ error: 'No encontrado' });

    const sandbox = await isSandboxWorkspace(access.workspaceId);

    const data: Record<string, any> = {};
    if (typeof body.alias === 'string') data.alias = body.alias.trim();
    if (typeof body.phoneE164 !== 'undefined') {
      try {
        const normalized = normalizeChilePhoneE164(body.phoneE164 ?? '');
        data.phoneE164 = normalized;
        if (normalized) data.needsAttention = false;
      } catch (err: any) {
        return reply.code(400).send({ error: err?.message || 'phoneE164 inválido.' });
      }
    }
    if (typeof body.waPhoneNumberId === 'string') data.waPhoneNumberId = body.waPhoneNumberId.trim();
    if (typeof body.wabaId !== 'undefined') data.wabaId = body.wabaId ? String(body.wabaId).trim() : null;
    if (typeof body.defaultProgramId !== 'undefined') data.defaultProgramId = body.defaultProgramId ? String(body.defaultProgramId).trim() : null;
    if (typeof body.inboundMode !== 'undefined') data.inboundMode = normalizeInboundMode(body.inboundMode);
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive;
    if (typeof body.archived === 'boolean') {
      data.archivedAt = body.archived ? new Date() : null;
      if (body.archived) data.isActive = false;
    }

    const nextInboundMode =
      typeof data.inboundMode === 'string'
        ? normalizeInboundMode(data.inboundMode)
        : normalizeInboundMode((existing as any).inboundMode);
    const hasProgramMenuIds = Object.prototype.hasOwnProperty.call(body || {}, 'programMenuIds');
    const hasInboundMode = Object.prototype.hasOwnProperty.call(body || {}, 'inboundMode');
    if (hasProgramMenuIds || hasInboundMode) {
      if (nextInboundMode !== 'MENU') {
        data.programMenuIdsJson = null;
      } else if (hasProgramMenuIds) {
        let programMenuIds: string[] = [];
        if (Array.isArray(body.programMenuIds)) {
          for (const raw of body.programMenuIds) {
            const id = String(raw || '').trim();
            if (!id) continue;
            if (!programMenuIds.includes(id)) programMenuIds.push(id);
          }
        }
        programMenuIds = programMenuIds.slice(0, 20);
        if (programMenuIds.length > 0) {
          const valid = await prisma.program.findMany({
            where: { workspaceId: access.workspaceId, id: { in: programMenuIds }, archivedAt: null, isActive: true },
            select: { id: true },
          });
          const set = new Set(valid.map((p) => p.id));
          programMenuIds = programMenuIds.filter((id) => set.has(id));
        }
        data.programMenuIdsJson = programMenuIds.length > 0 ? serializeJson(programMenuIds) : null;
      } else {
        // inboundMode changed to MENU but no list provided: keep existing list.
        data.programMenuIdsJson = (existing as any).programMenuIdsJson || null;
      }
    }

    const nextWaPhoneNumberId = typeof data.waPhoneNumberId === 'string' ? String(data.waPhoneNumberId) : String(existing.waPhoneNumberId);
    const nextIsActive = typeof data.isActive === 'boolean' ? Boolean(data.isActive) : Boolean(existing.isActive);
    const nextArchivedAt = typeof data.archivedAt !== 'undefined' ? data.archivedAt : existing.archivedAt;
    const enabling = !existing.isActive && nextIsActive;
    const needsAttention = Boolean((existing as any).needsAttention) && (typeof data.needsAttention === 'undefined' ? true : Boolean(data.needsAttention));
    if (enabling && needsAttention) {
      return reply
        .code(400)
        .send({
          error:
            'Este número requiere revisión (needsAttention). Corrige phoneE164 antes de activarlo.',
        });
    }
    if (nextIsActive && !nextArchivedAt) {
      if (!sandbox) {
        try {
          assertNumericId(nextWaPhoneNumberId, 'waPhoneNumberId');
          if (typeof data.wabaId === 'string' && data.wabaId) assertNumericId(String(data.wabaId), 'wabaId');
        } catch (err: any) {
          return reply.code(400).send({ error: err?.message || 'IDs inválidos.' });
        }
      }

      const conflict = await findActiveWaPhoneNumberIdConflict({
        workspaceId: access.workspaceId,
        phoneLineId: existing.id,
        waPhoneNumberId: nextWaPhoneNumberId,
      });
      if (conflict) {
        const name = conflict.conflictWorkspaceName || conflict.conflictWorkspaceId;
        return reply.code(409).send({
          error: `waPhoneNumberId ya está activo en otro workspace (${name}).`,
          ...conflict,
        });
      }
    }

    const updated = await prisma.phoneLine.update({
      where: { id },
      data,
    });
    return {
      ...updated,
      inboundMode: normalizeInboundMode((updated as any).inboundMode),
      programMenuIds: parseProgramMenuIdsJson((updated as any).programMenuIdsJson),
      lastInboundAt: updated.lastInboundAt ? updated.lastInboundAt.toISOString() : null,
      lastOutboundAt: updated.lastOutboundAt ? updated.lastOutboundAt.toISOString() : null,
      archivedAt: updated.archivedAt ? updated.archivedAt.toISOString() : null,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  });

  // Move a waPhoneNumberId from another workspace to the current one (archive-only).
  app.post('/move', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceOwner(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const userId = request.user?.userId ? String(request.user.userId) : null;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const body = request.body as {
      conflictWorkspaceId?: string;
      conflictPhoneLineId?: string;
      alias?: string;
      phoneE164?: string | null;
      waPhoneNumberId?: string;
      wabaId?: string | null;
      defaultProgramId?: string | null;
      inboundMode?: string;
      programMenuIds?: string[] | null;
      isActive?: boolean;
    };

    const conflictWorkspaceId = String(body?.conflictWorkspaceId || '').trim();
    const conflictPhoneLineId = String(body?.conflictPhoneLineId || '').trim();
    const alias = String(body?.alias || '').trim();
    const waPhoneNumberId = String(body?.waPhoneNumberId || '').trim();
    const sandbox = await isSandboxWorkspace(access.workspaceId);
    if (!conflictWorkspaceId || !conflictPhoneLineId) {
      return reply.code(400).send({ error: 'conflictWorkspaceId y conflictPhoneLineId son requeridos.' });
    }
    if (conflictWorkspaceId === access.workspaceId) {
      return reply.code(400).send({ error: 'El conflicto debe venir de otro workspace.' });
    }
    if (!alias) return reply.code(400).send({ error: '"alias" es requerido.' });
    if (!waPhoneNumberId) return reply.code(400).send({ error: '"waPhoneNumberId" es requerido.' });

    if (!sandbox) {
      try {
        assertNumericId(waPhoneNumberId, 'waPhoneNumberId');
        if (body?.wabaId) assertNumericId(String(body.wabaId), 'wabaId');
      } catch (err: any) {
        return reply.code(400).send({ error: err?.message || 'IDs inválidos.' });
      }
    }

    let phoneE164: string | null = null;
    try {
      phoneE164 = normalizeChilePhoneE164(typeof body.phoneE164 === 'string' ? body.phoneE164 : '');
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message || 'phoneE164 inválido.' });
    }

    const inboundMode = normalizeInboundMode(body.inboundMode);
    let programMenuIds: string[] = [];
    if (inboundMode === 'MENU' && Array.isArray(body.programMenuIds)) {
      for (const raw of body.programMenuIds) {
        const id = String(raw || '').trim();
        if (!id) continue;
        if (!programMenuIds.includes(id)) programMenuIds.push(id);
      }
      programMenuIds = programMenuIds.slice(0, 20);
      if (programMenuIds.length > 0) {
        const valid = await prisma.program.findMany({
          where: { workspaceId: access.workspaceId, id: { in: programMenuIds }, archivedAt: null, isActive: true },
          select: { id: true },
        });
        const set = new Set(valid.map((p) => p.id));
        programMenuIds = programMenuIds.filter((id) => set.has(id));
      }
    }

    // Permission on source workspace (global ADMIN OR membership OWNER).
    if (String(request.user?.role || '').toUpperCase() !== 'ADMIN') {
      const srcMembership = await prisma.membership.findFirst({
        where: { userId, workspaceId: conflictWorkspaceId, archivedAt: null },
        select: { role: true },
      });
      const ok = srcMembership && String(srcMembership.role || '').toUpperCase() === 'OWNER';
      if (!ok) return reply.code(403).send({ error: 'Forbidden (sin permisos para mover desde el workspace origen)' });
    }

    const now = new Date();
    try {
      const result = await prisma.$transaction(async (tx) => {
        const conflict = await tx.phoneLine.findFirst({
          where: {
            id: conflictPhoneLineId,
            workspaceId: conflictWorkspaceId,
            waPhoneNumberId,
            isActive: true,
            archivedAt: null,
          },
          select: { id: true, workspaceId: true, alias: true, waPhoneNumberId: true },
        });
        if (!conflict) {
          throw new Error('No se encontró una PhoneLine activa en el workspace origen con ese waPhoneNumberId.');
        }

        // Archive origin line.
        await tx.phoneLine.update({
          where: { id: conflict.id },
          data: { archivedAt: now, isActive: false },
        });

        // Ensure no other active conflicts remain.
        const still = await tx.phoneLine.findFirst({
          where: {
            waPhoneNumberId,
            isActive: true,
            archivedAt: null,
            workspaceId: { not: access.workspaceId },
          },
          select: { id: true, workspaceId: true },
        });
        if (still?.id) {
          throw new Error('waPhoneNumberId sigue activo en otro workspace. Revisa duplicados antes de mover.');
        }

        // Upsert into target workspace (unique by workspaceId+waPhoneNumberId).
        const existing = await tx.phoneLine.findFirst({
          where: { workspaceId: access.workspaceId, waPhoneNumberId },
          select: { id: true },
        });
        const isActive = typeof body.isActive === 'boolean' ? body.isActive : true;
        const updated = existing?.id
          ? await tx.phoneLine.update({
              where: { id: existing.id },
              data: {
                alias,
                phoneE164,
                waPhoneNumberId,
                wabaId: body.wabaId ? String(body.wabaId).trim() : null,
                defaultProgramId: body.defaultProgramId ? String(body.defaultProgramId).trim() : null,
                inboundMode,
                programMenuIdsJson: inboundMode === 'MENU' && programMenuIds.length > 0 ? serializeJson(programMenuIds) : null,
                isActive,
                archivedAt: null,
              },
            })
          : await tx.phoneLine.create({
              data: {
                workspaceId: access.workspaceId,
                alias,
                phoneE164,
                waPhoneNumberId,
                wabaId: body.wabaId ? String(body.wabaId).trim() : null,
                defaultProgramId: body.defaultProgramId ? String(body.defaultProgramId).trim() : null,
                inboundMode,
                programMenuIdsJson: inboundMode === 'MENU' && programMenuIds.length > 0 ? serializeJson(programMenuIds) : null,
                isActive,
              },
            });

        await tx.configChangeLog
          .create({
            data: {
              workspaceId: access.workspaceId,
              userId,
              type: 'PHONE_LINE_MOVED_IN',
              beforeJson: serializeJson({ waPhoneNumberId, fromWorkspaceId: conflictWorkspaceId, fromPhoneLineId: conflictPhoneLineId }),
              afterJson: serializeJson({ waPhoneNumberId, toWorkspaceId: access.workspaceId, toPhoneLineId: updated.id }),
            },
          })
          .catch(() => {});
        await tx.configChangeLog
          .create({
            data: {
              workspaceId: conflictWorkspaceId,
              userId,
              type: 'PHONE_LINE_MOVED_OUT',
              beforeJson: serializeJson({ waPhoneNumberId, fromWorkspaceId: conflictWorkspaceId, fromPhoneLineId: conflictPhoneLineId }),
              afterJson: serializeJson({ waPhoneNumberId, toWorkspaceId: access.workspaceId, toPhoneLineId: updated.id }),
            },
          })
          .catch(() => {});

        return updated;
      });

      return {
        ok: true,
        phoneLine: {
          ...result,
          lastInboundAt: result.lastInboundAt ? result.lastInboundAt.toISOString() : null,
          lastOutboundAt: result.lastOutboundAt ? result.lastOutboundAt.toISOString() : null,
          archivedAt: result.archivedAt ? result.archivedAt.toISOString() : null,
          createdAt: result.createdAt.toISOString(),
          updatedAt: result.updatedAt.toISOString(),
        },
      };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message || 'No se pudo mover la PhoneLine.' });
    }
  });
}
