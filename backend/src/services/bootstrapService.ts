import { prisma } from '../db/client';
import { hashPassword } from './passwordService';
import crypto from 'node:crypto';
import {
  DEFAULT_ADMIN_AI_PROMPT,
  DEFAULT_INTERVIEW_AI_PROMPT,
  DEFAULT_SALES_AI_PROMPT,
  getAdminWaIdAllowlist,
  getOutboundAllowlist,
  getOutboundPolicy,
  getSystemConfig,
  getTestWaIdAllowlist,
  updateAuthorizedNumbersConfig,
  updateOutboundSafetyConfig,
} from './configService';
import { getEffectiveOpenAiKey } from './aiService';
import { DEFAULT_AI_PROMPT } from '../constants/ai';
import { ensureWorkspaceStages } from './workspaceStageService';

async function ensureWorkspace(id: string, name: string, isSandbox: boolean) {
  const existing = await prisma.workspace.findUnique({ where: { id } }).catch(() => null);
  if (existing) {
    const needsUpdate = existing.name !== name || existing.isSandbox !== isSandbox;
    if (!needsUpdate) return existing;
    return prisma.workspace.update({ where: { id }, data: { name, isSandbox } });
  }
  return prisma.workspace.create({ data: { id, name, isSandbox } });
}

async function ensureMembership(userId: string, workspaceId: string, role: string) {
  return prisma.membership.upsert({
    where: { userId_workspaceId: { userId, workspaceId } },
    create: { userId, workspaceId, role, archivedAt: null } as any,
    update: { role, archivedAt: null } as any,
  });
}

async function ensureWorkspaceInvite(params: {
  workspaceId: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
  assignedOnly?: boolean;
}) {
  const email = params.email.trim().toLowerCase();
  const role = params.role;
  const assignedOnly = role === 'MEMBER' ? Boolean(params.assignedOnly) : false;
  const now = new Date();

  const existing = await prisma.workspaceInvite.findFirst({
    where: {
      workspaceId: params.workspaceId,
      email,
      role,
      assignedOnly,
      archivedAt: null,
      acceptedAt: null,
      expiresAt: { gt: now },
    } as any,
    select: { id: true },
  });
  if (existing?.id) return existing;

  const token = crypto.randomBytes(18).toString('base64url');
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return prisma.workspaceInvite.create({
    data: {
      workspaceId: params.workspaceId,
      email,
      role,
      assignedOnly,
      token,
      expiresAt,
    } as any,
    select: { id: true },
  });
}

async function ensurePhoneLine(params: {
  id: string;
  workspaceId: string;
  alias: string;
  waPhoneNumberId: string;
}) {
  const existing = await prisma.phoneLine.findUnique({ where: { id: params.id } }).catch(() => null);
  if (existing) {
    if (
      existing.workspaceId !== params.workspaceId ||
      existing.waPhoneNumberId !== params.waPhoneNumberId ||
      existing.alias !== params.alias
    ) {
      return prisma.phoneLine.update({
        where: { id: params.id },
        data: { workspaceId: params.workspaceId, alias: params.alias, waPhoneNumberId: params.waPhoneNumberId }
      });
    }
    return existing;
  }
  return prisma.phoneLine.create({
    data: {
      id: params.id,
      workspaceId: params.workspaceId,
      alias: params.alias,
      phoneE164: null,
      waPhoneNumberId: params.waPhoneNumberId,
      isActive: true
    }
  });
}

async function ensureProgram(params: {
  workspaceId: string;
  name: string;
  slug: string;
  agentSystemPrompt: string;
}) {
  const existing = await prisma.program.findFirst({
    where: { workspaceId: params.workspaceId, slug: params.slug, archivedAt: null }
  });
  if (existing) return existing;
  return prisma.program.create({
    data: {
      workspaceId: params.workspaceId,
      name: params.name,
      slug: params.slug,
      isActive: true,
      agentSystemPrompt: params.agentSystemPrompt
    }
  });
}

