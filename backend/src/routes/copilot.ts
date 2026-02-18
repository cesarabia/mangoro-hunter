import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import OpenAI from 'openai';
import { z } from 'zod';
import { prisma } from '../db/client';
import { getEffectiveOpenAiKey } from '../services/aiService';
import {
  DEFAULT_AI_MODEL,
  getEffectiveOutboundAllowlist,
  getOutboundPolicy,
  getSystemConfig,
  normalizeModelId,
  updateOutboundSafetyConfig,
} from '../services/configService';
import { resolveWorkspaceAccess, isWorkspaceAdmin, isWorkspaceOwner } from '../services/workspaceAuthService';
import { serializeJson } from '../utils/json';
import { SCENARIOS, getScenario } from '../services/simulate/scenarios';
import { createChatCompletionWithModelFallback, getUniqueModelFallbackChain } from '../services/openAiChatCompletionService';

const ViewSchema = z.enum(['inbox', 'inactive', 'simulator', 'agenda', 'config', 'review']);
const ConfigTabSchema = z.enum(['workspace', 'integrations', 'users', 'phoneLines', 'programs', 'automations', 'logs', 'usage']);
const SetupWizardGateSchema = z.enum([
  'phoneLine',
  'programs',
  'routing',
  'users',
  'automations',
  'notifications',
  'smoke',
  'goLive',
]);

const GuideStepSchema = z.object({
  guideId: z.string().min(1).max(80),
  title: z.string().max(140).optional().nullable(),
  body: z.string().max(800).optional().nullable(),
});

const CopilotActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('NAVIGATE'),
    view: ViewSchema,
    configTab: ConfigTabSchema.optional(),
    label: z.string().optional(),
    focusKind: z.enum(['program', 'automation', 'phoneLine']).optional(),
    focusId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('GUIDE'),
    title: z.string().max(140).optional().nullable(),
    label: z.string().optional(),
    steps: z.array(GuideStepSchema).min(1),
  }),
]);

type CopilotAction = z.infer<typeof CopilotActionSchema>;
type CopilotNavigateAction = Extract<CopilotAction, { type: 'NAVIGATE' }>;

const nav = (view: z.infer<typeof ViewSchema>, configTab?: z.infer<typeof ConfigTabSchema>, label?: string) =>
  ({ type: 'NAVIGATE', view, ...(configTab ? { configTab } : {}), ...(label ? { label } : {}) }) as CopilotNavigateAction;

const CopilotCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('CREATE_PROGRAM'),
    ref: z.string().min(1).max(40).optional(),
    name: z.string().min(1).max(120),
    description: z.string().max(400).optional().nullable(),
    slug: z.string().max(64).optional().nullable(),
    isActive: z.boolean().optional(),
    agentSystemPrompt: z.string().min(1),
  }),
  z.object({
    type: z.literal('CREATE_AUTOMATION'),
    ref: z.string().min(1).max(40).optional(),
    name: z.string().min(1).max(120),
    trigger: z.string().min(1).max(60),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(10000).optional(),
    scopeProgramRef: z.string().min(1).max(40).optional(),
    scopeProgramId: z.string().min(1).optional(),
    scopeProgramSlug: z.string().min(1).max(80).optional(),
    scopePhoneLineRef: z.string().min(1).max(40).optional(),
    scopePhoneLineId: z.string().min(1).optional(),
    scopePhoneLineWaId: z.string().min(1).max(80).optional(),
    conditions: z.any().optional(),
    actions: z.any().optional(),
  }),
  z.object({
    type: z.literal('TEMP_OFF_OUTBOUND'),
    minutes: z.number().int().min(1).max(240),
  }),
  z.object({
    type: z.literal('RUN_SMOKE_SCENARIOS'),
    scenarioIds: z.array(z.string().min(1)).optional(),
    sanitizePii: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('DOWNLOAD_REVIEW_PACK'),
  }),
  z.object({
    type: z.literal('CREATE_PHONE_LINE'),
    ref: z.string().min(1).max(40).optional(),
    alias: z.string().min(1).max(80),
    phoneE164: z.string().max(40).optional().nullable(),
    waPhoneNumberId: z.string().min(1).max(80),
    wabaId: z.string().max(80).optional().nullable(),
    defaultProgramRef: z.string().min(1).max(40).optional(),
    defaultProgramId: z.string().min(1).optional().nullable(),
    isActive: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('SET_PHONE_LINE_DEFAULT_PROGRAM'),
    phoneLineRef: z.string().min(1).max(40).optional(),
    phoneLineId: z.string().min(1).optional(),
    waPhoneNumberId: z.string().min(1).max(80).optional(),
    programRef: z.string().min(1).max(40).optional(),
    programId: z.string().min(1).optional(),
    programSlug: z.string().min(1).max(80).optional(),
  }),
  z.object({
    type: z.literal('CREATE_OR_UPDATE_USER_MEMBERSHIP'),
    email: z.string().min(3).max(200),
    role: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']),
    assignedOnly: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('INVITE_USER_BY_EMAIL'),
    email: z.string().min(3).max(200),
    role: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']),
    expiresDays: z.number().int().min(1).max(30).optional(),
  }),
  z.object({
    type: z.literal('WORKSPACE_BOOTSTRAP_BUNDLE'),
    gateId: SetupWizardGateSchema.optional(),
    scope: z.enum(['FIX_GATE', 'GO_LIVE', 'FULL']).optional(),
    workspaceName: z.string().min(1).max(140).optional().nullable(),
  }),
]);

const CopilotProposalSchema = z.object({
  id: z.string().min(1).max(60),
  title: z.string().min(1).max(140),
  summary: z.string().max(600).optional().nullable(),
  commands: z.array(CopilotCommandSchema).min(1),
});

const CopilotResponseSchema = z.object({
  reply: z.string().min(1),
  actions: z.array(CopilotActionSchema).optional(),
  proposals: z.array(CopilotProposalSchema).optional(),
});

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAffirmative(text: string): boolean {
  const t = normalizeText(text);
  if (!t) return false;
  if (t === 'si' || t === 'sí') return true;
  if (t === 'ok' || t === 'okay' || t === 'okey') return true;
  if (t === 'dale' || t === 'de acuerdo' || t === 'listo') return true;
  if (t === 'por favor') return true;
  if (t.startsWith('si ')) return true;
  return /\b(confirmo|confirmar|hazlo|haganlo|enviar|envia)\b/.test(t);
}

function isNegative(text: string): boolean {
  const t = normalizeText(text);
  if (!t) return false;
  if (t === 'no') return true;
  if (t === 'cancelar' || t === 'cancela') return true;
  if (t === 'no gracias' || t === 'gracias no') return true;
  return /\b(no quiero|mejor no|olvida|cancel)\b/.test(t);
}

function slugify(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function extractEmail(value: string): string | null {
  const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (!match) return null;
  return match[0].trim().toLowerCase();
}

function inferMembershipRoleFromText(value: string): 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' {
  const t = normalizeText(value);
  if (/\b(owner|dueno|dueño)\b/.test(t)) return 'OWNER';
  if (/\b(admin|administrador)\b/.test(t)) return 'ADMIN';
  if (/\b(viewer|solo lectura|lectura)\b/.test(t)) return 'VIEWER';
  return 'MEMBER';
}

function inferAssignedOnlyFromText(value: string): boolean {
  const t = normalizeText(value);
  return /\b(assigned-only|solo asignad|solo asignadas|solo asignados|asignad[oa]s)\b/.test(t);
}

function buildInviteToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

function buildInviteUrl(token: string): string {
  const base = process.env.PUBLIC_BASE_URL || 'https://hunter.mangoro.app';
  return `${base.replace(/\/+$/g, '')}/invite/${token}`;
}

function parseSetupWizardFixMarker(value: string): { cleanedText: string; gateId: z.infer<typeof SetupWizardGateSchema> | null } {
  const text = String(value || '');
  const match = text.match(/^\[SETUP_WIZARD_FIX(?:\s+gate=([a-zA-Z]+))?\]\s*/i);
  if (!match) return { cleanedText: text, gateId: null };
  const cleaned = text.replace(match[0], '').trim();
  const rawGate = String(match[1] || '').trim();
  const parsedGate = SetupWizardGateSchema.safeParse(rawGate);
  return {
    cleanedText: cleaned,
    gateId: parsedGate.success ? parsedGate.data : null,
  };
}

function inferSetupWizardGateFromText(value: string): z.infer<typeof SetupWizardGateSchema> | null {
  const t = normalizeText(value);
  if (!t) return null;
  if (t.includes('phone line') || t.includes('phoneline') || t.includes('numero whatsapp')) return 'phoneLine';
  if (t.includes('program') || t.includes('programa')) return 'programs';
  if (t.includes('routing') || t.includes('default') || t.includes('persona')) return 'routing';
  if (t.includes('usuario') || t.includes('staffwhatsapp')) return 'users';
  if (t.includes('automation') || t.includes('run_agent') || t.includes('regla')) return 'automations';
  if (t.includes('notificacion') || t.includes('notify') || t.includes('handoff')) return 'notifications';
  if (t.includes('smoke') || t.includes('scenario')) return 'smoke';
  if (t.includes('go-live') || t.includes('golive') || t.includes('setup wizard') || t.includes('completa los gates')) return 'goLive';
  return null;
}

async function ensureUniqueProgramSlug(workspaceId: string, desired: string): Promise<string> {
  const base = slugify(desired);
  if (!base) return `program-${Date.now().toString(36)}`;
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const existing = await prisma.program.findFirst({
      where: { workspaceId, slug },
      select: { id: true },
    });
    if (!existing) return slug;
    slug = `${base}-${i}`;
  }
  return `${base}-${Date.now().toString(36).slice(0, 6)}`;
}

function inferNavigation(text: string): CopilotNavigateAction | null {
  const t = normalizeText(text);
  const go = (view: z.infer<typeof ViewSchema>, configTab?: z.infer<typeof ConfigTabSchema>, label?: string) =>
    ({ type: 'NAVIGATE', view, ...(configTab ? { configTab } : {}), ...(label ? { label } : {}) }) as const;

  const wantsNav = /(ll[eé]vame|lleva(me)?|ir|abre|abrir|vamos|ve a|entra a|mostrar?|ver)/i.test(text);
  if (wantsNav) {
    if (/\b(inbox|bandeja)\b/i.test(text) || t === 'inbox') return go('inbox', undefined, 'Abrir Inbox');
    if (/\b(inactivos|archivados)\b/i.test(text) || t === 'inactivos') return go('inactive', undefined, 'Abrir Inactivos');
    if (/\b(simulador|simulator)\b/i.test(text) || t === 'simulador') return go('simulator', undefined, 'Abrir Simulador');
    if (/\b(agenda|calendario)\b/i.test(text) || t === 'agenda') return go('agenda', undefined, 'Abrir Agenda');
    // Config tabs (más específicos primero para evitar caer en "config" genérico).
    if (/\b(logs?|bitacora)\b/i.test(text) && /(esta conversacion|este chat|este hilo|conversationid|conversacion)/i.test(t)) {
      return go('review', undefined, 'Abrir QA (Logs)');
    }
    if (/\b(integraciones|integracion)\b/i.test(text)) return go('config', 'integrations', 'Ir a Integraciones');
    if (/\b(program|programa|programs)\b/i.test(text)) return go('config', 'programs', 'Ir a Programs');
    if (/\b(automation|automat|regla)\b/i.test(text)) return go('config', 'automations', 'Ir a Automations');
    if (/\b(numeros|numero|whatsapp|phoneline|linea)\b/i.test(text)) return go('config', 'phoneLines', 'Ir a Números WhatsApp');
    if (/\b(usuario|usuarios|users)\b/i.test(text)) return go('config', 'users', 'Ir a Usuarios');
    if (/\b(logs?|bitacora)\b/i.test(text)) return go('config', 'logs', 'Ir a Logs');
    if (/\b(uso|costos|consumo)\b/i.test(text)) return go('config', 'usage', 'Ir a Uso & Costos');
    if (/\b(config|configuracion|settings)\b/i.test(text)) return go('config', undefined, 'Abrir Configuración');
  }
  if (/\b(ayuda|qa|owner review)\b/i.test(text)) return go('review', undefined, 'Abrir Ayuda / QA');
  return null;
}

