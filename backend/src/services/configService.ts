import { prisma } from '../db/client';
import { SystemConfig } from '@prisma/client';
import { normalizeWhatsAppId } from '../utils/whatsapp';

const SINGLETON_ID = 1;
export type OutboundPolicy = 'ALLOW_ALL' | 'ALLOWLIST_ONLY' | 'BLOCK_ALL';
export const DEFAULT_WHATSAPP_BASE_URL = 'https://graph.facebook.com/v20.0';
export const DEFAULT_WHATSAPP_PHONE_ID = '1511895116748404';
export const DEFAULT_TEMPLATE_INTERVIEW_INVITE = 'entrevista_confirmacion_1';
export const DEFAULT_TEMPLATE_GENERAL_FOLLOWUP = 'postulacion_completar_1';
export const DEFAULT_TEMPLATE_LANGUAGE_CODE = 'es_CL';
export const DEFAULT_AI_MODEL = 'gpt-4.1-mini';
export const DEFAULT_JOB_TITLE = 'Ejecutivo(a) de Ventas en Terreno';
export const DEFAULT_RECRUIT_JOB_SHEET = `
Cargo: Ejecutivo(a) de Ventas en Terreno
- Rubro: alarmas de seguridad con monitoreo
- Zona: RM (Santiago)
- Proceso: revisamos tu postulación y te contactamos por WhatsApp
`.trim();
export const DEFAULT_RECRUIT_FAQ = null;
export const DEFAULT_INTERVIEW_DAY = 'Lunes';
export const DEFAULT_INTERVIEW_TIME = '10:00';
export const DEFAULT_INTERVIEW_LOCATION = 'Online';
export const DEFAULT_INTERVIEW_TIMEZONE = 'America/Santiago';
export const DEFAULT_INTERVIEW_SLOT_MINUTES = 30;
export const DEFAULT_INTERVIEW_WEEKLY_AVAILABILITY = JSON.stringify({
  lunes: [{ start: '09:00', end: '18:00' }],
  martes: [{ start: '09:00', end: '18:00' }],
  miércoles: [{ start: '09:00', end: '18:00' }],
  jueves: [{ start: '09:00', end: '18:00' }],
  viernes: [{ start: '09:00', end: '18:00' }]
});
export const DEFAULT_INTERVIEW_EXCEPTIONS = JSON.stringify([]);
export const DEFAULT_INTERVIEW_LOCATIONS = JSON.stringify([DEFAULT_INTERVIEW_LOCATION]);
export const DEFAULT_TEST_PHONE_NUMBER = null;
export const DEFAULT_ADMIN_AI_PROMPT =
  'Eres Hunter Admin, un asistente en español para managers de reclutamiento. Da respuestas claras y accionables, usa herramientas cuando te lo pidan.';
export const DEFAULT_ADMIN_AI_MODEL = 'gpt-4.1-mini';
export const DEFAULT_ADMIN_AI_ADDENDUM = null;
const LEGACY_DEFAULT_INTERVIEW_AI_PROMPT =
  'Eres Hunter Entrevistador. Haz preguntas de entrevista cortas y profesionales, enfocadas en validar experiencia, motivaciones y disponibilidad.';
export const INTERVIEW_AI_POLICY_ADDENDUM = `
Reglas obligatorias de coordinación:
- Si el candidato dice "no", "no puedo" o "no me sirve": no insistas con la misma hora. Pide 2 alternativas (día + rango horario) u ofrece cerrar con respeto.
- Si ya quedó un horario confirmado, no lo confirmes repetidamente. Agradece y explica el siguiente paso en una sola respuesta.
- Haz una sola pregunta a la vez.
`.trim();
export const DEFAULT_INTERVIEW_AI_PROMPT = `
Eres Hunter Entrevistador, coordinador de entrevistas por WhatsApp desde "Postulaciones".
Tu objetivo es coordinar y confirmar una entrevista (no hacer la entrevista completa).

Reglas:
- Responde en 2 a 4 líneas, tono humano, empático y profesional.
- Jamás menciones el nombre real de la empresa; usa "Postulaciones".
- Si el candidato dice "no", "no puedo" o "no me sirve": no insistas con la misma hora. Pide 2 alternativas (día + rango horario) o ofrece cerrar con respeto.
- Si ya quedó un horario confirmado, no lo confirmes repetidamente: agradece y explica el siguiente paso en una sola respuesta.
- Haz una sola pregunta a la vez.
`.trim();
export const DEFAULT_INTERVIEW_AI_MODEL = 'gpt-4.1-mini';

