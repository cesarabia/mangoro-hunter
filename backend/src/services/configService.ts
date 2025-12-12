import { prisma } from '../db/client';
import { SystemConfig } from '@prisma/client';

const SINGLETON_ID = 1;
export const DEFAULT_WHATSAPP_BASE_URL = 'https://graph.facebook.com/v20.0';
export const DEFAULT_WHATSAPP_PHONE_ID = '1511895116748404';
export const DEFAULT_ADMIN_AI_PROMPT =
  'Eres Hunter Admin, un asistente en español para managers de reclutamiento. Da respuestas claras y accionables, usa herramientas cuando te lo pidan.';
export const DEFAULT_ADMIN_AI_MODEL = 'gpt-4.1-mini';
export const DEFAULT_INTERVIEW_AI_PROMPT =
  'Eres Hunter Entrevistador. Haz preguntas de entrevista cortas y profesionales, enfocadas en validar experiencia, motivaciones y disponibilidad.';
export const DEFAULT_INTERVIEW_AI_MODEL = 'gpt-4.1-mini';

export async function getSystemConfig(): Promise<SystemConfig> {
  const config = await ensureConfigRecord();
  return config;
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

export async function updateAdminAiConfig(input: {
  prompt?: string | null;
  model?: string | null;
}): Promise<SystemConfig> {
  const config = await ensureConfigRecord();
  const data: Record<string, string | null | undefined> = {};
  if (typeof input.prompt !== 'undefined') {
    data.adminAiPrompt = normalizeValue(input.prompt);
  }
  if (typeof input.model !== 'undefined') {
    data.adminAiModel = normalizeValue(input.model);
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
    data.interviewAiModel = normalizeValue(input.model);
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
        botAutoReply: true
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
