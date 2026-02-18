import { prisma } from '../db/client';
import { serializeJson } from '../utils/json';
import { ensureWorkspaceStages, normalizeStageSlug } from './workspaceStageService';

export type WorkspaceTemplateId = 'RECRUITING' | 'SALES' | 'SUPPORT' | 'CLINIC' | 'LOGISTICS';

type StageSeed = {
  slug: string;
  labelEs: string;
  order: number;
  isDefault?: boolean;
  isTerminal?: boolean;
};

type ProgramSeed = {
  slug: string;
  name: string;
  description: string;
  prompt: string;
  kind: 'CLIENT' | 'STAFF';
};

type TemplateSpec = {
  id: WorkspaceTemplateId;
  label: string;
  description: string;
  stages: StageSeed[];
  programs: ProgramSeed[];
};

type SeedParams = {
  workspaceId: string;
  template: WorkspaceTemplateId;
  userId?: string | null;
};

export type SeedWorkspaceTemplateResult = {
  template: WorkspaceTemplateId;
  stages: { ensured: number; defaultStageSlug: string | null };
  programs: { ensured: string[]; clientDefaultProgramId: string | null; staffDefaultProgramId: string | null };
  automations: { inboundRunAgentEnsured: boolean; stageNotifyAssignEnsured: boolean };
};

const BASE_STAGES: StageSeed[] = [
  { slug: 'NEW_INTAKE', labelEs: 'Nuevo ingreso', order: 10, isDefault: true },
  { slug: 'WAITING_CANDIDATE', labelEs: 'Esperando datos', order: 20 },
  { slug: 'INTERESADO', labelEs: 'Interesado', order: 30 },
  { slug: 'EN_COORDINACION', labelEs: 'En coordinación', order: 40 },
  { slug: 'AGENDADO', labelEs: 'Agendado', order: 50 },
  { slug: 'COMPLETADO', labelEs: 'Completado', order: 60, isTerminal: true },
  { slug: 'NO_CONTACTAR', labelEs: 'No contactar', order: 95, isTerminal: true },
];

const STAFF_PROMPT_BASE = `
Programa STAFF — Operaciones (WhatsApp)

Reglas obligatorias:
- Si el mensaje pide operar casos ("clientes nuevos", "casos nuevos", "mis casos", "pendientes"), usa primero RUN_TOOL LIST_CASES.
- Para detalle de un caso, usa GET_CASE_SUMMARY.
- Para cambios operativos usa solo tools:
  - ADD_NOTE
  - SET_STAGE
  - SEND_CUSTOMER_MESSAGE
- No alucines. Si falla un tool, responde error claro + siguiente paso accionable.

Respuesta al saludo:
1) Casos nuevos
2) Buscar caso
3) Cambiar estado
4) Enviar mensaje al cliente
`.trim();

