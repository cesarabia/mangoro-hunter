import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { prisma } from '../db/client';
import { hashPassword, verifyPassword } from '../services/passwordService';
import { resolveWorkspaceAccess } from '../services/workspaceAuthService';

export async function registerAuthRoutes(app: FastifyInstance) {
  const buildResetUrl = (token: string): string => {
    const base = String(process.env.PUBLIC_BASE_URL || 'https://hunter.mangoro.app').replace(/\/+$/g, '');
    return `${base}/login?resetToken=${encodeURIComponent(token)}`;
  };

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

  app.post('/password-reset/request', async (request, reply) => {
    try {
      const body = request.body as { email?: string };
      const email = String(body?.email || '')
        .trim()
        .toLowerCase();
      if (!email || !email.includes('@')) {
        return reply.code(400).send({ error: 'Email inválido.' });
      }

      const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
      if (user?.id) {
        const token = crypto.randomBytes(24).toString('base64url');
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2h

        await (prisma as any).passwordResetToken
          .updateMany({
            where: { userId: user.id, usedAt: null, archivedAt: null },
            data: { archivedAt: now },
          })
          .catch(() => {});

        await (prisma as any).passwordResetToken.create({
          data: {
            userId: user.id,
            email: user.email,
            token,
            expiresAt,
          },
        });

        const isProd = ['prod', 'production'].includes(String(process.env.APP_ENV || '').toLowerCase());
        const resetUrl = buildResetUrl(token);
        if (!isProd) {
          return {
            ok: true,
            message: 'Si existe una cuenta para ese correo, enviamos instrucciones.',
            delivery: 'dev_link',
            resetUrl,
            expiresAt: expiresAt.toISOString(),
          };
        }
      }

      return {
        ok: true,
        message: 'Si existe una cuenta para ese correo, enviamos instrucciones.',
      };
    } catch (err) {
      app.log.error({ err }, 'Password reset request failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  app.get('/password-reset/validate', async (request, reply) => {
    try {
      const token = String((request.query as any)?.token || '').trim();
      if (!token) return reply.code(400).send({ error: 'Token requerido.' });
      const now = new Date();
      const row = await (prisma as any).passwordResetToken.findFirst({
        where: { token, usedAt: null, archivedAt: null, expiresAt: { gt: now } },
        select: { id: true, email: true, expiresAt: true },
      });
      if (!row?.id) return reply.code(404).send({ ok: false, valid: false, error: 'Token inválido o expirado.' });
      return { ok: true, valid: true, email: row.email, expiresAt: row.expiresAt.toISOString() };
    } catch (err) {
      app.log.error({ err }, 'Password reset validate failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  app.post('/password-reset/confirm', async (request, reply) => {
    try {
      const body = request.body as { token?: string; password?: string };
      const token = String(body?.token || '').trim();
      const password = String(body?.password || '');
      if (!token) return reply.code(400).send({ error: 'Token requerido.' });
      if (!password || password.length < 8) {
        return reply.code(400).send({ error: 'La contraseña debe tener al menos 8 caracteres.' });
      }

      const now = new Date();
      const row = await (prisma as any).passwordResetToken.findFirst({
        where: { token, usedAt: null, archivedAt: null, expiresAt: { gt: now } },
        select: { id: true, userId: true },
      });
      if (!row?.id) return reply.code(404).send({ error: 'Token inválido o expirado.' });

      const passwordHash = await hashPassword(password);
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: row.userId },
          data: { passwordHash },
        });
        await (tx as any).passwordResetToken.update({
          where: { id: row.id },
          data: { usedAt: new Date() },
        });
        await (tx as any).passwordResetToken
          .updateMany({
            where: { userId: row.userId, id: { not: row.id }, usedAt: null, archivedAt: null },
            data: { archivedAt: new Date() },
          })
          .catch(() => {});
      });

      return { ok: true };
    } catch (err) {
      app.log.error({ err }, 'Password reset confirm failed');
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
