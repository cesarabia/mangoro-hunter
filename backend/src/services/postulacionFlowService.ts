import OpenAI from 'openai';
import { z } from 'zod';
import { prisma } from '../db/client';
import { getEffectiveOpenAiKey } from './aiService';
import { getSystemConfig, DEFAULT_AI_MODEL } from './configService';
import { resolveModelChain } from './modelResolutionService';
import { createChatCompletionWithModelFallback } from './openAiChatCompletionService';
import { serializeJson } from '../utils/json';
import { coerceStageSlug, ensureWorkspaceStages } from './workspaceStageService';

export const APPLICATION_ROLE_VALUES = ['PEONETA', 'DRIVER_COMPANY', 'DRIVER_OWN_VAN'] as const;
export type ApplicationRole = (typeof APPLICATION_ROLE_VALUES)[number];

export const APPLICATION_STATE_VALUES = [
  'CHOOSE_ROLE',
  'COLLECT_MIN_INFO',
  'COLLECT_REQUIREMENTS',
  'REQUEST_CV',
  'CONFIRM_CONDITIONS',
  'REQUEST_OP_DOCS',
  'READY_FOR_OP_REVIEW',
  'WAITING_OP_RESULT',
  'OP_ACCEPTED',
  'OP_REJECTED',
] as const;
export type ApplicationState = (typeof APPLICATION_STATE_VALUES)[number];

const PostulacionExtractionSchema = z.object({
  roleIntent: z.enum(APPLICATION_ROLE_VALUES).optional(),
  fullName: z.string().min(2).max(120).optional(),
  comuna: z.string().min(2).max(120).optional(),
  availability: z.string().min(2).max(240).optional(),
  experience: z.string().min(2).max(240).optional(),
  yearsExperience: z.number().int().min(0).max(80).optional(),
  hasLicenseB: z.boolean().optional(),
  hasParking: z.boolean().optional(),
  hasOwnVan: z.boolean().optional(),
  vanClosed: z.boolean().optional(),
  vehicleDocsUpToDate: z.boolean().optional(),
  email: z.string().email().optional(),
  asksAboutPay: z.boolean().optional(),
  asksAboutWhere: z.boolean().optional(),
  wantsToContinue: z.boolean().optional(),
});

export type PostulacionExtraction = z.infer<typeof PostulacionExtractionSchema>;

function parseJsonLoose<T = any>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function normalizeApplicationRole(value: unknown): ApplicationRole | null {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw === 'PEONETA') return 'PEONETA';
  if (raw === 'DRIVER_COMPANY' || raw === 'CONDUCTOR') return 'DRIVER_COMPANY';
  if (raw === 'DRIVER_OWN_VAN' || raw === 'CONDUCTOR_FLOTA' || raw === 'CONDUCTOR_VEHICULO_PROPIO') {
    return 'DRIVER_OWN_VAN';
  }
  return null;
}

export function normalizeApplicationState(value: unknown): ApplicationState | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();

  if ((APPLICATION_STATE_VALUES as readonly string[]).includes(normalized)) {
    return normalized as ApplicationState;
  }

  if (normalized === 'STATE_0_ROLE_AND_LOCATION') return 'CHOOSE_ROLE';
  if (normalized === 'STATE_1_DISCOVERY') return 'COLLECT_MIN_INFO';
  if (normalized === 'STATE_2_WAITING_CV') return 'REQUEST_CV';
  if (normalized === 'EN_REVISION_OPERACION') return 'READY_FOR_OP_REVIEW';
  if (normalized === 'INTERVIEW_PENDING') return 'OP_ACCEPTED';
  if (normalized === 'REJECTED' || normalized === 'DESCARTADO') return 'OP_REJECTED';
  return null;
}

