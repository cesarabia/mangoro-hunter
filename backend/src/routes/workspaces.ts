import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { resolveWorkspaceAccess, isWorkspaceOwner, isWorkspaceAdmin } from '../services/workspaceAuthService';
import { serializeJson } from '../utils/json';
import { ensureWorkspaceStages, listWorkspaceStages, normalizeStageSlug } from '../services/workspaceStageService';

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
        templateRecruitmentStartName: true as any,
        templateInterviewConfirmationName: true as any,
        templateAdditionalNamesJson: true as any,
        ssclinicalNurseLeaderEmail: true as any,
        staffDefaultProgramId: true as any,
        clientDefaultProgramId: true as any,
        partnerDefaultProgramId: true as any,
        allowPersonaSwitchByWhatsApp: true as any,
        personaSwitchTtlMinutes: true as any,
        staffProgramMenuIdsJson: true as any,
        clientProgramMenuIdsJson: true as any,
        partnerProgramMenuIdsJson: true as any,
        partnerPhoneE164sJson: true as any,
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
      templateRecruitmentStartName: String((workspace as any).templateRecruitmentStartName || '').trim() || null,
      templateInterviewConfirmationName: String((workspace as any).templateInterviewConfirmationName || '').trim() || null,
      templateAdditionalNames: (() => {
        try {
          const raw = String((workspace as any).templateAdditionalNamesJson || '').trim();
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed.map((v) => String(v)).filter(Boolean) : [];
        } catch {
          return [];
        }
      })(),
      ssclinicalNurseLeaderEmail: (workspace as any).ssclinicalNurseLeaderEmail || null,
      staffDefaultProgramId: (workspace as any).staffDefaultProgramId || null,
      clientDefaultProgramId: (workspace as any).clientDefaultProgramId || null,
      partnerDefaultProgramId: (workspace as any).partnerDefaultProgramId || null,
      allowPersonaSwitchByWhatsApp: typeof (workspace as any).allowPersonaSwitchByWhatsApp === 'boolean' ? Boolean((workspace as any).allowPersonaSwitchByWhatsApp) : true,
      personaSwitchTtlMinutes: Number.isFinite((workspace as any).personaSwitchTtlMinutes) ? Number((workspace as any).personaSwitchTtlMinutes) : 360,
      staffProgramMenuIds: (() => {
        try {
          const raw = String((workspace as any).staffProgramMenuIdsJson || '').trim();
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
        } catch {
          return [];
        }
      })(),
      clientProgramMenuIds: (() => {
        try {
          const raw = String((workspace as any).clientProgramMenuIdsJson || '').trim();
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
        } catch {
          return [];
        }
      })(),
      partnerProgramMenuIds: (() => {
        try {
          const raw = String((workspace as any).partnerProgramMenuIdsJson || '').trim();
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
        } catch {
          return [];
        }
      })(),
      partnerPhoneE164s: (() => {
        try {
          const raw = String((workspace as any).partnerPhoneE164sJson || '').trim();
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
        } catch {
          return [];
        }
      })(),
      createdAt: new Date(workspace.createdAt).toISOString(),
      updatedAt: new Date(workspace.updatedAt).toISOString(),
    };
  });

  app.patch('/current', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const userId = request.user?.userId ? String(request.user.userId) : null;

    const body = request.body as {
      templateRecruitmentStartName?: string | null;
      templateInterviewConfirmationName?: string | null;
      templateAdditionalNames?: string[] | null;
      ssclinicalNurseLeaderEmail?: string | null;
      staffDefaultProgramId?: string | null;
      clientDefaultProgramId?: string | null;
      partnerDefaultProgramId?: string | null;
      allowPersonaSwitchByWhatsApp?: boolean;
      personaSwitchTtlMinutes?: number;
      staffProgramMenuIds?: string[] | null;
      clientProgramMenuIds?: string[] | null;
      partnerProgramMenuIds?: string[] | null;
      partnerPhoneE164s?: string[] | null;
    };
    const hasRecruitTemplate = Object.prototype.hasOwnProperty.call(body || {}, 'templateRecruitmentStartName');
    const hasInterviewTemplate = Object.prototype.hasOwnProperty.call(body || {}, 'templateInterviewConfirmationName');
    const hasAdditionalTemplates = Object.prototype.hasOwnProperty.call(body || {}, 'templateAdditionalNames');
    const hasEmail = Object.prototype.hasOwnProperty.call(body || {}, 'ssclinicalNurseLeaderEmail');
    const hasStaffProgram = Object.prototype.hasOwnProperty.call(body || {}, 'staffDefaultProgramId');
    const hasClientProgram = Object.prototype.hasOwnProperty.call(body || {}, 'clientDefaultProgramId');
    const hasPartnerProgram = Object.prototype.hasOwnProperty.call(body || {}, 'partnerDefaultProgramId');
    const hasAllowPersonaSwitch = Object.prototype.hasOwnProperty.call(body || {}, 'allowPersonaSwitchByWhatsApp');
    const hasPersonaTtl = Object.prototype.hasOwnProperty.call(body || {}, 'personaSwitchTtlMinutes');
    const hasStaffMenu = Object.prototype.hasOwnProperty.call(body || {}, 'staffProgramMenuIds');
    const hasClientMenu = Object.prototype.hasOwnProperty.call(body || {}, 'clientProgramMenuIds');
    const hasPartnerMenu = Object.prototype.hasOwnProperty.call(body || {}, 'partnerProgramMenuIds');
    const hasPartnerPhones = Object.prototype.hasOwnProperty.call(body || {}, 'partnerPhoneE164s');
    if (
      !hasRecruitTemplate &&
      !hasInterviewTemplate &&
      !hasAdditionalTemplates &&
      !hasEmail &&
      !hasStaffProgram &&
      !hasClientProgram &&
      !hasPartnerProgram &&
      !hasAllowPersonaSwitch &&
      !hasPersonaTtl &&
      !hasStaffMenu &&
      !hasClientMenu &&
      !hasPartnerMenu &&
      !hasPartnerPhones
    ) {
      return reply
        .code(400)
        .send({ error: 'Body vacío. Envía al menos 1 campo para actualizar.' });
    }

    const emailRaw = body?.ssclinicalNurseLeaderEmail;
    const nextEmail =
      emailRaw === null ? null : typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : null;
    if (typeof emailRaw === 'string' && nextEmail && (!nextEmail.includes('@') || nextEmail.length > 254)) {
      return reply.code(400).send({ error: 'Email inválido.' });
    }

    const recruitTemplateRaw = body?.templateRecruitmentStartName;
    const nextRecruitTemplateName =
      recruitTemplateRaw === null
        ? null
        : typeof recruitTemplateRaw === 'string'
          ? recruitTemplateRaw.trim()
          : null;
    if (typeof recruitTemplateRaw === 'string' && nextRecruitTemplateName && nextRecruitTemplateName.length > 120) {
      return reply.code(400).send({ error: '"templateRecruitmentStartName" es demasiado largo (max 120).' });
    }

    const interviewTemplateRaw = body?.templateInterviewConfirmationName;
    const nextInterviewTemplateName =
      interviewTemplateRaw === null
        ? null
        : typeof interviewTemplateRaw === 'string'
          ? interviewTemplateRaw.trim()
          : null;
    if (
      typeof interviewTemplateRaw === 'string' &&
      nextInterviewTemplateName &&
      nextInterviewTemplateName.length > 120
    ) {
      return reply.code(400).send({ error: '"templateInterviewConfirmationName" es demasiado largo (max 120).' });
    }

    const normalizeTemplateList = (value: unknown): string[] => {
      if (!Array.isArray(value)) return [];
      const out: string[] = [];
      for (const item of value) {
        const name = String(item || '').trim();
        if (!name) continue;
        if (name.length > 120) {
          throw new Error('"templateAdditionalNames" contiene un nombre demasiado largo (max 120).');
        }
        if (!out.includes(name)) out.push(name);
      }
      return out;
    };
    let nextAdditionalTemplateNames: string[] | null = null;
    if (hasAdditionalTemplates) {
      try {
        nextAdditionalTemplateNames = normalizeTemplateList(body?.templateAdditionalNames);
      } catch (err: any) {
        return reply.code(400).send({ error: err?.message || 'templateAdditionalNames inválido.' });
      }
    }

    const staffProgramRaw = body?.staffDefaultProgramId;
    const nextStaffProgramId =
      staffProgramRaw === null ? null : typeof staffProgramRaw === 'string' ? staffProgramRaw.trim() : null;
    if (typeof staffProgramRaw === 'string' && nextStaffProgramId && nextStaffProgramId.length > 64) {
      return reply.code(400).send({ error: '"staffDefaultProgramId" es demasiado largo (max 64).' });
    }

    const clientProgramRaw = body?.clientDefaultProgramId;
    const nextClientProgramId =
      clientProgramRaw === null ? null : typeof clientProgramRaw === 'string' ? clientProgramRaw.trim() : null;
    if (typeof clientProgramRaw === 'string' && nextClientProgramId && nextClientProgramId.length > 64) {
      return reply.code(400).send({ error: '"clientDefaultProgramId" es demasiado largo (max 64).' });
    }

    const partnerProgramRaw = body?.partnerDefaultProgramId;
    const nextPartnerProgramId =
      partnerProgramRaw === null ? null : typeof partnerProgramRaw === 'string' ? partnerProgramRaw.trim() : null;
    if (typeof partnerProgramRaw === 'string' && nextPartnerProgramId && nextPartnerProgramId.length > 64) {
      return reply.code(400).send({ error: '"partnerDefaultProgramId" es demasiado largo (max 64).' });
    }

    const nextAllowPersonaSwitch =
      typeof body.allowPersonaSwitchByWhatsApp === 'boolean' ? Boolean(body.allowPersonaSwitchByWhatsApp) : null;
    const ttlRaw = typeof body.personaSwitchTtlMinutes === 'number' ? body.personaSwitchTtlMinutes : null;
    const nextPersonaTtlMinutes =
      ttlRaw === null
        ? null
        : Number.isFinite(ttlRaw)
          ? Math.min(10_080, Math.max(5, Math.floor(ttlRaw)))
          : null;

    const normalizeIdList = (value: any): string[] => {
      if (!Array.isArray(value)) return [];
      const out: string[] = [];
      for (const item of value) {
        const id = String(item || '').trim();
        if (!id) continue;
        if (!out.includes(id)) out.push(id);
      }
      return out;
    };
    const nextStaffMenuIds = hasStaffMenu ? normalizeIdList(body.staffProgramMenuIds) : null;
    const nextClientMenuIds = hasClientMenu ? normalizeIdList(body.clientProgramMenuIds) : null;
    const nextPartnerMenuIds = hasPartnerMenu ? normalizeIdList(body.partnerProgramMenuIds) : null;
    const nextPartnerPhones = hasPartnerPhones ? normalizeIdList(body.partnerPhoneE164s) : null;

    const existing = await prisma.workspace.findUnique({
      where: { id: access.workspaceId },
      select: {
        id: true,
        archivedAt: true,
        templateRecruitmentStartName: true as any,
        templateInterviewConfirmationName: true as any,
        templateAdditionalNamesJson: true as any,
        ssclinicalNurseLeaderEmail: true as any,
        staffDefaultProgramId: true as any,
        clientDefaultProgramId: true as any,
        partnerDefaultProgramId: true as any,
        allowPersonaSwitchByWhatsApp: true as any,
        personaSwitchTtlMinutes: true as any,
        staffProgramMenuIdsJson: true as any,
        clientProgramMenuIdsJson: true as any,
        partnerProgramMenuIdsJson: true as any,
        partnerPhoneE164sJson: true as any,
      } as any,
    });
    if (!existing || existing.archivedAt) return reply.code(404).send({ error: 'Workspace no encontrado.' });

    if (typeof staffProgramRaw === 'string' && nextStaffProgramId) {
      const exists = await prisma.program.findFirst({
        where: { id: nextStaffProgramId, workspaceId: access.workspaceId, archivedAt: null, isActive: true },
        select: { id: true },
      });
      if (!exists?.id) {
        return reply.code(400).send({ error: 'Program no existe o está inactivo para este workspace.' });
      }
    }

    const validateActiveProgram = async (programId: string): Promise<boolean> => {
      const exists = await prisma.program.findFirst({
        where: { id: programId, workspaceId: access.workspaceId, archivedAt: null, isActive: true },
        select: { id: true },
      });
      return Boolean(exists?.id);
    };
    if (typeof clientProgramRaw === 'string' && nextClientProgramId) {
      const ok = await validateActiveProgram(nextClientProgramId);
      if (!ok) return reply.code(400).send({ error: 'clientDefaultProgramId no existe o está inactivo para este workspace.' });
    }
    if (typeof partnerProgramRaw === 'string' && nextPartnerProgramId) {
      const ok = await validateActiveProgram(nextPartnerProgramId);
      if (!ok) return reply.code(400).send({ error: 'partnerDefaultProgramId no existe o está inactivo para este workspace.' });
    }

    const updated = await prisma.workspace.update({
      where: { id: access.workspaceId },
      data: {
        ...(hasRecruitTemplate
          ? {
              templateRecruitmentStartName:
                typeof recruitTemplateRaw === 'string' ? nextRecruitTemplateName || null : null,
            }
          : {}),
        ...(hasInterviewTemplate
          ? {
              templateInterviewConfirmationName:
                typeof interviewTemplateRaw === 'string' ? nextInterviewTemplateName || null : null,
            }
          : {}),
        ...(hasAdditionalTemplates
          ? {
              templateAdditionalNamesJson:
                nextAdditionalTemplateNames && nextAdditionalTemplateNames.length > 0
                  ? serializeJson(nextAdditionalTemplateNames)
                  : null,
            }
          : {}),
        ...(hasEmail ? { ssclinicalNurseLeaderEmail: typeof emailRaw === 'string' ? nextEmail || null : null } : {}),
        ...(hasStaffProgram ? { staffDefaultProgramId: typeof staffProgramRaw === 'string' ? nextStaffProgramId || null : null } : {}),
        ...(hasClientProgram ? { clientDefaultProgramId: typeof clientProgramRaw === 'string' ? nextClientProgramId || null : null } : {}),
        ...(hasPartnerProgram ? { partnerDefaultProgramId: typeof partnerProgramRaw === 'string' ? nextPartnerProgramId || null : null } : {}),
        ...(hasAllowPersonaSwitch && nextAllowPersonaSwitch !== null ? { allowPersonaSwitchByWhatsApp: nextAllowPersonaSwitch } : {}),
        ...(hasPersonaTtl && nextPersonaTtlMinutes !== null ? { personaSwitchTtlMinutes: nextPersonaTtlMinutes } : {}),
        ...(hasStaffMenu ? { staffProgramMenuIdsJson: nextStaffMenuIds && nextStaffMenuIds.length > 0 ? serializeJson(nextStaffMenuIds) : null } : {}),
        ...(hasClientMenu ? { clientProgramMenuIdsJson: nextClientMenuIds && nextClientMenuIds.length > 0 ? serializeJson(nextClientMenuIds) : null } : {}),
        ...(hasPartnerMenu ? { partnerProgramMenuIdsJson: nextPartnerMenuIds && nextPartnerMenuIds.length > 0 ? serializeJson(nextPartnerMenuIds) : null } : {}),
        ...(hasPartnerPhones ? { partnerPhoneE164sJson: nextPartnerPhones && nextPartnerPhones.length > 0 ? serializeJson(nextPartnerPhones) : null } : {}),
        updatedAt: new Date(),
      } as any,
      select: {
        id: true,
        templateRecruitmentStartName: true as any,
        templateInterviewConfirmationName: true as any,
        templateAdditionalNamesJson: true as any,
        ssclinicalNurseLeaderEmail: true as any,
        staffDefaultProgramId: true as any,
        clientDefaultProgramId: true as any,
        partnerDefaultProgramId: true as any,
        allowPersonaSwitchByWhatsApp: true as any,
        personaSwitchTtlMinutes: true as any,
        staffProgramMenuIdsJson: true as any,
        clientProgramMenuIdsJson: true as any,
        partnerProgramMenuIdsJson: true as any,
        partnerPhoneE164sJson: true as any,
        updatedAt: true,
      } as any,
    });

    if (hasEmail) {
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
    }
    if (hasStaffProgram) {
      await prisma.configChangeLog
        .create({
          data: {
            workspaceId: access.workspaceId,
            userId,
            type: 'WORKSPACE_STAFF_DEFAULT_PROGRAM',
            beforeJson: serializeJson({ staffDefaultProgramId: (existing as any).staffDefaultProgramId || null }),
            afterJson: serializeJson({ staffDefaultProgramId: (updated as any).staffDefaultProgramId || null }),
          },
        })
        .catch(() => {});
    }

    if (hasRecruitTemplate || hasInterviewTemplate || hasAdditionalTemplates) {
      await prisma.configChangeLog
        .create({
          data: {
            workspaceId: access.workspaceId,
            userId,
            type: 'WORKSPACE_TEMPLATE_DEFAULTS',
            beforeJson: serializeJson({
              templateRecruitmentStartName: (existing as any).templateRecruitmentStartName || null,
              templateInterviewConfirmationName: (existing as any).templateInterviewConfirmationName || null,
              templateAdditionalNamesJson: (existing as any).templateAdditionalNamesJson || null,
            }),
            afterJson: serializeJson({
              templateRecruitmentStartName: (updated as any).templateRecruitmentStartName || null,
              templateInterviewConfirmationName: (updated as any).templateInterviewConfirmationName || null,
              templateAdditionalNamesJson: (updated as any).templateAdditionalNamesJson || null,
            }),
          },
        })
        .catch(() => {});
    }

    if (hasClientProgram || hasPartnerProgram || hasAllowPersonaSwitch || hasPersonaTtl || hasStaffMenu || hasClientMenu || hasPartnerMenu || hasPartnerPhones) {
      await prisma.configChangeLog
        .create({
          data: {
            workspaceId: access.workspaceId,
            userId,
            type: 'WORKSPACE_PERSONA_ROUTING',
            beforeJson: serializeJson({
              clientDefaultProgramId: (existing as any).clientDefaultProgramId || null,
              partnerDefaultProgramId: (existing as any).partnerDefaultProgramId || null,
              allowPersonaSwitchByWhatsApp: typeof (existing as any).allowPersonaSwitchByWhatsApp === 'boolean' ? Boolean((existing as any).allowPersonaSwitchByWhatsApp) : true,
              personaSwitchTtlMinutes: Number.isFinite((existing as any).personaSwitchTtlMinutes) ? Number((existing as any).personaSwitchTtlMinutes) : 360,
              staffProgramMenuIdsJson: (existing as any).staffProgramMenuIdsJson || null,
              clientProgramMenuIdsJson: (existing as any).clientProgramMenuIdsJson || null,
              partnerProgramMenuIdsJson: (existing as any).partnerProgramMenuIdsJson || null,
              partnerPhoneE164sJson: (existing as any).partnerPhoneE164sJson || null,
            }),
            afterJson: serializeJson({
              clientDefaultProgramId: (updated as any).clientDefaultProgramId || null,
              partnerDefaultProgramId: (updated as any).partnerDefaultProgramId || null,
              allowPersonaSwitchByWhatsApp: typeof (updated as any).allowPersonaSwitchByWhatsApp === 'boolean' ? Boolean((updated as any).allowPersonaSwitchByWhatsApp) : true,
              personaSwitchTtlMinutes: Number.isFinite((updated as any).personaSwitchTtlMinutes) ? Number((updated as any).personaSwitchTtlMinutes) : 360,
              staffProgramMenuIdsJson: (updated as any).staffProgramMenuIdsJson || null,
              clientProgramMenuIdsJson: (updated as any).clientProgramMenuIdsJson || null,
              partnerProgramMenuIdsJson: (updated as any).partnerProgramMenuIdsJson || null,
              partnerPhoneE164sJson: (updated as any).partnerPhoneE164sJson || null,
            }),
          },
        })
        .catch(() => {});
    }

    return {
      ok: true,
      templateRecruitmentStartName: String((updated as any).templateRecruitmentStartName || '').trim() || null,
      templateInterviewConfirmationName: String((updated as any).templateInterviewConfirmationName || '').trim() || null,
      templateAdditionalNames: (() => {
        try {
          const raw = String((updated as any).templateAdditionalNamesJson || '').trim();
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed.map((v) => String(v)).filter(Boolean) : [];
        } catch {
          return [];
        }
      })(),
      ssclinicalNurseLeaderEmail: (updated as any).ssclinicalNurseLeaderEmail || null,
      staffDefaultProgramId: (updated as any).staffDefaultProgramId || null,
      clientDefaultProgramId: (updated as any).clientDefaultProgramId || null,
      partnerDefaultProgramId: (updated as any).partnerDefaultProgramId || null,
      allowPersonaSwitchByWhatsApp: typeof (updated as any).allowPersonaSwitchByWhatsApp === 'boolean' ? Boolean((updated as any).allowPersonaSwitchByWhatsApp) : true,
      personaSwitchTtlMinutes: Number.isFinite((updated as any).personaSwitchTtlMinutes) ? Number((updated as any).personaSwitchTtlMinutes) : 360,
      staffProgramMenuIds: (() => {
        try {
          const raw = String((updated as any).staffProgramMenuIdsJson || '').trim();
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
        } catch {
          return [];
        }
      })(),
      clientProgramMenuIds: (() => {
        try {
          const raw = String((updated as any).clientProgramMenuIdsJson || '').trim();
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
        } catch {
          return [];
        }
      })(),
      partnerProgramMenuIds: (() => {
        try {
          const raw = String((updated as any).partnerProgramMenuIdsJson || '').trim();
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
        } catch {
          return [];
        }
      })(),
      partnerPhoneE164s: (() => {
        try {
          const raw = String((updated as any).partnerPhoneE164sJson || '').trim();
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
        } catch {
          return [];
        }
      })(),
      updatedAt: new Date((updated as any).updatedAt).toISOString(),
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

  app.get('/current/stages', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const includeArchived = String((request.query as any)?.includeArchived || '').toLowerCase() === 'true';
    const stages = await listWorkspaceStages({ workspaceId: access.workspaceId, includeArchived }).catch(() => []);
    return { ok: true, stages };
  });

  app.post('/current/stages', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const userId = request.user?.userId ? String(request.user.userId) : null;

    const body = request.body as { slug?: string; labelEs?: string; order?: number; isDefault?: boolean };
    const slug = normalizeStageSlug(body?.slug);
    const labelEs = String(body?.labelEs || '').trim();
    const order = typeof body?.order === 'number' && Number.isFinite(body.order) ? Math.round(body.order) : null;
    const isDefault = Object.prototype.hasOwnProperty.call(body || {}, 'isDefault') ? Boolean((body as any).isDefault) : null;
    if (!slug) return reply.code(400).send({ error: '"slug" es requerido.' });
    if (!/^[A-Z0-9][A-Z0-9_]*$/.test(slug)) {
      return reply.code(400).send({ error: '"slug" inválido. Usa A-Z, 0-9 y _ (ej: EN_PROCESO).' });
    }
    if (!labelEs) return reply.code(400).send({ error: '"labelEs" es requerido.' });
    if (labelEs.length > 80) return reply.code(400).send({ error: '"labelEs" es demasiado largo (max 80).' });

    await ensureWorkspaceStages(access.workspaceId).catch(() => {});

    const existing = await prisma.workspaceStage
      .findUnique({ where: { workspaceId_slug: { workspaceId: access.workspaceId, slug } } })
      .catch(() => null);
    if (existing && !existing.archivedAt) {
      return reply.code(409).send({ error: `Stage "${slug}" ya existe.` });
    }

    const created = await prisma.workspaceStage
      .upsert({
        where: { workspaceId_slug: { workspaceId: access.workspaceId, slug } },
        create: {
          workspaceId: access.workspaceId,
          slug,
          labelEs,
          order: order ?? 0,
          isDefault: Boolean(isDefault),
          isActive: true,
          isTerminal: false,
          archivedAt: null,
        } as any,
        update: {
          labelEs,
          ...(order === null ? {} : { order }),
          ...(isDefault === null ? {} : { isDefault: Boolean(isDefault) }),
          archivedAt: null,
          isActive: true,
          updatedAt: new Date(),
        } as any,
      })
      .catch((err: any) => {
        request.log.warn({ err, slug }, 'Failed to upsert workspace stage');
        throw err;
      });

    // If the created stage is marked as default, clear other defaults (one default per workspace).
    if (isDefault) {
      await prisma.workspaceStage
        .updateMany({
          where: { workspaceId: access.workspaceId, id: { not: created.id }, archivedAt: null },
          data: { isDefault: false } as any,
        })
        .catch(() => {});
      await prisma.workspaceStage.update({ where: { id: created.id }, data: { isDefault: true } as any }).catch(() => {});
    }

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId,
          type: 'WORKSPACE_STAGE_CREATED',
          beforeJson: existing ? serializeJson({ id: existing.id, slug: existing.slug, labelEs: existing.labelEs, order: existing.order, isActive: existing.isActive, archivedAt: existing.archivedAt ? true : false }) : null,
          afterJson: serializeJson({ id: created.id, slug: created.slug, labelEs: created.labelEs, order: created.order, isActive: created.isActive, archivedAt: created.archivedAt ? true : false }),
        },
      })
      .catch(() => {});

    const stages = await listWorkspaceStages({ workspaceId: access.workspaceId, includeArchived: true }).catch(() => []);
    return { ok: true, stages };
  });

  app.patch('/current/stages/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const userId = request.user?.userId ? String(request.user.userId) : null;

    const { id } = request.params as { id: string };
    const body = request.body as {
      labelEs?: string;
      order?: number;
      isActive?: boolean;
      isTerminal?: boolean;
      isDefault?: boolean;
      archived?: boolean;
    };

    const existing = await prisma.workspaceStage.findFirst({
      where: { id, workspaceId: access.workspaceId },
    });
    if (!existing) return reply.code(404).send({ error: 'Stage no encontrado.' });

    const patch: any = {};
    if (Object.prototype.hasOwnProperty.call(body || {}, 'labelEs')) {
      const label = String(body?.labelEs || '').trim();
      if (!label) return reply.code(400).send({ error: '"labelEs" es requerido.' });
      if (label.length > 80) return reply.code(400).send({ error: '"labelEs" es demasiado largo (max 80).' });
      patch.labelEs = label;
    }
    if (Object.prototype.hasOwnProperty.call(body || {}, 'order')) {
      const o = body?.order;
      if (typeof o !== 'number' || !Number.isFinite(o)) return reply.code(400).send({ error: '"order" inválido.' });
      patch.order = Math.round(o);
    }
    if (Object.prototype.hasOwnProperty.call(body || {}, 'isActive')) {
      if (typeof body?.isActive !== 'boolean') return reply.code(400).send({ error: '"isActive" inválido.' });
      patch.isActive = body.isActive;
    }
    if (Object.prototype.hasOwnProperty.call(body || {}, 'isTerminal')) {
      if (typeof body?.isTerminal !== 'boolean') return reply.code(400).send({ error: '"isTerminal" inválido.' });
      patch.isTerminal = body.isTerminal;
    }
    const touchedIsDefault = Object.prototype.hasOwnProperty.call(body || {}, 'isDefault');
    if (touchedIsDefault) {
      if (typeof (body as any)?.isDefault !== 'boolean') return reply.code(400).send({ error: '"isDefault" inválido.' });
      patch.isDefault = Boolean((body as any).isDefault);
    }
    if (Object.prototype.hasOwnProperty.call(body || {}, 'archived')) {
      if (typeof body?.archived !== 'boolean') return reply.code(400).send({ error: '"archived" inválido.' });
      patch.archivedAt = body.archived ? new Date() : null;
      if (body.archived) {
        patch.isActive = false;
      }
    }
    patch.updatedAt = new Date();

    // Default stage fix-up is workspace-wide: ensure only one default and never leave workspace without a default.
    const updated = await prisma.$transaction(async (tx) => {
      let next = await tx.workspaceStage.update({ where: { id: existing.id }, data: patch });
      if (touchedIsDefault && patch.isDefault === true) {
        await tx.workspaceStage
          .updateMany({
            where: { workspaceId: access.workspaceId, id: { not: existing.id }, archivedAt: null },
            data: { isDefault: false },
          })
          .catch(() => {});
        next = await tx.workspaceStage.update({ where: { id: existing.id }, data: { isDefault: true } }).catch(() => next);
      }
      return next;
    });

    // If we archived/deactivated/un-defaulted the default stage, pick a new default (best effort).
    try {
      const active = await prisma.workspaceStage.findMany({
        where: { workspaceId: access.workspaceId, archivedAt: null, isActive: true },
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, isDefault: true },
      });
      const hasDefault = active.some((s) => Boolean(s.isDefault));
      if (!hasDefault && active.length > 0) {
        await prisma.workspaceStage.updateMany({ where: { workspaceId: access.workspaceId, archivedAt: null }, data: { isDefault: false } }).catch(() => {});
        await prisma.workspaceStage.update({ where: { id: active[0].id }, data: { isDefault: true } }).catch(() => {});
      }
    } catch {
      // ignore
    }

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId,
          type: 'WORKSPACE_STAGE_UPDATED',
          beforeJson: serializeJson({ id: existing.id, slug: existing.slug, labelEs: existing.labelEs, order: existing.order, isDefault: (existing as any).isDefault || false, isActive: existing.isActive, isTerminal: existing.isTerminal, archivedAt: existing.archivedAt ? true : false }),
          afterJson: serializeJson({ id: updated.id, slug: updated.slug, labelEs: updated.labelEs, order: updated.order, isDefault: (updated as any).isDefault || false, isActive: updated.isActive, isTerminal: updated.isTerminal, archivedAt: updated.archivedAt ? true : false }),
        },
      })
      .catch(() => {});

    const stages = await listWorkspaceStages({ workspaceId: access.workspaceId, includeArchived: true }).catch(() => []);
    return { ok: true, stages };
  });
}