export const DEFAULT_SALES_AI_PROMPT = `
Eres Hunter Ventas, un asistente en español para vendedores.
Tu objetivo es ayudar con pitch, objeciones, y apoyo en terreno.

Reglas:
- Responde en lenguaje natural, corto y accionable.
- Si falta información, haz 1 pregunta clara (sin loops).
- No inventes políticas ni precios: si no están en la base, dilo y pide el dato.
`.trim();

export const DEFAULT_SALES_KNOWLEDGE_BASE = `
Guía rápida:
- Pitch: presenta beneficio principal + siguiente paso.
- Objeción precio: valida, compara valor, pregunta prioridad (precio vs resultado).
- Registro: usa "registro visita ..." o "registro venta ...".
`.trim();

export const DEFAULT_ADMIN_NOTIFICATION_DETAIL_LEVEL = 'MEDIUM';
export const DEFAULT_ADMIN_NOTIFICATION_TEMPLATES = JSON.stringify({
  RECRUIT_READY:
    '🟢 Reclutamiento listo: {{name}}\\nTel: {{phone}}\\n{{summary}}\\nPróximo paso: revisar y contactar.',
  INTERVIEW_SCHEDULED:
    '🗓️ Entrevista agendada: {{name}}\\nTel: {{phone}}\\n{{when}}\\nEstado: PENDIENTE.',
  INTERVIEW_RESCHEDULED:
    '🔁 Entrevista reagendada: {{name}}\\nTel: {{phone}}\\n{{when}}\\nEstado: PENDIENTE.',
  INTERVIEW_CONFIRMED:
    '✅ Entrevista confirmada: {{name}}\\nTel: {{phone}}\\n{{when}}.',
  INTERVIEW_ON_HOLD:
    '⏸️ Entrevista en pausa: {{name}}\\nTel: {{phone}}\\n{{when}}\\nEstado: EN PAUSA.',
  INTERVIEW_CANCELLED:
    '❌ Entrevista cancelada: {{name}}\\nTel: {{phone}}\\n{{when}}\\nEstado: CANCELADA.',
  SELLER_DAILY_SUMMARY: '📊 Resumen diario ventas: {{name}}\\nTel: {{phone}}\\n{{summary}}',
  SELLER_WEEKLY_SUMMARY: '📈 Resumen semanal ventas: {{name}}\\nTel: {{phone}}\\n{{summary}}'
});

export function getDefaultOutboundPolicy(): OutboundPolicy {
  // NOTE: NODE_ENV is often set to "production" even in non-prod deployments (for performance),
  // so we only use APP_ENV to decide outbound safety defaults.
  const raw = String(process.env.APP_ENV || '').toLowerCase().trim();
  if (raw === 'production' || raw === 'prod') return 'ALLOW_ALL';
  return 'ALLOWLIST_ONLY';
}

function normalizeOutboundPolicy(value?: string | null): OutboundPolicy | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  if (upper === 'ALLOW_ALL') return 'ALLOW_ALL';
  if (upper === 'ALLOWLIST_ONLY') return 'ALLOWLIST_ONLY';
  if (upper === 'BLOCK_ALL') return 'BLOCK_ALL';
  return null;
}

