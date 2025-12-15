import { FastifyInstance } from 'fastify';
import {
  getSystemConfig,
  updateAdminAccount,
  updateAiConfig,
  updateAiPrompt,
  updateAdminAiConfig,
  updateInterviewAiConfig,
  updateTemplateConfig,
  updateWhatsAppConfig,
  DEFAULT_ADMIN_AI_PROMPT,
  DEFAULT_ADMIN_AI_MODEL,
  DEFAULT_INTERVIEW_AI_PROMPT,
  DEFAULT_INTERVIEW_AI_MODEL,
  DEFAULT_TEMPLATE_GENERAL_FOLLOWUP,
  DEFAULT_TEMPLATE_INTERVIEW_INVITE,
  DEFAULT_TEMPLATE_LANGUAGE_CODE,
  DEFAULT_AI_MODEL,
  DEFAULT_JOB_TITLE,
  DEFAULT_INTERVIEW_DAY,
  DEFAULT_INTERVIEW_TIME,
  DEFAULT_INTERVIEW_LOCATION,
  DEFAULT_INTERVIEW_TIMEZONE,
  DEFAULT_INTERVIEW_SLOT_MINUTES,
  DEFAULT_INTERVIEW_WEEKLY_AVAILABILITY,
  DEFAULT_INTERVIEW_EXCEPTIONS,
  DEFAULT_INTERVIEW_LOCATIONS,
  DEFAULT_TEST_PHONE_NUMBER,
  updateInterviewScheduleConfig,
  updateAiModel
} from '../services/configService';
import { hashPassword } from '../services/passwordService';
import { DEFAULT_AI_PROMPT } from '../constants/ai';
import { normalizeWhatsAppId } from '../utils/whatsapp';
import { prisma } from '../db/client';
import { sendWhatsAppTemplate } from '../services/whatsappMessageService';
import { serializeJson } from '../utils/json';
import fs from 'fs/promises';
import path from 'path';

