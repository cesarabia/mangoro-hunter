import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { prisma } from '../db/client';
import { hashPassword } from '../services/passwordService';
import { resolveWorkspaceAccess, isWorkspaceOwner } from '../services/workspaceAuthService';
import { serializeJson } from '../utils/json';

function normalizeEmail(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function normalizeRole(value: unknown): 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' | null {
  const role = String(value || '').trim().toUpperCase();
  if (role === 'OWNER' || role === 'ADMIN' || role === 'MEMBER' || role === 'VIEWER') return role;
  return null;
}

function normalizeAssignedOnly(value: unknown): boolean {
  return value === true;
}

function generateInviteToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

function buildInviteUrl(token: string): string {
  const base = process.env.PUBLIC_BASE_URL || 'https://hunter.mangoro.app';
  return `${base.replace(/\/+$/g, '')}/invite/${token}`;
}

export async function registerInviteRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceOwner(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const includeArchivedRaw = (request.query as any)?.includeArchived;
    const includeArchived =
      includeArchivedRaw === true ||
      includeArchivedRaw === '1' ||
      includeArchivedRaw === 'true';

    const invites = await prisma.workspaceInvite.findMany({
      where: { workspaceId: access.workspaceId, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        email: true,
        role: true,
        assignedOnly: true as any,
        expiresAt: true,
        acceptedAt: true,
        archivedAt: true,
        createdAt: true,
        createdByUserId: true,
        acceptedByUserId: true,
        createdBy: { select: { id: true, email: true, name: true } },
        acceptedBy: { select: { id: true, email: true, name: true } },
      },
    });
    return invites.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      assignedOnly: Boolean((i as any).assignedOnly),
      expiresAt: i.expiresAt.toISOString(),
      acceptedAt: i.acceptedAt ? i.acceptedAt.toISOString() : null,
      archivedAt: i.archivedAt ? i.archivedAt.toISOString() : null,
      createdAt: i.createdAt.toISOString(),
      createdByUserId: i.createdByUserId || null,
      acceptedByUserId: i.acceptedByUserId || null,
      createdBy: i.createdBy ? { id: i.createdBy.id, email: i.createdBy.email, name: i.createdBy.name } : null,
      acceptedBy: i.acceptedBy ? { id: i.acceptedBy.id, email: i.acceptedBy.email, name: i.acceptedBy.name } : null,
    }));
  });

  app.post('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceOwner(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const userId = request.user?.userId ? String(request.user.userId) : null;

    const body = request.body as { email?: string; role?: string; expiresDays?: number; assignedOnly?: boolean };
    const email = normalizeEmail(body?.email);
    if (!email || !email.includes('@')) return reply.code(400).send({ error: '"email" inválido.' });
    const role = normalizeRole(body?.role) || 'MEMBER';
    const assignedOnly = role === 'MEMBER' ? normalizeAssignedOnly(body?.assignedOnly) : false;
    const expiresDaysRaw = typeof body?.expiresDays === 'number' ? body.expiresDays : 7;
    const expiresDays = Number.isFinite(expiresDaysRaw) ? Math.max(1, Math.min(30, Math.floor(expiresDaysRaw))) : 7;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresDays * 24 * 60 * 60 * 1000);

    const existing = await prisma.workspaceInvite.findFirst({
      where: {
        workspaceId: access.workspaceId,
        email,
        role,
        assignedOnly,
        archivedAt: null,
        acceptedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, token: true, expiresAt: true, createdAt: true },
    });
    if (existing) {
      return {
        ok: true,
        inviteId: existing.id,
        email,
        role,
        assignedOnly,
        expiresAt: existing.expiresAt.toISOString(),
        createdAt: existing.createdAt.toISOString(),
        inviteUrl: buildInviteUrl(existing.token),
        reused: true,
      };
    }

    const token = generateInviteToken();
    const created = await prisma.workspaceInvite.create({
      data: {
        workspaceId: access.workspaceId,
        email,
        role,
        assignedOnly,
        token,
        expiresAt,
        createdByUserId: userId,
      },
      select: { id: true, token: true, expiresAt: true, createdAt: true },
    });

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId,
          type: 'INVITE_CREATED',
          beforeJson: null,
          afterJson: serializeJson({ inviteId: created.id, email, role, expiresAt: created.expiresAt.toISOString() }),
        },
      })
      .catch(() => {});

    return {
      ok: true,
      inviteId: created.id,
      email,
      role,
      assignedOnly,
      expiresAt: created.expiresAt.toISOString(),
      createdAt: created.createdAt.toISOString(),
      inviteUrl: buildInviteUrl(created.token),
    };
  });

  app.patch('/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceOwner(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const userId = request.user?.userId ? String(request.user.userId) : null;

    const { id } = request.params as { id: string };
    const body = request.body as { archived?: boolean };
    if (typeof body?.archived !== 'boolean') return reply.code(400).send({ error: '"archived" requerido (boolean).' });

    const invite = await prisma.workspaceInvite.findFirst({
      where: { id, workspaceId: access.workspaceId },
      select: { id: true, archivedAt: true, email: true, role: true, expiresAt: true, assignedOnly: true as any },
    });
    if (!invite) return reply.code(404).send({ error: 'Invite no encontrado.' });

    const nextArchivedAt = body.archived ? new Date() : null;
    const updated = await prisma.workspaceInvite.update({
      where: { id: invite.id },
      data: { archivedAt: nextArchivedAt },
      select: { id: true, email: true, role: true, expiresAt: true, acceptedAt: true, archivedAt: true, assignedOnly: true as any, createdAt: true },
    });

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId,
          type: body.archived ? 'INVITE_ARCHIVED' : 'INVITE_RESTORED',
          beforeJson: serializeJson({ inviteId: invite.id, email: invite.email, role: invite.role, archivedAt: invite.archivedAt ? invite.archivedAt.toISOString() : null }),
          afterJson: serializeJson({ inviteId: updated.id, archivedAt: updated.archivedAt ? updated.archivedAt.toISOString() : null }),
        },
      })
      .catch(() => {});

    return {
      ok: true,
      invite: {
        id: updated.id,
        email: updated.email,
        role: updated.role,
        assignedOnly: Boolean((updated as any).assignedOnly),
        expiresAt: updated.expiresAt.toISOString(),
        acceptedAt: updated.acceptedAt ? updated.acceptedAt.toISOString() : null,
        archivedAt: updated.archivedAt ? updated.archivedAt.toISOString() : null,
        createdAt: updated.createdAt.toISOString(),
      },
    };
  });

  app.post('/:id/reissue', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceOwner(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const userId = request.user?.userId ? String(request.user.userId) : null;

    const { id } = request.params as { id: string };
    const body = request.body as { expiresDays?: number };
    const expiresDaysRaw = typeof body?.expiresDays === 'number' ? body.expiresDays : 7;
    const expiresDays = Number.isFinite(expiresDaysRaw) ? Math.max(1, Math.min(30, Math.floor(expiresDaysRaw))) : 7;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresDays * 24 * 60 * 60 * 1000);

    const existing = await prisma.workspaceInvite.findFirst({
      where: { id, workspaceId: access.workspaceId, archivedAt: null },
      select: { id: true, email: true, role: true, assignedOnly: true as any },
    });
    if (!existing) return reply.code(404).send({ error: 'Invite no encontrado.' });

    // Archive current invite (keeps audit trail).
    await prisma.workspaceInvite
      .update({
        where: { id: existing.id },
        data: { archivedAt: new Date() },
      })
      .catch(() => {});

    const created = await prisma.workspaceInvite.create({
      data: {
        workspaceId: access.workspaceId,
        email: existing.email,
        role: existing.role,
        assignedOnly: Boolean((existing as any).assignedOnly),
        token: generateInviteToken(),
        expiresAt,
        createdByUserId: userId,
      },
      select: { id: true, token: true, expiresAt: true, createdAt: true, email: true, role: true, assignedOnly: true as any },
    });

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId,
          type: 'INVITE_REISSUED',
          beforeJson: serializeJson({ inviteId: existing.id }),
          afterJson: serializeJson({ inviteId: created.id, email: created.email, role: created.role }),
        },
      })
      .catch(() => {});

    return {
      ok: true,
      inviteId: created.id,
      email: created.email,
      role: created.role,
      assignedOnly: Boolean((created as any).assignedOnly),
      expiresAt: created.expiresAt.toISOString(),
      createdAt: created.createdAt.toISOString(),
      inviteUrl: buildInviteUrl(created.token),
    };
  });

  app.post('/:id/url', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceOwner(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const { id } = request.params as { id: string };

    const invite = await prisma.workspaceInvite.findFirst({
      where: { id, workspaceId: access.workspaceId, archivedAt: null },
      select: { id: true, token: true, email: true, role: true, assignedOnly: true as any, expiresAt: true, acceptedAt: true },
    });
    if (!invite) return reply.code(404).send({ error: 'Invite no encontrado.' });
    return {
      ok: true,
      inviteId: invite.id,
      email: invite.email,
      role: invite.role,
      assignedOnly: Boolean((invite as any).assignedOnly),
      expiresAt: invite.expiresAt.toISOString(),
      acceptedAt: invite.acceptedAt ? invite.acceptedAt.toISOString() : null,
      inviteUrl: buildInviteUrl(invite.token),
    };
  });

  app.get('/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const raw = String(token || '').trim();
    if (!raw) return reply.code(404).send({ error: 'Invite no encontrado.' });

    const invite = await prisma.workspaceInvite.findFirst({
      where: { token: raw },
      include: { workspace: { select: { id: true, name: true } } },
    });
    if (!invite) return reply.code(404).send({ error: 'Invite no encontrado.' });

    const userExists = await prisma.user
      .findUnique({ where: { email: invite.email }, select: { id: true } })
      .then((u) => Boolean(u?.id))
      .catch(() => false);

    const expired = invite.expiresAt.getTime() <= Date.now();
    const archived = Boolean(invite.archivedAt);
    const accepted = Boolean(invite.acceptedAt);
    const status = archived ? 'ARCHIVED' : accepted ? 'ACCEPTED' : expired ? 'EXPIRED' : 'PENDING';

    return {
      ok: true,
      workspaceId: invite.workspaceId,
      workspaceName: invite.workspace?.name || invite.workspaceId,
      email: invite.email,
      role: invite.role,
      assignedOnly: Boolean((invite as any).assignedOnly),
      expiresAt: invite.expiresAt.toISOString(),
      acceptedAt: invite.acceptedAt ? invite.acceptedAt.toISOString() : null,
      archivedAt: invite.archivedAt ? invite.archivedAt.toISOString() : null,
      expired,
      archived,
      status,
      userExists,
    };
  });

  app.post('/:token/accept', async (request, reply) => {
    const { token } = request.params as { token: string };
    const raw = String(token || '').trim();
    if (!raw) return reply.code(404).send({ error: 'Invite no encontrado.' });

    const body = request.body as { name?: string; password?: string };
    const password = String(body?.password || '').trim();
    const name = String(body?.name || '').trim();
    if (password.length < 8) return reply.code(400).send({ error: 'Password demasiado corto (mínimo 8).' });

    const invite = await prisma.workspaceInvite.findFirst({
      where: { token: raw, archivedAt: null },
      include: { workspace: { select: { id: true, name: true } } },
    });
    if (!invite) return reply.code(404).send({ error: 'Invite no encontrado.' });
    if (invite.acceptedAt) return reply.code(409).send({ error: 'Invite ya fue usado.' });
    if (invite.expiresAt.getTime() <= Date.now()) return reply.code(410).send({ error: 'Invite expiró.' });

    const passwordHash = await hashPassword(password);
    const email = invite.email;

    const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existingUser?.id) {
      return reply.code(409).send({
        error: 'Este email ya tiene acceso. Inicia sesión y acepta la invitación desde tu cuenta.',
        code: 'USER_EXISTS',
      });
    }

    const user = await prisma.user.create({
      data: {
        email,
        name: name || email.split('@')[0],
        passwordHash,
        role: 'AGENT',
      },
      select: { id: true, role: true },
    });

    const role = normalizeRole(invite.role) || 'MEMBER';
    const assignedOnly = role === 'MEMBER' && Boolean((invite as any).assignedOnly);
    await prisma.membership.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId: invite.workspaceId } },
      create: { userId: user.id, workspaceId: invite.workspaceId, role, assignedOnly, archivedAt: null } as any,
      update: { role, assignedOnly, archivedAt: null } as any,
    });

    await prisma.workspaceInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date(), acceptedByUserId: user.id },
    });

    const jwt = (app as any).jwt;
    const signed = jwt.sign({ userId: user.id, role: user.role });
    return { ok: true, token: signed, workspaceId: invite.workspaceId };
  });

  // Accept invite for an existing user (no password reset). Requires login.
  app.post('/:token/accept-existing', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const raw = String(token || '').trim();
    if (!raw) return reply.code(404).send({ error: 'Invite no encontrado.' });

    const userId = request.user?.userId ? String(request.user.userId) : null;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const invite = await prisma.workspaceInvite.findFirst({
      where: { token: raw, archivedAt: null },
      include: { workspace: { select: { id: true, name: true } } },
    });
    if (!invite) return reply.code(404).send({ error: 'Invite no encontrado.' });
    if (invite.acceptedAt) return reply.code(409).send({ error: 'Invite ya fue usado.' });
    if (invite.expiresAt.getTime() <= Date.now()) return reply.code(410).send({ error: 'Invite expiró.' });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, role: true } });
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });

    if (normalizeEmail(user.email) !== normalizeEmail(invite.email)) {
      return reply.code(409).send({
        error: `Esta invitación es para ${invite.email}. Estás logueado como ${user.email}.`,
        code: 'EMAIL_MISMATCH',
      });
    }

    const role = normalizeRole(invite.role) || 'MEMBER';
    const assignedOnly = role === 'MEMBER' && Boolean((invite as any).assignedOnly);
    await prisma.membership.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId: invite.workspaceId } },
      create: { userId: user.id, workspaceId: invite.workspaceId, role, assignedOnly, archivedAt: null } as any,
      update: { role, assignedOnly, archivedAt: null } as any,
    });

    await prisma.workspaceInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date(), acceptedByUserId: user.id },
    });

    return { ok: true, workspaceId: invite.workspaceId };
  });
}
