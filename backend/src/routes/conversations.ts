import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { sendWhatsAppText, sendWhatsAppTemplate } from '../services/whatsappMessageService';
import { serializeJson } from '../utils/json';
import {
  DEFAULT_INTERVIEW_DAY,
  DEFAULT_INTERVIEW_LOCATION,
  DEFAULT_INTERVIEW_TIME,
  DEFAULT_JOB_TITLE,
  DEFAULT_TEMPLATE_GENERAL_FOLLOWUP,
  DEFAULT_TEMPLATE_INTERVIEW_INVITE,
  DEFAULT_TEMPLATE_LANGUAGE_CODE
} from '../services/configService';
import type { Prisma } from '@prisma/client';

export async function registerConversationRoutes(app: FastifyInstance) {
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  async function fetchTemplateConfigSafe(): Promise<{
    templateInterviewInvite: string | null;
    templateGeneralFollowup: string | null;
    templateLanguageCode: string | null;
    defaultJobTitle: string | null;
    defaultInterviewDay: string | null;
    defaultInterviewTime: string | null;
    defaultInterviewLocation: string | null;
    testPhoneNumber: string | null;
  }> {
    try {
      const config = await prisma.systemConfig.findUnique({
        where: { id: 1 },
        select: {
          templateInterviewInvite: true,
          templateGeneralFollowup: true,
          templateLanguageCode: true,
          defaultJobTitle: true,
          defaultInterviewDay: true,
          defaultInterviewTime: true,
          defaultInterviewLocation: true,
          testPhoneNumber: true
        }
      });
      return {
        templateInterviewInvite: config?.templateInterviewInvite || DEFAULT_TEMPLATE_INTERVIEW_INVITE,
        templateGeneralFollowup: config?.templateGeneralFollowup || DEFAULT_TEMPLATE_GENERAL_FOLLOWUP,
        templateLanguageCode: config?.templateLanguageCode || DEFAULT_TEMPLATE_LANGUAGE_CODE,
        defaultJobTitle: config?.defaultJobTitle || DEFAULT_JOB_TITLE,
        defaultInterviewDay: config?.defaultInterviewDay || DEFAULT_INTERVIEW_DAY,
        defaultInterviewTime: config?.defaultInterviewTime || DEFAULT_INTERVIEW_TIME,
        defaultInterviewLocation: config?.defaultInterviewLocation || DEFAULT_INTERVIEW_LOCATION,
        testPhoneNumber: config?.testPhoneNumber || null
      };
    } catch (err: any) {
      if (err?.code === 'P2022') {
        app.log.error({ err }, 'Template columns missing in SystemConfig');
        return {
          templateInterviewInvite: DEFAULT_TEMPLATE_INTERVIEW_INVITE,
          templateGeneralFollowup: DEFAULT_TEMPLATE_GENERAL_FOLLOWUP,
          templateLanguageCode: DEFAULT_TEMPLATE_LANGUAGE_CODE,
          defaultJobTitle: DEFAULT_JOB_TITLE,
          defaultInterviewDay: DEFAULT_INTERVIEW_DAY,
          defaultInterviewTime: DEFAULT_INTERVIEW_TIME,
          defaultInterviewLocation: DEFAULT_INTERVIEW_LOCATION,
          testPhoneNumber: null
        };
      }
      throw err;
    }
  }

  app.get('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const conversations = await prisma.conversation.findMany({
      include: {
        contact: true,
        messages: {
          orderBy: { timestamp: 'desc' },
          take: 1
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    const conversationIds = conversations.map(conversation => conversation.id);
    let unreadMap: Record<string, number> = {};

    if (conversationIds.length > 0) {
      const unreadCounts = await prisma.message.groupBy({
        by: ['conversationId'],
        where: {
          conversationId: { in: conversationIds },
          direction: 'INBOUND',
          read: false
        },
        _count: {
          _all: true
        }
      });

      unreadMap = unreadCounts.reduce<Record<string, number>>((acc, curr) => {
        acc[curr.conversationId] = curr._count._all;
        return acc;
      }, {});
    }

    return conversations.map(conversation => ({
      ...conversation,
      unreadCount: unreadMap[conversation.id] || 0
    }));
  });

  app.get('/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: {
        contact: true,
        messages: {
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    const lastInbound = await prisma.message.findFirst({
      where: { conversationId: id, direction: 'INBOUND' },
      orderBy: { timestamp: 'desc' }
    });
    const within24h = isWithin24Hours(lastInbound?.timestamp, WINDOW_MS);
    const templates = await fetchTemplateConfigSafe();
    const normalizedStatus = ['NEW', 'OPEN', 'CLOSED'].includes(conversation.status)
      ? conversation.status
      : 'NEW';
    const normalizedMode = ['RECRUIT', 'INTERVIEW', 'OFF'].includes(conversation.aiMode)
      ? conversation.aiMode
      : 'RECRUIT';

    return {
      ...conversation,
      status: normalizedStatus,
      aiMode: normalizedMode,
      lastInboundAt: lastInbound?.timestamp ?? null,
      within24h,
      templates
    };
  });

  app.post('/:id/messages', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { text } = request.body as { text: string };

    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: { contact: true }
    });

    if (!conversation || !conversation.contact.waId) {
      return reply.code(400).send({ error: 'Conversation or waId not found' });
    }

    if (!conversation.isAdmin) {
      const lastInbound = await prisma.message.findFirst({
        where: { conversationId: id, direction: 'INBOUND' },
        orderBy: { timestamp: 'desc' }
      });
      const within = isWithin24Hours(lastInbound?.timestamp, WINDOW_MS);
      if (!within) {
        return reply.code(409).send({ error: 'Fuera de ventana 24h. Debes usar plantilla.' });
      }
    }

    const sendResultRaw = await sendWhatsAppText(conversation.contact.waId, text).catch(err => ({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    }));

    const sendResult = {
      success: sendResultRaw.success,
      messageId: 'messageId' in sendResultRaw ? sendResultRaw.messageId ?? null : null,
      error: 'error' in sendResultRaw ? sendResultRaw.error ?? null : null
    };

    if (!sendResult.success) {
      app.log.warn(
        {
          conversationId: conversation.id,
          error: sendResult.error
        },
        'WhatsApp send failed'
      );
    }

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'OUTBOUND',
        text,
        rawPayload: serializeJson({
          sendResult
        }),
        timestamp: new Date(),
        read: true
      }
    });

    return { message, sendResult };
  });

  app.post('/:id/mark-read', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const conversation = await prisma.conversation.findUnique({ where: { id } });
    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    const result = await prisma.message.updateMany({
      where: { conversationId: id, direction: 'INBOUND', read: false },
      data: { read: true }
    });

    return { success: true, updated: result.count };
  });

  app.patch('/:id/status', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string };
    const allowed = ['NEW', 'OPEN', 'CLOSED'];
    const nextStatus = body.status?.toUpperCase();

    if (!nextStatus || !allowed.includes(nextStatus)) {
      return reply.code(400).send({ error: 'Invalid status' });
    }

    try {
      const updated = await prisma.conversation.update({
        where: { id },
        data: { status: nextStatus }
      });
      return updated;
    } catch (err) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }
  });

  app.patch('/:id/ai-mode', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { mode?: string };
    const allowed = ['RECRUIT', 'INTERVIEW', 'OFF'];
    const nextMode = body.mode?.toUpperCase();

    if (!nextMode || !allowed.includes(nextMode)) {
      return reply.code(400).send({ error: 'Modo inválido' });
    }

    try {
      const updated = await prisma.conversation.update({
        where: { id },
        data: { aiMode: nextMode }
      });
      return updated;
    } catch (err) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }
  });

  app.post('/:id/send-template', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { templateName?: string; variables?: string[] };
    if (!body.templateName) {
      return reply.code(400).send({ error: 'templateName es obligatorio' });
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: { contact: true }
    });

    if (!conversation || !conversation.contact.waId) {
      return reply.code(400).send({ error: 'Conversation or waId not found' });
    }

    const templates = await fetchTemplateConfigSafe();
    const normalizedVars = Array.isArray(body.variables)
      ? body.variables.map(v => (typeof v === 'string' ? v.trim() : '')).filter(v => v.length > 0)
      : [];
    let finalVariables = normalizedVars;
    if (body.templateName === (templates.templateGeneralFollowup || DEFAULT_TEMPLATE_GENERAL_FOLLOWUP)) {
      const v1 = normalizedVars[0] || templates.defaultJobTitle || DEFAULT_JOB_TITLE;
      finalVariables = [v1];
    } else if (body.templateName === (templates.templateInterviewInvite || DEFAULT_TEMPLATE_INTERVIEW_INVITE)) {
      finalVariables = [
        normalizedVars[0] || templates.defaultInterviewDay || DEFAULT_INTERVIEW_DAY,
        normalizedVars[1] || templates.defaultInterviewTime || DEFAULT_INTERVIEW_TIME,
        normalizedVars[2] || templates.defaultInterviewLocation || DEFAULT_INTERVIEW_LOCATION
      ];
    }

    const sendResult = await sendWhatsAppTemplate(conversation.contact.waId, body.templateName, finalVariables);
    if (!sendResult.success) {
      return reply.code(502).send({ error: sendResult.error || 'Falló el envío de plantilla' });
    }

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'OUTBOUND',
        text: `[TEMPLATE] ${body.templateName}`,
        rawPayload: serializeJson({
          template: body.templateName,
          variables: finalVariables || [],
          sendResult
        }),
        timestamp: new Date(),
        read: true
      }
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() }
    });

    return { success: true };
  });
}

function isWithin24Hours(date?: Date | null, windowMs = 24 * 60 * 60 * 1000): boolean {
  if (!date) return true;
  const diff = Date.now() - date.getTime();
  return diff <= windowMs;
}