async function ensureConnector(params: {
  workspaceId: string;
  name: string;
  slug: string;
  description?: string | null;
  actions?: string[];
}) {
  const existing = await prisma.workspaceConnector.findFirst({
    where: { workspaceId: params.workspaceId, slug: params.slug, archivedAt: null },
    select: { id: true },
  });
  if (existing) return existing;
  return prisma.workspaceConnector.create({
    data: {
      workspaceId: params.workspaceId,
      name: params.name,
      slug: params.slug,
      description: params.description ?? null,
      isActive: true,
      authType: 'BEARER_TOKEN' as any,
      authHeaderName: 'Authorization' as any,
      actionsJson: params.actions && params.actions.length > 0 ? JSON.stringify(params.actions) : null,
    },
    select: { id: true },
  });
}

async function ensureDefaultAutomationRule(params: { workspaceId: string; enabled: boolean }) {
  const existing = await prisma.automationRule.findFirst({
    where: { workspaceId: params.workspaceId, trigger: 'INBOUND_MESSAGE', name: 'Default inbound -> RUN_AGENT', archivedAt: null }
  });

  const data = {
    enabled: params.enabled,
    priority: 100,
    trigger: 'INBOUND_MESSAGE',
    scopePhoneLineId: null,
    scopeProgramId: null,
    conditionsJson: JSON.stringify([]),
    actionsJson: JSON.stringify([{ type: 'RUN_AGENT', agent: 'program_default' }])
  };

  if (existing) {
    return prisma.automationRule.update({ where: { id: existing.id }, data });
  }
  return prisma.automationRule.create({
    data: { workspaceId: params.workspaceId, name: 'Default inbound -> RUN_AGENT', description: 'Regla base: ante inbound, corre RUN_AGENT.', ...data } as any
  });
}