export async function registerConfigRoutes(app: FastifyInstance) {
  const whatsappDefaults = {
    whatsappBaseUrl: null,
    whatsappPhoneId: null,
    botAutoReply: true,
    adminWaId: null,
    hasToken: false,
    hasVerifyToken: false
  };

  const templatesDefaults = {
    templateInterviewInvite: DEFAULT_TEMPLATE_INTERVIEW_INVITE,
    templateGeneralFollowup: DEFAULT_TEMPLATE_GENERAL_FOLLOWUP,
    templateLanguageCode: DEFAULT_TEMPLATE_LANGUAGE_CODE,
    defaultJobTitle: DEFAULT_JOB_TITLE,
    defaultInterviewDay: DEFAULT_INTERVIEW_DAY,
    defaultInterviewTime: DEFAULT_INTERVIEW_TIME,
    defaultInterviewLocation: DEFAULT_INTERVIEW_LOCATION,
    testPhoneNumber: DEFAULT_TEST_PHONE_NUMBER
  };

  const interviewScheduleDefaults = {
    interviewTimezone: DEFAULT_INTERVIEW_TIMEZONE,
    interviewSlotMinutes: DEFAULT_INTERVIEW_SLOT_MINUTES,
    interviewWeeklyAvailability: DEFAULT_INTERVIEW_WEEKLY_AVAILABILITY,
    interviewExceptions: DEFAULT_INTERVIEW_EXCEPTIONS,
    interviewLocations: DEFAULT_INTERVIEW_LOCATIONS
  };

  function isMissingColumnError(err: any): boolean {
    return Boolean(err && typeof err === 'object' && err.code === 'P2022');
  }

  async function loadConfigSafe(request: any) {
    try {
      return await getSystemConfig();
    } catch (err) {
      if (isMissingColumnError(err)) {
        request.log.warn({ err }, 'SystemConfig columns missing; returning defaults');
        return null;
      }
      throw err;
    }
  }

  function respondMissingColumns(reply: any) {
    return reply
      .code(409)
      .send({ error: 'Campos de configuración no disponibles. Ejecuta las migraciones en el servidor.' });
  }

  async function executeUpdate(reply: any, fn: () => Promise<any>) {
    try {
      return await fn();
    } catch (err) {
      if (isMissingColumnError(err)) {
        respondMissingColumns(reply);
        return null;
      }
      throw err;
    }
  }

  app.get('/whatsapp', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const config = await loadConfigSafe(request);
    if (!config) {
      return whatsappDefaults;
    }
    return {
      whatsappBaseUrl: config.whatsappBaseUrl,
      whatsappPhoneId: config.whatsappPhoneId,
      botAutoReply: config.botAutoReply,
      adminWaId: config.adminWaId,
      hasToken: Boolean(config.whatsappToken),
      hasVerifyToken: Boolean(config.whatsappVerifyToken)
    };
  });

  app.put('/whatsapp', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as {
      whatsappBaseUrl?: string;
      whatsappPhoneId?: string;
      whatsappToken?: string;
      whatsappVerifyToken?: string | null;
      botAutoReply?: boolean;
      adminWaId?: string | null;
    };

    const updated = await executeUpdate(reply, () =>
      updateWhatsAppConfig({
        whatsappBaseUrl: body.whatsappBaseUrl,
        whatsappPhoneId: body.whatsappPhoneId,
        whatsappToken: body.whatsappToken,
        whatsappVerifyToken:
          typeof body.whatsappVerifyToken === 'undefined' ? undefined : body.whatsappVerifyToken,
        botAutoReply: body.botAutoReply,
        adminWaId: typeof body.adminWaId === 'undefined' ? undefined : body.adminWaId
      })
    );
    if (!updated) return;

    return {
      whatsappBaseUrl: updated.whatsappBaseUrl,
      whatsappPhoneId: updated.whatsappPhoneId,
      botAutoReply: updated.botAutoReply,
      adminWaId: updated.adminWaId,
      hasToken: Boolean(updated.whatsappToken),
      hasVerifyToken: Boolean(updated.whatsappVerifyToken)
    };
  });

  app.get('/ai', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const config = await loadConfigSafe(request);
    if (!config) {
      return {
        hasOpenAiKey: false,
        aiModel: DEFAULT_AI_MODEL
      };
    }
    return {
      hasOpenAiKey: Boolean(config.openAiApiKey),
      aiModel: config.aiModel || DEFAULT_AI_MODEL
    };
  });

  app.put('/ai', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as { openAiApiKey?: string | null; aiModel?: string | null };
    const updated = await executeUpdate(reply, async () => {
      const cfg = await updateAiConfig(body?.openAiApiKey ?? null);
      if (typeof body?.aiModel !== 'undefined') {
        await updateAiModel(body.aiModel ?? null);
      }
      return cfg;
    });
    if (!updated) return;
    const fresh = await getSystemConfig();
    return {
      hasOpenAiKey: Boolean(fresh.openAiApiKey),
      aiModel: fresh.aiModel || DEFAULT_AI_MODEL
    };
  });

  app.get('/ai-prompt', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const config = await loadConfigSafe(request);
    if (!config) {
      return {
        aiPrompt: DEFAULT_AI_PROMPT,
        aiModel: DEFAULT_AI_MODEL
      };
    }
    return {
      aiPrompt: config.aiPrompt || DEFAULT_AI_PROMPT,
      aiModel: config.aiModel || DEFAULT_AI_MODEL
    };
  });

  app.put('/ai-prompt', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as { aiPrompt?: string | null; aiModel?: string | null };
    const updated = await executeUpdate(reply, async () => {
      const cfg = await updateAiPrompt(body?.aiPrompt ?? null);
      if (typeof body?.aiModel !== 'undefined') {
        await updateAiModel(body.aiModel ?? null);
      }
      return cfg;
    });
    if (!updated) return;
    const fresh = await getSystemConfig();
    return {
      aiPrompt: fresh.aiPrompt || DEFAULT_AI_PROMPT,
      aiModel: fresh.aiModel || DEFAULT_AI_MODEL
    };
  });

  app.get('/admin-ai', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const config = await loadConfigSafe(request);
    if (!config) {
      return {
        prompt: DEFAULT_ADMIN_AI_PROMPT,
        hasCustomPrompt: false,
        model: DEFAULT_ADMIN_AI_MODEL
      };
    }
    return {
      prompt: config.adminAiPrompt || DEFAULT_ADMIN_AI_PROMPT,
      hasCustomPrompt: Boolean(config.adminAiPrompt),
      model: config.adminAiModel || DEFAULT_ADMIN_AI_MODEL
    };
  });

  app.put('/admin-ai', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const body = request.body as { prompt?: string | null; model?: string | null };
    const updated = await executeUpdate(reply, () =>
      updateAdminAiConfig({
        prompt: typeof body?.prompt === 'undefined' ? undefined : body.prompt,
        model: typeof body?.model === 'undefined' ? undefined : body.model
      })
    );
    if (!updated) return;
    return {
      prompt: updated.adminAiPrompt || DEFAULT_ADMIN_AI_PROMPT,
      hasCustomPrompt: Boolean(updated.adminAiPrompt),
      model: updated.adminAiModel || DEFAULT_ADMIN_AI_MODEL
    };
  });

  app.get('/interview-ai', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const config = await loadConfigSafe(request);
    if (!config) {
      return {
        prompt: DEFAULT_INTERVIEW_AI_PROMPT,
        hasCustomPrompt: false,
        model: DEFAULT_INTERVIEW_AI_MODEL
      };
    }
    return {
      prompt: config.interviewAiPrompt || DEFAULT_INTERVIEW_AI_PROMPT,
      hasCustomPrompt: Boolean(config.interviewAiPrompt),
      model: config.interviewAiModel || DEFAULT_INTERVIEW_AI_MODEL
    };
  });

  app.put('/interview-ai', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const body = request.body as { prompt?: string | null; model?: string | null };
    const updated = await executeUpdate(reply, () =>
      updateInterviewAiConfig({
        prompt: typeof body?.prompt === 'undefined' ? undefined : body.prompt,
        model: typeof body?.model === 'undefined' ? undefined : body.model
      })
    );
    if (!updated) return;
    return {
      prompt: updated.interviewAiPrompt || DEFAULT_INTERVIEW_AI_PROMPT,
      hasCustomPrompt: Boolean(updated.interviewAiPrompt),
      model: updated.interviewAiModel || DEFAULT_INTERVIEW_AI_MODEL
    };
  });

  app.get('/interview-schedule', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const config = await loadConfigSafe(request);
    if (!config) {
      return interviewScheduleDefaults;
    }

    return {
      interviewTimezone: config.interviewTimezone || DEFAULT_INTERVIEW_TIMEZONE,
      interviewSlotMinutes: config.interviewSlotMinutes || DEFAULT_INTERVIEW_SLOT_MINUTES,
      interviewWeeklyAvailability: config.interviewWeeklyAvailability || DEFAULT_INTERVIEW_WEEKLY_AVAILABILITY,
      interviewExceptions: config.interviewExceptions || DEFAULT_INTERVIEW_EXCEPTIONS,
      interviewLocations: config.interviewLocations || DEFAULT_INTERVIEW_LOCATIONS
    };
  });

  app.put('/interview-schedule', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as {
      interviewTimezone?: string | null;
      interviewSlotMinutes?: number | null;
      interviewWeeklyAvailability?: string | null;
      interviewExceptions?: string | null;
      interviewLocations?: string | null;
    };

    const updated = await executeUpdate(reply, () =>
      updateInterviewScheduleConfig({
        interviewTimezone:
          typeof body?.interviewTimezone === 'undefined' ? undefined : body.interviewTimezone,
        interviewSlotMinutes:
          typeof body?.interviewSlotMinutes === 'undefined' ? undefined : body.interviewSlotMinutes,
        interviewWeeklyAvailability:
          typeof body?.interviewWeeklyAvailability === 'undefined' ? undefined : body.interviewWeeklyAvailability,
        interviewExceptions:
          typeof body?.interviewExceptions === 'undefined' ? undefined : body.interviewExceptions,
        interviewLocations:
          typeof body?.interviewLocations === 'undefined' ? undefined : body.interviewLocations
      })
    );
    if (!updated) return;

    return {
      interviewTimezone: updated.interviewTimezone || DEFAULT_INTERVIEW_TIMEZONE,
      interviewSlotMinutes: updated.interviewSlotMinutes || DEFAULT_INTERVIEW_SLOT_MINUTES,
      interviewWeeklyAvailability: updated.interviewWeeklyAvailability || DEFAULT_INTERVIEW_WEEKLY_AVAILABILITY,
      interviewExceptions: updated.interviewExceptions || DEFAULT_INTERVIEW_EXCEPTIONS,
      interviewLocations: updated.interviewLocations || DEFAULT_INTERVIEW_LOCATIONS
    };
  });

  app.get('/templates', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const config = await loadConfigSafe(request);
    if (!config) {
      return templatesDefaults;
    }
    return {
      templateInterviewInvite: config.templateInterviewInvite || DEFAULT_TEMPLATE_INTERVIEW_INVITE,
      templateGeneralFollowup: config.templateGeneralFollowup || DEFAULT_TEMPLATE_GENERAL_FOLLOWUP,
      templateLanguageCode: config.templateLanguageCode || DEFAULT_TEMPLATE_LANGUAGE_CODE,
      defaultJobTitle: config.defaultJobTitle || DEFAULT_JOB_TITLE,
      defaultInterviewDay: config.defaultInterviewDay || DEFAULT_INTERVIEW_DAY,
      defaultInterviewTime: config.defaultInterviewTime || DEFAULT_INTERVIEW_TIME,
      defaultInterviewLocation: config.defaultInterviewLocation || DEFAULT_INTERVIEW_LOCATION,
      testPhoneNumber:
        typeof config.testPhoneNumber !== 'undefined'
          ? config.testPhoneNumber
          : DEFAULT_TEST_PHONE_NUMBER
    };
  });

  app.put('/templates', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const body = request.body as {
      templateInterviewInvite?: string | null;
      templateGeneralFollowup?: string | null;
      templateLanguageCode?: string | null;
      defaultJobTitle?: string | null;
      defaultInterviewDay?: string | null;
      defaultInterviewTime?: string | null;
      defaultInterviewLocation?: string | null;
      testPhoneNumber?: string | null;
    };
    const updated = await executeUpdate(reply, () =>
      updateTemplateConfig({
        templateInterviewInvite:
          typeof body?.templateInterviewInvite === 'undefined' ? undefined : body.templateInterviewInvite,
        templateGeneralFollowup:
          typeof body?.templateGeneralFollowup === 'undefined' ? undefined : body.templateGeneralFollowup,
        templateLanguageCode:
          typeof body?.templateLanguageCode === 'undefined' ? undefined : body.templateLanguageCode,
        defaultJobTitle: typeof body?.defaultJobTitle === 'undefined' ? undefined : body.defaultJobTitle,
        defaultInterviewDay:
          typeof body?.defaultInterviewDay === 'undefined' ? undefined : body.defaultInterviewDay,
        defaultInterviewTime:
          typeof body?.defaultInterviewTime === 'undefined' ? undefined : body.defaultInterviewTime,
        defaultInterviewLocation:
          typeof body?.defaultInterviewLocation === 'undefined' ? undefined : body.defaultInterviewLocation,
        testPhoneNumber: typeof body?.testPhoneNumber === 'undefined' ? undefined : body.testPhoneNumber
      })
    );
    if (!updated) return;
    return {
      templateInterviewInvite: updated.templateInterviewInvite || DEFAULT_TEMPLATE_INTERVIEW_INVITE,
      templateGeneralFollowup: updated.templateGeneralFollowup || DEFAULT_TEMPLATE_GENERAL_FOLLOWUP,
      templateLanguageCode: updated.templateLanguageCode || DEFAULT_TEMPLATE_LANGUAGE_CODE,
      defaultJobTitle: updated.defaultJobTitle || DEFAULT_JOB_TITLE,
      defaultInterviewDay: updated.defaultInterviewDay || DEFAULT_INTERVIEW_DAY,
      defaultInterviewTime: updated.defaultInterviewTime || DEFAULT_INTERVIEW_TIME,
      defaultInterviewLocation: updated.defaultInterviewLocation || DEFAULT_INTERVIEW_LOCATION,
      testPhoneNumber:
        typeof updated.testPhoneNumber !== 'undefined'
          ? updated.testPhoneNumber
          : DEFAULT_TEST_PHONE_NUMBER
    };
  });

  app.post('/templates/test-send', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const config = await getSystemConfig();
    const targetAdmin = normalizeWhatsAppId(config.adminWaId);
    const targetTest = normalizeWhatsAppId(config.testPhoneNumber);
    const whitelist = [targetAdmin, targetTest].filter(Boolean) as string[];
    const targetWaId = targetTest || targetAdmin;
    if (!targetWaId || whitelist.length === 0) {
      return reply
        .code(400)
        .send({ error: 'Configura un número de admin o testPhoneNumber para enviar la prueba.' });
    }

    const templateName = config.templateGeneralFollowup || DEFAULT_TEMPLATE_GENERAL_FOLLOWUP;
    const variables = [config.defaultJobTitle || DEFAULT_JOB_TITLE];

    if (!whitelist.includes(normalizeWhatsAppId(targetWaId)!)) {
      return reply.code(403).send({ error: 'Número destino no permitido para pruebas' });
    }

    const sendResult = await sendWhatsAppTemplate(targetWaId, templateName, variables);
    if (!sendResult.success) {
      return reply.code(502).send({ error: sendResult.error || 'Falló el envío de prueba' });
    }

    // Log conversation for traceability
    const contact = await prisma.contact.upsert({
      where: { waId: targetWaId },
      update: { phone: targetWaId },
      create: { waId: targetWaId, phone: targetWaId }
    });
    let conversation = await prisma.conversation.findFirst({
      where: { contactId: contact.id, isAdmin: false },
      orderBy: { updatedAt: 'desc' }
    });
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          contactId: contact.id,
          status: 'NEW',
          channel: 'whatsapp',
          aiMode: 'RECRUIT'
        }
      });
    }
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'OUTBOUND',
        text: `[TEST TEMPLATE] ${templateName}`,
        rawPayload: serializeJson({
          template: templateName,
          variables,
          sendResult,
          test: true
        }),
        timestamp: new Date(),
        read: true
      }
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() }
    });

    return { success: true, sendResult };
  });

  app.put('/admin-account', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as { email?: string; password?: string };
    if (!body.email || !body.password) {
      return reply.code(400).send({ error: 'Email y password son obligatorios' });
    }

    const passwordHash = await hashPassword(body.password);
    const updated = await executeUpdate(reply, () => updateAdminAccount(body.email!, passwordHash));
    if (!updated) return;

    return {
      adminEmail: updated.adminEmail
    };
  });

  app.get('/admin-account', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const config = await loadConfigSafe(request);
    if (!config) {
      return {
        adminEmail: null
      };
    }
    return {
      adminEmail: config.adminEmail
    };
  });

  app.post('/reset-test-conversation', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const config = await getSystemConfig();
    const waId = normalizeWhatsAppId(config.testPhoneNumber || '');
    if (!waId) {
      return reply.code(400).send({ error: 'Configura primero el Número de pruebas.' });
    }
    try {
      const dbPath = path.resolve(__dirname, '../../../dev.db');
      const backupName = `dev-backup-${new Date()
        .toISOString()
        .replace(/[-:T]/g, '')
        .slice(0, 14)}-testreset.db`;
      const backupPath = path.join(path.dirname(dbPath), backupName);
      await fs.copyFile(dbPath, backupPath);
    } catch (err) {
      request.log.error({ err }, 'No se pudo hacer backup antes de reset de pruebas');
      return reply.code(500).send({ error: 'No se pudo hacer backup de la base de datos' });
    }

    try {
      const contact = await prisma.contact.findFirst({
        where: {
          OR: [{ waId }, { phone: waId }]
        }
      });
      if (!contact) {
        return { success: true, message: 'No existe conversación de pruebas para limpiar.' };
      }
      const conversations = await prisma.conversation.findMany({
        where: { contactId: contact.id, isAdmin: false },
        select: { id: true }
      });
      const ids = conversations.map(c => c.id);
      await prisma.$transaction([
        prisma.message.deleteMany({ where: { conversationId: { in: ids } } }),
        prisma.conversation.deleteMany({ where: { id: { in: ids } } }),
        prisma.contact.update({
          where: { id: contact.id },
          data: {
            candidateName: null,
            name: null,
            displayName: null,
            updatedAt: new Date()
          }
        })
      ]);
      return { success: true, message: 'Conversación de prueba reseteada.' };
    } catch (err) {
      request.log.error({ err }, 'Reset de conversación de pruebas falló');
      return reply.code(500).send({ error: 'No se pudo resetear la conversación de prueba' });
    }
  });
}

function isAdmin(request: any): boolean {
  return request.user?.role === 'ADMIN';
}