function safeJsonParse<T>(value: string | null | undefined): T | null {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function parseWaIdList(value: string | null | undefined): string[] {
  const raw = (value || '').trim();
  if (!raw) return [];
  const parsed = safeJsonParse<unknown>(raw);
  const items: string[] = Array.isArray(parsed)
    ? parsed.map((v) => String(v))
    : raw.split(/[,\s]+/g);
  const out: string[] = [];
  for (const item of items) {
    const waId = normalizeWhatsAppId(item);
    if (!waId) continue;
    if (!out.includes(waId)) out.push(waId);
  }
  return out;
}

export function getAdminWaIdAllowlist(config: SystemConfig): string[] {
  const list = parseWaIdList((config as any).adminWaIds);
  const legacy = normalizeWhatsAppId(config.adminWaId || '');
  if (legacy && !list.includes(legacy)) {
    return [legacy, ...list];
  }
  return list;
}

export function getTestWaIdAllowlist(config: SystemConfig): string[] {
  const list = parseWaIdList((config as any).testPhoneNumbers);
  const legacy = normalizeWhatsAppId(config.testPhoneNumber || '');
  if (legacy && !list.includes(legacy)) {
    return [legacy, ...list];
  }
  return list;
}

export function getOutboundPolicy(config: SystemConfig): OutboundPolicy {
  const stored = normalizeOutboundPolicy((config as any).outboundPolicy);
  const defaultPolicy = getDefaultOutboundPolicy();
  // Guardrail: non-prod must never default to ALLOW_ALL, even if someone stored it in DB.
  if (defaultPolicy !== 'ALLOW_ALL' && stored === 'ALLOW_ALL') return 'ALLOWLIST_ONLY';
  return stored || defaultPolicy;
}

export function getOutboundAllowlist(config: SystemConfig): string[] {
  return parseWaIdList((config as any).outboundAllowlist);
}

export function getEffectiveOutboundAllowlist(config: SystemConfig): string[] {
  const union = [
    ...getAdminWaIdAllowlist(config),
    ...getTestWaIdAllowlist(config),
    ...getOutboundAllowlist(config),
  ];
  const out: string[] = [];
  for (const item of union) {
    const waId = normalizeWhatsAppId(item);
    if (!waId) continue;
    if (!out.includes(waId)) out.push(waId);
  }
  return out;
}

export async function updateOutboundSafetyConfig(input: {
  outboundPolicy?: OutboundPolicy | null;
  outboundAllowlist?: string[] | null;
}): Promise<SystemConfig> {
  const config = await ensureConfigRecord();
  const data: Record<string, any> = {};

  if (typeof input.outboundPolicy !== 'undefined') {
    data.outboundPolicy = input.outboundPolicy ? normalizeOutboundPolicy(input.outboundPolicy) : null;
  }

  if (typeof input.outboundAllowlist !== 'undefined') {
    const normalized = Array.isArray(input.outboundAllowlist)
      ? input.outboundAllowlist.map((v) => normalizeWhatsAppId(v)).filter(Boolean) as string[]
      : [];
    const unique: string[] = [];
    for (const id of normalized) if (!unique.includes(id)) unique.push(id);
    data.outboundAllowlist = unique.length > 0 ? JSON.stringify(unique) : null;
  }

  if (Object.keys(data).length === 0) return config;
  return prisma.systemConfig.update({
    where: { id: config.id },
    data,
  });
}

export async function updateAuthorizedNumbersConfig(input: {
  adminNumbers?: string[] | null;
  testNumbers?: string[] | null;
}): Promise<SystemConfig> {
  const config = await ensureConfigRecord();
  const data: Record<string, any> = {};

  if (typeof input.adminNumbers !== 'undefined') {
    const normalized = Array.isArray(input.adminNumbers)
      ? input.adminNumbers.map((v) => normalizeWhatsAppId(v)).filter(Boolean) as string[]
      : [];
    const unique: string[] = [];
    for (const id of normalized) if (!unique.includes(id)) unique.push(id);
    data.adminWaIds = unique.length > 0 ? JSON.stringify(unique) : null;
    data.adminWaId = unique.length > 0 ? unique[0] : null;
  }

  if (typeof input.testNumbers !== 'undefined') {
    const normalized = Array.isArray(input.testNumbers)
      ? input.testNumbers.map((v) => normalizeWhatsAppId(v)).filter(Boolean) as string[]
      : [];
    const unique: string[] = [];
    for (const id of normalized) if (!unique.includes(id)) unique.push(id);
    data.testPhoneNumbers = unique.length > 0 ? JSON.stringify(unique) : null;
    data.testPhoneNumber = unique.length > 0 ? unique[0] : null;
  }

  if (Object.keys(data).length === 0) return config;
  return prisma.systemConfig.update({
    where: { id: config.id },
    data
  });
}

export async function getSystemConfig(): Promise<SystemConfig> {
  const config = await ensureConfigRecord();
  return config;
}

export function normalizeModelId(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase().replace(/\s+/g, '-');
  const aliases: Record<string, string> = {
    "gpt-5-mini": "gpt-5-chat-latest",
    "gpt5-mini": "gpt-5-chat-latest",
    "gpt-5-mini-2025-08-07": "gpt-5-chat-latest",
    "gpt-5-chat-latest": "gpt-5-chat-latest",
    "gpt-4.1-mini": "gpt-4.1-mini",
    "gpt-41-mini": "gpt-4.1-mini",
    "gpt-4.1-mini-2024-12-17": "gpt-4.1-mini",
  };
  const mapped = aliases[lower] || lower;
  const allowed = new Set(["gpt-4.1-mini", "gpt-5-chat-latest"]);
  if (allowed.has(mapped)) return mapped;
  return "gpt-4.1-mini";
}

export async function updateWhatsAppConfig(input: {
  whatsappBaseUrl?: string | null;
  whatsappPhoneId?: string | null;
  whatsappToken?: string;
  whatsappVerifyToken?: string | null;
  botAutoReply?: boolean;
  adminWaId?: string | null;
}): Promise<SystemConfig> {
  const config = await ensureConfigRecord();

  const data: any = {};
  if (typeof input.whatsappBaseUrl !== 'undefined') {
    data.whatsappBaseUrl = normalizeValue(input.whatsappBaseUrl);
  }
  if (typeof input.whatsappPhoneId !== 'undefined') {
    data.whatsappPhoneId = normalizeValue(input.whatsappPhoneId);
  }
  if (typeof input.botAutoReply !== 'undefined') {
    data.botAutoReply = input.botAutoReply;
  }
  if (typeof input.whatsappToken !== 'undefined') {
    data.whatsappToken = normalizeValue(input.whatsappToken);
  }
  if (typeof input.whatsappVerifyToken !== 'undefined') {
    data.whatsappVerifyToken = normalizeValue(input.whatsappVerifyToken);
  }
  if (typeof input.adminWaId !== 'undefined') {
    data.adminWaId = normalizeValue(input.adminWaId);
  }

  if (Object.keys(data).length === 0) {
    return config;
  }

  return prisma.systemConfig.update({
    where: { id: config.id },
    data
  });
}

export async function updateAiConfig(openAiApiKey?: string | null): Promise<SystemConfig> {
  const config = await ensureConfigRecord();
  return prisma.systemConfig.update({
    where: { id: config.id },
    data: {
      openAiApiKey: normalizeValue(openAiApiKey)
    }
  });
}

export async function updateAiPrompt(aiPrompt?: string | null): Promise<SystemConfig> {
  const config = await ensureConfigRecord();
  return prisma.systemConfig.update({
    where: { id: config.id },
    data: {
      aiPrompt: normalizeValue(aiPrompt)
    }
  });
}

export async function updateRecruitmentContent(input: {
  jobSheet?: string | null;
  faq?: string | null;
}): Promise<SystemConfig> {
  const config = await ensureConfigRecord();
  const data: any = {};
  if (typeof input.jobSheet !== 'undefined') {
    data.recruitJobSheet = normalizeValue(input.jobSheet);
  }
  if (typeof input.faq !== 'undefined') {
    data.recruitFaq = normalizeValue(input.faq);
  }
  if (Object.keys(data).length === 0) {
    return config;
  }
  return prisma.systemConfig.update({
    where: { id: config.id },
    data
  });
}

export async function updateAdminNotificationConfig(input: {
  detailLevel?: string | null;
  templates?: string | null;
  enabledEvents?: string | null;
  detailLevelsByEvent?: string | null;
}): Promise<SystemConfig> {
  const config = await ensureConfigRecord();
  const data: any = {};
  if (typeof input.detailLevel !== 'undefined') {
    data.adminNotificationDetailLevel = normalizeValue(input.detailLevel);
  }
  if (typeof input.templates !== 'undefined') {
    data.adminNotificationTemplates = normalizeValue(input.templates);
  }
  if (typeof input.enabledEvents !== 'undefined') {
    data.adminNotificationEnabledEvents = normalizeValue(input.enabledEvents);
  }
  if (typeof input.detailLevelsByEvent !== 'undefined') {
    data.adminNotificationDetailLevelsByEvent = normalizeValue(input.detailLevelsByEvent);
  }
  if (Object.keys(data).length === 0) {
    return config;
  }
  return prisma.systemConfig.update({
    where: { id: config.id },
    data
  });
}

export async function updateWorkflowConfig(input: {
  rules?: string | null;
  inactivityDays?: number | null;
  archiveDays?: number | null;
}): Promise<SystemConfig> {
  const config = await ensureConfigRecord();
  const data: any = {};
  if (typeof input.rules !== 'undefined') {
    data.workflowRules = normalizeValue(input.rules);
  }
  if (typeof input.inactivityDays !== 'undefined') {
    data.workflowInactivityDays =
      typeof input.inactivityDays === 'number' && Number.isFinite(input.inactivityDays)
        ? Math.floor(input.inactivityDays)
        : input.inactivityDays === null
          ? null
          : undefined;
  }
  if (typeof input.archiveDays !== 'undefined') {
    data.workflowArchiveDays =
      typeof input.archiveDays === 'number' && Number.isFinite(input.archiveDays)
        ? Math.floor(input.archiveDays)
        : input.archiveDays === null
          ? null
          : undefined;
  }
  if (Object.keys(data).length === 0) return config;
  return prisma.systemConfig.update({
    where: { id: config.id },
    data
  });
}

export async function updateAiModel(aiModel?: string | null): Promise<SystemConfig> {
  const config = await ensureConfigRecord();
  return prisma.systemConfig.update({
    where: { id: config.id },
    data: {
      aiModel: normalizeModelId(aiModel)
    }
  });
}

export async function updateAdminAiConfig(input: {
  prompt?: string | null;
  model?: string | null;
  addendum?: string | null;
}): Promise<SystemConfig> {
  const config = await ensureConfigRecord();
  const data: Record<string, string | null | undefined> = {};
  if (typeof input.prompt !== 'undefined') {
    data.adminAiPrompt = normalizeValue(input.prompt);
  }
  if (typeof input.model !== 'undefined') {
    data.adminAiModel = normalizeModelId(input.model);
  }
  if (typeof input.addendum !== 'undefined') {
    data.adminAiAddendum = normalizeValue(input.addendum);
  }
  return prisma.systemConfig.update({
    where: { id: config.id },
    data
  });
}

export async function updateAdminAccount(email: string, passwordHash: string): Promise<SystemConfig> {
  const config = await ensureConfigRecord();
  const adminUser = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
    orderBy: { createdAt: 'asc' }
  });

  if (adminUser) {
    await prisma.user.update({
      where: { id: adminUser.id },
      data: {
        email,
        passwordHash
      }
    });
  } else {
    await prisma.user.create({
      data: {
        email,
        name: 'Administrador',
        passwordHash,
        role: 'ADMIN'
      }
    });
  }

  return prisma.systemConfig.update({
    where: { id: config.id },
    data: { adminEmail: email }
  });
}

