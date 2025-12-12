import { FastifyInstance } from 'fastify';
import {
  getSystemConfig,
  updateAdminAccount,
  updateAiConfig,
  updateAiPrompt,
  updateAdminAiConfig,
  updateInterviewAiConfig,
  updateWhatsAppConfig,
  DEFAULT_ADMIN_AI_PROMPT,
  DEFAULT_ADMIN_AI_MODEL,
  DEFAULT_INTERVIEW_AI_PROMPT,
  DEFAULT_INTERVIEW_AI_MODEL
} from '../services/configService';
import { hashPassword } from '../services/passwordService';
import { DEFAULT_AI_PROMPT } from '../constants/ai';

export async function registerConfigRoutes(app: FastifyInstance) {
  app.get('/whatsapp', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const config = await getSystemConfig();
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

    const updated = await updateWhatsAppConfig({
      whatsappBaseUrl: body.whatsappBaseUrl,
      whatsappPhoneId: body.whatsappPhoneId,
      whatsappToken: body.whatsappToken,
      whatsappVerifyToken: typeof body.whatsappVerifyToken === 'undefined' ? undefined : body.whatsappVerifyToken,
      botAutoReply: body.botAutoReply,
      adminWaId: typeof body.adminWaId === 'undefined' ? undefined : body.adminWaId
    });

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

    const config = await getSystemConfig();
    return {
      hasOpenAiKey: Boolean(config.openAiApiKey)
    };
  });

  app.put('/ai', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as { openAiApiKey?: string | null };
    const updated = await updateAiConfig(body?.openAiApiKey ?? null);
    return {
      hasOpenAiKey: Boolean(updated.openAiApiKey)
    };
  });

  app.get('/ai-prompt', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const config = await getSystemConfig();
    return {
      aiPrompt: config.aiPrompt || DEFAULT_AI_PROMPT
    };
  });

  app.put('/ai-prompt', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as { aiPrompt?: string | null };
    const updated = await updateAiPrompt(body?.aiPrompt ?? null);

    return {
      aiPrompt: updated.aiPrompt || DEFAULT_AI_PROMPT
    };
  });

  app.get('/admin-ai', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const config = await getSystemConfig();
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
    const updated = await updateAdminAiConfig({
      prompt: typeof body?.prompt === 'undefined' ? undefined : body.prompt,
      model: typeof body?.model === 'undefined' ? undefined : body.model
    });
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
    const config = await getSystemConfig();
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
    const updated = await updateInterviewAiConfig({
      prompt: typeof body?.prompt === 'undefined' ? undefined : body.prompt,
      model: typeof body?.model === 'undefined' ? undefined : body.model
    });
    return {
      prompt: updated.interviewAiPrompt || DEFAULT_INTERVIEW_AI_PROMPT,
      hasCustomPrompt: Boolean(updated.interviewAiPrompt),
      model: updated.interviewAiModel || DEFAULT_INTERVIEW_AI_MODEL
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
    const updated = await updateAdminAccount(body.email, passwordHash);

    return {
      adminEmail: updated.adminEmail
    };
  });

  app.get('/admin-account', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const config = await getSystemConfig();
    return {
      adminEmail: config.adminEmail
    };
  });
}

function isAdmin(request: any): boolean {
  return request.user?.role === 'ADMIN';
}