export function mapApplicationStateToStage(params: {
  state: ApplicationState | null;
  role: ApplicationRole | null;
}): string | null {
  const state = params.state;
  if (!state) return null;
  if (state === 'CHOOSE_ROLE') return 'NEW_INTAKE';
  if (state === 'COLLECT_MIN_INFO' || state === 'COLLECT_REQUIREMENTS' || state === 'CONFIRM_CONDITIONS') {
    return 'SCREENING';
  }
  if (state === 'REQUEST_CV') return 'SCREENING';
  if (state === 'REQUEST_OP_DOCS') return 'DOCS_PENDING';
  if (state === 'READY_FOR_OP_REVIEW' || state === 'WAITING_OP_RESULT') return 'OP_REVIEW';
  if (state === 'OP_ACCEPTED') return 'INTERVIEW_PENDING';
  if (state === 'OP_REJECTED') return 'REJECTED';
  return null;
}

export function mapRoleToContactJobRole(role: ApplicationRole | null): string | null {
  if (!role) return null;
  if (role === 'PEONETA') return 'PEONETA';
  if (role === 'DRIVER_COMPANY') return 'CONDUCTOR';
  if (role === 'DRIVER_OWN_VAN') return 'CONDUCTOR_FLOTA';
  return null;
}

export function buildPostulacionBusinessRulesPrompt(): string {
  return [
    'Reglas de negocio obligatorias (no inventar):',
    '- Roles válidos: PEONETA, DRIVER_COMPANY, DRIVER_OWN_VAN.',
    '- Etapa 1 (mínimo para revisión): cargo + comuna + disponibilidad + experiencia.',
    '- Si es conductor (empresa o vehículo propio) y falta CV: no avanzar, pide CV.',
    '- Etapa 2 (operación): pedir foto carnet (ambos lados) + foto licencia clase B.',
    '- Conductor empresa: CHEX $400, Vol $1.000; Mercado Libre $25.000/día; Falabella por definir.',
    '- Conductor vehículo propio: CHEX $800, Vol $2.000.',
    '- Peoneta: $15.000/día.',
    '- Requisitos conductor empresa: licencia B + estacionamiento para guardar vehículo.',
    '- Requisitos conductor vehículo propio: furgón cerrado + docs al día + licencia B.',
    '- Entrevista presencial en Providencia. La dirección exacta se entrega solo al confirmar entrevista.',
    '- Si preguntan por pagos/ubicación, responde primero y luego retoma la captura de datos faltantes.',
    '- Prohibido inventar montos/condiciones no definidas.',
  ].join('\n');
}

export async function ensurePostulacionStages(workspaceId: string): Promise<void> {
  await ensureWorkspaceStages(workspaceId).catch(() => {});
  const required: Array<{ slug: string; labelEs: string; order: number; isTerminal?: boolean }> = [
    { slug: 'SCREENING', labelEs: 'Screening', order: 20 },
    { slug: 'DOCS_PENDING', labelEs: 'Documentos pendientes', order: 35 },
    { slug: 'OP_REVIEW', labelEs: 'Revisión operación', order: 45 },
    { slug: 'INTERVIEW_PENDING', labelEs: 'Entrevista pendiente', order: 55 },
    { slug: 'REJECTED', labelEs: 'Rechazado', order: 95, isTerminal: true },
  ];
  for (const seed of required) {
    const exists = await prisma.workspaceStage
      .findFirst({
        where: { workspaceId, slug: seed.slug, archivedAt: null },
        select: { id: true },
      })
      .catch(() => null);
    if (exists?.id) continue;
    await prisma.workspaceStage
      .create({
        data: {
          workspaceId,
          slug: seed.slug,
          labelEs: seed.labelEs,
          order: seed.order,
          isDefault: false,
          isActive: true,
          isTerminal: Boolean(seed.isTerminal),
          archivedAt: null,
        } as any,
      })
      .catch(() => {});
  }
}

function detectRoleIntentHeuristic(text: string): ApplicationRole | null {
  const low = String(text || '').toLowerCase();
  const normalized = low
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^3(?:\D|$)/.test(normalized)) return 'DRIVER_OWN_VAN';
  if (/^1(?:\D|$)/.test(normalized)) return 'PEONETA';
  if (/^2(?:\D|$)/.test(normalized)) return 'DRIVER_COMPANY';
  if (/\bpeoneta\b/.test(low)) return 'PEONETA';
  if (/\b(furgon|furgón|vehiculo propio|vehículo propio|van propia|flota)\b/.test(low)) {
    return 'DRIVER_OWN_VAN';
  }
  if (/\bconductor|driver|chofer\b/.test(low)) return 'DRIVER_COMPANY';
  return null;
}

