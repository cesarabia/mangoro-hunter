import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { sendWhatsAppText, sendWhatsAppTemplate } from '../services/whatsappMessageService';
import { serializeJson } from '../utils/json';
import { createConversationAndMaybeSend } from '../services/conversationCreateService';
import { loadTemplateConfig, resolveTemplateVariables } from '../services/templateService';

export async function registerConversationRoutes(app: FastifyInstance) {
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const fetchTemplateConfigSafe = () => loadTemplateConfig(app.log);
  const isSuspiciousCandidateName = (value?: string | null) => {
    if (!value) return true;
    const lower = value.toLowerCase();
    const patterns = [
      'hola quiero postular',
      'quiero postular',
      'postular',
      'hola',
      'buenas',
      'confirmo',
      'no puedo',
      'no me sirve',
      'ok',
      'si pero',
      'gracias'
    ];
    if (patterns.some(p => lower.includes(p))) return true;
    if (/(lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)/i.test(value)) return true;
    if (/medio ?d[ií]a/i.test(value)) return true;
    if (/\b\d{1,2}:\d{2}\b/.test(value)) return true;
    return false;
  };

  async function sanitizeContact(contact: any) {
    if (contact?.candidateName && isSuspiciousCandidateName(contact.candidateName)) {
      await prisma.contact.update({
        where: { id: contact.id },
        data: { candidateName: null }
      }).catch(() => {});
      contact.candidateName = null;
    }
    return contact;
  }

  async function logSystemMessage(conversationId: string, text: string, rawPayload?: any) {
    await prisma.message.create({
      data: {
        conversationId,
        direction: 'OUTBOUND',
        text,
        rawPayload: serializeJson({ system: true, ...(rawPayload || {}) }),
        timestamp: new Date(),
        read: true
      }
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() }
    }).catch(() => {});
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

    const sanitizedContacts = await Promise.all(
      conversations.map(async conversation => {
        if (conversation.contact && isSuspiciousCandidateName(conversation.contact.candidateName)) {
          await prisma.contact.update({
            where: { id: conversation.contact.id },
            data: { candidateName: null }
          }).catch(() => {});
          conversation.contact.candidateName = null;
        }
        return conversation;
      })
    );

    return sanitizedContacts.map(conversation => ({
      ...conversation,
      unreadCount: unreadMap[conversation.id] || 0
    }));
  });

  app.post('/create-and-send', { preValidation: [app.authenticate] }, async (request, reply) => {
    const body = request.body as {
      phoneE164?: string;
      mode?: string | null;
      status?: string | null;
      sendTemplateNow?: boolean;
      variables?: string[];
      templateName?: string | null;
    };

    if (!body.phoneE164) {
      return reply.code(400).send({ error: 'phoneE164 es obligatorio' });
    }

    try {
      const result = await createConversationAndMaybeSend({
        phoneE164: body.phoneE164,
        mode: body.mode,
        status: body.status,
        sendTemplateNow: body.sendTemplateNow !== false,
        variables: body.variables,
        templateNameOverride: body.templateName ?? null
      });

      if (body.sendTemplateNow !== false && result.sendResult && !result.sendResult.success) {
        return reply.code(502).send({
          error: result.sendResult.error || 'Falló el envío de plantilla',
          conversationId: result.conversationId
        });
      }

      return { conversationId: result.conversationId, sendResult: result.sendResult ?? null };
    } catch (err: any) {
      const errorMessage = err instanceof Error ? err.message : 'No se pudo crear la conversación';
      return reply.code(400).send({ error: errorMessage });
    }
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
      contact: await sanitizeContact(conversation.contact),
      status: normalizedStatus,
      aiMode: normalizedMode,
      aiPaused: Boolean(conversation.aiPaused),
      lastInboundAt: lastInbound?.timestamp ?? null,
      within24h,
      templates
    };
  });

  app.patch('/:id/no-contact', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { noContact?: boolean; reason?: string | null };

    if (typeof body.noContact !== 'boolean') {
      return reply.code(400).send({ error: '"noContact" debe ser boolean' });
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: { contact: true }
    });

    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }
    if (conversation.isAdmin) {
      return reply.code(400).send({ error: 'NO_CONTACTAR no aplica a conversación admin' });
    }

    const contactId = conversation.contactId;
    const nextNoContact = body.noContact;
    const rawReason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const now = new Date();
    const actor = (request as any)?.user?.userId || null;

    if (nextNoContact) {
      const reason = rawReason || 'Marcado manualmente desde CRM';
      await prisma.contact.update({
        where: { id: contactId },
        data: { noContact: true, noContactAt: now, noContactReason: reason }
      });
      await prisma.conversation.updateMany({
        where: { contactId },
        data: { aiPaused: true }
      });
      await logSystemMessage(
        id,
        `🔕 Marcado como NO_CONTACTAR. Motivo: ${reason}`,
        { noContactAction: 'SET', source: 'UI', reason, actor }
      );
      return { success: true };
    }

    await prisma.contact.update({
      where: { id: contactId },
      data: { noContact: false, noContactAt: null, noContactReason: null }
    });
    await prisma.conversation.updateMany({
      where: { contactId },
      data: { aiPaused: false }
    });
    await logSystemMessage(
      id,
      '✅ Contacto reactivado (NO_CONTACTAR desactivado).',
      { noContactAction: 'UNSET', source: 'UI', actor }
    );
    return { success: true };
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
    if (conversation.contact.noContact) {
      return reply.code(403).send({ error: 'Contacto marcado como NO_CONTACTAR. Reactívalo antes de enviar.' });
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

  app.patch('/:id/ai-settings', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { mode?: string; aiPaused?: boolean };
    const data: Record<string, any> = {};
    if (typeof body.aiPaused !== 'undefined') {
      data.aiPaused = Boolean(body.aiPaused);
    }
    if (body.mode) {
      const nextMode = body.mode.toUpperCase();
      if (!['RECRUIT', 'INTERVIEW', 'OFF'].includes(nextMode)) {
        return reply.code(400).send({ error: 'Modo inválido' });
      }
      data.aiMode = nextMode;
    }
    if (Object.keys(data).length === 0) {
      return reply.code(400).send({ error: 'Sin cambios' });
    }
    try {
      const updated = await prisma.conversation.update({
        where: { id },
        data
      });
      return updated;
    } catch (err) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }
  });

  app.patch('/:id/interview', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      interviewDay?: string | null;
      interviewTime?: string | null;
      interviewLocation?: string | null;
      interviewStatus?: string | null;
    };

    const data: Record<string, string | null> = {};
    if (typeof body.interviewDay !== 'undefined') data.interviewDay = normalizeValue(body.interviewDay);
    if (typeof body.interviewTime !== 'undefined') data.interviewTime = normalizeValue(body.interviewTime);
    if (typeof body.interviewLocation !== 'undefined')
      data.interviewLocation = normalizeValue(body.interviewLocation);
    if (typeof body.interviewStatus !== 'undefined') data.interviewStatus = normalizeValue(body.interviewStatus);

    if (Object.keys(data).length === 0) {
      return reply.code(400).send({ error: 'Sin cambios' });
    }

    try {
      const updated = await prisma.conversation.update({
        where: { id },
        data
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
    if (conversation.contact.noContact) {
      return reply.code(403).send({ error: 'Contacto marcado como NO_CONTACTAR. Reactívalo antes de enviar.' });
    }

    const templates = await fetchTemplateConfigSafe();
    const finalVariables = resolveTemplateVariables(body.templateName, body.variables, templates, {
      interviewDay: conversation.interviewDay,
      interviewTime: conversation.interviewTime,
      interviewLocation: conversation.interviewLocation
    });

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

function normalizeValue(value?: string | null): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return value ?? null;
}