export async function ensureAdminUser(): Promise<void> {
  let admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (!admin) {
    const passwordHash = await hashPassword('admin123');
    admin = await prisma.user.create({
      data: {
        name: 'Admin',
        email: 'admin@example.com',
        passwordHash,
        role: 'ADMIN'
      }
    });
  }

  let config = await getSystemConfig().catch(() => null);

  // DEV safety: enforce allowlist-only with exactly admin+test numbers, to avoid molesting real candidates.
  const appEnv = String(process.env.APP_ENV || '').toLowerCase().trim();
  const isProd = appEnv === 'production' || appEnv === 'prod';
  if (!isProd && config) {
    const desiredAdmin = ['56982345846'];
    const desiredTest = ['56994830202'];
    const currentAdmin = getAdminWaIdAllowlist(config);
    const currentTest = getTestWaIdAllowlist(config);
    const currentExtraAllowlist = getOutboundAllowlist(config);

    const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, idx) => v === b[idx]);
    const needsNumbers = !sameList(currentAdmin, desiredAdmin) || !sameList(currentTest, desiredTest);
    const needsPolicy = getOutboundPolicy(config) !== 'ALLOWLIST_ONLY';
    const needsOutboundAllowlistClear = currentExtraAllowlist.length > 0;

    if (needsNumbers) {
      await updateAuthorizedNumbersConfig({ adminNumbers: desiredAdmin, testNumbers: desiredTest }).catch(() => {});
    }
    if (needsPolicy || needsOutboundAllowlistClear) {
      await updateOutboundSafetyConfig({ outboundPolicy: 'ALLOWLIST_ONLY', outboundAllowlist: [], outboundAllowAllUntil: null }).catch(() => {});
    }
    if (needsNumbers || needsPolicy || needsOutboundAllowlistClear) {
      config = await getSystemConfig().catch(() => config);
    }
  }

  await ensureWorkspace('default', 'Hunter Internal', false);
  await ensureWorkspace('sandbox', 'Platform Sandbox', true);
  if (!isProd) {
    await ensureWorkspace('ssclinical', 'SSClinical', false);
  }
  await ensureWorkspaceStages('default').catch(() => {});
  await ensureWorkspaceStages('sandbox').catch(() => {});
  await ensureMembership(admin.id, 'default', 'OWNER');
  await ensureMembership(admin.id, 'sandbox', 'OWNER');

  // Platform SuperAdmin: only cesarabia@gmail.com.
  const superadminEmail = 'cesarabia@gmail.com';
  await prisma.user
    .updateMany({
      where: { platformRole: 'SUPERADMIN', email: { not: superadminEmail } } as any,
      data: { platformRole: 'NONE' } as any,
    })
    .catch(() => {});
  await prisma.user
    .updateMany({
      where: { email: superadminEmail } as any,
      data: { platformRole: 'SUPERADMIN' } as any,
    })
    .catch(() => {});

  const phoneNumberId = config?.whatsappPhoneId || 'unknown';
  await ensurePhoneLine({ id: 'default', workspaceId: 'default', alias: 'Default', waPhoneNumberId: phoneNumberId });
  await ensurePhoneLine({ id: 'sandbox-default', workspaceId: 'sandbox', alias: 'Sandbox', waPhoneNumberId: 'sandbox' });

  const recruitmentPrompt = `
Programa: Reclutamiento (Postulaciones).
Objetivo: completar los datos mínimos del candidato: nombre y apellido, comuna/ciudad (Chile), RUT, experiencia, disponibilidad; email es opcional.

Instrucciones:
- Extrae datos desde el mensaje usando tools (resolve_location, validate_rut, normalize_text).
- Cuando detectes datos, usa UPSERT_PROFILE_FIELDS (solo con alta confianza).
- Si faltan datos, pregunta SOLO por los faltantes en 1 mensaje corto (máx 6 líneas).
- Cuando estén los mínimos, responde con cierre: "Gracias, {{name}}. Ya tenemos los datos mínimos. El equipo revisará tu postulación y te contactará por este medio."
  y emite NOTIFY_ADMIN eventType=RECRUIT_READY con un resumen útil.
`.trim();

  const interviewPrompt = `
Programa: Entrevista.
Objetivo: agendar/reagendar y confirmar entrevista.
- Si el usuario pide cancelar/cambiar/reagendar: NO es opt-out. Pide 2 alternativas (día + rango horario).
- Solo entrega dirección exacta después de CONFIRMED y solo si existe en config/agenda; si no, di "te enviaremos la dirección exacta por este medio".
`.trim();

  const adminPrompt = `
Programa: Admin.
Objetivo: ayudar al equipo a operar el CRM en lenguaje natural: agendar, cambiar estados, resumir candidatos.
Reglas:
- Si piden "último reclutamiento": usa el candidato más reciente y responde con resumen.
- Si el nombre tiene typos: fuzzy match; si hay ambigüedad lista top 3 para confirmar.
`.trim();

  const salesPrompt = `
Programa: Ventas.
Objetivo: apoyar a vendedores con pitch, objeciones y registro de visitas/ventas; generar resumen diario/semanal para admin.
`.trim();

  const pRecruit = await ensureProgram({
    workspaceId: 'default',
    name: 'Reclutamiento',
    slug: 'recruitment',
    agentSystemPrompt: config?.aiPrompt?.trim() || DEFAULT_AI_PROMPT || recruitmentPrompt
  });
  const pInterview = await ensureProgram({
    workspaceId: 'default',
    name: 'Entrevista',
    slug: 'interview',
    agentSystemPrompt: config?.interviewAiPrompt?.trim() || DEFAULT_INTERVIEW_AI_PROMPT || interviewPrompt
  });
  const pSales = await ensureProgram({
    workspaceId: 'default',
    name: 'Ventas',
    slug: 'sales',
    agentSystemPrompt: config?.salesAiPrompt?.trim() || DEFAULT_SALES_AI_PROMPT || salesPrompt
  });
  const pAdmin = await ensureProgram({
    workspaceId: 'default',
    name: 'Admin',
    slug: 'admin',
    agentSystemPrompt: config?.adminAiPrompt?.trim() || DEFAULT_ADMIN_AI_PROMPT || adminPrompt
  });

  await ensureProgram({ workspaceId: 'sandbox', name: 'Reclutamiento', slug: 'recruitment', agentSystemPrompt: pRecruit.agentSystemPrompt });
  await ensureProgram({ workspaceId: 'sandbox', name: 'Entrevista', slug: 'interview', agentSystemPrompt: pInterview.agentSystemPrompt });
  await ensureProgram({ workspaceId: 'sandbox', name: 'Ventas', slug: 'sales', agentSystemPrompt: pSales.agentSystemPrompt });
  await ensureProgram({ workspaceId: 'sandbox', name: 'Admin', slug: 'admin', agentSystemPrompt: pAdmin.agentSystemPrompt });

  // Default demo connector (base for Program Tools)
  await ensureConnector({
    workspaceId: 'default',
    name: 'Medilink',
    slug: 'medilink',
    description: 'Conector demo (sin endpoints reales en v1).',
    actions: ['search_patient', 'create_appointment', 'create_payment'],
  });
  await ensureConnector({
    workspaceId: 'sandbox',
    name: 'Medilink',
    slug: 'medilink',
    description: 'Conector demo (sandbox).',
    actions: ['search_patient', 'create_appointment', 'create_payment'],
  });

  const programByMode: Record<string, string> = {
    RECRUIT: pRecruit.id,
    INTERVIEW: pInterview.id,
    SELLER: pSales.id,
    OFF: pRecruit.id
  };
  await prisma.conversation.updateMany({ where: { programId: null, isAdmin: true }, data: { programId: pAdmin.id } });
  for (const [mode, programId] of Object.entries(programByMode)) {
    await prisma.conversation.updateMany({ where: { programId: null, isAdmin: false, aiMode: mode }, data: { programId } });
  }
  await prisma.conversation.updateMany({ where: { programId: null, isAdmin: false }, data: { programId: pRecruit.id } });

  const hasKey = Boolean(config && getEffectiveOpenAiKey(config));
  await ensureDefaultAutomationRule({ workspaceId: 'default', enabled: hasKey });
  await ensureDefaultAutomationRule({ workspaceId: 'sandbox', enabled: hasKey });

  // SSClinical pilot defaults (idempotent; never overwrite custom config).
  try {
    const ssclinical = await prisma.workspace.findUnique({
      where: { id: 'ssclinical' },
      select: { id: true, archivedAt: true, ssclinicalNurseLeaderEmail: true as any },
    });
    if (ssclinical && !ssclinical.archivedAt) {
      await ensureWorkspaceStages('ssclinical').catch(() => {});
      // Ensure inbound RUN_AGENT exists (workspace setup).
      await ensureDefaultAutomationRule({ workspaceId: 'ssclinical', enabled: hasKey }).catch(() => {});

      // Seed SSClinical Programs (no-op if already exist).
      await ensureProgram({
        workspaceId: 'ssclinical',
        name: 'Asistente Virtual SSClinical — Domicilio (Suero Hidratante y Terapia)',
        slug: 'coordinadora-ssclinical-suero-hidratante-y-terapia',
        agentSystemPrompt:
          `
Eres el Asistente Virtual de SSClinical (salud) para atención a domicilio.

Identidad (importante):
- Te presentas como: "Asistente Virtual SSClinical" (en el primer mensaje y si te preguntan quién eres).
- Programa actual: Domicilio (Suero Hidratante y Terapia).

Alcance:
- Solo atención a domicilio (no presencial).
- No inventes disponibilidad/horarios. Si el usuario quiere agendar, dile que la enfermera líder confirmará horarios.

Objetivo:
- Resolver dudas en forma humana (máx 6 líneas).
- Confirmar intención: 1) Más info 2) Coordinar/agendar.
- Si quieren coordinar/agendar: pedir datos mínimos en 1 mensaje:
  • Nombre y comuna/sector, • motivo/servicio (hidratación / sueroterapia), • fecha/horario preferido (si tiene), • si tiene orden médica (sí/no).

Handoff / Coordinación:
- Cuando el caso está listo para coordinar (interés explícito + datos mínimos), marca Stage=INTERESADO y avisa:
  "Perfecto, nuestra enfermera líder te contactará para confirmar horarios."

Reglas:
- No pedir datos sensibles innecesarios por WhatsApp.
- Si falta algo, pregunta 1 cosa a la vez.
- Si no sabes algo, dilo y pide confirmación.
`.trim(),
      }).catch(() => {});

      // Best-effort upgrade for existing SSClinical default program (do not overwrite if customized).
      try {
        const program = await prisma.program.findFirst({
          where: { workspaceId: 'ssclinical', slug: 'coordinadora-ssclinical-suero-hidratante-y-terapia', archivedAt: null },
          select: { id: true, name: true, agentSystemPrompt: true, updatedAt: true },
        });
        if (program?.id) {
          const oldNames = new Set([
            'Coordinadora Salud — Suero Hidratante y Sueroterapia',
            'Coordinadora Salud — Suero Hidratante y Terapia',
          ]);
          const oldPrompts = [
            'Eres Coordinadora de SSClinical (salud). Objetivo: informar y coordinar, pedir solo datos necesarios y guiar al siguiente paso. Responde breve y en español.',
            `
Programa: Coordinadora Salud (SSClinical).
Objetivo: informar sobre suero hidratante / suero terapia, resolver dudas, coordinar agenda y derivar cuando corresponda.
Reglas:
- Responde corto y humano (máx 6 líneas).
- Si falta información, pregunta 1 cosa a la vez.
- No inventes precios/políticas; si no existe en knowledge, dilo y pide confirmación.
`.trim(),
          ];

          const shouldUpdateName = oldNames.has(String(program.name || '').trim());
          const shouldUpdatePrompt = oldPrompts.includes(String(program.agentSystemPrompt || '').trim());

          if (shouldUpdateName || shouldUpdatePrompt) {
            await prisma.program.update({
              where: { id: program.id },
              data: {
                ...(shouldUpdateName ? { name: 'Asistente Virtual SSClinical — Domicilio (Suero Hidratante y Terapia)' } : {}),
                ...(shouldUpdatePrompt ? { agentSystemPrompt: `
Eres el Asistente Virtual de SSClinical (salud) para atención a domicilio.

Identidad (importante):
- Te presentas como: "Asistente Virtual SSClinical" (en el primer mensaje y si te preguntan quién eres).
- Programa actual: Domicilio (Suero Hidratante y Terapia).

Alcance:
- Solo atención a domicilio (no presencial).
- No inventes disponibilidad/horarios. Si el usuario quiere agendar, dile que la enfermera líder confirmará horarios.

Objetivo:
- Resolver dudas en forma humana (máx 6 líneas).
- Confirmar intención: 1) Más info 2) Coordinar/agendar.
- Si quieren coordinar/agendar: pedir datos mínimos en 1 mensaje:
  • Nombre y comuna/sector, • motivo/servicio (hidratación / sueroterapia), • fecha/horario preferido (si tiene), • si tiene orden médica (sí/no).

Handoff / Coordinación:
- Cuando el caso está listo para coordinar (interés explícito + datos mínimos), marca Stage=INTERESADO y avisa:
  "Perfecto, nuestra enfermera líder te contactará para confirmar horarios."

Reglas:
- No pedir datos sensibles innecesarios por WhatsApp.
- Si falta algo, pregunta 1 cosa a la vez.
- Si no sabes algo, dilo y pide confirmación.
`.trim() } : {}),
              },
            });
          }
        }
      } catch {
        // ignore
      }
      await ensureProgram({
        workspaceId: 'ssclinical',
        name: 'Enfermera Líder',
        slug: 'enfermera-lider-coordinadora',
        agentSystemPrompt:
          'Eres Enfermera Líder (SSClinical). Objetivo: coordinar casos, validar información clínica básica y definir próximos pasos. Responde breve y en español.',
      }).catch(() => {});
      await ensureProgram({
        workspaceId: 'ssclinical',
        name: 'Enfermera Domicilio',
        slug: 'enfermera-domicilio',
        agentSystemPrompt:
          'Eres Enfermera Domicilio (SSClinical). Objetivo: coordinar visita, confirmar disponibilidad y registrar observaciones. Responde breve y en español.',
      }).catch(() => {});
      await ensureProgram({
        workspaceId: 'ssclinical',
        name: 'Médico (Orden médica)',
        slug: 'medico-orden-medica',
        agentSystemPrompt:
          'Eres Médico (SSClinical). Objetivo: revisar/solicitar orden médica y orientar al siguiente paso. Responde breve y en español.',
      }).catch(() => {});

      // Seed pilot invites (archive-only; no crea usuarios automáticamente).
      await ensureWorkspaceInvite({ workspaceId: 'ssclinical', email: 'csarabia@ssclinical.cl', role: 'OWNER' }).catch(() => {});
      await ensureWorkspaceInvite({ workspaceId: 'ssclinical', email: 'contacto@ssclinical.cl', role: 'MEMBER', assignedOnly: true }).catch(() => {});

      // Ensure at least one internal ADMIN/OWNER membership exists to support the pilot (and allow auto-assignment).
      await ensureMembership(admin.id, 'ssclinical', 'ADMIN').catch(() => {});

      // Ensure nurse leader email is set (best-effort: first OWNER/ADMIN).
      const currentLeader = String((ssclinical as any).ssclinicalNurseLeaderEmail || '').trim();
      if (!currentLeader) {
        const leaderMembership = await prisma.membership.findFirst({
          where: {
            workspaceId: 'ssclinical',
            archivedAt: null,
            role: { in: ['OWNER', 'ADMIN'] },
            user: { email: { contains: '@' } },
          } as any,
          include: { user: { select: { email: true } } },
          orderBy: { createdAt: 'asc' },
        });
        const leaderEmail = String(leaderMembership?.user?.email || '').trim().toLowerCase();
        if (leaderEmail) {
          await prisma.workspace
            .update({
              where: { id: 'ssclinical' },
              data: { ssclinicalNurseLeaderEmail: leaderEmail } as any,
            })
            .catch(() => {});
        }
      }

      // Ensure stage assignment automation exists (SSClinical workflow).
      const stageRules = await prisma.automationRule.findMany({
        where: { workspaceId: 'ssclinical', trigger: 'STAGE_CHANGED', archivedAt: null },
        select: { id: true, actionsJson: true },
        orderBy: { createdAt: 'asc' },
      });
      const hasAssign = stageRules.some((r) => {
        try {
          const parsed = JSON.parse(String(r.actionsJson || '[]'));
          if (!Array.isArray(parsed)) return false;
          return parsed.some((a: any) => String(a?.type || '').toUpperCase() === 'ASSIGN_TO_NURSE_LEADER');
        } catch {
          return false;
        }
      });
      if (!hasAssign) {
        await prisma.automationRule
          .create({
            data: {
              workspaceId: 'ssclinical',
              name: 'SSClinical: Stage INTERESADO -> asignar enfermera líder',
              enabled: true,
              priority: 110,
              trigger: 'STAGE_CHANGED',
              scopePhoneLineId: null,
              scopeProgramId: null,
              conditionsJson: JSON.stringify([{ field: 'conversation.stage', op: 'equals', value: 'INTERESADO' }]),
              actionsJson: JSON.stringify([
                { type: 'ASSIGN_TO_NURSE_LEADER', note: 'Caso marcado como INTERESADO. Revisar y coordinar próximos pasos.' },
              ]),
              archivedAt: null,
            } as any,
          })
          .catch(() => {});
      }
    }
  } catch {
    // ignore; pilot workspace is optional
  }
}