function heuristicExtraction(inboundText: string): PostulacionExtraction {
  const text = String(inboundText || '');
  const low = text.toLowerCase();
  const out: PostulacionExtraction = {};
  const role = detectRoleIntentHeuristic(text);
  if (role) out.roleIntent = role;

  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (emailMatch?.[0]) out.email = emailMatch[0].trim();

  if (/\blicencia\s*b\b|\btengo licencia\b/.test(low)) out.hasLicenseB = true;
  if (/\bsin licencia\b|\bno tengo licencia\b/.test(low)) out.hasLicenseB = false;
  if (/\bestacionamiento\b/.test(low)) out.hasParking = true;
  if (/\bno tengo estacionamiento\b/.test(low)) out.hasParking = false;
  if (/\bfurgon\b|\bfurgón\b/.test(low)) out.hasOwnVan = true;
  if (/\bdocs? al dia\b|\bdocumentos al dia\b|\bdocumentos al día\b/.test(low)) out.vehicleDocsUpToDate = true;

  if (/\bsueldo|pago|cuanto pagan|cuánto pagan|tarifa\b/.test(low)) out.asksAboutPay = true;
  if (/\bdonde|dónde|direccion|dirección|providencia\b/.test(low)) out.asksAboutWhere = true;
  if (/\bsi\b.*\binteresa|\bquiero\b.*\bpostular|\bcontinuar\b/.test(low)) out.wantsToContinue = true;

  const yearsMatch = low.match(/(\d{1,2})\s*(anos|años)/);
  if (yearsMatch?.[1]) out.yearsExperience = Math.max(0, Math.min(80, Number(yearsMatch[1])));
  if (/\bexperien/.test(low)) out.experience = text.trim().slice(0, 240);
  if (/\bmanana|mañana|hoy|tarde|manana|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|\d{1,2}:\d{2}/.test(low)) {
    out.availability = text.trim().slice(0, 240);
  }

  const comunaMatch = text.match(/\b(providencia|pudahuel|maipu|maipú|santiago|puente alto|la florida|quilicura|estacion central|estación central|san bernardo|renca|nunoa|ñuñoa|independencia)\b/i);
  if (comunaMatch?.[0]) {
    const c = comunaMatch[0];
    out.comuna = c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
  }

  const nameMatch = text.match(/\b(me llamo|soy)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ'\-]{2,}(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ'\-]{2,}){0,3})/i);
  if (nameMatch?.[2]) out.fullName = nameMatch[2].trim();
  return out;
}

export async function extractPostulacionDataFromInbound(params: {
  workspaceId: string;
  conversationId: string;
  inboundText: string;
  applicationRole?: string | null;
  applicationState?: string | null;
}): Promise<{ data: PostulacionExtraction; modelRequested: string; modelResolved: string } | null> {
  const inboundText = String(params.inboundText || '').trim();
  if (!inboundText) return null;

  const config = await getSystemConfig();
  const apiKey = getEffectiveOpenAiKey(config);
  if (!apiKey) {
    const heuristic = heuristicExtraction(inboundText);
    return { data: heuristic, modelRequested: 'heuristic', modelResolved: 'heuristic' };
  }

  const modelResolution = resolveModelChain({
    modelOverride: (config as any)?.aiModelOverride,
    modelAlias: (config as any)?.aiModelAlias,
    defaultModel: (config as any)?.aiModel || DEFAULT_AI_MODEL,
  });

  const system = [
    'Extrae datos estructurados de una conversación de postulación en Chile.',
    'Debes devolver SOLO JSON válido (sin markdown) y cumplir schema.',
    'No inventes campos faltantes.',
    'roleIntent solo puede ser PEONETA, DRIVER_COMPANY o DRIVER_OWN_VAN.',
  ].join('\n');

  const user = [
    `applicationRole actual: ${String(params.applicationRole || '') || '(vacío)'}`,
    `applicationState actual: ${String(params.applicationState || '') || '(vacío)'}`,
    'Mensaje inbound:',
    inboundText,
  ].join('\n');

  const openai = new OpenAI({ apiKey });
  try {
    const { completion, modelRequested, modelResolved } = await createChatCompletionWithModelFallback(
      openai,
      {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 280,
      },
      modelResolution.modelChain,
      { perRequestTimeoutMs: 8000, totalTimeoutMs: 10000 },
    );

    const content = String(completion?.choices?.[0]?.message?.content || '').trim();
    const parsed = parseJsonLoose(content) || {};
    const validated = PostulacionExtractionSchema.safeParse(parsed);
    if (!validated.success) {
      const heuristic = heuristicExtraction(inboundText);
      return { data: heuristic, modelRequested, modelResolved };
    }
    const data = validated.data;
    if (!data.roleIntent) {
      const fallbackRole = detectRoleIntentHeuristic(inboundText);
      if (fallbackRole) data.roleIntent = fallbackRole;
    }
    return { data, modelRequested, modelResolved };
  } catch {
    const heuristic = heuristicExtraction(inboundText);
    return {
      data: heuristic,
      modelRequested: modelResolution.modelRequested || DEFAULT_AI_MODEL,
      modelResolved: 'heuristic_fallback',
    };
  }
}