export async function updateInterviewAiConfig(input: {
  prompt?: string | null;
  model?: string | null;
}): Promise<SystemConfig> {
  const config = await ensureConfigRecord();
  const data: Record<string, string | null | undefined> = {};
  if (typeof input.prompt !== 'undefined') {
    data.interviewAiPrompt = normalizeValue(input.prompt);
  }
  if (typeof input.model !== 'undefined') {
    data.interviewAiModel = normalizeModelId(input.model);
  }
  return prisma.systemConfig.update({
    where: { id: config.id },
    data
  });
}

export async function updateSalesAiConfig(input: {
  prompt?: string | null;
  knowledgeBase?: string | null;
}): Promise<SystemConfig> {
  const config = await ensureConfigRecord();
  const data: Record<string, string | null | undefined> = {};
  if (typeof input.prompt !== 'undefined') {
    data.salesAiPrompt = normalizeValue(input.prompt);
  }
  if (typeof input.knowledgeBase !== 'undefined') {
    data.salesKnowledgeBase = normalizeValue(input.knowledgeBase);
  }
  if (Object.keys(data).length === 0) {
    return config;
  }
  return prisma.systemConfig.update({
    where: { id: config.id },
    data
  });
}

export async function updateTemplateConfig(input: {
  templateInterviewInvite?: string | null;
  templateGeneralFollowup?: string | null;
  templateLanguageCode?: string | null;
  defaultJobTitle?: string | null;
  defaultInterviewDay?: string | null;
  defaultInterviewTime?: string | null;
  defaultInterviewLocation?: string | null;
   testPhoneNumber?: string | null;
}): Promise<SystemConfig> {
  const config = await ensureConfigRecord();
  const data: Record<string, string | null | undefined> = {};
  if (typeof input.templateInterviewInvite !== 'undefined') {
    data.templateInterviewInvite = normalizeValue(input.templateInterviewInvite);
  }
  if (typeof input.templateGeneralFollowup !== 'undefined') {
    data.templateGeneralFollowup = normalizeValue(input.templateGeneralFollowup);
  }
  if (typeof input.templateLanguageCode !== 'undefined') {
    data.templateLanguageCode = normalizeValue(input.templateLanguageCode);
  }
  if (typeof input.defaultJobTitle !== 'undefined') {
    data.defaultJobTitle = normalizeValue(input.defaultJobTitle);
  }
  if (typeof input.defaultInterviewDay !== 'undefined') {
    data.defaultInterviewDay = normalizeValue(input.defaultInterviewDay);
  }
  if (typeof input.defaultInterviewTime !== 'undefined') {
    data.defaultInterviewTime = normalizeValue(input.defaultInterviewTime);
  }
  if (typeof input.defaultInterviewLocation !== 'undefined') {
    data.defaultInterviewLocation = normalizeValue(input.defaultInterviewLocation);
  }
  if (typeof input.testPhoneNumber !== 'undefined') {
    data.testPhoneNumber = normalizeValue(input.testPhoneNumber);
  }
  return prisma.systemConfig.update({
    where: { id: config.id },
    data
  });
}

