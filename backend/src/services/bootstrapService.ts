import { prisma } from '../db/client';
import { hashPassword } from './passwordService';
import {
  DEFAULT_ADMIN_AI_PROMPT,
  DEFAULT_INTERVIEW_AI_PROMPT,
  DEFAULT_SALES_AI_PROMPT,
  getSystemConfig
} from './configService';
import { getEffectiveOpenAiKey } from './aiService';
import { DEFAULT_AI_PROMPT } from '../constants/ai';

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
    data: { workspaceId: params.workspaceId, name: 'Default inbound -> RUN_AGENT', ...data }
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

  const config = await getSystemConfig().catch(() => null);

  await ensureWorkspace('default', 'Hunter Internal', false);
  await ensureWorkspace('sandbox', 'Platform Sandbox', true);
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
      // Ensure inbound RUN_AGENT exists (workspace setup).
      await ensureDefaultAutomationRule({ workspaceId: 'ssclinical', enabled: hasKey }).catch(() => {});

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
