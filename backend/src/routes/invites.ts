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

    const invites = await prisma.workspaceInvite.findMany({
      where: { workspaceId: access.workspaceId, archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        email: true,
        role: true,
        expiresAt: true,
        acceptedAt: true,
        createdAt: true,
        createdByUserId: true,
      },
    });
    return invites.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      expiresAt: i.expiresAt.toISOString(),
      acceptedAt: i.acceptedAt ? i.acceptedAt.toISOString() : null,
      createdAt: i.createdAt.toISOString(),
      createdByUserId: i.createdByUserId || null,
    }));
  });

  app.post('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceOwner(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const userId = request.user?.userId ? String(request.user.userId) : null;

    const body = request.body as { email?: string; role?: string; expiresDays?: number };
    const email = normalizeEmail(body?.email);
    if (!email || !email.includes('@')) return reply.code(400).send({ error: '"email" inválido.' });
    const role = normalizeRole(body?.role) || 'MEMBER';
    const expiresDaysRaw = typeof body?.expiresDays === 'number' ? body.expiresDays : 7;
    const expiresDays = Number.isFinite(expiresDaysRaw) ? Math.max(1, Math.min(30, Math.floor(expiresDaysRaw))) : 7;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresDays * 24 * 60 * 60 * 1000);

    const existing = await prisma.workspaceInvite.findFirst({
      where: {
        workspaceId: access.workspaceId,
        email,
        role,
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
      select: { id: true, token: true, email: true, role: true, expiresAt: true, acceptedAt: true },
    });
    if (!invite) return reply.code(404).send({ error: 'Invite no encontrado.' });
    return {
      ok: true,
      inviteId: invite.id,
      email: invite.email,
      role: invite.role,
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
      where: { token: raw, archivedAt: null },
      include: { workspace: { select: { id: true, name: true } } },
    });
    if (!invite) return reply.code(404).send({ error: 'Invite no encontrado.' });

    return {
      ok: true,
      workspaceId: invite.workspaceId,
      workspaceName: invite.workspace?.name || invite.workspaceId,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt.toISOString(),
      acceptedAt: invite.acceptedAt ? invite.acceptedAt.toISOString() : null,
      expired: invite.expiresAt.getTime() <= Date.now(),
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

    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        name: name || email.split('@')[0],
        passwordHash,
        role: 'AGENT',
      },
      update: {
        name: name || undefined,
        passwordHash,
      },
      select: { id: true, role: true },
    });

    const role = normalizeRole(invite.role) || 'MEMBER';
    await prisma.membership.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId: invite.workspaceId } },
      create: { userId: user.id, workspaceId: invite.workspaceId, role, archivedAt: null },
      update: { role, archivedAt: null },
    });

    await prisma.workspaceInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date(), acceptedByUserId: user.id },
    });

    const jwt = (app as any).jwt;
    const signed = jwt.sign({ userId: user.id, role: user.role });
    return { ok: true, token: signed, workspaceId: invite.workspaceId };
  });
}