const TEMPLATE_SPECS: Record<WorkspaceTemplateId, TemplateSpec> = {
  RECRUITING: {
    id: 'RECRUITING',
    label: 'Recruiting',
    description: 'Captación y calificación de candidatos.',
    stages: BASE_STAGES,
    programs: [
      {
        slug: 'recruiting-client-assistant',
        name: 'Asistente Recruiting — Cliente',
        description: 'Intake y pre-filtro de candidatos.',
        kind: 'CLIENT',
        prompt:
          'Eres Asistente Virtual de Recruiting. Pide datos mínimos en lenguaje natural y resume faltantes sin loops.',
      },
      {
        slug: 'recruiting-staff-ops',
        name: 'Staff — Operaciones Recruiting',
        description: 'Consola staff por WhatsApp para gestionar casos.',
        kind: 'STAFF',
        prompt: STAFF_PROMPT_BASE,
      },
    ],
  },
  SALES: {
    id: 'SALES',
    label: 'Sales',
    description: 'Atención comercial y seguimiento de leads.',
    stages: BASE_STAGES.map((s) =>
      s.slug === 'WAITING_CANDIDATE' ? { ...s, labelEs: 'Esperando lead' } : s,
    ),
    programs: [
      {
        slug: 'sales-client-assistant',
        name: 'Asistente Ventas — Cliente',
        description: 'Calificación y coordinación comercial.',
        kind: 'CLIENT',
        prompt:
          'Eres Asistente Virtual de Ventas. Resuelve dudas, califica lead y coordina siguiente paso sin prometer agendas no confirmadas.',
      },
      {
        slug: 'sales-staff-ops',
        name: 'Staff — Operaciones Ventas',
        description: 'Consola staff por WhatsApp para leads/casos.',
        kind: 'STAFF',
        prompt: STAFF_PROMPT_BASE,
      },
    ],
  },
  SUPPORT: {
    id: 'SUPPORT',
    label: 'Support',
    description: 'Atención de soporte y seguimiento de tickets.',
    stages: BASE_STAGES.map((s) =>
      s.slug === 'WAITING_CANDIDATE' ? { ...s, labelEs: 'Esperando cliente' } : s,
    ),
    programs: [
      {
        slug: 'support-client-assistant',
        name: 'Asistente Soporte — Cliente',
        description: 'Recepción de requerimientos de soporte.',
        kind: 'CLIENT',
        prompt:
          'Eres Asistente Virtual de Soporte. Levanta contexto técnico, prioriza y deriva sin inventar resoluciones.',
      },
      {
        slug: 'support-staff-ops',
        name: 'Staff — Operaciones Soporte',
        description: 'Consola staff por WhatsApp para casos de soporte.',
        kind: 'STAFF',
        prompt: STAFF_PROMPT_BASE,
      },
    ],
  },
  CLINIC: {
    id: 'CLINIC',
    label: 'Clinic',
    description: 'Atención clínica y coordinación de visitas.',
    stages: BASE_STAGES.map((s) =>
      s.slug === 'WAITING_CANDIDATE' ? { ...s, labelEs: 'Esperando paciente' } : s,
    ),
    programs: [
      {
        slug: 'clinic-client-assistant',
        name: 'Asistente Clínica — Cliente',
        description: 'Intake clínico y coordinación inicial.',
        kind: 'CLIENT',
        prompt:
          'Eres Asistente Virtual de Clínica (domicilio). Pide día + rango horario y confirma lo entendido antes de avanzar.',
      },
      {
        slug: 'clinic-staff-ops',
        name: 'Staff — Operaciones Clínica',
        description: 'Consola staff por WhatsApp para coordinación clínica.',
        kind: 'STAFF',
        prompt: STAFF_PROMPT_BASE,
      },
    ],
  },
  LOGISTICS: {
    id: 'LOGISTICS',
    label: 'Logistics',
    description: 'Coordinación logística y entregas.',
    stages: BASE_STAGES.map((s) =>
      s.slug === 'WAITING_CANDIDATE' ? { ...s, labelEs: 'Esperando remitente' } : s,
    ),
    programs: [
      {
        slug: 'logistics-client-assistant',
        name: 'Asistente Logística — Cliente',
        description: 'Captura de requerimientos logísticos.',
        kind: 'CLIENT',
        prompt:
          'Eres Asistente Virtual de Logística. Captura origen/destino/ventana horaria y confirma faltantes con 1 pregunta clara.',
      },
      {
        slug: 'logistics-staff-ops',
        name: 'Staff — Operaciones Logística',
        description: 'Consola staff por WhatsApp para operación logística.',
        kind: 'STAFF',
        prompt: STAFF_PROMPT_BASE,
      },
    ],
  },
};

export function listWorkspaceTemplates(): Array<{ id: WorkspaceTemplateId; label: string; description: string }> {
  return Object.values(TEMPLATE_SPECS).map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
  }));
}

export function normalizeWorkspaceTemplateId(value: unknown): WorkspaceTemplateId {
  const raw = String(value || '')
    .trim()
    .toUpperCase() as WorkspaceTemplateId;
  if (raw && Object.prototype.hasOwnProperty.call(TEMPLATE_SPECS, raw)) return raw;
  return 'RECRUITING';
}

function actionsIncludeRunAgent(actionsJson: string | null | undefined): boolean {
  if (!actionsJson || typeof actionsJson !== 'string') return false;
  try {
    const parsed = JSON.parse(actionsJson);
    if (!Array.isArray(parsed)) return false;
    return parsed.some((a: any) => String(a?.type || '').toUpperCase() === 'RUN_AGENT');
  } catch {
    return String(actionsJson).toUpperCase().includes('RUN_AGENT');
  }
}

