import { prisma } from '../db/client';
import { SystemConfig } from '@prisma/client';

const SINGLETON_ID = 1;
export const DEFAULT_WHATSAPP_BASE_URL = 'https://graph.facebook.com/v20.0';
export const DEFAULT_WHATSAPP_PHONE_ID = '1511895116748404';
export const DEFAULT_TEMPLATE_INTERVIEW_INVITE = 'entrevista_confirmacion_1';
export const DEFAULT_TEMPLATE_GENERAL_FOLLOWUP = 'postulacion_completar_1';
export const DEFAULT_TEMPLATE_LANGUAGE_CODE = 'es_CL';
export const DEFAULT_AI_MODEL = 'gpt-4.1-mini';
export const DEFAULT_JOB_TITLE = 'Vendedor/a';
export const DEFAULT_INTERVIEW_DAY = 'Lunes';
export const DEFAULT_INTERVIEW_TIME = '10:00';
export const DEFAULT_INTERVIEW_LOCATION = 'Online';
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

async function ensureConfigRecord(): Promise<SystemConfig> {
  let existing = await prisma.systemConfig.findUnique({ where: { id: SINGLETON_ID } });
  if (!existing) {
    existing = await prisma.systemConfig.create({
      data: {
        id: SINGLETON_ID,
        whatsappBaseUrl: DEFAULT_WHATSAPP_BASE_URL,
        whatsappPhoneId: DEFAULT_WHATSAPP_PHONE_ID,
        botAutoReply: true,
        interviewAiPrompt: DEFAULT_INTERVIEW_AI_PROMPT,
        interviewAiModel: DEFAULT_INTERVIEW_AI_MODEL,
        aiModel: DEFAULT_AI_MODEL,
        templateInterviewInvite: DEFAULT_TEMPLATE_INTERVIEW_INVITE,
        templateGeneralFollowup: DEFAULT_TEMPLATE_GENERAL_FOLLOWUP,
        templateLanguageCode: DEFAULT_TEMPLATE_LANGUAGE_CODE,
        defaultJobTitle: DEFAULT_JOB_TITLE,
        defaultInterviewDay: DEFAULT_INTERVIEW_DAY,
        defaultInterviewTime: DEFAULT_INTERVIEW_TIME,
        defaultInterviewLocation: DEFAULT_INTERVIEW_LOCATION,
        testPhoneNumber: DEFAULT_TEST_PHONE_NUMBER,
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