export async function updateInterviewScheduleConfig(input: {
  interviewTimezone?: string | null;
  interviewSlotMinutes?: number | null;
  interviewWeeklyAvailability?: string | null;
  interviewExceptions?: string | null;
  interviewLocations?: string | null;
}): Promise<SystemConfig> {
  const config = await ensureConfigRecord();
  const data: Record<string, any> = {};
  if (typeof input.interviewTimezone !== 'undefined') {
    data.interviewTimezone = normalizeValue(input.interviewTimezone);
  }
  if (typeof input.interviewSlotMinutes !== 'undefined') {
    const raw = input.interviewSlotMinutes;
    const parsed =
      typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : null;
    data.interviewSlotMinutes = parsed && parsed > 0 ? parsed : null;
  }
  if (typeof input.interviewWeeklyAvailability !== 'undefined') {
    data.interviewWeeklyAvailability = normalizeValue(input.interviewWeeklyAvailability);
  }
  if (typeof input.interviewExceptions !== 'undefined') {
    data.interviewExceptions = normalizeValue(input.interviewExceptions);
  }
  if (typeof input.interviewLocations !== 'undefined') {
    data.interviewLocations = normalizeValue(input.interviewLocations);
  }
  if (Object.keys(data).length === 0) {
    return config;
  }
  return prisma.systemConfig.update({
    where: { id: config.id },
    data
  });
}

