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
  DEFAULT_SALES_AI_PROMPT,
  DEFAULT_SALES_KNOWLEDGE_BASE,
  DEFAULT_ADMIN_NOTIFICATION_DETAIL_LEVEL,
  DEFAULT_ADMIN_NOTIFICATION_TEMPLATES,
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
  updateSalesAiConfig,
  updateAiModel,
  updateRecruitmentContent,
  updateAdminNotificationConfig,
  DEFAULT_RECRUIT_JOB_SHEET,
  DEFAULT_RECRUIT_FAQ
} from '../services/configService';
import { hashPassword } from '../services/passwordService';
import { DEFAULT_AI_PROMPT } from '../constants/ai';
import { buildWaIdCandidates, normalizeWhatsAppId } from '../utils/whatsapp';
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

  const salesAiDefaults = {
    prompt: DEFAULT_SALES_AI_PROMPT,
    knowledgeBase: DEFAULT_SALES_KNOWLEDGE_BASE
  };

  const isValidTime = (value: string): boolean => {
    const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return false;
    const hh = parseInt(match[1], 10);
    const mm = parseInt(match[2], 10);
    return Number.isFinite(hh) && Number.isFinite(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
  };

  const parseJsonSafe = (value: string): any => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const validateLocationsJson = (value: string): string | null => {
    const parsed = parseJsonSafe(value);
    if (!Array.isArray(parsed)) return 'Ubicaciones debe ser un JSON array (ej: ["Providencia","Online"]).';
    const locations = parsed.filter((item: any) => typeof item === 'string' && item.trim().length > 0);
    if (locations.length === 0) return 'Define al menos 1 ubicación.';
    return null;
  };

  const validateWeeklyAvailabilityJson = (value: string): string | null => {
    const parsed = parseJsonSafe(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'Disponibilidad semanal debe ser un JSON object (ej: {"lunes":[{"start":"09:00","end":"18:00"}]}).';
    }
    for (const [day, intervals] of Object.entries(parsed as Record<string, any>)) {
      if (!Array.isArray(intervals)) {
        return `Disponibilidad de "${day}" debe ser un array de intervalos.`;
      }
      for (const interval of intervals) {
        if (!interval || typeof interval !== 'object') return `Intervalo inválido en "${day}".`;
        const start = interval.start;
        const end = interval.end;
        if (typeof start !== 'string' || typeof end !== 'string') {
          return `Intervalo inválido en "${day}" (usa {"start":"HH:MM","end":"HH:MM"}).`;
        }
        if (!isValidTime(start) || !isValidTime(end)) {
          return `Hora inválida en "${day}" (usa HH:MM).`;
        }
        const [sh, sm] = start.split(':').map(n => parseInt(n, 10));
        const [eh, em] = end.split(':').map(n => parseInt(n, 10));
        const startM = sh * 60 + sm;
        const endM = eh * 60 + em;
        if (startM >= endM) return `Intervalo inválido en "${day}" (start debe ser menor que end).`;
      }
    }
    return null;
  };

  const validateExceptionsJson = (value: string): string | null => {
    const parsed = parseJsonSafe(value);
    if (!Array.isArray(parsed)) return 'Excepciones debe ser un JSON array (ej: ["2025-12-25"]).';
    for (const entry of parsed) {
      const date =
        typeof entry === 'string' ? entry.trim() : entry && typeof entry === 'object' ? String((entry as any).date || '').trim() : '';
      if (!date) return 'Excepción inválida (usa "YYYY-MM-DD" o {"date":"YYYY-MM-DD"}).';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return `Fecha inválida en excepciones: "${date}".`;
    }
    return null;
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
        aiModel: DEFAULT_AI_MODEL,
        jobSheet: DEFAULT_RECRUIT_JOB_SHEET,
        faq: DEFAULT_RECRUIT_FAQ
      };
    }
    return {
      aiPrompt: config.aiPrompt || DEFAULT_AI_PROMPT,
      aiModel: config.aiModel || DEFAULT_AI_MODEL,
      jobSheet: (config as any).recruitJobSheet || DEFAULT_RECRUIT_JOB_SHEET,
      faq: typeof (config as any).recruitFaq === 'string' ? (config as any).recruitFaq : DEFAULT_RECRUIT_FAQ
    };
  });

  app.put('/ai-prompt', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as { aiPrompt?: string | null; aiModel?: string | null; jobSheet?: string | null; faq?: string | null };
    const updated = await executeUpdate(reply, async () => {
      if (typeof body?.aiPrompt !== 'undefined') {
        await updateAiPrompt(body.aiPrompt ?? null);
      }
      if (typeof body?.aiModel !== 'undefined') {
        await updateAiModel(body.aiModel ?? null);
      }
      if (typeof body?.jobSheet !== 'undefined' || typeof body?.faq !== 'undefined') {
        await updateRecruitmentContent({
          jobSheet: typeof body?.jobSheet === 'undefined' ? undefined : body.jobSheet ?? null,
          faq: typeof body?.faq === 'undefined' ? undefined : body.faq ?? null
        });
      }
      return await getSystemConfig();
    });
    if (!updated) return;
    const fresh = await getSystemConfig();
    return {
      aiPrompt: fresh.aiPrompt || DEFAULT_AI_PROMPT,
      aiModel: fresh.aiModel || DEFAULT_AI_MODEL,
      jobSheet: (fresh as any).recruitJobSheet || DEFAULT_RECRUIT_JOB_SHEET,
      faq: typeof (fresh as any).recruitFaq === 'string' ? (fresh as any).recruitFaq : DEFAULT_RECRUIT_FAQ
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

  app.get('/sales-ai', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const config = await loadConfigSafe(request);
    if (!config) {
      return { ...salesAiDefaults, hasCustomPrompt: false, hasCustomKnowledgeBase: false };
    }
    return {
      prompt: config.salesAiPrompt || DEFAULT_SALES_AI_PROMPT,
      knowledgeBase: config.salesKnowledgeBase || DEFAULT_SALES_KNOWLEDGE_BASE,
      hasCustomPrompt: Boolean(config.salesAiPrompt),
      hasCustomKnowledgeBase: Boolean(config.salesKnowledgeBase)
    };
  });

  app.put('/sales-ai', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const body = request.body as { prompt?: string | null; knowledgeBase?: string | null };
    const updated = await executeUpdate(reply, () =>
      updateSalesAiConfig({
        prompt: typeof body?.prompt === 'undefined' ? undefined : body.prompt,
        knowledgeBase: typeof body?.knowledgeBase === 'undefined' ? undefined : body.knowledgeBase
      })
    );
    if (!updated) return;
    return {
      prompt: updated.salesAiPrompt || DEFAULT_SALES_AI_PROMPT,
      knowledgeBase: updated.salesKnowledgeBase || DEFAULT_SALES_KNOWLEDGE_BASE,
      hasCustomPrompt: Boolean(updated.salesAiPrompt),
      hasCustomKnowledgeBase: Boolean(updated.salesKnowledgeBase)
    };
  });

  app.get('/admin-notifications', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const config = await loadConfigSafe(request);
    const templatesRaw = config?.adminNotificationTemplates || DEFAULT_ADMIN_NOTIFICATION_TEMPLATES;
    let templatesParsed: any = null;
    try {
      templatesParsed = JSON.parse(templatesRaw);
    } catch {
      templatesParsed = null;
    }
    const templates =
      templatesParsed && typeof templatesParsed === 'object' && !Array.isArray(templatesParsed)
        ? templatesParsed
        : JSON.parse(DEFAULT_ADMIN_NOTIFICATION_TEMPLATES);

    return {
      detailLevel: config?.adminNotificationDetailLevel || DEFAULT_ADMIN_NOTIFICATION_DETAIL_LEVEL,
      templates
    };
  });

  app.put('/admin-notifications', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as { detailLevel?: string | null; templates?: any };
    const allowedLevels = new Set(['SHORT', 'MEDIUM', 'DETAILED']);
    if (typeof body?.detailLevel === 'string') {
      const level = body.detailLevel.trim().toUpperCase();
      if (!allowedLevels.has(level)) {
        return reply.code(400).send({ error: 'Nivel inválido. Usa SHORT, MEDIUM o DETAILED.' });
      }
    }

    if (typeof body?.templates !== 'undefined') {
      if (!body.templates || typeof body.templates !== 'object' || Array.isArray(body.templates)) {
        return reply.code(400).send({ error: 'Templates debe ser un objeto JSON (clave -> texto).' });
      }
      for (const [key, value] of Object.entries(body.templates)) {
        if (typeof key !== 'string' || typeof value !== 'string') {
          return reply.code(400).send({ error: 'Templates inválidos: cada template debe ser un string.' });
        }
      }
    }

    const updated = await executeUpdate(reply, () =>
      updateAdminNotificationConfig({
        detailLevel:
          typeof body?.detailLevel === 'undefined'
            ? undefined
            : body.detailLevel
              ? body.detailLevel.trim().toUpperCase()
              : null,
        templates:
          typeof body?.templates === 'undefined'
            ? undefined
            : serializeJson(body.templates)
      })
    );
    if (!updated) return;

    const fresh = await getSystemConfig();
    let templatesParsed: any = null;
    try {
      templatesParsed = fresh.adminNotificationTemplates ? JSON.parse(fresh.adminNotificationTemplates) : null;
    } catch {
      templatesParsed = null;
    }
    const templates =
      templatesParsed && typeof templatesParsed === 'object' && !Array.isArray(templatesParsed)
        ? templatesParsed
        : JSON.parse(DEFAULT_ADMIN_NOTIFICATION_TEMPLATES);

    return {
      detailLevel: fresh.adminNotificationDetailLevel || DEFAULT_ADMIN_NOTIFICATION_DETAIL_LEVEL,
      templates
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

    if (typeof body?.interviewSlotMinutes === 'number') {
      const minutes = Math.floor(body.interviewSlotMinutes);
      if (!Number.isFinite(minutes) || minutes < 5 || minutes > 240) {
        return reply.code(400).send({ error: 'Duración de slot inválida (5–240 min).' });
      }
    }
    if (typeof body?.interviewTimezone === 'string') {
      const tz = body.interviewTimezone.trim();
      if (!tz) {
        return reply.code(400).send({ error: 'Timezone inválida.' });
      }
    }
    if (typeof body?.interviewLocations === 'string') {
      const err = validateLocationsJson(body.interviewLocations);
      if (err) return reply.code(400).send({ error: err });
    }
    if (typeof body?.interviewWeeklyAvailability === 'string') {
      const err = validateWeeklyAvailabilityJson(body.interviewWeeklyAvailability);
      if (err) return reply.code(400).send({ error: err });
    }
    if (typeof body?.interviewExceptions === 'string') {
      const err = validateExceptionsJson(body.interviewExceptions);
      if (err) return reply.code(400).send({ error: err });
    }

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

  app.post('/cleanup-test-data', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const config = await getSystemConfig();
    const testWaId = normalizeWhatsAppId(config.testPhoneNumber || '');
    const adminWaId = normalizeWhatsAppId(config.adminWaId || '');

    if (!testWaId && !adminWaId) {
      return reply.code(400).send({ error: 'Configura primero Número de pruebas y/o adminWaId.' });
    }

    try {
      const dbPath = path.resolve(__dirname, '../../../dev.db');
      const backupName = `dev-backup-${new Date()
        .toISOString()
        .replace(/[-:T]/g, '')
        .slice(0, 14)}-cleanup.db`;
      const backupPath = path.join(path.dirname(dbPath), backupName);
      await fs.copyFile(dbPath, backupPath);
    } catch (err) {
      request.log.error({ err }, 'No se pudo hacer backup antes de cleanup de pruebas');
      return reply.code(500).send({ error: 'No se pudo hacer backup de la base de datos' });
    }

    const results: any = { success: true, cleaned: {} as any };
    let primaryTestContactId: string | null = null;
    let primaryAdminContactId: string | null = null;

    const cleanupNumber = async (label: 'test' | 'admin', waIdRaw: string) => {
      const candidates = buildWaIdCandidates(waIdRaw);
      const contacts = await prisma.contact.findMany({
        where: {
          OR: [{ waId: { in: candidates } }, { phone: { in: candidates } }]
        },
        orderBy: { createdAt: 'asc' }
      });
      if (contacts.length === 0) {
        results.cleaned[label] = { contactsFound: 0, mergedContacts: 0, conversationsDeleted: 0, messagesDeleted: 0 };
        return;
      }
      const primary =
        contacts.find(c => normalizeWhatsAppId(c.waId || '') === waIdRaw) ||
        contacts.find(c => normalizeWhatsAppId(c.phone || '') === waIdRaw) ||
        contacts[0];
      if (label === 'test') primaryTestContactId = primary.id;
      if (label === 'admin') primaryAdminContactId = primary.id;
      const secondaryIds = contacts.filter(c => c.id !== primary.id).map(c => c.id);

      let mergedContacts = 0;
      if (secondaryIds.length > 0) {
        await prisma.$transaction(async tx => {
          for (const secId of secondaryIds) {
            await tx.conversation.updateMany({ where: { contactId: secId }, data: { contactId: primary.id } });
            await tx.application.updateMany({ where: { contactId: secId }, data: { contactId: primary.id } });
            await tx.interviewReservation.updateMany({ where: { contactId: secId }, data: { contactId: primary.id } });
            await tx.sellerEvent.updateMany({ where: { contactId: secId }, data: { contactId: primary.id } });
            await tx.contact.update({ where: { id: secId }, data: { waId: null, phone: null } });
            await tx.contact.delete({ where: { id: secId } });
            mergedContacts += 1;
          }
          await tx.contact.update({
            where: { id: primary.id },
            data: { waId: waIdRaw, phone: `+${waIdRaw}` }
          });
        });
      } else {
        await prisma.contact.update({
          where: { id: primary.id },
          data: { waId: waIdRaw, phone: `+${waIdRaw}` }
        }).catch(() => {});
      }

      const conversationsToDelete = await prisma.conversation.findMany({
        where: { contactId: primary.id, isAdmin: false },
        select: { id: true }
      });
      const convoIds = conversationsToDelete.map(c => c.id);

      let messagesDeleted = 0;
      let conversationsDeleted = 0;
      if (convoIds.length > 0) {
        const [messagesRes, reservationsRes, eventsRes, conversationsRes] = await prisma.$transaction([
          prisma.message.deleteMany({ where: { conversationId: { in: convoIds } } }),
          prisma.interviewReservation.deleteMany({ where: { conversationId: { in: convoIds } } }),
          prisma.sellerEvent.deleteMany({ where: { conversationId: { in: convoIds } } }),
          prisma.conversation.deleteMany({ where: { id: { in: convoIds } } })
        ]);
        messagesDeleted = messagesRes.count;
        conversationsDeleted = conversationsRes.count;
        void reservationsRes;
        void eventsRes;
      }

      if (label === 'test') {
        await prisma.contact.update({
          where: { id: primary.id },
          data: {
            candidateName: null,
            candidateNameManual: null,
            name: null,
            displayName: null,
            noContact: false,
            noContactAt: null,
            noContactReason: null,
            updatedAt: new Date()
          }
        }).catch(() => {});
      }
      if (label === 'admin') {
        await prisma.contact.update({
          where: { id: primary.id },
          data: {
            name: 'Administrador',
            candidateName: null,
            candidateNameManual: null,
            noContact: false,
            noContactAt: null,
            noContactReason: null,
            updatedAt: new Date()
          }
        }).catch(() => {});
        // Ensure at most 1 admin conversation exists
        const adminConversations = await prisma.conversation.findMany({
          where: { contactId: primary.id, isAdmin: true },
          orderBy: { updatedAt: 'desc' }
        });
        if (adminConversations.length > 1) {
          const keep = adminConversations[0];
          const remove = adminConversations.slice(1).map(c => c.id);
          await prisma.$transaction([
            prisma.message.deleteMany({ where: { conversationId: { in: remove } } }),
            prisma.conversation.deleteMany({ where: { id: { in: remove } } })
          ]);
          await prisma.conversation.update({
            where: { id: keep.id },
            data: { aiMode: 'OFF', status: 'OPEN', updatedAt: new Date() }
          }).catch(() => {});
        }
      }

      results.cleaned[label] = {
        contactsFound: contacts.length,
        mergedContacts,
        conversationsDeleted,
        messagesDeleted
      };
    };

    try {
      if (testWaId) await cleanupNumber('test', testWaId);
      if (adminWaId) await cleanupNumber('admin', adminWaId);
    } catch (err) {
      request.log.error({ err }, 'Cleanup test data failed');
      return reply.code(500).send({ error: 'No se pudo limpiar los datos de prueba' });
    }

    try {
      const simulated = await prisma.conversation.findMany({
        where: {
          isAdmin: false,
          messages: {
            some: { rawPayload: { contains: '"simulated":true' } }
          }
        },
        select: { id: true }
      });
      const ids = simulated.map(c => c.id);
      if (ids.length > 0) {
        const [messagesRes, reservationsRes, eventsRes, conversationsRes] = await prisma.$transaction([
          prisma.message.deleteMany({ where: { conversationId: { in: ids } } }),
          prisma.interviewReservation.deleteMany({ where: { conversationId: { in: ids } } }),
          prisma.sellerEvent.deleteMany({ where: { conversationId: { in: ids } } }),
          prisma.conversation.deleteMany({ where: { id: { in: ids } } })
        ]);
        results.cleaned.simulated = {
          conversationsDeleted: conversationsRes.count,
          messagesDeleted: messagesRes.count
        };
        void reservationsRes;
        void eventsRes;
      } else {
        results.cleaned.simulated = { conversationsDeleted: 0, messagesDeleted: 0 };
      }
    } catch (err) {
      request.log.warn({ err }, 'Cleanup simulated conversations failed');
      results.cleaned.simulated = { error: 'failed' };
    }

    // Remove agenda blocks created for tests (no candidate involved).
    try {
      const blocksRes = await prisma.interviewSlotBlock.deleteMany({
        where: { tag: { startsWith: 'TEST' } }
      });
      results.cleaned.blocks = { blocksDeleted: blocksRes.count };
    } catch (err) {
      request.log.warn({ err }, 'Cleanup slot blocks failed');
      results.cleaned.blocks = { error: 'failed' };
    }

    // Remove orphan contacts left behind by tests (no conversations/apps/reservations/events),
    // and remove their admin notifications from the admin conversation.
    try {
      const protectedIds: string[] = [];
      if (primaryTestContactId) protectedIds.push(primaryTestContactId);
      if (primaryAdminContactId) protectedIds.push(primaryAdminContactId);
      const orphanContacts = await prisma.contact.findMany({
        where: {
          ...(protectedIds.length > 0 ? { id: { notIn: protectedIds } } : {}),
          conversations: { none: {} },
          applications: { none: {} },
          interviewReservations: { none: {} },
          sellerEvents: { none: {} },
          OR: [{ waId: { not: null } }, { phone: { not: null } }]
        },
        select: { id: true, waId: true, phone: true }
      });

      const orphanIds = orphanContacts.map(c => c.id);
      let adminMessagesDeleted = 0;

      if (orphanIds.length > 0) {
        const adminConvos = await prisma.conversation.findMany({
          where: { isAdmin: true },
          select: { id: true }
        });
        const adminIds = adminConvos.map(c => c.id);
        if (adminIds.length > 0) {
          const adminRes = await prisma.message.deleteMany({
            where: {
              conversationId: { in: adminIds },
              OR: orphanIds.map(id => ({
                rawPayload: { contains: `"contactId":"${id}"` }
              }))
            }
          });
          adminMessagesDeleted = adminRes.count;
        }
      }

      const contactsDeleted = orphanIds.length > 0
        ? (await prisma.contact.deleteMany({ where: { id: { in: orphanIds } } })).count
        : 0;

      results.cleaned.orphanContacts = {
        contactsDeleted,
        adminMessagesDeleted
      };
    } catch (err) {
      request.log.warn({ err }, 'Cleanup orphan contacts failed');
      results.cleaned.orphanContacts = { error: 'failed' };
    }

    return results;
  });
}

function isAdmin(request: any): boolean {
  return request.user?.role === 'ADMIN';
}
