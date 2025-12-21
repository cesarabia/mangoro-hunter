import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { resolveWorkspaceAccess, isWorkspaceOwner, isWorkspaceAdmin } from '../services/workspaceAuthService';
import { serializeJson } from '../utils/json';

export async function registerWorkspaceRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const userId = request.user?.userId as string | undefined;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const platformRole = await prisma.user
      .findUnique({ where: { id: userId }, select: { platformRole: true } })
      .then((u) => String(u?.platformRole || '').toUpperCase())
      .catch(() => '');
    const isPlatformSuperAdmin = platformRole === 'SUPERADMIN';

    const memberships = await prisma.membership.findMany({
      where: { userId, archivedAt: null, workspace: { archivedAt: null } },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });
    return memberships
      .filter((m) => (m.workspace.isSandbox ? isPlatformSuperAdmin : true))
      .map((m) => ({
        id: m.workspace.id,
        name: m.workspace.name,
        isSandbox: m.workspace.isSandbox,
        createdAt: m.workspace.createdAt.toISOString(),
        role: m.role,
      }));
  });

  app.get('/current', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const workspace = (await prisma.workspace.findUnique({
      where: { id: access.workspaceId },
      select: {
        id: true,
        name: true,
        isSandbox: true,
        ssclinicalNurseLeaderEmail: true as any,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
      } as any,
    })) as any;
    if (!workspace || workspace.archivedAt) return reply.code(404).send({ error: 'Workspace no encontrado.' });
    return {
      id: workspace.id,
      name: workspace.name,
      isSandbox: Boolean(workspace.isSandbox),
      ssclinicalNurseLeaderEmail: (workspace as any).ssclinicalNurseLeaderEmail || null,
      createdAt: new Date(workspace.createdAt).toISOString(),
      updatedAt: new Date(workspace.updatedAt).toISOString(),
    };
  });

  app.patch('/current', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const userId = request.user?.userId ? String(request.user.userId) : null;

    const body = request.body as { ssclinicalNurseLeaderEmail?: string | null };
    const hasEmail = Object.prototype.hasOwnProperty.call(body || {}, 'ssclinicalNurseLeaderEmail');
    if (!hasEmail) return reply.code(400).send({ error: '"ssclinicalNurseLeaderEmail" es requerido (string|null).' });

    const raw = body?.ssclinicalNurseLeaderEmail;
    const next =
      raw === null
        ? null
        : typeof raw === 'string'
          ? raw.trim().toLowerCase()
          : null;
    if (typeof raw === 'string' && next && (!next.includes('@') || next.length > 254)) {
      return reply.code(400).send({ error: 'Email inválido.' });
    }

    const existing = await prisma.workspace.findUnique({
      where: { id: access.workspaceId },
      select: { id: true, archivedAt: true, ssclinicalNurseLeaderEmail: true as any },
    });
    if (!existing || existing.archivedAt) return reply.code(404).send({ error: 'Workspace no encontrado.' });

    const updated = await prisma.workspace.update({
      where: { id: access.workspaceId },
      data: {
        ssclinicalNurseLeaderEmail: typeof raw === 'string' ? (next || null) : null,
        updatedAt: new Date(),
      } as any,
      select: { id: true, ssclinicalNurseLeaderEmail: true as any, updatedAt: true },
    });

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId,
          type: 'WORKSPACE_SSCLINICAL_NURSE_LEADER',
          beforeJson: serializeJson({ ssclinicalNurseLeaderEmail: (existing as any).ssclinicalNurseLeaderEmail || null }),
          afterJson: serializeJson({ ssclinicalNurseLeaderEmail: (updated as any).ssclinicalNurseLeaderEmail || null }),
        },
      })
      .catch(() => {});

    return {
      ok: true,
      ssclinicalNurseLeaderEmail: (updated as any).ssclinicalNurseLeaderEmail || null,
      updatedAt: updated.updatedAt.toISOString(),
    };
  });

  app.post('/clone-from', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceOwner(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const userId = request.user?.userId ? String(request.user.userId) : null;

    const body = request.body as {
      sourceWorkspaceId?: string;
      clonePrograms?: boolean;
      cloneAutomations?: boolean;
      cloneConnectors?: boolean;
    };

    const sourceWorkspaceId = String(body?.sourceWorkspaceId || '').trim();
    if (!sourceWorkspaceId) return reply.code(400).send({ error: '"sourceWorkspaceId" es requerido.' });
    if (sourceWorkspaceId === access.workspaceId) return reply.code(400).send({ error: 'sourceWorkspaceId debe ser distinto al workspace actual.' });

    // Access check for source workspace:
    // - Global ADMIN can clone across workspaces
    // - Otherwise require membership ADMIN/OWNER in source workspace
    if (String(request.user?.role || '').toUpperCase() !== 'ADMIN') {
      const srcMembership = await prisma.membership.findFirst({
        where: { userId: userId || '', workspaceId: sourceWorkspaceId, archivedAt: null, workspace: { archivedAt: null } },
        select: { role: true },
      });
      const ok = srcMembership && ['OWNER', 'ADMIN'].includes(String(srcMembership.role || '').toUpperCase());
      if (!ok) return reply.code(403).send({ error: 'Forbidden (sin acceso al workspace origen)' });
    }

    const [sourceWs, targetWs] = await Promise.all([
      prisma.workspace.findUnique({ where: { id: sourceWorkspaceId }, select: { id: true, name: true, archivedAt: true } }),
      prisma.workspace.findUnique({ where: { id: access.workspaceId }, select: { id: true, name: true, archivedAt: true } }),
    ]);
    if (!sourceWs || sourceWs.archivedAt) return reply.code(404).send({ error: 'Workspace origen no existe o está archivado.' });
    if (!targetWs || targetWs.archivedAt) return reply.code(404).send({ error: 'Workspace destino no existe o está archivado.' });

    const clonePrograms = body?.clonePrograms !== false;
    const cloneAutomations = body?.cloneAutomations !== false;
    const cloneConnectors = body?.cloneConnectors !== false;

    const summary: any = {
      ok: true,
      source: { id: sourceWs.id, name: sourceWs.name },
      target: { id: targetWs.id, name: targetWs.name },
      clonedAt: new Date().toISOString(),
      programs: { created: 0, skipped: 0, knowledgeAssetsCreated: 0, permissionsCreated: 0 },
      automations: { created: 0, skipped: 0, disabledDueToInboundConflict: 0 },
      connectors: { created: 0, updated: 0, skipped: 0, secretsNotCopied: true },
    };

    const beforeSnapshot = serializeJson({
      sourceWorkspaceId,
      targetWorkspaceId: access.workspaceId,
      clonePrograms,
      cloneAutomations,
      cloneConnectors,
    });

    // Clone connectors first (without secrets).
    if (cloneConnectors) {
      const sourceConnectors = await prisma.workspaceConnector.findMany({
        where: { workspaceId: sourceWorkspaceId, archivedAt: null },
        orderBy: { createdAt: 'asc' },
      });

      for (const c of sourceConnectors) {
        const slug = String(c.slug || '').trim();
        if (!slug) continue;
        const existing = await prisma.workspaceConnector.findFirst({
          where: { workspaceId: access.workspaceId, slug },
        });
        if (!existing) {
          await prisma.workspaceConnector.create({
            data: {
              workspaceId: access.workspaceId,
              name: c.name,
              slug: c.slug,
              description: c.description,
              baseUrl: c.baseUrl,
              testPath: c.testPath,
              testMethod: c.testMethod,
              authType: c.authType,
              authHeaderName: c.authHeaderName,
              // authToken NOT copied
              allowedDomainsJson: c.allowedDomainsJson,
              timeoutMs: c.timeoutMs,
              maxPayloadBytes: c.maxPayloadBytes,
              actionsJson: c.actionsJson,
              isActive: c.isActive,
              archivedAt: null,
            } as any,
          });
          summary.connectors.created += 1;
        } else {
          // Update non-secret fields. Keep existing authToken unchanged.
          await prisma.workspaceConnector.update({
            where: { id: existing.id },
            data: {
              name: c.name,
              description: c.description,
              baseUrl: c.baseUrl,
              testPath: c.testPath,
              testMethod: c.testMethod,
              authType: c.authType,
              authHeaderName: c.authHeaderName,
              allowedDomainsJson: c.allowedDomainsJson,
              timeoutMs: c.timeoutMs,
              maxPayloadBytes: c.maxPayloadBytes,
              actionsJson: c.actionsJson,
              isActive: c.isActive,
              archivedAt: null,
            } as any,
          });
          summary.connectors.updated += 1;
        }
      }
    }

    const connectorBySlug = async () => {
      const list = await prisma.workspaceConnector.findMany({
        where: { workspaceId: access.workspaceId, archivedAt: null },
        select: { id: true, slug: true },
      });
      const map = new Map<string, string>();
      for (const c of list) {
        const slug = String(c.slug || '').trim();
        if (!slug) continue;
        map.set(slug, c.id);
      }
      return map;
    };

    const connectorSlugByIdInSource = async () => {
      const list = await prisma.workspaceConnector.findMany({
        where: { workspaceId: sourceWorkspaceId, archivedAt: null },
        select: { id: true, slug: true },
      });
      const map = new Map<string, string>();
      for (const c of list) {
        const id = String(c.id || '').trim();
        const slug = String(c.slug || '').trim();
        if (!id || !slug) continue;
        map.set(id, slug);
      }
      return map;
    };

    const connectorIdBySlug = cloneConnectors ? await connectorBySlug() : new Map<string, string>();
    const connectorSlugById = cloneConnectors ? await connectorSlugByIdInSource() : new Map<string, string>();

    // Clone programs + knowledge + connector permissions.
    const programIdMap = new Map<string, string>(); // sourceProgramId -> targetProgramId
    if (clonePrograms) {
      const sourcePrograms = await prisma.program.findMany({
        where: { workspaceId: sourceWorkspaceId, archivedAt: null },
        orderBy: { createdAt: 'asc' },
      });

      for (const p of sourcePrograms) {
        const existing = await prisma.program.findFirst({
          where: { workspaceId: access.workspaceId, slug: p.slug, archivedAt: null },
          select: { id: true },
        });
        if (existing?.id) {
          summary.programs.skipped += 1;
          continue;
        }
        const created = await prisma.program.create({
          data: {
            workspaceId: access.workspaceId,
            name: p.name,
            slug: p.slug,
            description: p.description,
            goal: (p as any).goal ?? null,
            audience: (p as any).audience ?? null,
            tone: (p as any).tone ?? null,
            language: (p as any).language ?? null,
            isActive: p.isActive,
            agentSystemPrompt: p.agentSystemPrompt,
            archivedAt: null,
          } as any,
          select: { id: true },
        });
        summary.programs.created += 1;
        programIdMap.set(p.id, created.id);

        // Knowledge pack: only LINK/TEXT assets, archive-only.
        const assets = await prisma.programKnowledgeAsset.findMany({
          where: { workspaceId: sourceWorkspaceId, programId: p.id, archivedAt: null },
          orderBy: { createdAt: 'asc' },
        });
        for (const a of assets) {
          const type = String(a.type || '').toUpperCase();
          if (type !== 'LINK' && type !== 'TEXT') continue;
          await prisma.programKnowledgeAsset.create({
            data: {
              workspaceId: access.workspaceId,
              programId: created.id,
              type: a.type,
              title: a.title,
              url: a.url,
              contentText: a.contentText,
              tags: a.tags,
              archivedAt: null,
            } as any,
          });
          summary.programs.knowledgeAssetsCreated += 1;
        }

        // Tool/connector permissions
        const perms = await prisma.programConnectorPermission.findMany({
          where: { workspaceId: sourceWorkspaceId, programId: p.id, archivedAt: null },
        });
        for (const perm of perms) {
          const slug = connectorSlugById.get(perm.connectorId);
          if (!slug) continue;
          const targetConnectorId = connectorIdBySlug.get(slug);
          if (!targetConnectorId) continue;
          await prisma.programConnectorPermission
            .create({
              data: {
                workspaceId: access.workspaceId,
                programId: created.id,
                connectorId: targetConnectorId,
                allowedActionsJson: perm.allowedActionsJson,
                archivedAt: null,
              } as any,
            })
            .catch(() => {});
          summary.programs.permissionsCreated += 1;
        }
      }
    }

    // Clone automations (avoid creating duplicate inbound RUN_AGENT enabled rules).
    if (cloneAutomations) {
      const sourceRules = await prisma.automationRule.findMany({
        where: { workspaceId: sourceWorkspaceId, archivedAt: null },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      });
      const targetRules = await prisma.automationRule.findMany({
        where: { workspaceId: access.workspaceId, archivedAt: null },
        select: { id: true, enabled: true, trigger: true, actionsJson: true, conditionsJson: true, scopePhoneLineId: true, scopeProgramId: true, name: true },
      });

      const targetHasEnabledInboundRunAgent = targetRules.some((r) => {
        if (!r.enabled) return false;
        if (String(r.trigger || '').toUpperCase() !== 'INBOUND_MESSAGE') return false;
        try {
          const parsed = JSON.parse(String(r.actionsJson || '[]'));
          return Array.isArray(parsed) && parsed.some((a: any) => String(a?.type || '').toUpperCase() === 'RUN_AGENT');
        } catch {
          return String(r.actionsJson || '').toUpperCase().includes('RUN_AGENT');
        }
      });

      const isSameRule = (a: any, b: any): boolean => {
        return (
          String(a.trigger || '') === String(b.trigger || '') &&
          String(a.scopePhoneLineId || '') === String(b.scopePhoneLineId || '') &&
          String(a.scopeProgramId || '') === String(b.scopeProgramId || '') &&
          String(a.conditionsJson || '') === String(b.conditionsJson || '') &&
          String(a.actionsJson || '') === String(b.actionsJson || '')
        );
      };

      for (const r of sourceRules) {
        const already = targetRules.some((t) => isSameRule(r, t));
        if (already) {
          summary.automations.skipped += 1;
          continue;
        }
        const wantsInboundRunAgent = (() => {
          if (!r.enabled) return false;
          if (String(r.trigger || '').toUpperCase() !== 'INBOUND_MESSAGE') return false;
          try {
            const parsed = JSON.parse(String(r.actionsJson || '[]'));
            return Array.isArray(parsed) && parsed.some((a: any) => String(a?.type || '').toUpperCase() === 'RUN_AGENT');
          } catch {
            return String(r.actionsJson || '').toUpperCase().includes('RUN_AGENT');
          }
        })();

        const enabled = wantsInboundRunAgent && targetHasEnabledInboundRunAgent ? false : Boolean(r.enabled);
        if (wantsInboundRunAgent && targetHasEnabledInboundRunAgent) summary.automations.disabledDueToInboundConflict += 1;

        let name = r.name;
        const nameExists = targetRules.some((t) => String(t.name || '') === String(name || ''));
        if (nameExists) name = `${name} (clonado)`;

        await prisma.automationRule.create({
          data: {
            workspaceId: access.workspaceId,
            enabled,
            name,
            trigger: r.trigger,
            scopePhoneLineId: r.scopePhoneLineId,
            scopeProgramId: r.scopeProgramId,
            priority: r.priority,
            conditionsJson: r.conditionsJson,
            actionsJson: r.actionsJson,
            archivedAt: null,
          } as any,
        });
        summary.automations.created += 1;
      }
    }

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId,
          type: 'WORKSPACE_CLONED_FROM_TEMPLATE',
          beforeJson: beforeSnapshot,
          afterJson: serializeJson(summary),
        },
      })
      .catch(() => {});

    return summary;
  });
}