function inferGuide(text: string, ctx: { isAdmin: boolean; conversationId: string | null }) {
  const t = normalizeText(text);
  const wantsGuide = /\b(mu[eé]stra|muestrame|donde|d[oó]nde|guia|gu[ií]a|guiame|resalta|highlight)\b/.test(t);
  if (!wantsGuide) return null;

  const guide = (title: string, steps: Array<z.infer<typeof GuideStepSchema>>) =>
    ({ type: 'GUIDE', title, label: 'Iniciar guía', steps } as const);

  if (/\b(program|programs|programa)\b/.test(t) && /\b(cambiar|cambio|selector|seleccionar|asignar)\b/.test(t)) {
    const steps = [
      {
        guideId: 'conversation-details-button',
        title: 'Abrir Detalles',
        body: 'Haz click en “Detalles” para ver la configuración de esta conversación.',
      },
      {
        guideId: 'conversation-program-select',
        title: 'Cambiar Program',
        body: 'Usa este selector para elegir el Program (agente) activo. El siguiente “Sugerir” y el siguiente inbound usarán ese Program.',
      },
    ];
    const reply = ctx.conversationId
      ? 'Listo. Te muestro dónde cambiar el Program de esta conversación.'
      : 'Te llevo a Inbox. Abre una conversación y luego te muestro dónde cambiar el Program.';
    return { reply, actions: [nav('inbox', undefined, 'Abrir Inbox'), guide('Guía: Cambiar Program', steps)], autoNavigate: true };
  }

  if (/\b(logs?|bitacora)\b/.test(t)) {
    if (!ctx.isAdmin) {
      return {
        reply: 'Para ver Logs necesitas permisos de ADMIN/OWNER. Si no los tienes, pídele a un ADMIN que revise Ayuda / QA.',
        actions: [nav('inbox', undefined, 'Abrir Inbox')],
        autoNavigate: true,
      };
    }
    const steps = [
      {
        guideId: 'review-logs-filter',
        title: 'Filtrar por conversación',
        body: 'Pega aquí un conversationId para ver Agent Runs / Outbound / Automation Runs del chat (útil para “no respondió”).',
      },
    ];
    return { reply: 'Abriendo QA y resaltando dónde filtrar logs…', actions: [nav('review', undefined, 'Abrir QA (Logs)'), guide('Guía: Ver Logs', steps)], autoNavigate: true };
  }

  if (/\b(automation|automations|automat|regla|reglas)\b/.test(t)) {
    if (!ctx.isAdmin) {
      return {
        reply: 'Para crear Automations necesitas permisos de ADMIN/OWNER. Si no los tienes, pídele a un ADMIN que lo haga desde Configuración → Automations.',
        actions: [nav('inbox', undefined, 'Abrir Inbox')],
        autoNavigate: true,
      };
    }
    const steps = [
      {
        guideId: 'config-automations-new-rule',
        title: 'Crear regla',
        body: 'Haz click aquí para crear una regla. Para empezar: Trigger INBOUND_MESSAGE + Action RUN_AGENT + Enabled=true.',
      },
    ];
    return { reply: 'Abriendo Automations y resaltando el botón para crear una regla…', actions: [nav('config', 'automations', 'Ir a Automations'), guide('Guía: Crear Automation', steps)], autoNavigate: true };
  }

  return null;
}

function explainBlockedReason(blockedReason: string): string {
  const reason = String(blockedReason || '').toUpperCase();
  if (!reason) return 'El envío quedó bloqueado por una regla de seguridad.';
  if (reason.includes('SAFE_OUTBOUND')) return 'El envío fue bloqueado por SAFE MODE (allowlist-only).';
  if (reason.includes('NO_CONTACT')) return 'El contacto está marcado como NO_CONTACTAR.';
  if (reason.includes('OUTSIDE_24H')) return 'La conversación está fuera de la ventana de 24h de WhatsApp (requiere plantilla).';
  if (reason.includes('DEDUP')) return 'El sistema evitó un duplicado (dedupe/idempotencia).';
  if (reason.includes('ANTI_LOOP')) return 'Se bloqueó para evitar loops (mensaje repetido).';
  return `El envío quedó bloqueado: ${blockedReason}`;
}

async function buildAutomationsExactReply(workspaceId: string): Promise<{ replyText: string; actions: CopilotAction[] }> {
  const rules = await prisma.automationRule.findMany({
    where: { workspaceId, archivedAt: null },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      name: true,
      description: true,
      exampleUseCase: true,
      enabled: true,
      priority: true,
      trigger: true,
      scopePhoneLineId: true,
      scopeProgramId: true,
      conditionsJson: true,
      actionsJson: true,
    },
  });

  if (rules.length === 0) {
    return {
      replyText:
        'No hay Automations activas en este workspace (lista vacía). Puedes crear una con “+ Nueva regla” en Configuración → Automations.',
      actions: [nav('config', 'automations', 'Ir a Automations')],
    };
  }

  const formatJsonInline = (value: string | null | undefined): string => {
    const parsed = safeJsonParse(String(value || '')) ?? [];
    return serializeJson(parsed);
  };

  const lines: string[] = [];
  lines.push(`Automations en workspace "${workspaceId}" (${rules.length}):`);
  for (const r of rules) {
    const enabledLabel = r.enabled ? 'habilitada' : 'deshabilitada';
    const desc = String((r as any).description || '').trim();
    const example = String((r as any).exampleUseCase || '').trim();
    lines.push(`\n- ${r.name} (${enabledLabel}, priority=${r.priority}, trigger=${r.trigger})`);
    if (desc) lines.push(`  Descripción: ${desc}`);
    if (example) lines.push(`  Ejemplo: ${example}`);
    if (r.scopePhoneLineId) lines.push(`  Scope: phoneLineId=${r.scopePhoneLineId}`);
    if (r.scopeProgramId) lines.push(`  Scope: programId=${r.scopeProgramId}`);
    lines.push(`  Conditions: ${formatJsonInline(r.conditionsJson)}`);
    lines.push(`  Actions: ${formatJsonInline(r.actionsJson)}`);
  }

  return {
    replyText: lines.join('\n').trim(),
    actions: [nav('config', 'automations', 'Abrir Automations')],
  };
}

async function buildProgramsExactReply(workspaceId: string): Promise<{ replyText: string; actions: CopilotAction[] }> {
  const programs = await prisma.program.findMany({
    where: { workspaceId, archivedAt: null },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    select: { id: true, name: true, slug: true, isActive: true, updatedAt: true },
  });
  if (programs.length === 0) {
    return {
      replyText: 'No hay Programs en este workspace. Crea uno en Configuración → Programs.',
      actions: [nav('config', 'programs', 'Ir a Programs')],
    };
  }
  const lines: string[] = [];
  lines.push(`Programs en workspace "${workspaceId}" (${programs.length}):`);
  for (const p of programs) {
    lines.push(`- ${p.name} (${p.isActive ? 'activo' : 'inactivo'}) · slug=${p.slug}`);
  }
  return {
    replyText: lines.join('\n').trim(),
    actions: [nav('config', 'programs', 'Abrir Programs')],
  };
}

