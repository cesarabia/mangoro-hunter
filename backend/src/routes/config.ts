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
  getDefaultOutboundPolicy,
  getOutboundAllowlist,
  getOutboundPolicy,
  getEffectiveOutboundAllowlist,
  updateOutboundSafetyConfig,
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
  updateWorkflowConfig,
  updateAuthorizedNumbersConfig,
  DEFAULT_RECRUIT_JOB_SHEET,
  DEFAULT_RECRUIT_FAQ,
  getAdminWaIdAllowlist,
  getTestWaIdAllowlist
} from '../services/configService';
import { hashPassword } from '../services/passwordService';
import { DEFAULT_AI_PROMPT } from '../constants/ai';
import { buildWaIdCandidates, normalizeWhatsAppId } from '../utils/whatsapp';
import { prisma } from '../db/client';
import { sendWhatsAppTemplate } from '../services/whatsappMessageService';
import { serializeJson } from '../utils/json';
import { archiveConversation } from '../services/conversationArchiveService';
import {
  DEFAULT_WORKFLOW_ARCHIVE_DAYS,
  DEFAULT_WORKFLOW_INACTIVITY_DAYS,
  DEFAULT_WORKFLOW_RULES
} from '../services/workflowService';
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
    if (!Array.isArray(parsed)) {
      return 'Ubicaciones debe ser un JSON array (ej: ["Providencia"] o [{"label":"Providencia","exactAddress":"..."}]).';
    }
    const normalized: string[] = [];
    for (const item of parsed) {
      if (typeof item === 'string') {
        const label = item.trim();
        if (!label) continue;
        normalized.push(label);
        continue;
      }
      if (item && typeof item === 'object') {
        const labelRaw = typeof (item as any).label === 'string' ? String((item as any).label).trim() : '';
        if (!labelRaw) return 'Cada ubicación debe tener "label" (string).';
        normalized.push(labelRaw);
        continue;
      }
      return 'Ubicación inválida: usa strings o objects {label, exactAddress?, instructions?}.';
    }
    if (normalized.length === 0) return 'Define al menos 1 ubicación.';
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

  app.get('/authorized-numbers', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const config = await loadConfigSafe(request);
    if (!config) {
      return { adminNumbers: [], testNumbers: [] };
    }
    return {
      adminNumbers: getAdminWaIdAllowlist(config),
      testNumbers: getTestWaIdAllowlist(config)
    };
  });

  app.put('/authorized-numbers', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as { adminNumbers?: string[] | null; testNumbers?: string[] | null };

    const normalizeList = (raw?: string[] | null) => {
      if (!Array.isArray(raw)) return null;
      const out: string[] = [];
      for (const value of raw) {
        const waId = normalizeWhatsAppId(value);
        if (!waId) continue;
        if (!out.includes(waId)) out.push(waId);
      }
      return out;
    };

    const adminNumbers = typeof body?.adminNumbers === 'undefined' ? undefined : normalizeList(body.adminNumbers);
    const testNumbers = typeof body?.testNumbers === 'undefined' ? undefined : normalizeList(body.testNumbers);

    if (adminNumbers !== undefined && adminNumbers !== null && adminNumbers.length === 0) {
      return reply.code(400).send({ error: 'Define al menos 1 admin number válido.' });
    }

    const updated = await executeUpdate(reply, () =>
      updateAuthorizedNumbersConfig({
        adminNumbers: adminNumbers === undefined ? undefined : adminNumbers,
        testNumbers: testNumbers === undefined ? undefined : testNumbers
      })
    );
    if (!updated) return;

    return {
      adminNumbers: getAdminWaIdAllowlist(updated),
      testNumbers: getTestWaIdAllowlist(updated)
    };
  });

  app.get('/outbound-safety', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const config = await loadConfigSafe(request);
    if (!config) {
      return {
        outboundPolicy: getDefaultOutboundPolicy(),
        outboundPolicyStored: null,
        defaultPolicy: getDefaultOutboundPolicy(),
        outboundAllowlist: [],
        effectiveAllowlist: [],
        adminNumbers: [],
        testNumbers: []
      };
    }
    return {
      outboundPolicy: getOutboundPolicy(config),
      outboundPolicyStored: (config as any).outboundPolicy || null,
      defaultPolicy: getDefaultOutboundPolicy(),
      outboundAllowlist: getOutboundAllowlist(config),
      effectiveAllowlist: getEffectiveOutboundAllowlist(config),
      adminNumbers: getAdminWaIdAllowlist(config),
      testNumbers: getTestWaIdAllowlist(config)
    };
  });

  app.put('/outbound-safety', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as {
      outboundPolicy?: string | null;
      outboundAllowlist?: string[] | null;
    };

    const normalizePolicy = (raw: unknown) => {
      if (raw === null) return null;
      if (typeof raw !== 'string') return undefined;
      const upper = raw.trim().toUpperCase();
      if (!upper) return null;
      if (upper === 'ALLOW_ALL' || upper === 'ALLOWLIST_ONLY' || upper === 'BLOCK_ALL') return upper;
      return undefined;
    };

    const outboundPolicy = typeof body?.outboundPolicy === 'undefined' ? undefined : normalizePolicy(body.outboundPolicy);
    if (typeof body?.outboundPolicy !== 'undefined' && typeof outboundPolicy === 'undefined') {
      return reply.code(400).send({ error: 'outboundPolicy inválido (ALLOW_ALL | ALLOWLIST_ONLY | BLOCK_ALL).' });
    }
    if (outboundPolicy === 'ALLOW_ALL' && getDefaultOutboundPolicy() !== 'ALLOW_ALL') {
      return reply.code(400).send({ error: 'En DEV no se permite ALLOW_ALL. Usa ALLOWLIST_ONLY.' });
    }

    const allowlist = typeof body?.outboundAllowlist === 'undefined' ? undefined : body.outboundAllowlist;

    const updated = await executeUpdate(reply, () =>
      updateOutboundSafetyConfig({
        outboundPolicy: outboundPolicy as any,
        outboundAllowlist: allowlist as any,
      }),
    );
    if (!updated) return;

    return {
      outboundPolicy: getOutboundPolicy(updated),
      outboundPolicyStored: (updated as any).outboundPolicy || null,
      defaultPolicy: getDefaultOutboundPolicy(),
      outboundAllowlist: getOutboundAllowlist(updated),
      effectiveAllowlist: getEffectiveOutboundAllowlist(updated),
      adminNumbers: getAdminWaIdAllowlist(updated),
      testNumbers: getTestWaIdAllowlist(updated)
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
    const templatesDefault = JSON.parse(DEFAULT_ADMIN_NOTIFICATION_TEMPLATES);
    let templatesCustom: any = null;
    try {
      templatesCustom = config?.adminNotificationTemplates ? JSON.parse(config.adminNotificationTemplates) : null;
    } catch {
      templatesCustom = null;
    }
    const templates =
      templatesCustom && typeof templatesCustom === 'object' && !Array.isArray(templatesCustom)
        ? { ...templatesDefault, ...templatesCustom }
        : templatesDefault;

    let enabledEventsParsed: any = null;
    try {
      enabledEventsParsed = config?.adminNotificationEnabledEvents ? JSON.parse(config.adminNotificationEnabledEvents) : null;
    } catch {
      enabledEventsParsed = null;
    }
    const allEvents = Object.keys(templates);
    const enabledEvents =
      Array.isArray(enabledEventsParsed) && enabledEventsParsed.length > 0
        ? enabledEventsParsed.map((v: any) => String(v)).filter(Boolean)
        : allEvents;

    let detailLevelsParsed: any = null;
    try {
      detailLevelsParsed = config?.adminNotificationDetailLevelsByEvent ? JSON.parse(config.adminNotificationDetailLevelsByEvent) : null;
    } catch {
      detailLevelsParsed = null;
    }
    const detailLevelsByEvent =
      detailLevelsParsed && typeof detailLevelsParsed === 'object' && !Array.isArray(detailLevelsParsed)
        ? detailLevelsParsed
        : {};

    return {
      detailLevel: config?.adminNotificationDetailLevel || DEFAULT_ADMIN_NOTIFICATION_DETAIL_LEVEL,
      templates,
      enabledEvents,
      detailLevelsByEvent
    };
  });

  app.put('/admin-notifications', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as {
      detailLevel?: string | null;
      templates?: any;
      enabledEvents?: string[] | null;
      detailLevelsByEvent?: any;
    };
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

    const knownEventTypes = new Set(Object.keys(JSON.parse(DEFAULT_ADMIN_NOTIFICATION_TEMPLATES)));
    if (typeof body?.enabledEvents !== 'undefined' && body.enabledEvents !== null) {
      if (!Array.isArray(body.enabledEvents)) {
        return reply.code(400).send({ error: 'enabledEvents debe ser array (o null).' });
      }
      for (const value of body.enabledEvents) {
        if (typeof value !== 'string' || !knownEventTypes.has(value)) {
          return reply.code(400).send({ error: `Evento inválido en enabledEvents: ${String(value)}` });
        }
      }
    }

    if (typeof body?.detailLevelsByEvent !== 'undefined' && body.detailLevelsByEvent !== null) {
      if (!body.detailLevelsByEvent || typeof body.detailLevelsByEvent !== 'object' || Array.isArray(body.detailLevelsByEvent)) {
        return reply.code(400).send({ error: 'detailLevelsByEvent debe ser un objeto JSON (evento -> nivel) o null.' });
      }
      for (const [eventType, levelRaw] of Object.entries(body.detailLevelsByEvent)) {
        if (!knownEventTypes.has(eventType)) {
          return reply.code(400).send({ error: `Evento inválido en detailLevelsByEvent: ${eventType}` });
        }
        if (typeof levelRaw !== 'string' || !allowedLevels.has(levelRaw.trim().toUpperCase())) {
          return reply.code(400).send({ error: `Nivel inválido para ${eventType}. Usa SHORT, MEDIUM o DETAILED.` });
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
        ,
        enabledEvents:
          typeof body?.enabledEvents === 'undefined'
            ? undefined
            : body.enabledEvents === null
              ? null
              : serializeJson(body.enabledEvents),
        detailLevelsByEvent:
          typeof body?.detailLevelsByEvent === 'undefined'
            ? undefined
            : body.detailLevelsByEvent === null
              ? null
              : serializeJson(body.detailLevelsByEvent)
      })
    );
    if (!updated) return;

    const fresh = await getSystemConfig();
    const templatesDefault = JSON.parse(DEFAULT_ADMIN_NOTIFICATION_TEMPLATES);
    let templatesCustom: any = null;
    try {
      templatesCustom = fresh.adminNotificationTemplates ? JSON.parse(fresh.adminNotificationTemplates) : null;
    } catch {
      templatesCustom = null;
    }
    const templates =
      templatesCustom && typeof templatesCustom === 'object' && !Array.isArray(templatesCustom)
        ? { ...templatesDefault, ...templatesCustom }
        : templatesDefault;

    let enabledEventsParsed: any = null;
    try {
      enabledEventsParsed = fresh.adminNotificationEnabledEvents ? JSON.parse(fresh.adminNotificationEnabledEvents) : null;
    } catch {
      enabledEventsParsed = null;
    }
    const allEvents = Object.keys(templates);
    const enabledEvents =
      Array.isArray(enabledEventsParsed) && enabledEventsParsed.length > 0
        ? enabledEventsParsed.map((v: any) => String(v)).filter(Boolean)
        : allEvents;

    let detailLevelsParsed: any = null;
    try {
      detailLevelsParsed = fresh.adminNotificationDetailLevelsByEvent ? JSON.parse(fresh.adminNotificationDetailLevelsByEvent) : null;
    } catch {
      detailLevelsParsed = null;
    }
    const detailLevelsByEvent =
      detailLevelsParsed && typeof detailLevelsParsed === 'object' && !Array.isArray(detailLevelsParsed)
        ? detailLevelsParsed
        : {};

    return {
      detailLevel: fresh.adminNotificationDetailLevel || DEFAULT_ADMIN_NOTIFICATION_DETAIL_LEVEL,
      templates,
      enabledEvents,
      detailLevelsByEvent
    };
  });

  app.get('/workflow', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const config = await loadConfigSafe(request);
    const inactivityDays =
      typeof config?.workflowInactivityDays === 'number' ? config.workflowInactivityDays : DEFAULT_WORKFLOW_INACTIVITY_DAYS;
    const archiveDays =
      typeof config?.workflowArchiveDays === 'number' ? config.workflowArchiveDays : DEFAULT_WORKFLOW_ARCHIVE_DAYS;

    let rules: any = null;
    try {
      rules = config?.workflowRules ? JSON.parse(config.workflowRules) : null;
    } catch {
      rules = null;
    }
    if (!Array.isArray(rules)) {
      rules = DEFAULT_WORKFLOW_RULES;
    }

    return {
      inactivityDays,
      archiveDays,
      rules
    };
  });

  app.put('/workflow', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const body = request.body as { inactivityDays?: number | null; archiveDays?: number | null; rules?: any };

    const validateDays = (value: any, label: string, max: number) => {
      if (value === null) return;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label} debe ser número o null.`);
      }
      const int = Math.floor(value);
      if (int < 1 || int > max) throw new Error(`${label} fuera de rango (1-${max}).`);
    };

    try {
      if (typeof body?.inactivityDays !== 'undefined') validateDays(body.inactivityDays, 'inactivityDays', 365);
      if (typeof body?.archiveDays !== 'undefined') validateDays(body.archiveDays, 'archiveDays', 3650);
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message || 'Valores inválidos' });
    }

    if (typeof body?.rules !== 'undefined') {
      if (!Array.isArray(body.rules)) {
        return reply.code(400).send({ error: 'rules debe ser un JSON array.' });
      }
      for (const rule of body.rules) {
        if (!rule || typeof rule !== 'object') {
          return reply.code(400).send({ error: 'Cada regla debe ser un objeto.' });
        }
        if (typeof (rule as any).id !== 'string' || !(rule as any).id.trim()) {
          return reply.code(400).send({ error: 'Cada regla debe tener id (string).' });
        }
        const trigger = (rule as any).trigger;
        if (trigger !== 'onRecruitDataUpdated' && trigger !== 'onInactivity') {
          return reply.code(400).send({ error: `Trigger inválido: ${String(trigger)}` });
        }
      }
    }

    const updated = await executeUpdate(reply, () =>
      updateWorkflowConfig({
        inactivityDays: typeof body?.inactivityDays === 'undefined' ? undefined : body.inactivityDays,
        archiveDays: typeof body?.archiveDays === 'undefined' ? undefined : body.archiveDays,
        rules: typeof body?.rules === 'undefined' ? undefined : serializeJson(body.rules)
      })
    );
    if (!updated) return;

    const fresh = await getSystemConfig();
    let rules: any = null;
    try {
      rules = fresh.workflowRules ? JSON.parse(fresh.workflowRules) : null;
    } catch {
      rules = null;
    }
    if (!Array.isArray(rules)) rules = DEFAULT_WORKFLOW_RULES;

    return {
      inactivityDays:
        typeof fresh.workflowInactivityDays === 'number' ? fresh.workflowInactivityDays : DEFAULT_WORKFLOW_INACTIVITY_DAYS,
      archiveDays:
        typeof fresh.workflowArchiveDays === 'number' ? fresh.workflowArchiveDays : DEFAULT_WORKFLOW_ARCHIVE_DAYS,
      rules
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
    const testWaIds = getTestWaIdAllowlist(config);
    const adminWaIds = getAdminWaIdAllowlist(config);
    const whitelist = [...testWaIds, ...adminWaIds].filter(Boolean) as string[];
    const targetWaId = testWaIds[0] || null;
    if (!targetWaId || whitelist.length === 0) {
      return reply
        .code(400)
        .send({ error: 'Configura al menos 1 test number para enviar la prueba.' });
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
        select: { id: true },
        orderBy: { updatedAt: 'desc' }
      });
      const ids = conversations.map(c => c.id);
      for (const id of ids) {
        await archiveConversation({
          conversationId: id,
          reason: 'TEST_RESET',
          tags: ['TEST'],
          summary: 'Reset de pruebas (historial preservado).'
        });
      }
      await prisma.contact.update({
        where: { id: contact.id },
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
      });
      const newConversation = await prisma.conversation.create({
        data: {
          contactId: contact.id,
          status: 'NEW',
          channel: 'whatsapp',
          aiMode: 'RECRUIT'
        }
      });
      return {
        success: true,
        message: 'Conversación de prueba archivada y reiniciada (sin borrar historial).',
        archived: ids.length,
        conversationId: newConversation.id
      };
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
        results.cleaned[label] = { contactsFound: 0, mergedContacts: 0, conversationsArchived: 0 };
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
            await tx.contact.update({
              where: { id: secId },
              data: {
                waId: null,
                phone: null,
                mergedIntoContactId: primary.id,
                mergedAt: new Date(),
                mergedReason: 'TEST_CLEANUP_DEDUPE',
                archivedAt: new Date()
              }
            });
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

      const conversationsToArchive = await prisma.conversation.findMany({
        where: { contactId: primary.id, isAdmin: false },
        select: { id: true }
      });
      const convoIds = conversationsToArchive.map(c => c.id);

      for (const convoId of convoIds) {
        await archiveConversation({
          conversationId: convoId,
          reason: 'TEST_CLEANUP',
          tags: ['TEST', label.toUpperCase()],
          summary: 'Limpieza de pruebas (historial preservado).'
        });
      }
      // Make sure pending reservations don't keep blocking slots on reruns.
      if (convoIds.length > 0) {
        await prisma.interviewReservation.updateMany({
          where: { conversationId: { in: convoIds }, activeKey: 'ACTIVE' },
          data: { status: 'CANCELLED', activeKey: null }
        }).catch(() => {});
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
        const existingActive = await prisma.conversation.findFirst({
          where: { contactId: primary.id, isAdmin: false, conversationStage: { not: 'ARCHIVED' } },
          orderBy: { updatedAt: 'desc' },
          select: { id: true }
        });
        if (!existingActive) {
          await prisma.conversation.create({
            data: {
              contactId: primary.id,
              status: 'NEW',
              channel: 'whatsapp',
              aiMode: 'RECRUIT'
            }
          }).catch(() => {});
        }
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
          for (const convoId of remove) {
            await archiveConversation({
              conversationId: convoId,
              reason: 'ADMIN_DEDUPE',
              tags: ['ADMIN', 'TEST'],
              summary: 'Conversación admin duplicada (archivada).'
            });
          }
          await prisma.conversation.update({
            where: { id: keep.id },
            data: { aiMode: 'OFF', status: 'OPEN', updatedAt: new Date() }
          }).catch(() => {});
        }
      }

      results.cleaned[label] = {
        contactsFound: contacts.length,
        mergedContacts,
        conversationsArchived: convoIds.length
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
        for (const convoId of ids) {
          await archiveConversation({
            conversationId: convoId,
            reason: 'SIMULATED_CLEANUP',
            tags: ['TEST', 'SIMULATED'],
            summary: 'Conversación simulada (archivada).'
          });
        }
        await prisma.interviewReservation.updateMany({
          where: { conversationId: { in: ids }, activeKey: 'ACTIVE' },
          data: { status: 'CANCELLED', activeKey: null }
        }).catch(() => {});
        results.cleaned.simulated = { conversationsArchived: ids.length };
      } else {
        results.cleaned.simulated = { conversationsArchived: 0 };
      }
    } catch (err) {
      request.log.warn({ err }, 'Cleanup simulated conversations failed');
      results.cleaned.simulated = { error: 'failed' };
    }

    // Remove agenda blocks created for tests (no candidate involved).
    try {
      const blocksRes = await prisma.interviewSlotBlock.updateMany({
        where: { tag: { startsWith: 'TEST' }, archivedAt: null },
        data: { archivedAt: new Date() }
      });
      results.cleaned.blocks = { blocksArchived: blocksRes.count };
    } catch (err) {
      request.log.warn({ err }, 'Cleanup slot blocks failed');
      results.cleaned.blocks = { error: 'failed' };
    }

    // Report orphan contacts, but do not delete anything (retain evidence).
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

      results.cleaned.orphanContacts = {
        contactsFound: orphanContacts.length
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