async function ensureTemplateStages(workspaceId: string, stages: StageSeed[]): Promise<{ ensured: number; defaultStageSlug: string | null }> {
  let ensured = 0;
  let defaultStageSlug: string | null = null;

  for (const stage of stages) {
    const slug = normalizeStageSlug(stage.slug);
    if (!slug) continue;
    if (stage.isDefault) defaultStageSlug = slug;
    await prisma.workspaceStage
      .upsert({
        where: { workspaceId_slug: { workspaceId, slug } },
        create: {
          workspaceId,
          slug,
          labelEs: stage.labelEs,
          order: stage.order,
          isDefault: Boolean(stage.isDefault),
          isActive: true,
          isTerminal: Boolean(stage.isTerminal),
          archivedAt: null,
        } as any,
        update: {
          labelEs: stage.labelEs,
          order: stage.order,
          isDefault: Boolean(stage.isDefault),
          isActive: true,
          isTerminal: Boolean(stage.isTerminal),
          archivedAt: null,
          updatedAt: new Date(),
        } as any,
      })
      .catch(() => {});
    ensured += 1;
  }

  if (defaultStageSlug) {
    const target = await prisma.workspaceStage.findUnique({
      where: { workspaceId_slug: { workspaceId, slug: defaultStageSlug } },
      select: { id: true },
    });
    if (target?.id) {
      await prisma.workspaceStage
        .updateMany({
          where: { workspaceId, archivedAt: null, id: { not: target.id } },
          data: { isDefault: false } as any,
        })
        .catch(() => {});
      await prisma.workspaceStage.update({ where: { id: target.id }, data: { isDefault: true } as any }).catch(() => {});
    }
  }

  return { ensured, defaultStageSlug };
}

