import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { sendWhatsAppText, sendWhatsAppTemplate } from '../services/whatsappMessageService';
import { serializeJson } from '../utils/json';
import { createConversationAndMaybeSend } from '../services/conversationCreateService';
import { loadTemplateConfig, resolveTemplateVariables } from '../services/templateService';
import { getSystemConfig } from '../services/configService';
import {
  attemptScheduleInterview,
  confirmActiveReservation,
  formatSlotHuman,
  releaseActiveReservation
} from '../services/interviewSchedulerService';
import { sendAdminNotification } from '../services/adminNotificationService';
import { getContactDisplayName } from '../utils/contactDisplay';
import { isWorkspaceAdmin, resolveWorkspaceAccess } from '../services/workspaceAuthService';
import { stableHash } from '../services/agent/tools';
import { runAutomations } from '../services/automationRunnerService';
import { isKnownActiveStage, normalizeStageSlug } from '../services/workspaceStageService';

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
      'mas informacion',
      'más información',
      'más info',
      'info',
      'informacion',
      'información',
      'hola',
      'buenas',
      'confirmo',
      'no puedo',
      'no me sirve',
      'ok',
      'si pero',
      'gracias',
      'inmediata',
      'inmediato'
    ];
    if (patterns.some(p => lower.includes(p))) return true;
    if (/\b(cancelar|cancelaci[oó]n|reagend|reprogram|cambiar|modificar|mover)\b/i.test(lower)) return true;
    if (/\b(resumen|reporte|generar|genera|registro|registrar|visita|venta|pitch|onboarding)\b/i.test(lower)) return true;
    if (/\b(cv|cb|curric|curr[íi]cul|vitae|adjunt|archivo|documento|imagen|foto|pdf|word|docx)\b/i.test(lower)) return true;
    if (/\b(tengo|adjunto|envio|envi[ée]|enviar|mando|mand[ée]|subo)\b/i.test(lower)) return true;
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

  const normalizeManualName = (value: unknown): string | null | undefined => {
    if (typeof value === 'undefined') return undefined;
    if (value === null) return null;
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim().replace(/\s+/g, ' ');
    if (!trimmed) return null;
    return trimmed;
  };

  const isValidManualName = (value: string): boolean => {
    if (!value) return false;
    if (value.length < 2 || value.length > 60) return false;
    if (!/^[A-Za-zÁÉÍÓÚáéíóúÑñ][A-Za-zÁÉÍÓÚáéíóúÑñ\s'.-]*$/.test(value)) return false;
    const words = value.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 4) return false;
    return !isSuspiciousCandidateName(value);
  };

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

  const canSeeOnlyAssigned = (access: any, userId: string | null) => {
    const role = String(access?.role || '').toUpperCase();
    return role === 'MEMBER' && Boolean(access?.assignedOnly) && Boolean(userId);
  };

  app.get('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const userId = (request as any)?.user?.userId ? String((request as any).user.userId) : null;
    const assignedOnly = canSeeOnlyAssigned(access, userId);
    const conversations = await prisma.conversation.findMany({
      where: {
        workspaceId: access.workspaceId,
        ...(assignedOnly ? { assignedToId: userId } : {}),
      },
      include: {
        contact: true,
        assignedTo: { select: { id: true, email: true, name: true } },
        program: { select: { id: true, name: true, slug: true } },
        phoneLine: { select: { id: true, alias: true } },
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
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const body = request.body as {
      phoneE164?: string;
      phoneLineId?: string | null;
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
        templateNameOverride: body.templateName ?? null,
        workspaceId: access.workspaceId,
        phoneLineId: typeof body.phoneLineId === 'string' ? body.phoneLineId.trim() : body.phoneLineId ?? null
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
    const access = await resolveWorkspaceAccess(request);
    const { id } = request.params as { id: string };
    const userId = (request as any)?.user?.userId ? String((request as any).user.userId) : null;

    const conversation = await prisma.conversation.findFirst({
      where: { id, workspaceId: access.workspaceId },
      include: {
        contact: true,
        assignedTo: { select: { id: true, email: true, name: true } },
        program: { select: { id: true, name: true, slug: true } },
        phoneLine: { select: { id: true, alias: true } },
        messages: {
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }
    if (canSeeOnlyAssigned(access, userId) && String(conversation.assignedToId || '') !== String(userId)) {
      return reply.code(403).send({ error: 'Forbidden' });
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
    const normalizedMode = ['RECRUIT', 'INTERVIEW', 'SELLER', 'OFF'].includes(conversation.aiMode)
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

  app.patch('/:id/program', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const { id } = request.params as { id: string };
    const body = request.body as { programId?: string | null };

    const conversation = await prisma.conversation.findFirst({
      where: { id, workspaceId: access.workspaceId }
    });
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });

    const programId =
      typeof body.programId === 'string' && body.programId.trim() ? body.programId.trim() : null;
    let nextAiMode: string | null = null;
    if (programId) {
      const program = await prisma.program.findFirst({
        where: { id: programId, workspaceId: access.workspaceId, archivedAt: null },
        select: { id: true, slug: true }
      });
      if (!program) return reply.code(400).send({ error: 'Program inválido' });
      const slug = String(program.slug || '').toLowerCase();
      if (slug === 'interview') nextAiMode = 'INTERVIEW';
      else if (slug === 'sales') nextAiMode = 'SELLER';
      else if (slug === 'recruitment') nextAiMode = 'RECRUIT';
    }

    await prisma.conversation.update({
      where: { id },
      data: {
        programId,
        ...(nextAiMode && !conversation.isAdmin ? { aiMode: nextAiMode } : {}),
        updatedAt: new Date()
      }
    });
    return { ok: true };
  });

  app.patch('/:id/assign', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const actor = (request as any)?.user?.userId || null;
    const { id } = request.params as { id: string };
    const body = request.body as { assignedToUserId?: string | null };

    const conversation = await prisma.conversation.findFirst({
      where: { id, workspaceId: access.workspaceId, archivedAt: null },
      select: { id: true, assignedToId: true, isAdmin: true }
    });
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
    if (conversation.isAdmin) return reply.code(400).send({ error: 'No aplica a conversación admin' });

    const nextUserId = typeof body.assignedToUserId === 'string' && body.assignedToUserId.trim() ? body.assignedToUserId.trim() : null;
    if (nextUserId) {
      const membership = await prisma.membership.findFirst({
        where: { workspaceId: access.workspaceId, userId: nextUserId, archivedAt: null },
        include: { user: { select: { email: true, name: true } } }
      });
      if (!membership) return reply.code(400).send({ error: 'Usuario inválido para este workspace' });
      await prisma.conversation.update({
        where: { id },
        data: { assignedToId: nextUserId, updatedAt: new Date() }
      });
      const label = membership.user?.name || membership.user?.email || nextUserId;
      await logSystemMessage(id, `👤 Conversación asignada a: ${label}`, { assignment: 'SET', assignedToUserId: nextUserId, actor });
      return { ok: true, assignedToUserId: nextUserId };
    }

    await prisma.conversation.update({
      where: { id },
      data: { assignedToId: null, updatedAt: new Date() }
    });
    await logSystemMessage(id, '👤 Asignación removida (sin responsable).', { assignment: 'UNSET', actor });
    return { ok: true, assignedToUserId: null };
  });

  app.patch('/:id/stage', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const actor = (request as any)?.user?.userId || null;
    const { id } = request.params as { id: string };
    const body = request.body as { stage?: string; reason?: string | null };

    const stageRaw = typeof body?.stage === 'string' ? body.stage.trim() : '';
    if (!stageRaw) return reply.code(400).send({ error: '"stage" es obligatorio.' });
    if (stageRaw.length > 64) return reply.code(400).send({ error: '"stage" es demasiado largo (max 64).' });
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(stageRaw)) {
      return reply.code(400).send({ error: '"stage" inválido. Usa letras/números/espacios/_/-' });
    }
    const stageSlug = normalizeStageSlug(stageRaw);
    if (!stageSlug) return reply.code(400).send({ error: '"stage" inválido.' });

    const reasonRaw = typeof body?.reason === 'string' ? body.reason.trim() : '';
    const reason = reasonRaw ? reasonRaw.slice(0, 140) : null;

    const conversation = await prisma.conversation.findFirst({
      where: { id, workspaceId: access.workspaceId, archivedAt: null },
      select: { id: true, isAdmin: true, conversationStage: true },
    });
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
    if (conversation.isAdmin) return reply.code(400).send({ error: 'No aplica a conversación admin' });

    // If the workspace has configured stages, validate against active slugs.
    const hasAnyStageConfig = await prisma.workspaceStage
      .findFirst({ where: { workspaceId: access.workspaceId, archivedAt: null }, select: { id: true } })
      .then((r) => Boolean(r?.id))
      .catch(() => false);
    if (hasAnyStageConfig) {
      const ok = await isKnownActiveStage(access.workspaceId, stageSlug).catch(() => false);
      if (!ok) {
        return reply.code(400).send({
          error: `Stage "${stageSlug}" no existe o está inactivo para este workspace. Configúralo en Configuración → Workspace → Estados.`,
          code: 'STAGE_UNKNOWN',
        });
      }
    }

    await prisma.conversation.update({
      where: { id },
      data: {
        conversationStage: stageSlug,
        stageReason: reason || 'manual',
        updatedAt: new Date(),
      },
    });

    const reasonSuffix = reason ? ` (motivo: ${reason})` : '';
    await logSystemMessage(id, `🏷️ Stage actualizado: ${stageSlug}${reasonSuffix}`, {
      stageUpdate: true,
      stage: stageSlug,
      reason,
      actor,
    });

    let automationError: string | null = null;
    try {
      await runAutomations({
        app,
        workspaceId: access.workspaceId,
        eventType: 'STAGE_CHANGED',
        conversationId: id,
        transportMode: 'REAL',
      });
    } catch (err: any) {
      automationError = err?.message || 'automation failed';
      request.log.warn({ err, conversationId: id }, 'STAGE_CHANGED automations failed');
    }

    return { ok: true, stage: stageSlug, automationError };
  });

  app.patch('/:id/contact-name', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const { id } = request.params as { id: string };
    const body = request.body as { manualName?: string | null };

    const nextManual = normalizeManualName(body?.manualName);
    if (typeof nextManual === 'string' && !isValidManualName(nextManual)) {
      return reply.code(400).send({ error: 'Nombre manual inválido. Usa solo nombre y apellido (sin etiquetas).' });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id, workspaceId: access.workspaceId },
      include: { contact: true }
    });
    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }
    if (conversation.isAdmin) {
      return reply.code(400).send({ error: 'No se puede editar nombre en conversación admin' });
    }

    const updated = await prisma.contact.update({
      where: { id: conversation.contactId },
      data: { candidateNameManual: nextManual === undefined ? conversation.contact.candidateNameManual : nextManual }
    });

    const display = getContactDisplayName(updated);
    if (typeof nextManual === 'string') {
      await logSystemMessage(id, `✏️ Nombre manual guardado: ${display}`, {
        contactUpdate: 'candidateNameManual',
        value: nextManual
      });
    } else if (nextManual === null) {
      await logSystemMessage(id, `🧹 Nombre manual eliminado. Volviendo a nombre detectado: ${display}`, {
        contactUpdate: 'candidateNameManual',
        value: null
      });
    }

    return { success: true, contact: updated };
  });

  app.patch('/:id/no-contact', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const { id } = request.params as { id: string };
    const body = request.body as { noContact?: boolean; reason?: string | null };

    if (typeof body.noContact !== 'boolean') {
      return reply.code(400).send({ error: '"noContact" debe ser boolean' });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id, workspaceId: access.workspaceId },
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
    const access = await resolveWorkspaceAccess(request);
    const { id } = request.params as { id: string };
    const { text } = request.body as { text: string };
    const userId = (request as any)?.user?.userId ? String((request as any).user.userId) : null;

    const conversation = await prisma.conversation.findFirst({
      where: { id, workspaceId: access.workspaceId },
      include: { contact: true, phoneLine: true }
    });

    if (!conversation || !conversation.contact.waId) {
      return reply.code(400).send({ error: 'Conversation or waId not found' });
    }
    if (canSeeOnlyAssigned(access, userId) && String(conversation.assignedToId || '') !== String(userId)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const role = String(access.role || '').toUpperCase();
    const canSend =
      isWorkspaceAdmin(request, access) ||
      (role === 'MEMBER' && Boolean(userId) && String(conversation.assignedToId || '') === String(userId));
    if (!canSend) {
      return reply.code(403).send({ error: 'Forbidden' });
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

    const sendResultRaw = await sendWhatsAppText(conversation.contact.waId, text, {
      phoneNumberId: conversation.phoneLine?.waPhoneNumberId || null
    }).catch(err => ({
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

    try {
      await prisma.outboundMessageLog.create({
        data: {
          workspaceId: conversation.workspaceId,
          conversationId: conversation.id,
          channel: 'WHATSAPP',
          type: 'SESSION_TEXT',
          templateName: null,
          dedupeKey: `manual:${message.id}`,
          textHash: stableHash(text),
          blockedReason: sendResult.success ? null : (sendResult.error || 'SEND_FAILED'),
          waMessageId: sendResult.messageId || null,
        }
      });
    } catch (err) {
      app.log.warn({ err, conversationId: conversation.id }, 'Failed to write OutboundMessageLog for manual send');
    }

    return { message, sendResult };
  });

  app.post('/:id/mark-read', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const { id } = request.params as { id: string };
    const userId = (request as any)?.user?.userId ? String((request as any).user.userId) : null;

    const conversation = await prisma.conversation.findFirst({ where: { id, workspaceId: access.workspaceId } });
    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }
    if (canSeeOnlyAssigned(access, userId) && String(conversation.assignedToId || '') !== String(userId)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const result = await prisma.message.updateMany({
      where: { conversationId: id, direction: 'INBOUND', read: false },
      data: { read: true }
    });

    return { success: true, updated: result.count };
  });

  app.patch('/:id/status', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string };
    const allowed = ['NEW', 'OPEN', 'CLOSED'];
    const nextStatus = body.status?.toUpperCase();

    if (!nextStatus || !allowed.includes(nextStatus)) {
      return reply.code(400).send({ error: 'Invalid status' });
    }

    const updated = await prisma.conversation.updateMany({
      where: { id, workspaceId: access.workspaceId },
      data: { status: nextStatus, updatedAt: new Date() }
    });
    if (updated.count === 0) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }
    const fresh = await prisma.conversation.findFirst({
      where: { id, workspaceId: access.workspaceId },
      include: { contact: true, program: { select: { id: true, name: true, slug: true } }, phoneLine: { select: { id: true, alias: true } } }
    });
    return fresh || { id, status: nextStatus };
  });

  app.patch('/:id/ai-mode', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const { id } = request.params as { id: string };
    const body = request.body as { mode?: string };
    const allowed = ['RECRUIT', 'INTERVIEW', 'SELLER', 'OFF'];
    const nextMode = body.mode?.toUpperCase();

    if (!nextMode || !allowed.includes(nextMode)) {
      return reply.code(400).send({ error: 'Modo inválido' });
    }

    const updated = await prisma.conversation.updateMany({
      where: { id, workspaceId: access.workspaceId },
      data: { aiMode: nextMode, updatedAt: new Date() }
    });
    if (updated.count === 0) return reply.code(404).send({ error: 'Conversation not found' });
    return prisma.conversation.findFirst({ where: { id, workspaceId: access.workspaceId } });
  });

  app.patch('/:id/ai-settings', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const { id } = request.params as { id: string };
    const body = request.body as { mode?: string; aiPaused?: boolean };
    const data: Record<string, any> = {};
    if (typeof body.aiPaused !== 'undefined') {
      data.aiPaused = Boolean(body.aiPaused);
    }
    if (body.mode) {
      const nextMode = body.mode.toUpperCase();
      if (!['RECRUIT', 'INTERVIEW', 'SELLER', 'OFF'].includes(nextMode)) {
        return reply.code(400).send({ error: 'Modo inválido' });
      }
      data.aiMode = nextMode;
    }
    if (Object.keys(data).length === 0) {
      return reply.code(400).send({ error: 'Sin cambios' });
    }
    const updated = await prisma.conversation.updateMany({
      where: { id, workspaceId: access.workspaceId },
      data: { ...data, updatedAt: new Date() }
    });
    if (updated.count === 0) return reply.code(404).send({ error: 'Conversation not found' });
    return prisma.conversation.findFirst({ where: { id, workspaceId: access.workspaceId } });
  });

  app.patch('/:id/interview', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const { id } = request.params as { id: string };
    const body = request.body as {
      interviewDay?: string | null;
      interviewTime?: string | null;
      interviewLocation?: string | null;
      interviewStatus?: string | null;
    };

    const conversation = await prisma.conversation.findFirst({
      where: { id, workspaceId: access.workspaceId },
      include: { contact: true }
    });
    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }
    if (conversation.isAdmin) {
      return reply.code(400).send({ error: 'No aplica a conversación admin' });
    }

    const requestedDay =
      typeof body.interviewDay !== 'undefined' ? normalizeValue(body.interviewDay) : conversation.interviewDay;
    const requestedTime =
      typeof body.interviewTime !== 'undefined' ? normalizeValue(body.interviewTime) : conversation.interviewTime;
    const requestedLocation =
      typeof body.interviewLocation !== 'undefined'
        ? normalizeValue(body.interviewLocation)
        : conversation.interviewLocation;

    const requestedStatusRaw =
      typeof body.interviewStatus !== 'undefined'
        ? normalizeValue(body.interviewStatus)
        : conversation.interviewStatus;
    const requestedStatus = requestedStatusRaw ? requestedStatusRaw.toUpperCase() : null;

    const wantsScheduleChange =
      typeof body.interviewDay !== 'undefined' ||
      typeof body.interviewTime !== 'undefined' ||
      typeof body.interviewLocation !== 'undefined';

    const config = await getSystemConfig();
    let slot = { day: requestedDay, time: requestedTime, location: requestedLocation };
    let reservationId: string | null = null;
    let scheduleKind: 'SCHEDULED' | 'RESCHEDULED' | 'UNCHANGED' | null = null;

    if (wantsScheduleChange && slot.day && slot.time) {
      const scheduleAttempt = await attemptScheduleInterview({
        conversationId: conversation.id,
        contactId: conversation.contactId,
        day: slot.day,
        time: slot.time,
        location: slot.location,
        config
      });
      if (!scheduleAttempt.ok) {
        const alternatives = scheduleAttempt.alternatives.map(item => formatSlotHuman(item));
        return reply.code(409).send({ error: scheduleAttempt.message, alternatives });
      }
      slot = {
        day: scheduleAttempt.slot.day,
        time: scheduleAttempt.slot.time,
        location: scheduleAttempt.slot.location
      };
      reservationId = scheduleAttempt.reservationId;
      scheduleKind = scheduleAttempt.kind;
    }

    if (typeof body.interviewStatus !== 'undefined' && requestedStatus === 'CONFIRMED') {
      const update = await confirmActiveReservation(conversation.id);
      reservationId = reservationId || update.reservationId;
    }
    if (
      typeof body.interviewStatus !== 'undefined' &&
      (requestedStatus === 'CANCELLED' || requestedStatus === 'ON_HOLD')
    ) {
      const update = await releaseActiveReservation({
        conversationId: conversation.id,
        status: requestedStatus
      });
      reservationId = reservationId || update.reservationId;
    }

    const data: Record<string, any> = { aiMode: 'INTERVIEW', status: 'OPEN' };
    if (typeof body.interviewDay !== 'undefined' || scheduleKind) data.interviewDay = slot.day;
    if (typeof body.interviewTime !== 'undefined' || scheduleKind) data.interviewTime = slot.time;
    if (typeof body.interviewLocation !== 'undefined' || scheduleKind) data.interviewLocation = slot.location;
    if (typeof body.interviewStatus !== 'undefined') data.interviewStatus = requestedStatusRaw;
    if (Object.keys(data).length === 0) {
      return reply.code(400).send({ error: 'Sin cambios' });
    }

    const updated = await prisma.conversation.update({
      where: { id },
      data,
      include: { contact: true }
    });

    if (scheduleKind === 'SCHEDULED' || scheduleKind === 'RESCHEDULED') {
      await sendAdminNotification({
        app,
        eventType: scheduleKind === 'RESCHEDULED' ? 'INTERVIEW_RESCHEDULED' : 'INTERVIEW_SCHEDULED',
        contact: updated.contact,
        reservationId,
        interviewDay: slot.day,
        interviewTime: slot.time,
        interviewLocation: slot.location
      });
    }

    if (typeof body.interviewStatus !== 'undefined' && requestedStatus === 'CANCELLED') {
      await sendAdminNotification({
        app,
        eventType: 'INTERVIEW_CANCELLED',
        contact: updated.contact,
        reservationId,
        interviewDay: slot.day,
        interviewTime: slot.time,
        interviewLocation: slot.location
      });
    }
    if (typeof body.interviewStatus !== 'undefined' && requestedStatus === 'ON_HOLD') {
      await sendAdminNotification({
        app,
        eventType: 'INTERVIEW_ON_HOLD',
        contact: updated.contact,
        reservationId,
        interviewDay: slot.day,
        interviewTime: slot.time,
        interviewLocation: slot.location
      });
    }

    if (typeof body.interviewStatus !== 'undefined' && requestedStatus === 'CONFIRMED') {
      await sendAdminNotification({
        app,
        eventType: 'INTERVIEW_CONFIRMED',
        contact: updated.contact,
        reservationId,
        interviewDay: slot.day,
        interviewTime: slot.time,
        interviewLocation: slot.location
      });
    }

    return updated;
  });

  app.post('/:id/send-template', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const { id } = request.params as { id: string };
    const body = request.body as { templateName?: string; variables?: string[] };
    if (!body.templateName) {
      return reply.code(400).send({ error: 'templateName es obligatorio' });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id, workspaceId: access.workspaceId },
      include: { contact: true, phoneLine: true }
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

    const sendResult = await sendWhatsAppTemplate(conversation.contact.waId, body.templateName, finalVariables, {
      phoneNumberId: conversation.phoneLine?.waPhoneNumberId || null
    });
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
