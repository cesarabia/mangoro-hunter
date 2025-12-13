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
  DEFAULT_INTERVIEW_AI_MODEL
} from '../services/configService';
import { hashPassword } from '../services/passwordService';
import { DEFAULT_AI_PROMPT } from '../constants/ai';

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
    templateInterviewInvite: '',
    templateGeneralFollowup: ''
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
        hasOpenAiKey: false
      };
    }
    return {
      hasOpenAiKey: Boolean(config.openAiApiKey)
    };
  });

  app.put('/ai', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as { openAiApiKey?: string | null };
    const updated = await executeUpdate(reply, () => updateAiConfig(body?.openAiApiKey ?? null));
    if (!updated) return;
    return {
      hasOpenAiKey: Boolean(updated.openAiApiKey)
    };
  });

  app.get('/ai-prompt', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const config = await loadConfigSafe(request);
    if (!config) {
      return {
        aiPrompt: DEFAULT_AI_PROMPT
      };
    }
    return {
      aiPrompt: config.aiPrompt || DEFAULT_AI_PROMPT
    };
  });

  app.put('/ai-prompt', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as { aiPrompt?: string | null };
    const updated = await executeUpdate(reply, () => updateAiPrompt(body?.aiPrompt ?? null));
    if (!updated) return;

    return {
      aiPrompt: updated.aiPrompt || DEFAULT_AI_PROMPT
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

  app.get('/templates', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const config = await loadConfigSafe(request);
    if (!config) {
      return templatesDefaults;
    }
    return {
      templateInterviewInvite: config.templateInterviewInvite || '',
      templateGeneralFollowup: config.templateGeneralFollowup || ''
    };
  });

  app.put('/templates', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const body = request.body as { templateInterviewInvite?: string | null; templateGeneralFollowup?: string | null };
    const updated = await executeUpdate(reply, () =>
      updateTemplateConfig({
        templateInterviewInvite:
          typeof body?.templateInterviewInvite === 'undefined' ? undefined : body.templateInterviewInvite,
        templateGeneralFollowup:
          typeof body?.templateGeneralFollowup === 'undefined' ? undefined : body.templateGeneralFollowup
      })
    );
    if (!updated) return;
    return {
      templateInterviewInvite: updated.templateInterviewInvite || '',
      templateGeneralFollowup: updated.templateGeneralFollowup || ''
    };
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
}

function isAdmin(request: any): boolean {
  return request.user?.role === 'ADMIN';
}