export async function seedWorkspaceTemplate(params: SeedParams): Promise<SeedWorkspaceTemplateResult> {
  const workspaceId = String(params.workspaceId || '').trim();
  if (!workspaceId) throw new Error('workspaceId requerido');

  const template = normalizeWorkspaceTemplateId(params.template);
  const spec = TEMPLATE_SPECS[template];
  await ensureWorkspaceStages(workspaceId).catch(() => {});

  const stageResult = await ensureTemplateStages(workspaceId, spec.stages);

  const ensuredPrograms: string[] = [];
  let clientDefaultProgramId: string | null = null;
  let staffDefaultProgramId: string | null = null;

  for (const p of spec.programs) {
    const program = await prisma.program.upsert({
      where: { workspaceId_slug: { workspaceId, slug: p.slug } } as any,
      create: {
        workspaceId,
        name: p.name,
        slug: p.slug,
        description: p.description,
        isActive: true,
        agentSystemPrompt: p.prompt,
        archivedAt: null,
      } as any,
      update: {
        name: p.name,
        description: p.description,
        isActive: true,
        agentSystemPrompt: p.prompt,
        archivedAt: null,
        updatedAt: new Date(),
      } as any,
      select: { id: true, slug: true },
    });
    ensuredPrograms.push(program.slug);
    if (p.kind === 'CLIENT') clientDefaultProgramId = program.id;
    if (p.kind === 'STAFF') staffDefaultProgramId = program.id;
  }

  await prisma.workspace
    .update({
      where: { id: workspaceId },
      data: {
        ...(clientDefaultProgramId ? { clientDefaultProgramId } : {}),
        ...(staffDefaultProgramId ? { staffDefaultProgramId } : {}),
        ...(clientDefaultProgramId ? { clientProgramMenuIdsJson: serializeJson([clientDefaultProgramId]) } : {}),
        ...(staffDefaultProgramId ? { staffProgramMenuIdsJson: serializeJson([staffDefaultProgramId]) } : {}),
      } as any,
    })
    .catch(() => {});

  const inboundRules = await prisma.automationRule.findMany({
    where: { workspaceId, trigger: 'INBOUND_MESSAGE', archivedAt: null },
    select: { id: true, enabled: true, actionsJson: true },
  });
  const hasInboundRunAgent = inboundRules.some((r) => Boolean(r.enabled) && actionsIncludeRunAgent(r.actionsJson));
  if (!hasInboundRunAgent) {
    await prisma.automationRule.create({
      data: {
        workspaceId,
        name: 'Default inbound -> RUN_AGENT',
        description: 'Regla base: ante inbound, ejecuta RUN_AGENT con Program actual/default.',
        enabled: true,
        priority: 100,
        trigger: 'INBOUND_MESSAGE',
        scopePhoneLineId: null,
        scopeProgramId: null,
        conditionsJson: serializeJson([]),
        actionsJson: serializeJson([{ type: 'RUN_AGENT', agent: 'program_default' }]),
      } as any,
    });
  }

  const stageRules = await prisma.automationRule.findMany({
    where: { workspaceId, trigger: 'STAGE_CHANGED', archivedAt: null },
    select: { id: true, conditionsJson: true, actionsJson: true },
  });
  const hasInteresadoNotify = stageRules.some((r) => {
    let condOk = false;
    let notifyOk = false;
    try {
      const conditions = JSON.parse(String(r.conditionsJson || '[]'));
      condOk =
        Array.isArray(conditions) &&
        conditions.some(
          (c: any) =>
            String(c?.field || '').toLowerCase() === 'conversation.stage' &&
            String(c?.op || '').toLowerCase() === 'equals' &&
            String(c?.value || '').toUpperCase() === 'INTERESADO',
        );
    } catch {
      condOk = false;
    }
    try {
      const actions = JSON.parse(String(r.actionsJson || '[]'));
      notifyOk =
        Array.isArray(actions) &&
        actions.some((a: any) =>
          ['NOTIFY_STAFF_WHATSAPP', 'ASSIGN_TO_NURSE_LEADER'].includes(String(a?.type || '').toUpperCase()),
        );
    } catch {
      notifyOk = false;
    }
    return condOk && notifyOk;
  });

  if (!hasInteresadoNotify) {
    const isClinic = template === 'CLINIC';
    const stageActions: any[] = [];
    if (isClinic) {
      stageActions.push({
        type: 'ASSIGN_TO_NURSE_LEADER',
        note: 'Caso INTERESADO. Revisar y coordinar.',
      });
    }
    stageActions.push({
      type: 'NOTIFY_STAFF_WHATSAPP',
      recipients: 'ASSIGNED_TO',
      dedupePolicy: 'PER_STAGE_CHANGE',
      templateText: '🔔 Caso {{stage}} · {{clientName}} · {{service}} · {{availability}} · {{location}}',
    });

    await prisma.automationRule.create({
      data: {
        workspaceId,
        name: isClinic
          ? 'Stage INTERESADO -> asignar y notificar staff'
          : 'Stage INTERESADO -> notificar staff',
        description:
          isClinic
            ? 'Cuando el caso pasa a INTERESADO, intenta asignar a líder (si está configurado) y notificar por WhatsApp al staff.'
            : 'Cuando el caso pasa a INTERESADO, notifica por WhatsApp al staff usando reglas del workspace.',
        enabled: true,
        priority: 110,
        trigger: 'STAGE_CHANGED',
        scopePhoneLineId: null,
        scopeProgramId: null,
        conditionsJson: serializeJson([{ field: 'conversation.stage', op: 'equals', value: 'INTERESADO' }]),
        actionsJson: serializeJson(stageActions),
      } as any,
    });
  }

  if (params.userId) {
    await prisma.configChangeLog
      .create({
        data: {
          workspaceId,
          userId: params.userId,
          type: 'WORKSPACE_TEMPLATE_SEEDED',
          beforeJson: null,
          afterJson: serializeJson({
            template,
            stages: stageResult,
            programs: ensuredPrograms,
            clientDefaultProgramId,
            staffDefaultProgramId,
          }),
        },
      })
      .catch(() => {});
  }

  return {
    template,
    stages: stageResult,
    programs: { ensured: ensuredPrograms, clientDefaultProgramId, staffDefaultProgramId },
    automations: {
      inboundRunAgentEnsured: true,
      stageNotifyAssignEnsured: true,
    },
  };
}