export async function registerCopilotRoutes(app: FastifyInstance) {
  app.get('/threads', { preValidation: [app.authenticate] }, async (request) => {
    const access = await resolveWorkspaceAccess(request);
    const userId = request.user?.userId || null;
    if (!userId) return [];
    const includeArchived = (() => {
      const q: any = (request as any).query || {};
      const raw = q.includeArchived ?? q.include_archived ?? null;
      if (raw === null || typeof raw === 'undefined') return false;
      const t = String(raw).trim().toLowerCase();
      return t === '1' || t === 'true' || t === 'yes' || t === 'si' || t === 'sí';
    })();

    const threads = await prisma.copilotThread.findMany({
      where: { workspaceId: access.workspaceId, userId, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
        runs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { inputText: true, responseText: true, createdAt: true },
        },
      },
    });

    return threads.map((t) => ({
      id: t.id,
      title: t.title,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      archivedAt: t.archivedAt ? t.archivedAt.toISOString() : null,
      lastRunAt: t.runs?.[0]?.createdAt ? t.runs[0].createdAt.toISOString() : null,
      lastUserText: t.runs?.[0]?.inputText || null,
      lastAssistantText: t.runs?.[0]?.responseText || null,
    }));
  });

  app.post('/threads', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const userId = request.user?.userId || null;
    if (!userId) return reply.code(400).send({ error: 'Usuario inválido.' });
    const body = request.body as { title?: string | null };
    const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 80) : null;

    const created = await prisma.copilotThread.create({
      data: { workspaceId: access.workspaceId, userId, title: title || null } as any,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
    return {
      id: created.id,
      title: created.title,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  });

  app.get('/threads/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const userId = request.user?.userId || null;
    const { id } = request.params as { id: string };
    if (!userId) return reply.code(400).send({ error: 'Usuario inválido.' });

    const thread = await prisma.copilotThread.findFirst({
      where: { id, workspaceId: access.workspaceId, userId },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
        runs: {
          orderBy: { createdAt: 'asc' },
          take: 200,
          select: {
            id: true,
            inputText: true,
            responseText: true,
            actionsJson: true,
            proposalsJson: true as any,
            resultsJson: true as any,
            status: true,
            error: true,
            confirmedAt: true as any,
            createdAt: true,
          } as any,
        },
      },
    });
    if (!thread) return reply.code(404).send({ error: 'Thread no encontrado.' });

    const runs = Array.isArray((thread as any).runs) ? (thread as any).runs : [];
    return {
      id: thread.id,
      title: thread.title,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
      archivedAt: (thread as any).archivedAt ? new Date((thread as any).archivedAt).toISOString() : null,
      runs: runs.map((r: any) => ({
        id: r.id,
        createdAt: r?.createdAt instanceof Date ? r.createdAt.toISOString() : new Date(r.createdAt).toISOString(),
        inputText: r.inputText,
        responseText: r.responseText,
        actions: safeJsonParse(String(r.actionsJson || '')) || null,
        proposals: safeJsonParse(String(r.proposalsJson || '')) || null,
        results: safeJsonParse(String(r.resultsJson || '')) || null,
        status: r.status,
        error: r.error,
        confirmedAt: r.confirmedAt ? new Date(r.confirmedAt).toISOString() : null,
      })),
    };
  });

  app.patch('/threads/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const userId = request.user?.userId || null;
    const { id } = request.params as { id: string };
    if (!userId) return reply.code(400).send({ error: 'Usuario inválido.' });

    const body = request.body as { archived?: boolean | null };
    const archived = typeof body?.archived === 'boolean' ? body.archived : null;
    if (archived === null) {
      return reply.code(400).send({ error: '"archived" es obligatorio (true/false).' });
    }

    const existing = await prisma.copilotThread.findFirst({
      where: { id, workspaceId: access.workspaceId, userId },
      select: { id: true },
    });
    if (!existing) return reply.code(404).send({ error: 'Thread no encontrado.' });

    const updated = await prisma.copilotThread.update({
      where: { id },
      data: { archivedAt: archived ? new Date() : null, updatedAt: new Date() } as any,
      select: { id: true, archivedAt: true, updatedAt: true },
    });
    return {
      id: updated.id,
      archivedAt: updated.archivedAt ? updated.archivedAt.toISOString() : null,
      updatedAt: updated.updatedAt.toISOString(),
    };
  });

  app.post('/chat', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const isAdmin = isWorkspaceAdmin(request, access);
    const isOwner = isWorkspaceOwner(request, access);
    const body = request.body as { text?: string; conversationId?: string | null; view?: string | null; threadId?: string | null };
    const rawText = String(body?.text || '').trim();
    const setupFixMarker = parseSetupWizardFixMarker(rawText);
    const text = setupFixMarker.cleanedText;
    const conversationId = body?.conversationId ? String(body.conversationId) : null;
    const view = typeof body?.view === 'string' ? body.view : null;
    const userId = request.user?.userId || null;

    if (!text) return reply.code(400).send({ error: '"text" es obligatorio.' });

    let threadId: string | null = body?.threadId ? String(body.threadId).trim() : null;
    if (threadId && userId) {
      const exists = await prisma.copilotThread.findFirst({
        where: { id: threadId, workspaceId: access.workspaceId, userId, archivedAt: null },
        select: { id: true },
      });
      if (!exists) threadId = null;
    }
    if (!threadId && userId) {
      const title = text.slice(0, 80);
      const created = await prisma.copilotThread.create({
        data: { workspaceId: access.workspaceId, userId, title } as any,
        select: { id: true },
      });
      threadId = created.id;
    }

    const run = await prisma.copilotRunLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId,
          threadId,
          conversationId,
          view: view || null,
          inputText: text,
          status: 'RUNNING',
        } as any,
      })
      .catch(() => null);

    if (threadId) {
      await prisma.copilotThread
        .update({ where: { id: threadId }, data: { updatedAt: new Date() } })
        .catch(() => {});
    }

    // Follow-up state (Copilot V2): if the previous response offered an explicit listing, honor "sí/ok" without repreguntar.
    let threadState: any | null = null;
    if (threadId && userId) {
      const thread = await prisma.copilotThread
        .findFirst({
          where: { id: threadId, workspaceId: access.workspaceId, userId },
          select: { id: true, stateJson: true as any },
        })
        .catch(() => null);
      threadState = thread?.stateJson ? safeJsonParse(String(thread.stateJson)) : null;
    }
    const pendingKind = String(threadState?.pending?.kind || '').toUpperCase();
    if (pendingKind === 'LIST_AUTOMATIONS' && isAffirmative(text)) {
      const { replyText, actions } = await buildAutomationsExactReply(access.workspaceId);
      if (threadId) {
        await prisma.copilotThread.update({ where: { id: threadId }, data: { stateJson: null, updatedAt: new Date() } as any }).catch(() => {});
      }
      if (run?.id) {
        await prisma.copilotRunLog.update({
          where: { id: run.id },
          data: { status: 'SUCCESS', responseText: replyText, actionsJson: serializeJson(actions) },
        });
      }
      return { reply: replyText, actions, threadId, runId: run?.id || null, autoNavigate: true };
    }
    if (pendingKind === 'LIST_PROGRAMS' && isAffirmative(text)) {
      const { replyText, actions } = await buildProgramsExactReply(access.workspaceId);
      if (threadId) {
        await prisma.copilotThread.update({ where: { id: threadId }, data: { stateJson: null, updatedAt: new Date() } as any }).catch(() => {});
      }
      if (run?.id) {
        await prisma.copilotRunLog.update({
          where: { id: run.id },
          data: { status: 'SUCCESS', responseText: replyText, actionsJson: serializeJson(actions) },
        });
      }
      return { reply: replyText, actions, threadId, runId: run?.id || null, autoNavigate: true };
    }
    if ((pendingKind === 'LIST_AUTOMATIONS' || pendingKind === 'LIST_PROGRAMS') && isNegative(text)) {
      if (threadId) {
        await prisma.copilotThread.update({ where: { id: threadId }, data: { stateJson: null, updatedAt: new Date() } as any }).catch(() => {});
      }
      const replyText = 'Perfecto. Si quieres, dime qué necesitas y te ayudo.';
      if (run?.id) {
        await prisma.copilotRunLog.update({
          where: { id: run.id },
          data: { status: 'SUCCESS', responseText: replyText },
        });
      }
      return { reply: replyText, actions: [], threadId, runId: run?.id || null, autoNavigate: false };
    }

    const guideHint = inferGuide(text, { isAdmin, conversationId });
    if (guideHint) {
      if (run?.id) {
        await prisma.copilotRunLog.update({
          where: { id: run.id },
          data: { status: 'SUCCESS', responseText: guideHint.reply, actionsJson: serializeJson(guideHint.actions) },
        });
      }
      return { ...guideHint, threadId, runId: run?.id || null };
    }

    const directNav = inferNavigation(text);
    if (directNav && (!directNav.configTab || isAdmin)) {
      const cleaned = String(directNav.label || '')
        .replace(/^(abrir|ir a)\s+/i, '')
        .trim();
      const replyText = cleaned ? `Abriendo ${cleaned}…` : 'Abriendo…';
      const response = { reply: replyText, actions: [directNav], threadId, runId: run?.id || null, autoNavigate: true };
      if (run?.id) {
        await prisma.copilotRunLog.update({
          where: { id: run.id },
          data: { status: 'SUCCESS', responseText: response.reply, actionsJson: serializeJson(response.actions) },
        });
      }
      return response;
    }

    const inferredSetupGate = setupFixMarker.gateId || inferSetupWizardGateFromText(text);
    const wantsWorkspaceBootstrap =
      Boolean(setupFixMarker.gateId) ||
      /\b(setup wizard|bootstrap|go-live|go live)\b/i.test(text) ||
      /\b(configura|configurar|deja|dejar)\b/i.test(text) &&
        /\b(workspace|program|stage|automation|routing|staff mode|staff)\b/i.test(text);
    if (wantsWorkspaceBootstrap && isAdmin) {
      const proposal: z.infer<typeof CopilotProposalSchema> = {
        id: `ws_bootstrap_${Date.now().toString(36)}`,
        title: inferredSetupGate
          ? `Setup Wizard: Fix gate ${inferredSetupGate}`
          : 'Bootstrap de workspace (Programs + Stages + Routing + Automations)',
        summary: `Workspace: ${access.workspaceId} · Ejecución en bundle con auditoría y rollback transaccional donde aplica.`,
        commands: [
          {
            type: 'WORKSPACE_BOOTSTRAP_BUNDLE',
            gateId: inferredSetupGate || undefined,
            scope: inferredSetupGate === 'goLive' || !inferredSetupGate ? 'GO_LIVE' : 'FIX_GATE',
          } as any,
        ],
      };
      const replyText = inferredSetupGate
        ? `Puedo corregir automáticamente el gate "${inferredSetupGate}" del Setup Wizard. ¿Confirmas?`
        : 'Puedo aplicar un bootstrap completo del workspace (Programs, Stages, Routing, Automations y defaults) en un bundle auditable. ¿Confirmas?';
      if (run?.id) {
        await prisma.copilotRunLog.update({
          where: { id: run.id },
          data: {
            status: 'PENDING_CONFIRMATION',
            responseText: replyText,
            actionsJson: serializeJson([nav('config', 'workspace', 'Ir a Workspace')]),
            proposalsJson: serializeJson([proposal]),
          } as any,
        });
      }
      return {
        reply: replyText,
        actions: [nav('config', 'workspace', 'Ir a Workspace')],
        proposals: [proposal],
        threadId,
        runId: run?.id || null,
        autoNavigate: true,
      };
    }

    const maybeUserMgmt =
      /\b(crea|crear|agrega|agregar|añade|anade|invita|invitar|invite|add)\b/i.test(text) &&
      Boolean(extractEmail(text));
    const email = extractEmail(text);
    if (maybeUserMgmt && email) {
      if (!isOwner) {
        const replyText =
          'Solo un OWNER puede gestionar usuarios/invitaciones en este workspace. Pídele a un OWNER que lo haga desde Configuración → Usuarios.';
        const actions = [{ type: 'NAVIGATE' as const, view: 'review' as const, label: 'Abrir Ayuda / QA' }];
        if (run?.id) {
          await prisma.copilotRunLog.update({
            where: { id: run.id },
            data: { status: 'SUCCESS', responseText: replyText, actionsJson: serializeJson(actions) },
          });
        }
        return { reply: replyText, actions, threadId, runId: run?.id || null, autoNavigate: true };
      }

      const role = inferMembershipRoleFromText(text);
      const assignedOnly = inferAssignedOnlyFromText(text);
      const wantsInvite = /\b(invita|invitar|invite)\b/i.test(text);
      const assignedNote = assignedOnly && wantsInvite ? ' · Nota: "solo asignadas" se aplica después de aceptar el invite.' : '';
      const proposal: z.infer<typeof CopilotProposalSchema> = {
        id: `user_${Date.now().toString(36)}`,
        title: `${wantsInvite ? 'Invitar' : 'Crear/actualizar acceso'}: ${email}`,
        summary: `Workspace: ${access.workspaceId} · Rol: ${role}${assignedOnly && !wantsInvite ? ' · Scope: solo asignadas' : ''}${assignedNote}`,
        commands: [
          wantsInvite
            ? ({
                type: 'INVITE_USER_BY_EMAIL',
                email,
                role,
              } as any)
            : ({
                type: 'CREATE_OR_UPDATE_USER_MEMBERSHIP',
                email,
                role,
                ...(assignedOnly ? { assignedOnly: true } : {}),
              } as any),
        ],
      };
      const replyText = wantsInvite
        ? `Puedo crear un invite para ${email} (rol ${role}). ¿Confirmas?`
        : `Puedo crear/actualizar el acceso de ${email} con rol ${role} en este workspace. ¿Confirmas?`;
      if (run?.id) {
        await prisma.copilotRunLog.update({
          where: { id: run.id },
          data: { status: 'PENDING_CONFIRMATION', responseText: replyText, proposalsJson: serializeJson([proposal]) } as any,
        });
      }
      return { reply: replyText, proposals: [proposal], threadId, runId: run?.id || null, autoNavigate: false };
    }

    // Deterministic: explain/list Automations for this workspace (exact, no hallucinations).
    const wantsExplainAutomations =
      /\b(explica|explicame|explicación|explicacion|listar|lista|mu[eé]strame|muestra|ver)\b/i.test(text) &&
      /\b(automation|automations|automat|regla|reglas)\b/i.test(text);
    if (wantsExplainAutomations) {
      if (!isAdmin) {
        const replyText =
          'Para ver Automations necesitas permisos de ADMIN/OWNER en este workspace. Si no los tienes, pídele a un ADMIN que lo revise en Configuración → Automations.';
        const actions = [nav('config', 'automations', 'Ir a Automations')];
        if (run?.id) {
          await prisma.copilotRunLog.update({
            where: { id: run.id },
            data: { status: 'SUCCESS', responseText: replyText, actionsJson: serializeJson(actions) },
          });
        }
        return { reply: replyText, actions, threadId, runId: run?.id || null, autoNavigate: true };
      }

      // For long lists, ask for confirmation and keep a pending follow-up in the thread state.
      const count = await prisma.automationRule.count({ where: { workspaceId: access.workspaceId, archivedAt: null } }).catch(() => 0);
      if (count > 6) {
        const replyText = `En este workspace hay ${count} Automations. ¿Quieres que te muestre la lista exacta (condiciones + acciones)? Responde “si” para listarlas.`;
        const actions = [nav('config', 'automations', 'Ir a Automations')];
        if (threadId) {
          await prisma.copilotThread
            .update({
              where: { id: threadId },
              data: { stateJson: serializeJson({ pending: { kind: 'LIST_AUTOMATIONS', createdAt: new Date().toISOString() } }) } as any,
            })
            .catch(() => {});
        }
        if (run?.id) {
          await prisma.copilotRunLog.update({
            where: { id: run.id },
            data: { status: 'SUCCESS', responseText: replyText, actionsJson: serializeJson(actions) },
          });
        }
        return { reply: replyText, actions, threadId, runId: run?.id || null, autoNavigate: true };
      }

      const { replyText, actions } = await buildAutomationsExactReply(access.workspaceId);
      if (threadId) {
        await prisma.copilotThread.update({ where: { id: threadId }, data: { stateJson: null, updatedAt: new Date() } as any }).catch(() => {});
      }
      if (run?.id) {
        await prisma.copilotRunLog.update({
          where: { id: run.id },
          data: { status: 'SUCCESS', responseText: replyText, actionsJson: serializeJson(actions) },
        });
      }
      return { reply: replyText, actions, threadId, runId: run?.id || null, autoNavigate: true };
    }

    const wantsExplainPrograms =
      /\b(explica|explicame|listar|lista|mu[eé]strame|muestra|ver)\b/i.test(text) &&
      /\b(program|programa|programs)\b/i.test(text);
    if (wantsExplainPrograms) {
      if (!isAdmin) {
        const replyText =
          'Para ver Programs necesitas permisos de ADMIN/OWNER en este workspace. Si no los tienes, pídele a un ADMIN que lo revise en Configuración → Programs.';
        const actions = [nav('config', 'programs', 'Ir a Programs')];
        if (run?.id) {
          await prisma.copilotRunLog.update({
            where: { id: run.id },
            data: { status: 'SUCCESS', responseText: replyText, actionsJson: serializeJson(actions) },
          });
        }
        return { reply: replyText, actions, threadId, runId: run?.id || null, autoNavigate: true };
      }

      const count = await prisma.program.count({ where: { workspaceId: access.workspaceId, archivedAt: null } }).catch(() => 0);
      if (count > 10) {
        const replyText = `En este workspace hay ${count} Programs. ¿Quieres que te los liste? Responde “si” para listarlos.`;
        const actions = [nav('config', 'programs', 'Ir a Programs')];
        if (threadId) {
          await prisma.copilotThread
            .update({
              where: { id: threadId },
              data: { stateJson: serializeJson({ pending: { kind: 'LIST_PROGRAMS', createdAt: new Date().toISOString() } }) } as any,
            })
            .catch(() => {});
        }
        if (run?.id) {
          await prisma.copilotRunLog.update({
            where: { id: run.id },
            data: { status: 'SUCCESS', responseText: replyText, actionsJson: serializeJson(actions) },
          });
        }
        return { reply: replyText, actions, threadId, runId: run?.id || null, autoNavigate: true };
      }

      const { replyText, actions } = await buildProgramsExactReply(access.workspaceId);
      if (threadId) {
        await prisma.copilotThread.update({ where: { id: threadId }, data: { stateJson: null, updatedAt: new Date() } as any }).catch(() => {});
      }
      if (run?.id) {
        await prisma.copilotRunLog.update({
          where: { id: run.id },
          data: { status: 'SUCCESS', responseText: replyText, actionsJson: serializeJson(actions) },
        });
      }
      return { reply: replyText, actions, threadId, runId: run?.id || null, autoNavigate: true };
    }

    const config = await getSystemConfig();
    const apiKey = getEffectiveOpenAiKey(config);

    const outboundPolicy = getOutboundPolicy(config);
    const effectiveAllowlist = getEffectiveOutboundAllowlist(config);

    let conversationSnapshot: any | null = null;
    let programIdForUsage: string | null = null;
    let recentAgentRuns: any[] = [];
    let recentOutbound: any[] = [];
    let availablePrograms: any[] = [];
    let availablePhoneLines: any[] = [];

    if (isAdmin && conversationId) {
      const convo = await prisma.conversation.findFirst({
        where: { id: conversationId, workspaceId: access.workspaceId },
        include: { contact: true, program: true, phoneLine: true },
      });
      if (convo) {
        programIdForUsage = convo.programId ? String(convo.programId) : null;
        conversationSnapshot = {
          id: convo.id,
          status: convo.status,
          stage: convo.conversationStage,
          program: convo.program ? { id: convo.program.id, name: convo.program.name, slug: convo.program.slug } : null,
          phoneLine: convo.phoneLine ? { id: convo.phoneLine.id, alias: convo.phoneLine.alias } : null,
          contact: {
            id: convo.contactId,
            displayName: convo.contact.displayName,
            candidateName: convo.contact.candidateName,
            candidateNameManual: (convo.contact as any).candidateNameManual,
            noContact: convo.contact.noContact,
            noContactReason: (convo.contact as any).noContactReason,
          },
        };
      }

      recentAgentRuns = await prisma.agentRunLog.findMany({
        where: { workspaceId: access.workspaceId, conversationId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, status: true, eventType: true, createdAt: true, error: true },
      });
      recentOutbound = await prisma.outboundMessageLog.findMany({
        where: { workspaceId: access.workspaceId, conversationId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, type: true, templateName: true, blockedReason: true, createdAt: true, dedupeKey: true },
      });
    }

    if (isAdmin) {
      const [programs, phoneLines] = await Promise.all([
        prisma.program.findMany({
          where: { workspaceId: access.workspaceId, archivedAt: null },
          orderBy: { updatedAt: 'desc' },
          take: 30,
          select: { id: true, name: true, slug: true, isActive: true, updatedAt: true },
        }),
        prisma.phoneLine.findMany({
          where: { workspaceId: access.workspaceId, archivedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 20,
          select: { id: true, alias: true, waPhoneNumberId: true, defaultProgramId: true, isActive: true },
        }),
      ]);
      availablePrograms = programs.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        isActive: p.isActive,
        updatedAt: p.updatedAt.toISOString(),
      }));
      availablePhoneLines = phoneLines.map((l) => ({
        id: l.id,
        alias: l.alias,
        waPhoneNumberId: l.waPhoneNumberId,
        defaultProgramId: l.defaultProgramId,
        isActive: l.isActive,
      }));
    }

    const lastOutbound = recentOutbound.length > 0 ? recentOutbound[0] : null;
    const lastAgentRun = recentAgentRuns.length > 0 ? recentAgentRuns[0] : null;

    const defaultDiagnosis = (() => {
      if (!isAdmin || !conversationSnapshot) return null;
      if (conversationSnapshot.contact?.noContact) {
        return 'Este contacto está marcado como NO_CONTACTAR, por lo que el sistema no enviará mensajes automáticos.';
      }
      if (lastOutbound?.blockedReason) {
        return explainBlockedReason(lastOutbound.blockedReason);
      }
      if (!lastAgentRun) {
        return 'No veo corridas recientes del agente para esta conversación. Puede ser que no se haya disparado la automation o que el inbound no haya entrado.';
      }
      if (lastAgentRun.status === 'ERROR') {
        return `La última corrida del agente falló: ${lastAgentRun.error || 'error'}.`;
      }
      if (recentOutbound.length === 0) {
        return 'El agente corrió, pero no veo mensajes outbound recientes asociados. Puede que haya decidido no enviar o que un guardrail lo haya bloqueado.';
      }
      return null;
    })();

    if (!apiKey) {
      const replyText =
        defaultDiagnosis ||
        'Puedo ayudarte a navegar y diagnosticar. Para respuestas con IA, configura la API Key de OpenAI en Configuración → Integraciones.';
      const actions = isAdmin
        ? [
            { type: 'NAVIGATE' as const, view: 'config' as const, configTab: 'integrations' as const, label: 'Ir a Integraciones' },
            { type: 'NAVIGATE' as const, view: 'review' as const, label: 'Abrir Ayuda / QA' },
          ]
        : [];
      if (run?.id) {
        await prisma.copilotRunLog.update({
          where: { id: run.id },
          data: { status: 'SUCCESS', responseText: replyText, actionsJson: serializeJson(actions) },
        });
      }
      return { reply: replyText, actions, threadId, runId: run?.id || null, autoNavigate: false };
    }

    const client = new OpenAI({ apiKey });
    const modelOverride = (typeof (config as any).aiModelOverride === 'string' ? (config as any).aiModelOverride.trim() : '') || null;
    const modelAliasStored = (typeof (config as any).aiModelAlias === 'string' ? (config as any).aiModelAlias.trim() : '') || config.aiModel?.trim() || null;
    const configuredAliasResolved = normalizeModelId(modelAliasStored || DEFAULT_AI_MODEL) || DEFAULT_AI_MODEL;
    const hasExplicitModel =
      Boolean(modelOverride) ||
      Boolean((config as any).aiModelAlias) ||
      (config.aiModel && normalizeModelId(config.aiModel) !== normalizeModelId(DEFAULT_AI_MODEL));
    const defaultCopilotAliasResolved = normalizeModelId('gpt-5-mini') || configuredAliasResolved;
    const modelAliasResolved = hasExplicitModel ? configuredAliasResolved : defaultCopilotAliasResolved;
    const modelChain = getUniqueModelFallbackChain([modelOverride || modelAliasResolved, modelAliasResolved, DEFAULT_AI_MODEL]);
    const modelRequested = modelChain[0] || DEFAULT_AI_MODEL;

    const system = `
Eres el Copilot interno de Hunter CRM (Agent OS).
Objetivo: ayudar a un humano a usar la plataforma, navegar y diagnosticar problemas.

Reglas:
- Responde SIEMPRE en español, corto y claro.
- NO envíes WhatsApp ni propongas enviar WhatsApp.
- Puedes sugerir navegación con actions[].type="NAVIGATE" (views permitidos: inbox, inactive, simulator, agenda, config, review).
- Si el usuario pide hacer cambios en la plataforma, NO los ejecutes directamente: propone acciones en "proposals" para que el humano confirme.
- Si el usuario pide "por qué no respondió", usa logs/contexto y explica causas comunes (SAFE MODE, NO_CONTACTAR, ventana 24h, dedupe, error de agente).
- Si falta información, pregunta 1 cosa concreta.
- No inventes datos.

Formato de proposals (Nivel 2 / confirmación):
- proposals es un array (máximo 3) de objetos:
  { "id": string, "title": string, "summary"?: string, "commands": CopilotCommand[] }

CopilotCommand permitidos (usa solo estos):
1) CREATE_PROGRAM:
   { "type":"CREATE_PROGRAM", "ref"?: string, "name": string, "description"?: string|null, "slug"?: string|null, "isActive"?: boolean, "agentSystemPrompt": string }
2) CREATE_AUTOMATION:
   { "type":"CREATE_AUTOMATION", "ref"?: string, "name": string, "trigger": "INBOUND_MESSAGE" | "INACTIVITY" | "STAGE_CHANGED" | "PROFILE_UPDATED",
     "enabled"?: boolean, "priority"?: number,
     "scopeProgramRef"?: string, "scopeProgramSlug"?: string, "scopeProgramId"?: string,
     "scopePhoneLineId"?: string, "scopePhoneLineWaId"?: string,
     "conditions"?: any, "actions"?: any }
   (Si no sabes conditions/actions, usa [] y actions=[{"type":"RUN_AGENT","agent":"program_default"}].)
3) TEMP_OFF_OUTBOUND:
   { "type":"TEMP_OFF_OUTBOUND", "minutes": 10 | 30 | 60 }
4) RUN_SMOKE_SCENARIOS:
   { "type":"RUN_SMOKE_SCENARIOS", "scenarioIds"?: string[], "sanitizePii"?: boolean }
5) DOWNLOAD_REVIEW_PACK:
   { "type":"DOWNLOAD_REVIEW_PACK" }
6) CREATE_PHONE_LINE:
   { "type":"CREATE_PHONE_LINE", "ref"?: string, "alias": string, "phoneE164"?: string|null, "waPhoneNumberId": string, "wabaId"?: string|null,
     "defaultProgramRef"?: string, "defaultProgramId"?: string|null, "isActive"?: boolean }
7) SET_PHONE_LINE_DEFAULT_PROGRAM:
   { "type":"SET_PHONE_LINE_DEFAULT_PROGRAM", "phoneLineId"?: string, "waPhoneNumberId"?: string, "programId"?: string, "programSlug"?: string, "programRef"?: string }
8) CREATE_OR_UPDATE_USER_MEMBERSHIP (solo OWNER):
   { "type":"CREATE_OR_UPDATE_USER_MEMBERSHIP", "email": string, "role": "OWNER"|"ADMIN"|"MEMBER"|"VIEWER", "assignedOnly"?: boolean }
   (Si el usuario NO existe, crea un invite en lugar de setear password.)
9) INVITE_USER_BY_EMAIL (solo OWNER):
   { "type":"INVITE_USER_BY_EMAIL", "email": string, "role": "OWNER"|"ADMIN"|"MEMBER"|"VIEWER", "expiresDays"?: number }
10) WORKSPACE_BOOTSTRAP_BUNDLE:
   { "type":"WORKSPACE_BOOTSTRAP_BUNDLE", "gateId"?: "phoneLine"|"programs"|"routing"|"users"|"automations"|"notifications"|"smoke"|"goLive", "scope"?: "FIX_GATE"|"GO_LIVE"|"FULL" }
   (Aplica un bundle real de configuración del workspace: Programs, Stages, Routing, Automations y defaults con auditoría.)

Tu salida debe ser SOLO un JSON válido con el shape:
{
  "reply": string,
  "actions"?: [ { "type":"NAVIGATE", "view": "...", "configTab"?: "...", "label"?: "..." } ],
  "proposals"?: [ { "id": string, "title": string, "summary"?: string, "commands": any[] } ]
}
`.trim();

    const context = {
      workspaceId: access.workspaceId,
      userRole: request.user?.role || access.role || null,
      isAdmin,
      view,
      safeMode: { outboundPolicy, effectiveAllowlist },
      availablePrograms,
      availablePhoneLines,
      availableScenarios: SCENARIOS.map((s) => ({ id: s.id, name: s.name })),
      conversation: conversationSnapshot,
      recentAgentRuns: recentAgentRuns.map((r) => ({
        id: r.id,
        status: r.status,
        eventType: r.eventType,
        createdAt: r.createdAt.toISOString(),
        error: r.error,
      })),
      recentOutbound: recentOutbound.map((o) => ({
        id: o.id,
        type: o.type,
        templateName: o.templateName,
        blockedReason: o.blockedReason,
        createdAt: o.createdAt.toISOString(),
        dedupeKey: o.dedupeKey,
      })),
      defaultDiagnosis,
    };

    let responseText = '';
    let actionsJson: any[] = [];
    let proposalsJson: any[] = [];
    let usagePrompt = 0;
    let usageCompletion = 0;
    let usageTotal = 0;
    let modelResolved = modelRequested;

    try {
      const completionResult = await createChatCompletionWithModelFallback(
        client,
        {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: serializeJson({ userMessage: text, context }) },
          ],
          temperature: 0.2,
          max_tokens: 350,
        },
        modelChain
      );
      const completion = completionResult.completion;
      modelResolved = completionResult.modelResolved;

      usagePrompt = completion.usage?.prompt_tokens || 0;
      usageCompletion = completion.usage?.completion_tokens || 0;
      usageTotal = completion.usage?.total_tokens || 0;

      const raw = String(completion.choices[0]?.message?.content || '').trim();
      const parsed = safeJsonParse(raw) || {};
      const validated = CopilotResponseSchema.safeParse(parsed);
      if (!validated.success) {
        throw new Error('Respuesta inválida del Copilot (schema).');
      }
      responseText = validated.data.reply.trim();
      const actions = Array.isArray(validated.data.actions) ? validated.data.actions : [];
      actionsJson = actions.filter((a) => {
        if (a.type !== 'NAVIGATE') return false;
        if (!isAdmin && a.view !== 'inbox' && a.view !== 'inactive' && a.view !== 'review') return false;
        if (a.view === 'config' && !isAdmin) return false;
        if (a.view === 'config' && a.configTab && !ConfigTabSchema.safeParse(a.configTab).success) return false;
        return true;
      });

      const proposals = Array.isArray((validated.data as any).proposals) ? (validated.data as any).proposals : [];
      proposalsJson = isAdmin ? proposals.slice(0, 3) : [];
    } catch (err) {
      const errorText = err instanceof Error ? err.message : 'Error';
      const actionable =
        /api key|apikey|unauthorized|401/i.test(errorText)
          ? 'No pude usar OpenAI: la API Key parece inválida o no autorizada.'
          : /model/i.test(errorText) && /not found|invalid/i.test(errorText)
            ? 'No pude usar OpenAI: el modelo configurado parece inválido.'
            : /timeout|timed out|504/i.test(errorText)
              ? 'No pude usar OpenAI: timeout al consultar el proveedor.'
              : null;
      const fallback = defaultDiagnosis
        ? `${defaultDiagnosis}\n\nSi quieres, dime “ver logs” y te llevo a Ayuda / QA.`
        : `${actionable ? `${actionable} ` : ''}Puedes intentar de nuevo o abrir Ayuda / QA para ver el motivo exacto en Logs.`;
      responseText = fallback;
      actionsJson = isAdmin
        ? [
            { type: 'NAVIGATE', view: 'config', configTab: 'integrations', label: 'Ir a Integraciones' },
            { type: 'NAVIGATE', view: 'review', label: 'Abrir Ayuda / QA' },
          ]
        : [];

      if (run?.id) {
        await prisma.copilotRunLog.update({
          where: { id: run.id },
          data: { status: 'ERROR', error: errorText, responseText, actionsJson: serializeJson(actionsJson) },
        });
      }
      if (run?.id) {
        await prisma.aiUsageLog
          .create({
            data: {
              workspaceId: access.workspaceId,
              actor: 'COPILOT',
              model: modelResolved,
              modelRequested,
              modelResolved,
              inputTokens: usagePrompt,
              outputTokens: usageCompletion,
              totalTokens: usageTotal,
              copilotRunId: run.id,
              conversationId,
              programId: programIdForUsage,
            },
          })
          .catch(() => {});
      }
      return { reply: responseText, actions: actionsJson, threadId, runId: run?.id || null, autoNavigate: false };
    }

    if (run?.id) {
      const status = proposalsJson.length > 0 ? 'PENDING_CONFIRMATION' : 'SUCCESS';
      await prisma.copilotRunLog.update({
        where: { id: run.id },
        data: {
          status,
          responseText,
          actionsJson: serializeJson(actionsJson),
          proposalsJson: proposalsJson.length > 0 ? serializeJson(proposalsJson) : null,
        } as any,
      });
      await prisma.aiUsageLog
        .create({
          data: {
            workspaceId: access.workspaceId,
            actor: 'COPILOT',
            model: modelResolved,
            modelRequested,
            modelResolved,
            inputTokens: usagePrompt,
            outputTokens: usageCompletion,
            totalTokens: usageTotal,
            copilotRunId: run.id,
            conversationId,
            programId: programIdForUsage,
          },
        })
        .catch(() => {});
    }

    const userWantsNav = /(ll[eé]vame|lleva(me)?|ir|abre|abrir|vamos|ve a|entra a|mostrar?|ver)/i.test(text);
    const autoNavigate = userWantsNav && actionsJson.length > 0 && proposalsJson.length === 0;

    return {
      reply: responseText,
      actions: actionsJson,
      proposals: proposalsJson.length > 0 ? proposalsJson : undefined,
      threadId,
      runId: run?.id || null,
      autoNavigate,
    };
  });

  app.post('/runs/:id/cancel', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const userId = request.user?.userId || null;
    const { id } = request.params as { id: string };

    const existing = await prisma.copilotRunLog.findFirst({
      where: { id, workspaceId: access.workspaceId },
      select: { id: true, status: true, threadId: true, responseText: true, actionsJson: true as any, resultsJson: true as any, error: true },
    });
    if (!existing) return reply.code(404).send({ error: 'Run no encontrado.' });

    if (existing.status !== 'PENDING_CONFIRMATION') {
      // Idempotente: si ya se canceló/ejecutó/falló, devolvemos el estado actual sin error.
      return {
        reply: String(existing.responseText || '').trim() || (existing.status === 'ERROR' ? `La ejecución falló: ${existing.error || 'error'}` : 'Acción ya procesada.'),
        actions: safeJsonParse(String((existing as any).actionsJson || '').trim()) || [],
        threadId: existing.threadId || null,
        runId: existing.id,
        autoNavigate: false,
        results: safeJsonParse(String((existing as any).resultsJson || '').trim()) || null,
        status: existing.status,
      };
    }

    const updatedText = `${String(existing.responseText || '').trim()}\n\n(Acción cancelada.)`.trim();
    const update = await prisma.copilotRunLog.updateMany({
      where: { id: existing.id, status: 'PENDING_CONFIRMATION' },
      data: {
        status: 'CANCELLED',
        responseText: updatedText,
        confirmedAt: new Date(),
        confirmedByUserId: userId,
        resultsJson: serializeJson({ cancelled: true }),
      } as any,
    });

    if (update.count === 0) {
      const fresh = await prisma.copilotRunLog.findFirst({
        where: { id: existing.id, workspaceId: access.workspaceId },
        select: { id: true, status: true, threadId: true, responseText: true, actionsJson: true as any, resultsJson: true as any, error: true },
      });
      if (!fresh) return reply.code(404).send({ error: 'Run no encontrado.' });
      return {
        reply: String(fresh.responseText || '').trim() || (fresh.status === 'ERROR' ? `La ejecución falló: ${fresh.error || 'error'}` : 'Acción ya procesada.'),
        actions: safeJsonParse(String((fresh as any).actionsJson || '').trim()) || [],
        threadId: fresh.threadId || null,
        runId: fresh.id,
        autoNavigate: false,
        results: safeJsonParse(String((fresh as any).resultsJson || '').trim()) || null,
        status: fresh.status,
      };
    }

    return {
      reply: updatedText,
      actions: [],
      threadId: existing.threadId || null,
      runId: existing.id,
      autoNavigate: false,
      status: 'CANCELLED',
    };
  });

  app.post('/runs/:id/confirm', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const userId = request.user?.userId || null;
    const isOwner = isWorkspaceOwner(request, access);
    const { id } = request.params as { id: string };
    const body = request.body as { proposalId?: string | null };
    const proposalId = typeof body?.proposalId === 'string' && body.proposalId.trim() ? body.proposalId.trim() : null;

    // Transición atómica: PENDING_CONFIRMATION -> EXECUTING (evita doble ejecución).
    const claimed = await prisma.copilotRunLog.updateMany({
      where: { id, workspaceId: access.workspaceId, status: 'PENDING_CONFIRMATION' },
      data: {
        status: 'EXECUTING',
        confirmedAt: new Date(),
        confirmedByUserId: userId,
      } as any,
    });

    if (claimed.count === 0) {
      // Idempotente: ya fue ejecutado/cancelado/falló o se está ejecutando.
      const existing = await prisma.copilotRunLog.findFirst({
        where: { id, workspaceId: access.workspaceId },
        select: { id: true, status: true, threadId: true as any, responseText: true, actionsJson: true as any, resultsJson: true as any, error: true },
      });
      if (!existing) return reply.code(404).send({ error: 'Run no encontrado.' });
      return {
        reply: String(existing.responseText || '').trim() || (existing.status === 'ERROR' ? `La ejecución falló: ${existing.error || 'error'}` : 'Acción ya procesada.'),
        actions: safeJsonParse(String((existing as any).actionsJson || '').trim()) || [],
        threadId: (existing as any).threadId || null,
        runId: existing.id,
        autoNavigate: false,
        results: safeJsonParse(String((existing as any).resultsJson || '').trim()) || null,
        status: existing.status,
      };
    }

    const run = await prisma.copilotRunLog.findFirst({
      where: { id, workspaceId: access.workspaceId },
      select: {
        id: true,
        status: true,
        responseText: true,
        threadId: true as any,
        actionsJson: true as any,
        proposalsJson: true as any,
      } as any,
    });
    if (!run) return reply.code(404).send({ error: 'Run no encontrado.' });
    const runId = String((run as any).id || id);

    const proposalsRaw = safeJsonParse(String((run as any).proposalsJson || '').trim()) || [];
    const proposalsParsed = z.array(CopilotProposalSchema).safeParse(proposalsRaw);
    if (!proposalsParsed.success) {
      const errText = 'Propuesta inválida (schema).';
      const updatedText = `${String(run.responseText || '').trim()}\n\n(Acción falló: ${errText})`.trim();
      await prisma.copilotRunLog
        .update({
          where: { id: runId },
          data: {
            status: 'ERROR',
            error: errText,
            responseText: updatedText,
            resultsJson: serializeJson({ ok: false, error: errText }),
          } as any,
        })
        .catch(() => {});
      return { reply: updatedText, actions: [], threadId: (run as any).threadId || null, runId, autoNavigate: false, status: 'ERROR' };
    }

    const proposal = proposalId
      ? proposalsParsed.data.find((p) => p.id === proposalId) || null
      : proposalsParsed.data[0] || null;
    if (!proposal) {
      const errText = 'Propuesta no encontrada.';
      const updatedText = `${String(run.responseText || '').trim()}\n\n(Acción falló: ${errText})`.trim();
      await prisma.copilotRunLog
        .update({
          where: { id: runId },
          data: {
            status: 'ERROR',
            error: errText,
            responseText: updatedText,
            resultsJson: serializeJson({ ok: false, error: errText }),
          } as any,
        })
        .catch(() => {});
      return { reply: updatedText, actions: [], threadId: (run as any).threadId || null, runId, autoNavigate: false, status: 'ERROR' };
    }

    const refs: Record<string, { kind: string; id: string }> = {};
    const results: any[] = [];
    const summaryLines: string[] = [];
    let ok = true;

    const requireAutomationActionArray = (value: any): any[] => {
      if (!Array.isArray(value)) return [];
      const out: any[] = [];
      for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const type = String((item as any).type || '').trim();
        if (!type) continue;
        if (type === 'RUN_AGENT') {
          out.push({ type: 'RUN_AGENT', agent: typeof (item as any).agent === 'string' ? String((item as any).agent) : 'program_default' });
          continue;
        }
        if (type === 'SET_STATUS') {
          const status = String((item as any).status || '').toUpperCase();
          if (status === 'NEW' || status === 'OPEN' || status === 'CLOSED') out.push({ type: 'SET_STATUS', status });
          continue;
        }
        if (type === 'ADD_NOTE') {
          const note = String((item as any).note || '').trim();
          if (note) out.push({ type: 'ADD_NOTE', note });
          continue;
        }
      }
      return out;
    };

    const parseConditions = (value: any): any[] => {
      if (!value) return [];
      if (Array.isArray(value)) return value;
      return [];
    };

    const parseIdListJson = (raw: unknown): string[] => {
      if (!raw || typeof raw !== 'string') return [];
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const out: string[] = [];
        for (const item of parsed) {
          const id = String(item || '').trim();
          if (!id) continue;
          if (!out.includes(id)) out.push(id);
        }
        return out;
      } catch {
        return [];
      }
    };

    const isStaffProgramLike = (program: { name?: string | null; slug?: string | null }) => {
      const text = normalizeText(`${String(program.name || '')} ${String(program.slug || '')}`);
      return /\bstaff\b/.test(text) || /\boperaci/.test(text) || /\benfermera\b/.test(text);
    };

    const buildGenericClientPrompt = (workspaceName: string) =>
      [
        `Eres el Asistente Virtual de ${workspaceName}.`,
        `Objetivo: informar, calificar y recolectar datos mínimos para derivar al equipo humano.`,
        `Reglas:`,
        `- Responde corto, humano y sin loops.`,
        `- Si faltan datos, pide solo los faltantes en 1 mensaje.`,
        `- Nunca inventes agenda/confirmaciones: si falta disponibilidad, dilo explícitamente.`,
      ].join('\n');

    const buildGenericStaffPrompt = (workspaceName: string) =>
      [
        `Programa STAFF — Operaciones (${workspaceName}).`,
        `Reglas obligatorias:`,
        `- Si piden casos ("casos nuevos", "mis casos", "pendientes"), usa RUN_TOOL LIST_CASES primero.`,
        `- Para detalle: GET_CASE_SUMMARY.`,
        `- Para operar: SET_STAGE, ADD_NOTE, SEND_CUSTOMER_MESSAGE.`,
        `- Nunca alucines; si falla una tool, explica error y siguiente paso accionable.`,
      ].join('\n');

    for (const cmd of proposal.commands) {
      try {
        if (cmd.type === 'WORKSPACE_BOOTSTRAP_BUNDLE') {
          const gateId = SetupWizardGateSchema.safeParse((cmd as any).gateId).success
            ? (cmd as any).gateId
            : null;
          const scope = String((cmd as any).scope || '').toUpperCase();
          const doFull = scope === 'FULL' || scope === 'GO_LIVE' || gateId === 'goLive' || !gateId;
          const doPrograms = doFull || gateId === 'programs';
          const doRouting = doFull || gateId === 'routing' || gateId === 'phoneLine';
          const doAutomations = doFull || gateId === 'automations';
          const doNotifications = doFull || gateId === 'notifications';
          const doStages = doFull || /\bstage\b/i.test(String((proposal.summary || '') + ' ' + String(proposal.title || '')));

          const workspace = await prisma.workspace.findUnique({
            where: { id: access.workspaceId },
            select: {
              id: true,
              name: true,
              archivedAt: true,
              staffDefaultProgramId: true as any,
              clientDefaultProgramId: true as any,
              staffProgramMenuIdsJson: true as any,
              clientProgramMenuIdsJson: true as any,
            } as any,
          });
          if (!workspace || (workspace as any).archivedAt) {
            throw new Error('BLOCKED: Workspace no disponible o archivado. Issue para Codex: revisar estado del workspace.');
          }

          const txResult = await prisma.$transaction(async (tx) => {
            const changes: string[] = [];
            const warnings: string[] = [];

            const programs = await tx.program.findMany({
              where: { workspaceId: access.workspaceId, archivedAt: null },
              orderBy: { createdAt: 'asc' },
              select: { id: true, name: true, slug: true, isActive: true, agentSystemPrompt: true },
            });
            const activePrograms = programs.filter((p) => Boolean(p.isActive));
            const phoneLines = await tx.phoneLine.findMany({
              where: { workspaceId: access.workspaceId, archivedAt: null, isActive: true },
              orderBy: { createdAt: 'asc' },
              select: { id: true, alias: true, defaultProgramId: true },
            });

            let clientProgram = activePrograms.find((p) => !isStaffProgramLike(p) && normalizeText(p.slug || '') !== 'admin') || null;
            let staffProgram = activePrograms.find((p) => isStaffProgramLike(p)) || null;

            if (doPrograms && !clientProgram) {
              const slug = await ensureUniqueProgramSlug(access.workspaceId, 'client-assistant');
              clientProgram = await tx.program.create({
                data: {
                  workspaceId: access.workspaceId,
                  name: `Asistente — Cliente (${String((workspace as any).name || access.workspaceId)})`,
                  slug,
                  description: 'Programa base CLIENT para conversación externa.',
                  isActive: true,
                  agentSystemPrompt: buildGenericClientPrompt(String((workspace as any).name || access.workspaceId)),
                } as any,
                select: { id: true, name: true, slug: true, isActive: true, agentSystemPrompt: true },
              });
              changes.push(`Program CLIENT creado (${clientProgram.slug}).`);
            }

            if (doPrograms && !staffProgram) {
              const slug = await ensureUniqueProgramSlug(access.workspaceId, 'staff-operaciones');
              staffProgram = await tx.program.create({
                data: {
                  workspaceId: access.workspaceId,
                  name: `Staff — Operaciones (${String((workspace as any).name || access.workspaceId)})`,
                  slug,
                  description: 'Programa base STAFF para operación interna por WhatsApp.',
                  isActive: true,
                  agentSystemPrompt: buildGenericStaffPrompt(String((workspace as any).name || access.workspaceId)),
                } as any,
                select: { id: true, name: true, slug: true, isActive: true, agentSystemPrompt: true },
              });
              changes.push(`Program STAFF creado (${staffProgram.slug}).`);
            }

            if (doPrograms) {
              const legacyNeedle = /(ejecutivo\(a\)\s+de\s+ventas\s+en\s+terreno|alarmas?\s+de\s+seguridad)/i;
              if (clientProgram && legacyNeedle.test(String(clientProgram.agentSystemPrompt || ''))) {
                await tx.program.update({
                  where: { id: clientProgram.id },
                  data: { agentSystemPrompt: buildGenericClientPrompt(String((workspace as any).name || access.workspaceId)), updatedAt: new Date() },
                });
                changes.push(`Program CLIENT saneado (se removió prompt heredado específico).`);
              }
            }

            if ((doRouting || doPrograms) && (clientProgram || staffProgram)) {
              const currentStaffDefault = String((workspace as any).staffDefaultProgramId || '').trim();
              const currentClientDefault = String((workspace as any).clientDefaultProgramId || '').trim();
              const nextStaffDefault = currentStaffDefault || String(staffProgram?.id || '');
              const nextClientDefault = currentClientDefault || String(clientProgram?.id || '');
              const patch: any = {};
              if (!currentClientDefault && nextClientDefault) patch.clientDefaultProgramId = nextClientDefault;
              if (!currentStaffDefault && nextStaffDefault) patch.staffDefaultProgramId = nextStaffDefault;
              const staffMenu = parseIdListJson((workspace as any).staffProgramMenuIdsJson);
              const clientMenu = parseIdListJson((workspace as any).clientProgramMenuIdsJson);
              if (staffMenu.length === 0 && nextStaffDefault) patch.staffProgramMenuIdsJson = serializeJson([nextStaffDefault]);
              if (clientMenu.length === 0 && nextClientDefault) patch.clientProgramMenuIdsJson = serializeJson([nextClientDefault]);
              if (Object.keys(patch).length > 0) {
                await tx.workspace.update({ where: { id: access.workspaceId }, data: patch as any });
                changes.push('Defaults de routing CLIENT/STAFF configurados.');
              }

              if (doRouting) {
                if (phoneLines.length === 0) {
                  warnings.push('No hay PhoneLine activa: no pude configurar defaultProgram de línea. Paso UI: Configuración → Números WhatsApp.');
                } else if (nextClientDefault) {
                  const missingLine = phoneLines.filter((l) => !String(l.defaultProgramId || '').trim());
                  for (const line of missingLine) {
                    await tx.phoneLine.update({
                      where: { id: line.id },
                      data: { defaultProgramId: nextClientDefault, updatedAt: new Date() } as any,
                    });
                  }
                  if (missingLine.length > 0) {
                    changes.push(`Default Program aplicado a ${missingLine.length} PhoneLine(s) activa(s).`);
                  }
                }
              }
            }

            if (doStages) {
              const stageSeeds = [
                { slug: 'NEW_INTAKE', labelEs: 'Nuevo ingreso', order: 10, isDefault: true, isTerminal: false },
                { slug: 'SCREENING', labelEs: 'Screening', order: 20, isDefault: false, isTerminal: false },
                { slug: 'QUALIFIED', labelEs: 'Calificado', order: 30, isDefault: false, isTerminal: false },
                { slug: 'INTERVIEW_PENDING', labelEs: 'Entrevista pendiente', order: 40, isDefault: false, isTerminal: false },
                { slug: 'INTERVIEW_SCHEDULED', labelEs: 'Entrevista agendada', order: 50, isDefault: false, isTerminal: false },
                { slug: 'INTERVIEWED', labelEs: 'Entrevistado', order: 60, isDefault: false, isTerminal: false },
                { slug: 'HIRED', labelEs: 'Contratado', order: 70, isDefault: false, isTerminal: true },
                { slug: 'REJECTED', labelEs: 'Rechazado', order: 80, isDefault: false, isTerminal: true },
                { slug: 'NO_CONTACTAR', labelEs: 'No contactar', order: 95, isDefault: false, isTerminal: true },
                { slug: 'ARCHIVED', labelEs: 'Archivado', order: 99, isDefault: false, isTerminal: true },
              ];
              for (const stage of stageSeeds) {
                await tx.workspaceStage.upsert({
                  where: { workspaceId_slug: { workspaceId: access.workspaceId, slug: stage.slug } },
                  create: {
                    workspaceId: access.workspaceId,
                    slug: stage.slug,
                    labelEs: stage.labelEs,
                    order: stage.order,
                    isDefault: stage.isDefault,
                    isActive: true,
                    isTerminal: stage.isTerminal,
                    archivedAt: null,
                  } as any,
                  update: {
                    labelEs: stage.labelEs,
                    order: stage.order,
                    isTerminal: stage.isTerminal,
                    ...(stage.isDefault ? { isDefault: true } : {}),
                    isActive: true,
                    archivedAt: null,
                    updatedAt: new Date(),
                  } as any,
                });
              }
              await tx.workspaceStage.updateMany({
                where: { workspaceId: access.workspaceId, archivedAt: null, slug: { not: 'NEW_INTAKE' } },
                data: { isDefault: false } as any,
              });
              await tx.workspaceStage.updateMany({
                where: { workspaceId: access.workspaceId, archivedAt: null, slug: 'NEW_INTAKE' },
                data: { isDefault: true } as any,
              });
              changes.push('Stages base asegurados y ordenados.');
            }

            if (doAutomations) {
              const allInbound = await tx.automationRule.findMany({
                where: { workspaceId: access.workspaceId, trigger: 'INBOUND_MESSAGE', archivedAt: null },
                select: { id: true, enabled: true, actionsJson: true },
              });
              const hasInboundRunAgent = allInbound.some((r) => {
                try {
                  const parsed = JSON.parse(String(r.actionsJson || '[]'));
                  return r.enabled && Array.isArray(parsed) && parsed.some((a: any) => String(a?.type || '').toUpperCase() === 'RUN_AGENT');
                } catch {
                  return false;
                }
              });
              if (!hasInboundRunAgent) {
                await tx.automationRule.create({
                  data: {
                    workspaceId: access.workspaceId,
                    name: 'Default inbound → RUN_AGENT',
                    description: 'Regla base: ante inbound, ejecuta RUN_AGENT.',
                    enabled: true,
                    priority: 100,
                    trigger: 'INBOUND_MESSAGE',
                    scopePhoneLineId: null,
                    scopeProgramId: null,
                    conditionsJson: serializeJson([]),
                    actionsJson: serializeJson([{ type: 'RUN_AGENT', agent: 'program_default' }]),
                  } as any,
                });
                changes.push('Automation base INBOUND_MESSAGE → RUN_AGENT creada.');
              } else {
                changes.push('Automation base RUN_AGENT ya estaba activa.');
              }
            }

            if (doNotifications) {
              const stageRules = await tx.automationRule.findMany({
                where: { workspaceId: access.workspaceId, trigger: 'STAGE_CHANGED', archivedAt: null },
                select: { id: true, actionsJson: true, conditionsJson: true, enabled: true },
              });
              const hasNotify = stageRules.some((r) => {
                try {
                  const cond = JSON.parse(String(r.conditionsJson || '[]'));
                  const acts = JSON.parse(String(r.actionsJson || '[]'));
                  const condOk = Array.isArray(cond) && cond.some((c: any) => String(c?.field || '').toLowerCase() === 'conversation.stage' && String(c?.value || '').toUpperCase() === 'INTERESADO');
                  const actOk = Array.isArray(acts) && acts.some((a: any) => String(a?.type || '').toUpperCase() === 'NOTIFY_STAFF_WHATSAPP');
                  return Boolean(r.enabled) && condOk && actOk;
                } catch {
                  return false;
                }
              });
              if (!hasNotify) {
                await tx.automationRule.create({
                  data: {
                    workspaceId: access.workspaceId,
                    name: 'Stage INTERESADO → notificar staff',
                    description: 'Handoff: al pasar a INTERESADO, asigna y notifica al staff por WhatsApp.',
                    enabled: true,
                    priority: 110,
                    trigger: 'STAGE_CHANGED',
                    scopePhoneLineId: null,
                    scopeProgramId: null,
                    conditionsJson: serializeJson([{ field: 'conversation.stage', op: 'equals', value: 'INTERESADO' }]),
                    actionsJson: serializeJson([
                      { type: 'ASSIGN_TO_NURSE_LEADER', note: 'Caso listo para coordinación.' },
                      { type: 'NOTIFY_STAFF_WHATSAPP', recipients: 'ASSIGNED_TO', dedupePolicy: 'DAILY' },
                    ]),
                  } as any,
                });
                changes.push('Automation de handoff INTERESADO creada.');
              } else {
                changes.push('Automation de handoff INTERESADO ya estaba activa.');
              }
            }

            await tx.configChangeLog
              .create({
                data: {
                  workspaceId: access.workspaceId,
                  userId: userId ? String(userId) : null,
                  type: 'COPILOT_WORKSPACE_BOOTSTRAP',
                  beforeJson: null,
                  afterJson: serializeJson({ gateId: gateId || null, scope: scope || null, changes, warnings }),
                },
              })
              .catch(() => {});

            return { changes, warnings };
          });

          results.push({ type: cmd.type, ok: true, gateId: gateId || null, details: txResult });
          if (Array.isArray(txResult?.changes) && txResult.changes.length > 0) {
            for (const line of txResult.changes) summaryLines.push(`✅ ${line}`);
          }
          if (Array.isArray(txResult?.warnings) && txResult.warnings.length > 0) {
            for (const warn of txResult.warnings) summaryLines.push(`⚠️ ${warn}`);
          }
          continue;
        }

        if (cmd.type === 'CREATE_PROGRAM') {
          const desiredSlug = cmd.slug ? String(cmd.slug) : cmd.name;
          const slug = await ensureUniqueProgramSlug(access.workspaceId, desiredSlug);
          const created = await prisma.program.create({
            data: {
              workspaceId: access.workspaceId,
              name: cmd.name.trim(),
              slug,
              description: cmd.description ? String(cmd.description).trim() : null,
              isActive: typeof cmd.isActive === 'boolean' ? cmd.isActive : true,
              agentSystemPrompt: String(cmd.agentSystemPrompt || '').trim(),
            },
          });
          if (cmd.ref) refs[cmd.ref] = { kind: 'program', id: created.id };
          results.push({ type: cmd.type, ok: true, programId: created.id, slug: created.slug });
          summaryLines.push(`✅ Program creado: ${created.name} (${created.slug})`);
          continue;
        }

        if (cmd.type === 'CREATE_PHONE_LINE') {
          const existing = await prisma.phoneLine.findFirst({
            where: { workspaceId: access.workspaceId, waPhoneNumberId: cmd.waPhoneNumberId },
            select: { id: true },
          });
          if (existing) throw new Error('Ya existe un PhoneLine con ese waPhoneNumberId.');
          let defaultProgramId: string | null = cmd.defaultProgramId ? String(cmd.defaultProgramId) : null;
          if (!defaultProgramId && cmd.defaultProgramRef && refs[cmd.defaultProgramRef]?.kind === 'program') {
            defaultProgramId = refs[cmd.defaultProgramRef].id;
          }
          const created = await prisma.phoneLine.create({
            data: {
              workspaceId: access.workspaceId,
              alias: cmd.alias.trim(),
              phoneE164: cmd.phoneE164 ? String(cmd.phoneE164).trim() : null,
              waPhoneNumberId: cmd.waPhoneNumberId.trim(),
              wabaId: cmd.wabaId ? String(cmd.wabaId).trim() : null,
              defaultProgramId,
              isActive: typeof cmd.isActive === 'boolean' ? cmd.isActive : true,
            },
          });
          if (cmd.ref) refs[cmd.ref] = { kind: 'phoneLine', id: created.id };
          results.push({ type: cmd.type, ok: true, phoneLineId: created.id });
          summaryLines.push(`✅ PhoneLine creado: ${created.alias}`);
          continue;
        }

        if (cmd.type === 'SET_PHONE_LINE_DEFAULT_PROGRAM') {
          let phoneLineId: string | null = cmd.phoneLineId ? String(cmd.phoneLineId) : null;
          if (!phoneLineId && cmd.phoneLineRef && refs[cmd.phoneLineRef]?.kind === 'phoneLine') phoneLineId = refs[cmd.phoneLineRef].id;
          if (!phoneLineId && cmd.waPhoneNumberId) {
            const found = await prisma.phoneLine.findFirst({
              where: { workspaceId: access.workspaceId, waPhoneNumberId: String(cmd.waPhoneNumberId) },
              select: { id: true },
            });
            phoneLineId = found?.id || null;
          }
          if (!phoneLineId) throw new Error('No se pudo resolver phoneLineId.');

          let programId: string | null = cmd.programId ? String(cmd.programId) : null;
          if (!programId && cmd.programRef && refs[cmd.programRef]?.kind === 'program') programId = refs[cmd.programRef].id;
          if (!programId && cmd.programSlug) {
            const found = await prisma.program.findFirst({
              where: { workspaceId: access.workspaceId, slug: String(cmd.programSlug), archivedAt: null },
              select: { id: true },
            });
            programId = found?.id || null;
          }
          if (!programId) throw new Error('No se pudo resolver programId.');

          await prisma.phoneLine.update({
            where: { id: phoneLineId },
            data: { defaultProgramId: programId, updatedAt: new Date() },
          });
          results.push({ type: cmd.type, ok: true, phoneLineId, defaultProgramId: programId });
          summaryLines.push('✅ Default Program actualizado para la PhoneLine.');
          continue;
        }

        if (cmd.type === 'CREATE_AUTOMATION') {
          const trigger = String(cmd.trigger || '').trim();
          const allowedTriggers = new Set(['INBOUND_MESSAGE', 'INACTIVITY', 'STAGE_CHANGED', 'PROFILE_UPDATED']);
          if (!allowedTriggers.has(trigger.toUpperCase())) throw new Error('Trigger inválido.');

          let scopeProgramId: string | null = cmd.scopeProgramId ? String(cmd.scopeProgramId) : null;
          if (!scopeProgramId && cmd.scopeProgramRef && refs[cmd.scopeProgramRef]?.kind === 'program') scopeProgramId = refs[cmd.scopeProgramRef].id;
          if (!scopeProgramId && cmd.scopeProgramSlug) {
            const found = await prisma.program.findFirst({
              where: { workspaceId: access.workspaceId, slug: String(cmd.scopeProgramSlug), archivedAt: null },
              select: { id: true },
            });
            scopeProgramId = found?.id || null;
          }

          let scopePhoneLineId: string | null = cmd.scopePhoneLineId ? String(cmd.scopePhoneLineId) : null;
          if (!scopePhoneLineId && cmd.scopePhoneLineRef && refs[cmd.scopePhoneLineRef]?.kind === 'phoneLine') scopePhoneLineId = refs[cmd.scopePhoneLineRef].id;
          if (!scopePhoneLineId && cmd.scopePhoneLineWaId) {
            const found = await prisma.phoneLine.findFirst({
              where: { workspaceId: access.workspaceId, waPhoneNumberId: String(cmd.scopePhoneLineWaId), archivedAt: null },
              select: { id: true },
            });
            scopePhoneLineId = found?.id || null;
          }

          const conditions = parseConditions(cmd.conditions);
          const actions = requireAutomationActionArray(cmd.actions);
          const finalActions = actions.length > 0 ? actions : [{ type: 'RUN_AGENT', agent: 'program_default' }];

          const created = await prisma.automationRule.create({
            data: {
              workspaceId: access.workspaceId,
              name: cmd.name.trim(),
              enabled: typeof cmd.enabled === 'boolean' ? cmd.enabled : true,
              priority: typeof cmd.priority === 'number' && Number.isFinite(cmd.priority) ? Math.floor(cmd.priority) : 100,
              trigger: trigger.toUpperCase(),
              scopeProgramId,
              scopePhoneLineId,
              conditionsJson: serializeJson(conditions),
              actionsJson: serializeJson(finalActions),
            },
          });
          if (cmd.ref) refs[cmd.ref] = { kind: 'automation', id: created.id };
          results.push({ type: cmd.type, ok: true, automationId: created.id });
          summaryLines.push(`✅ Automation creada: ${created.name}`);
          continue;
        }

        if (cmd.type === 'TEMP_OFF_OUTBOUND') {
          if (!isOwner) throw new Error('Solo OWNER puede cambiar SAFE MODE.');
          const before = await getSystemConfig();
          const until = new Date(Date.now() + cmd.minutes * 60 * 1000);
          const after = await updateOutboundSafetyConfig({ outboundAllowAllUntil: until });
          await prisma.configChangeLog
            .create({
              data: {
                workspaceId: access.workspaceId,
                userId,
                type: 'COPILOT_OUTBOUND_TEMP_OFF',
                beforeJson: serializeJson({ outboundAllowAllUntil: (before as any).outboundAllowAllUntil || null }),
                afterJson: serializeJson({ outboundAllowAllUntil: (after as any).outboundAllowAllUntil || null }),
              },
            })
            .catch(() => {});
          results.push({ type: cmd.type, ok: true, outboundAllowAllUntil: (after as any).outboundAllowAllUntil || null });
          summaryLines.push(`✅ SAFE MODE temporal: allow-all por ${cmd.minutes} min (auto-revierte).`);
          continue;
        }

        if (cmd.type === 'RUN_SMOKE_SCENARIOS') {
          const ids = Array.isArray(cmd.scenarioIds) && cmd.scenarioIds.length > 0 ? cmd.scenarioIds : SCENARIOS.map((s) => s.id);
          const sanitize = cmd.sanitizePii !== false;
          const scenarioResults: any[] = [];
          for (const sid of ids) {
            const scenario = getScenario(sid);
            if (!scenario) {
              scenarioResults.push({ id: sid, ok: false, error: 'Scenario no encontrado' });
              continue;
            }
            const res = await app.inject({
              method: 'POST',
              url: `/api/simulate/scenario/${encodeURIComponent(sid)}`,
              payload: { sanitizePii: sanitize },
              headers: {
                authorization: (request.headers as any)?.authorization || '',
                'x-workspace-id': access.workspaceId,
              },
            });
            const data = safeJsonParse(res.body) || null;
            scenarioResults.push({ id: sid, ok: Boolean(data?.ok), sessionId: data?.sessionId || null, error: data?.error || null });
          }
          const allOk = scenarioResults.every((r) => r.ok);
          results.push({ type: cmd.type, ok: allOk, scenarios: scenarioResults });
          summaryLines.push(allOk ? '✅ Smoke Scenarios: PASS' : '⚠️ Smoke Scenarios: hay fallas (ver detalle).');
          continue;
        }

        if (cmd.type === 'DOWNLOAD_REVIEW_PACK') {
          results.push({ type: cmd.type, ok: true, downloadUrl: '/api/review-pack/' });
          summaryLines.push('✅ Review Pack listo para descargar.');
          continue;
        }

        if (cmd.type === 'INVITE_USER_BY_EMAIL') {
          if (!isOwner) throw new Error('Solo OWNER puede invitar usuarios.');
          const email = String(cmd.email || '').trim().toLowerCase();
          if (!email || !email.includes('@')) throw new Error('Email inválido.');
          const role = cmd.role;
          const expiresDays = typeof (cmd as any).expiresDays === 'number' ? Math.max(1, Math.min(30, Math.floor((cmd as any).expiresDays))) : 7;
          const now = new Date();
          const expiresAt = new Date(now.getTime() + expiresDays * 24 * 60 * 60 * 1000);

          const existing = await prisma.workspaceInvite.findFirst({
            where: { workspaceId: access.workspaceId, email, role, archivedAt: null, acceptedAt: null, expiresAt: { gt: now } },
            select: { id: true },
          });
          const created = existing
            ? existing
            : await prisma.workspaceInvite.create({
                data: {
                  workspaceId: access.workspaceId,
                  email,
                  role,
                  token: buildInviteToken(),
                  expiresAt,
                  createdByUserId: userId ? String(userId) : null,
                },
                select: { id: true },
              });

          await prisma.configChangeLog
            .create({
              data: {
                workspaceId: access.workspaceId,
                userId: userId ? String(userId) : null,
                type: 'INVITE_CREATED',
                beforeJson: null,
                afterJson: serializeJson({ inviteId: created.id, email, role, expiresAt: expiresAt.toISOString() }),
              },
            })
            .catch(() => {});

          results.push({ type: cmd.type, ok: true, inviteId: created.id });
          summaryLines.push(`✅ Invite creado para ${email} (rol ${role}).`);
          continue;
        }

        if (cmd.type === 'CREATE_OR_UPDATE_USER_MEMBERSHIP') {
          if (!isOwner) throw new Error('Solo OWNER puede gestionar usuarios.');
          const email = String(cmd.email || '').trim().toLowerCase();
          if (!email || !email.includes('@')) throw new Error('Email inválido.');
          const role = cmd.role;
          const assignedOnly = typeof (cmd as any).assignedOnly === 'boolean' ? Boolean((cmd as any).assignedOnly) : null;

          const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
          if (!user) {
            const now = new Date();
            const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
            const existing = await prisma.workspaceInvite.findFirst({
              where: { workspaceId: access.workspaceId, email, role, archivedAt: null, acceptedAt: null, expiresAt: { gt: now } },
              select: { id: true },
            });
            const created = existing
              ? existing
              : await prisma.workspaceInvite.create({
                  data: {
                    workspaceId: access.workspaceId,
                    email,
                    role,
                    token: buildInviteToken(),
                    expiresAt,
                    createdByUserId: userId ? String(userId) : null,
                  },
                  select: { id: true },
                });
            results.push({ type: cmd.type, ok: true, inviteId: created.id, invited: true });
            summaryLines.push(`✅ Invite creado para ${email} (rol ${role}).`);
            continue;
          }

          const existing = await prisma.membership.findFirst({
            where: { userId: user.id, workspaceId: access.workspaceId },
            select: { id: true, role: true, assignedOnly: true as any, archivedAt: true },
          });

          const updated = existing
            ? await prisma.membership.update({
                where: { id: existing.id },
                data: {
                  role,
                  archivedAt: null,
                  ...(assignedOnly === null ? {} : { assignedOnly }),
                } as any,
                select: { id: true, role: true, assignedOnly: true as any },
              })
            : await prisma.membership.create({
                data: {
                  userId: user.id,
                  workspaceId: access.workspaceId,
                  role,
                  archivedAt: null,
                  ...(assignedOnly === null ? {} : { assignedOnly }),
                } as any,
                select: { id: true, role: true, assignedOnly: true as any },
              });

          await prisma.configChangeLog
            .create({
              data: {
                workspaceId: access.workspaceId,
                userId: userId ? String(userId) : null,
                type: 'MEMBERSHIP_UPDATED',
                beforeJson: existing ? serializeJson({ membershipId: existing.id, role: existing.role, assignedOnly: Boolean((existing as any).assignedOnly), archivedAt: existing.archivedAt ? true : false }) : null,
                afterJson: serializeJson({ membershipId: updated.id, email, role: updated.role, assignedOnly: Boolean((updated as any).assignedOnly) }),
              },
            })
            .catch(() => {});

          results.push({ type: cmd.type, ok: true, membershipId: updated.id, userId: user.id, role: updated.role, assignedOnly: Boolean((updated as any).assignedOnly) });
          summaryLines.push(`✅ Membership actualizado: ${email} (${role})`);
          continue;
        }

        throw new Error('Comando no soportado.');
      } catch (err: any) {
        ok = false;
        const msg = err?.message || 'Error';
        results.push({ type: cmd.type, ok: false, error: msg });
        summaryLines.push(`❌ ${cmd.type}: ${msg}`);
        break;
      }
    }

    const execSummary = summaryLines.length > 0 ? `\n\nResultado:\n${summaryLines.map((l) => `- ${l}`).join('\n')}` : '';
    const updatedText = `${String(run.responseText || '').trim()}${execSummary}`.trim();

    const actions: any[] = [];
    const createdProgram = results.find((r) => r.type === 'CREATE_PROGRAM' && r.ok && r.programId);
    if (createdProgram) {
      actions.push({
        type: 'NAVIGATE',
        view: 'config',
        configTab: 'programs',
        label: 'Ver Programs',
        focusKind: 'program',
        focusId: String(createdProgram.programId),
      });
    }
    const membershipResult = results.find((r) => (r.type === 'CREATE_OR_UPDATE_USER_MEMBERSHIP' || r.type === 'INVITE_USER_BY_EMAIL') && r.ok);
    if (membershipResult && isOwner) {
      actions.push({
        type: 'NAVIGATE',
        view: 'config',
        configTab: 'users',
        label: 'Ver Usuarios',
      });
    }

    await prisma.copilotRunLog.update({
      where: { id: runId },
      data: {
        status: ok ? 'EXECUTED' : 'ERROR',
        error: ok ? null : 'Ejecución falló',
        responseText: updatedText,
        actionsJson: actions.length > 0 ? serializeJson(actions) : (run as any).actionsJson,
        resultsJson: serializeJson({ proposalId: proposal.id, ok, results }),
        confirmedAt: (run as any).confirmedAt || new Date(),
        confirmedByUserId: (run as any).confirmedByUserId || userId,
      } as any,
    });

    return {
      reply: updatedText,
      actions,
      threadId: (run as any).threadId || null,
      runId,
      autoNavigate: createdProgram ? true : false,
      results: { ok, results },
      status: ok ? 'EXECUTED' : 'ERROR',
    };
  });
}