export async function persistPostulacionExtraction(params: {
  workspaceId: string;
  conversationId: string;
  extraction: PostulacionExtraction;
  source: 'INBOUND' | 'SUGGEST';
  modelRequested: string;
  modelResolved: string;
}): Promise<void> {
  const extraction = params.extraction || {};
  const convo = await prisma.conversation
    .findUnique({ where: { id: params.conversationId }, include: { contact: true } })
    .catch(() => null);
  if (!convo) return;

  const role = normalizeApplicationRole(extraction.roleIntent || (convo as any).applicationRole);
  const jobRole = mapRoleToContactJobRole(role);

  const currentData = parseJsonLoose<any>((convo as any).applicationDataJson || null) || {};
  const mergedData = {
    ...currentData,
    ...extraction,
    roleIntent: role || currentData.roleIntent || null,
    updatedAt: new Date().toISOString(),
    source: params.source,
    modelRequested: params.modelRequested,
    modelResolved: params.modelResolved,
  };

  const convoPatch: Record<string, any> = {
    applicationDataJson: serializeJson(mergedData),
    updatedAt: new Date(),
  };
  if (role) convoPatch.applicationRole = role;
  if (extraction.availability) convoPatch.availabilityRaw = String(extraction.availability).slice(0, 240);

  const contactPatch: Record<string, any> = {
    updatedAt: new Date(),
  };
  if (extraction.fullName) contactPatch.candidateName = String(extraction.fullName).slice(0, 120);
  if (extraction.email) contactPatch.email = String(extraction.email).slice(0, 180);
  if (extraction.comuna) contactPatch.comuna = String(extraction.comuna).slice(0, 120);
  if (extraction.availability) contactPatch.availabilityText = String(extraction.availability).slice(0, 240);
  if (typeof extraction.yearsExperience === 'number' && Number.isFinite(extraction.yearsExperience)) {
    contactPatch.experienceYears = Math.max(0, Math.min(80, Math.floor(extraction.yearsExperience)));
  }
  if (role && jobRole) contactPatch.jobRole = jobRole;

  await prisma.conversation.update({ where: { id: convo.id }, data: convoPatch as any }).catch(() => {});
  await prisma.contact.update({ where: { id: convo.contactId }, data: contactPatch as any }).catch(() => {});
}

export async function resolveStageForApplicationState(params: {
  workspaceId: string;
  role: ApplicationRole | null;
  state: ApplicationState | null;
}): Promise<string | null> {
  await ensurePostulacionStages(params.workspaceId).catch(() => {});
  const mapped = mapApplicationStateToStage({ role: params.role, state: params.state });
  if (!mapped) return null;
  const stage = await coerceStageSlug({ workspaceId: params.workspaceId, stageSlug: mapped }).catch(() => mapped);
  return stage || null;
}
