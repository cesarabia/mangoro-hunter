import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { prisma } from '../db/client';
import { serializeJson } from '../utils/json';
import { resolveWorkspaceAccess } from '../services/workspaceAuthService';

function slugifyWorkspaceId(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function normalizeEmail(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function buildInviteToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

function buildInviteUrl(token: string): string {
  const base = process.env.PUBLIC_BASE_URL || 'https://hunter.mangoro.app';
  return `${base.replace(/\/+$/g, '')}/invite/${token}`;
}

async function isPlatformOwner(request: any): Promise<boolean> {
  const userId = request.user?.userId ? String(request.user.userId) : null;
  if (!userId) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, role: true } });
  if (!user) return false;
  if (String(user.role || '').toUpperCase() === 'ADMIN') return true;
  const allow = String(process.env.PLATFORM_OWNER_EMAILS || 'cesarabia@gmail.com')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(String(user.email || '').toLowerCase());
}

export async function registerPlatformRoutes(app: FastifyInstance) {
  app.get('/me', { preValidation: [app.authenticate] }, async (request, reply) => {
    return { platformOwner: await isPlatformOwner(request) };
  });

  app.get('/workspaces', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!(await isPlatformOwner(request))) return reply.code(403).send({ error: 'Forbidden' });

    const workspaces = await prisma.workspace.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, isSandbox: true, createdAt: true },
    });
    const ids = workspaces.map((w) => w.id);

    const owners = ids.length
      ? await prisma.membership.findMany({
          where: { workspaceId: { in: ids }, role: 'OWNER', archivedAt: null },
          include: { user: { select: { email: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        })
      : [];

    const ownersByWorkspaceId: Record<string, Array<{ email: string; name: string | null }>> = {};
    for (const m of owners) {
      if (!ownersByWorkspaceId[m.workspaceId]) ownersByWorkspaceId[m.workspaceId] = [];
      ownersByWorkspaceId[m.workspaceId].push({ email: m.user.email, name: m.user.name || null });
    }

    const counts = ids.length
      ? await prisma.membership.groupBy({
          by: ['workspaceId'],
          where: { workspaceId: { in: ids }, archivedAt: null },
          _count: { _all: true },
        })
      : [];
    const countByWorkspaceId: Record<string, number> = {};
    for (const row of counts) {
      countByWorkspaceId[row.workspaceId] = row._count._all;
    }

    return workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      isSandbox: w.isSandbox,
      createdAt: w.createdAt.toISOString(),
      owners: ownersByWorkspaceId[w.id] || [],
      membersCount: countByWorkspaceId[w.id] || 0,
    }));
  });

  app.post('/workspaces', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!(await isPlatformOwner(request))) return reply.code(403).send({ error: 'Forbidden' });
    const access = await resolveWorkspaceAccess(request);
    const userId = request.user?.userId ? String(request.user.userId) : null;

    const body = request.body as { name?: string; slug?: string; ownerEmail?: string; isSandbox?: boolean };
    const name = String(body?.name || '').trim();
    if (!name) return reply.code(400).send({ error: '"name" es requerido.' });
    const slug = slugifyWorkspaceId(String(body?.slug || ''));
    if (!slug) return reply.code(400).send({ error: '"slug" es requerido.' });
    if (slug === 'default' || slug === 'sandbox') return reply.code(400).send({ error: 'slug reservado.' });

    const ownerEmail = normalizeEmail(body?.ownerEmail);
    if (!ownerEmail || !ownerEmail.includes('@')) return reply.code(400).send({ error: '"ownerEmail" inválido.' });

    const exists = await prisma.workspace.findUnique({ where: { id: slug } });
    if (exists) return reply.code(409).send({ error: `Workspace "${slug}" ya existe.` });

    const created = await prisma.workspace.create({
      data: { id: slug, name, isSandbox: Boolean(body?.isSandbox) },
      select: { id: true, name: true, isSandbox: true, createdAt: true },
    });

    // Ensure creator has access to manage the workspace.
    if (userId) {
      await prisma.membership
        .upsert({
          where: { userId_workspaceId: { userId, workspaceId: created.id } },
          create: { userId, workspaceId: created.id, role: 'OWNER', archivedAt: null },
          update: { role: 'OWNER', archivedAt: null },
        })
        .catch(() => {});
    }

    const ownerUser = await prisma.user.findUnique({ where: { email: ownerEmail }, select: { id: true } }).catch(() => null);
    if (ownerUser?.id) {
      await prisma.membership
        .upsert({
          where: { userId_workspaceId: { userId: ownerUser.id, workspaceId: created.id } },
          create: { userId: ownerUser.id, workspaceId: created.id, role: 'OWNER', archivedAt: null },
          update: { role: 'OWNER', archivedAt: null },
        })
        .catch(() => {});
    }

    // Always create an invite link (useful as onboarding / password reset).
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const invite = await prisma.workspaceInvite.create({
      data: {
        workspaceId: created.id,
        email: ownerEmail,
        role: 'OWNER',
        token: buildInviteToken(),
        expiresAt,
        createdByUserId: userId,
      },
      select: { id: true, token: true, expiresAt: true },
    });

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId,
          type: 'WORKSPACE_CREATED',
          beforeJson: null,
          afterJson: serializeJson({ workspaceId: created.id, name: created.name, ownerEmail }),
        },
      })
      .catch(() => {});

    return {
      ok: true,
      workspace: {
        id: created.id,
        name: created.name,
        isSandbox: created.isSandbox,
        createdAt: created.createdAt.toISOString(),
      },
      owner: { email: ownerEmail },
      invite: { id: invite.id, expiresAt: invite.expiresAt.toISOString(), inviteUrl: buildInviteUrl(invite.token) },
    };
  });

  // Seed SSClinical pilot pack (Programs + default inbound automation + Medilink connector scaffold).
  app.post('/workspaces/:workspaceId/seed-ssclinical', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!(await isPlatformOwner(request))) return reply.code(403).send({ error: 'Forbidden' });
    const access = await resolveWorkspaceAccess(request);
    const userId = request.user?.userId ? String(request.user.userId) : null;

    const { workspaceId } = request.params as { workspaceId: string };
    const wsId = String(workspaceId || '').trim();
    if (!wsId) return reply.code(400).send({ error: 'workspaceId requerido.' });

    const ws = await prisma.workspace.findUnique({ where: { id: wsId } });
    if (!ws) return reply.code(404).send({ error: 'Workspace no encontrado.' });
    if (ws.isSandbox) return reply.code(400).send({ error: 'No se puede seedear un workspace sandbox.' });

    const programs = [
      {
        slug: 'coordinadora-salud-suero-hidratante-y-terapia',
        name: 'Coordinadora Salud — Suero Hidratante y Terapia',
        prompt: `
Programa: Coordinadora Salud (SSClinical).
Objetivo: informar sobre suero hidratante / suero terapia, resolver dudas, coordinar agenda y derivar cuando corresponda.
Reglas:
- Responde corto y humano (máx 6 líneas).
- Si falta información, pregunta 1 cosa a la vez.
- No inventes precios/políticas; si no existe en knowledge, dilo y pide confirmación.
`.trim(),
      },
      {
        slug: 'enfermera-lider-coordinadora',
        name: 'Enfermera Líder — Coordinación',
        prompt: `
Programa: Enfermera Líder (SSClinical).
Objetivo: guiar al equipo, revisar casos, coordinar visitas y validar información clínica básica.
Reglas: no diagnosticar; si falta orden médica o indicación, pedirla.
`.trim(),
      },
      {
        slug: 'enfermera-domicilio',
        name: 'Enfermera Domicilio — Atención',
        prompt: `
Programa: Enfermera Domicilio (SSClinical).
Objetivo: coordinar visita domiciliaria, confirmar datos de paciente, requisitos y preparación.
Reglas:
- No pedir datos sensibles innecesarios en WhatsApp.
- Si se requiere orden médica, solicitarla.
`.trim(),
      },
      {
        slug: 'medico-orden-medica',
        name: 'Médico — Orden Médica',
        prompt: `
Programa: Médico (SSClinical).
Objetivo: orientar sobre requisitos de orden médica y documentación necesaria.
Reglas: no entregar diagnóstico; solo requisitos y próximos pasos.
`.trim(),
      },
    ];

    const createdPrograms: string[] = [];
    for (const p of programs) {
      const existing = await prisma.program.findFirst({ where: { workspaceId: wsId, slug: p.slug, archivedAt: null } });
      if (existing) continue;
      await prisma.program.create({
        data: {
          workspaceId: wsId,
          name: p.name,
          slug: p.slug,
          isActive: true,
          agentSystemPrompt: p.prompt,
        },
      });
      createdPrograms.push(p.slug);
    }

    const existingRule = await prisma.automationRule.findFirst({
      where: { workspaceId: wsId, trigger: 'INBOUND_MESSAGE', archivedAt: null, enabled: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!existingRule) {
      await prisma.automationRule.create({
        data: {
          workspaceId: wsId,
          name: 'Default inbound -> RUN_AGENT',
          enabled: true,
          priority: 100,
          trigger: 'INBOUND_MESSAGE',
          scopePhoneLineId: null,
          scopeProgramId: null,
          conditionsJson: serializeJson([]),
          actionsJson: serializeJson([{ type: 'RUN_AGENT', agent: 'program_default' }]),
        },
      });
    }

    const existingConnector = await prisma.workspaceConnector.findFirst({
      where: { workspaceId: wsId, slug: 'medilink', archivedAt: null },
      select: { id: true },
    });
    if (!existingConnector) {
      await prisma.workspaceConnector
        .create({
          data: {
            workspaceId: wsId,
            name: 'Medilink',
            slug: 'medilink',
            description: 'Medilink API (SSClinical)',
            isActive: true,
            authType: 'BEARER_TOKEN' as any,
            authHeaderName: 'Authorization' as any,
            actionsJson: serializeJson(['search_patient', 'create_appointment', 'create_payment']),
          } as any,
        })
        .catch(() => {});
    }

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId,
          type: 'PLATFORM_SEED_SSCLINICAL',
          beforeJson: null,
          afterJson: serializeJson({ targetWorkspaceId: wsId, createdPrograms }),
        },
      })
      .catch(() => {});

    return { ok: true, workspaceId: wsId, createdPrograms, ensuredAutomation: true, ensuredConnector: true };
  });
}