async function ensureConfigRecord(): Promise<SystemConfig> {
  let existing = await prisma.systemConfig.findUnique({ where: { id: SINGLETON_ID } });
  if (!existing) {
    const outboundPolicy = getDefaultOutboundPolicy();
    existing = await prisma.systemConfig.create({
      data: {
        id: SINGLETON_ID,
        whatsappBaseUrl: DEFAULT_WHATSAPP_BASE_URL,
        whatsappPhoneId: DEFAULT_WHATSAPP_PHONE_ID,
        botAutoReply: true,
        outboundPolicy,
        outboundAllowlist: null,
        devReleaseNotes: null,
        openAiModelPricing: null,
        whatsappPricing: null,
        interviewAiPrompt: DEFAULT_INTERVIEW_AI_PROMPT,
        interviewAiModel: DEFAULT_INTERVIEW_AI_MODEL,
        aiModel: DEFAULT_AI_MODEL,
        recruitJobSheet: DEFAULT_RECRUIT_JOB_SHEET,
        recruitFaq: DEFAULT_RECRUIT_FAQ,
        adminNotificationDetailLevel: DEFAULT_ADMIN_NOTIFICATION_DETAIL_LEVEL,
        adminNotificationTemplates: DEFAULT_ADMIN_NOTIFICATION_TEMPLATES,
        templateInterviewInvite: DEFAULT_TEMPLATE_INTERVIEW_INVITE,
        templateGeneralFollowup: DEFAULT_TEMPLATE_GENERAL_FOLLOWUP,
        templateLanguageCode: DEFAULT_TEMPLATE_LANGUAGE_CODE,
        defaultJobTitle: DEFAULT_JOB_TITLE,
        defaultInterviewDay: DEFAULT_INTERVIEW_DAY,
        defaultInterviewTime: DEFAULT_INTERVIEW_TIME,
        defaultInterviewLocation: DEFAULT_INTERVIEW_LOCATION,
        interviewTimezone: DEFAULT_INTERVIEW_TIMEZONE,
        interviewSlotMinutes: DEFAULT_INTERVIEW_SLOT_MINUTES,
        interviewWeeklyAvailability: DEFAULT_INTERVIEW_WEEKLY_AVAILABILITY,
        interviewExceptions: DEFAULT_INTERVIEW_EXCEPTIONS,
        interviewLocations: DEFAULT_INTERVIEW_LOCATIONS,
        testPhoneNumber: DEFAULT_TEST_PHONE_NUMBER,
        salesAiPrompt: DEFAULT_SALES_AI_PROMPT,
        salesKnowledgeBase: DEFAULT_SALES_KNOWLEDGE_BASE,
        adminAiAddendum: DEFAULT_ADMIN_AI_ADDENDUM
      }
    });
    return existing;
  }
  const updates: Record<string, any> = {};
  if (!existing.whatsappBaseUrl) {
    updates.whatsappBaseUrl = DEFAULT_WHATSAPP_BASE_URL;
  }
  if (!existing.whatsappPhoneId) {
    updates.whatsappPhoneId = DEFAULT_WHATSAPP_PHONE_ID;
  }
  if (!existing.templateInterviewInvite) {
    updates.templateInterviewInvite = DEFAULT_TEMPLATE_INTERVIEW_INVITE;
  }
  if (!existing.templateGeneralFollowup) {
    updates.templateGeneralFollowup = DEFAULT_TEMPLATE_GENERAL_FOLLOWUP;
  }
  if (!existing.templateLanguageCode) {
    updates.templateLanguageCode = DEFAULT_TEMPLATE_LANGUAGE_CODE;
  }
  if (!existing.defaultJobTitle) {
    updates.defaultJobTitle = DEFAULT_JOB_TITLE;
  }
  if (!existing.defaultInterviewDay) {
    updates.defaultInterviewDay = DEFAULT_INTERVIEW_DAY;
  }
  if (!existing.defaultInterviewTime) {
    updates.defaultInterviewTime = DEFAULT_INTERVIEW_TIME;
  }
  if (!existing.defaultInterviewLocation) {
    updates.defaultInterviewLocation = DEFAULT_INTERVIEW_LOCATION;
  }
  if (!existing.interviewTimezone) {
    updates.interviewTimezone = DEFAULT_INTERVIEW_TIMEZONE;
  }
  if (!existing.interviewSlotMinutes) {
    updates.interviewSlotMinutes = DEFAULT_INTERVIEW_SLOT_MINUTES;
  }
  if (!existing.interviewWeeklyAvailability) {
    updates.interviewWeeklyAvailability = DEFAULT_INTERVIEW_WEEKLY_AVAILABILITY;
  }
  if (!existing.interviewExceptions) {
    updates.interviewExceptions = DEFAULT_INTERVIEW_EXCEPTIONS;
  }
  if (!existing.interviewLocations) {
    updates.interviewLocations = DEFAULT_INTERVIEW_LOCATIONS;
  }
  if (!existing.aiModel) {
    updates.aiModel = DEFAULT_AI_MODEL;
  } else {
    const normalized = normalizeModelId(existing.aiModel);
    if (normalized && normalized !== existing.aiModel) {
      updates.aiModel = normalized;
    }
  }
  if (typeof (existing as any).adminAiAddendum === 'undefined') {
    updates.adminAiAddendum = DEFAULT_ADMIN_AI_ADDENDUM;
  }
  if (typeof existing.testPhoneNumber === 'undefined') {
    updates.testPhoneNumber = DEFAULT_TEST_PHONE_NUMBER;
  }
  if (typeof (existing as any).adminWaIds === 'undefined') {
    updates.adminWaIds = null;
  }
  if (typeof (existing as any).testPhoneNumbers === 'undefined') {
    updates.testPhoneNumbers = null;
  }
  if (typeof (existing as any).salesAiPrompt === 'undefined') {
    updates.salesAiPrompt = DEFAULT_SALES_AI_PROMPT;
  }
  if (typeof (existing as any).salesKnowledgeBase === 'undefined') {
    updates.salesKnowledgeBase = DEFAULT_SALES_KNOWLEDGE_BASE;
  }
  if (typeof (existing as any).recruitJobSheet === 'undefined') {
    updates.recruitJobSheet = DEFAULT_RECRUIT_JOB_SHEET;
  } else if (!existing.recruitJobSheet) {
    updates.recruitJobSheet = DEFAULT_RECRUIT_JOB_SHEET;
  }
  if (typeof (existing as any).recruitFaq === 'undefined') {
    updates.recruitFaq = DEFAULT_RECRUIT_FAQ;
  }
  if (typeof (existing as any).adminNotificationDetailLevel === 'undefined') {
    updates.adminNotificationDetailLevel = DEFAULT_ADMIN_NOTIFICATION_DETAIL_LEVEL;
  } else if (!existing.adminNotificationDetailLevel) {
    updates.adminNotificationDetailLevel = DEFAULT_ADMIN_NOTIFICATION_DETAIL_LEVEL;
  }
  if (typeof (existing as any).adminNotificationTemplates === 'undefined') {
    updates.adminNotificationTemplates = DEFAULT_ADMIN_NOTIFICATION_TEMPLATES;
  } else if (!existing.adminNotificationTemplates) {
    updates.adminNotificationTemplates = DEFAULT_ADMIN_NOTIFICATION_TEMPLATES;
  }
  if (typeof (existing as any).outboundPolicy === 'undefined') {
    updates.outboundPolicy = getDefaultOutboundPolicy();
  } else if ((existing as any).outboundPolicy) {
    const normalizedPolicy = normalizeOutboundPolicy((existing as any).outboundPolicy);
    if (normalizedPolicy && normalizedPolicy !== (existing as any).outboundPolicy) {
      updates.outboundPolicy = normalizedPolicy;
    }
  }
  if (typeof (existing as any).outboundAllowlist === 'undefined') {
    updates.outboundAllowlist = null;
  }
  if (typeof (existing as any).devReleaseNotes === 'undefined') {
    updates.devReleaseNotes = null;
  }
  if (typeof (existing as any).openAiModelPricing === 'undefined') {
    updates.openAiModelPricing = null;
  }
  if (typeof (existing as any).whatsappPricing === 'undefined') {
    updates.whatsappPricing = null;
  }
  if (!existing.interviewAiPrompt) {
    updates.interviewAiPrompt = DEFAULT_INTERVIEW_AI_PROMPT;
  } else if (existing.interviewAiPrompt.trim() === LEGACY_DEFAULT_INTERVIEW_AI_PROMPT) {
    updates.interviewAiPrompt = DEFAULT_INTERVIEW_AI_PROMPT;
  }
  if (!existing.interviewAiModel) {
    updates.interviewAiModel = DEFAULT_INTERVIEW_AI_MODEL;
  } else {
    const normalizedInterview = normalizeModelId(existing.interviewAiModel);
    if (normalizedInterview && normalizedInterview !== existing.interviewAiModel) {
      updates.interviewAiModel = normalizedInterview;
    }
  }
  if (existing.adminAiModel) {
    const normalizedAdmin = normalizeModelId(existing.adminAiModel);
    if (normalizedAdmin && normalizedAdmin !== existing.adminAiModel) {
      updates.adminAiModel = normalizedAdmin;
    }
  }
  if (Object.keys(updates).length > 0) {
    existing = await prisma.systemConfig.update({
      where: { id: existing.id },
      data: updates
    });
  }
  return existing;
}

function normalizeValue(value?: string | null): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return value ?? null;
}
