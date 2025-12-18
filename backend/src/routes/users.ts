import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { prisma } from '../db/client';
import { hashPassword } from '../services/passwordService';
import { resolveWorkspaceAccess, isWorkspaceAdmin, isWorkspaceOwner } from '../services/workspaceAuthService';

function generateTempPassword(): string {
  return crypto.randomBytes(9).toString('base64url');
}

export async function registerUserRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const memberships = await prisma.membership.findMany({
      where: { workspaceId: access.workspaceId },
      include: { user: true },
      orderBy: { createdAt: 'asc' }
    });

    return memberships.map((m) => ({
      membershipId: m.id,
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      assignedOnly: Boolean((m as any).assignedOnly),
      addedAt: m.createdAt.toISOString(),
      archivedAt: m.archivedAt ? m.archivedAt.toISOString() : null
    }));
  });

  app.post('/invite', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceOwner(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const body = request.body as { email?: string; role?: string; name?: string };
    const email = String(body.email || '').trim().toLowerCase();
    const role = String(body.role || '').trim().toUpperCase() || 'MEMBER';
    if (!email) return reply.code(400).send({ error: '"email" es requerido.' });
    if (!['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'].includes(role)) {
      return reply.code(400).send({ error: 'Role inválido.' });
    }

    let tempPassword: string | null = null;
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      tempPassword = generateTempPassword();
      const passwordHash = await hashPassword(tempPassword);
      user = await prisma.user.create({
        data: {
          email,
          name: body.name ? String(body.name).trim() : email.split('@')[0],
          passwordHash,
          role: 'AGENT'
        }
      });
    }

    const membership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId: access.workspaceId }
    });
    if (membership && !membership.archivedAt) {
      const updated = await prisma.membership.update({
        where: { id: membership.id },
        data: { role }
      });
      return { ok: true, membershipId: updated.id, userId: user.id, tempPassword };
    }

    const created = membership
      ? await prisma.membership.update({
          where: { id: membership.id },
          data: { role, archivedAt: null }
        })
      : await prisma.membership.create({
          data: { userId: user.id, workspaceId: access.workspaceId, role }
        });

    return { ok: true, membershipId: created.id, userId: user.id, tempPassword };
  });

  app.patch('/:membershipId', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceOwner(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const { membershipId } = request.params as { membershipId: string };
    const body = request.body as { role?: string; archived?: boolean; assignedOnly?: boolean };

    const membership = await prisma.membership.findFirst({
      where: { id: membershipId, workspaceId: access.workspaceId }
    });
    if (!membership) return reply.code(404).send({ error: 'No encontrado' });

    const data: Record<string, any> = {};
    if (typeof body.role === 'string') {
      const role = body.role.trim().toUpperCase();
      if (!['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'].includes(role)) {
        return reply.code(400).send({ error: 'Role inválido.' });
      }
      data.role = role;
    }
    if (typeof body.archived === 'boolean') {
      data.archivedAt = body.archived ? new Date() : null;
    }
    if (typeof body.assignedOnly === 'boolean') {
      data.assignedOnly = body.assignedOnly;
    }

    const updated = await prisma.membership.update({ where: { id: membershipId }, data });
    return {
      membershipId: updated.id,
      userId: updated.userId,
      role: updated.role,
      assignedOnly: Boolean((updated as any).assignedOnly),
      archivedAt: updated.archivedAt ? updated.archivedAt.toISOString() : null
    };
  });
}
