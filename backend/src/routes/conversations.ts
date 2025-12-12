import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { sendWhatsAppText, sendWhatsAppTemplate } from '../services/whatsappMessageService';
import { serializeJson } from '../utils/json';
import { getSystemConfig } from '../services/configService';

export async function registerConversationRoutes(app: FastifyInstance) {
  const WINDOW_MS = 24 * 60 * 60 * 1000;

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
    const config = await getSystemConfig();

    return {
      ...conversation,
      lastInboundAt: lastInbound?.timestamp ?? null,
      within24h,
      templates: {
        interviewInvite: config.templateInterviewInvite || null,
        generalFollowup: config.templateGeneralFollowup || null
      }
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

    const sendResult = await sendWhatsAppTemplate(conversation.contact.waId, body.templateName, body.variables);
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
          variables: body.variables || [],
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
