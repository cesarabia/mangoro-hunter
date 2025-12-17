import { FastifyInstance } from 'fastify';
import { prisma } from '../../db/client';
import { serializeJson } from '../../utils/json';
import { AgentCommand, AgentResponse } from './commandSchema';
import { computeOutboundBlockReason } from './guardrails';
import { stableHash, stripAccents } from './tools';
import { sendWhatsAppTemplate, sendWhatsAppText, SendResult } from '../whatsappMessageService';
import { attemptScheduleInterview, formatInterviewExactAddress } from '../interviewSchedulerService';
import { getSystemConfig } from '../configService';
import { sendAdminNotification } from '../adminNotificationService';
import { getContactDisplayName } from '../../utils/contactDisplay';

export type ExecutorTransportMode = 'REAL' | 'NULL';

export type ExecuteResult = {
  ok: boolean;
  blocked?: boolean;
  blockedReason?: string;
  details?: any;
};

type WhatsAppWindowStatus = 'IN_24H' | 'OUTSIDE_24H';

function normalizeForNameChecks(value: string): string {
  return stripAccents(String(value || '')).toLowerCase().replace(/\s+/g, ' ').trim();
}

function isSuspiciousCandidateName(value?: string | null): boolean {
  if (!value) return true;
  const lower = normalizeForNameChecks(value);
  if (!lower) return true;
  const patterns = [
    'hola',
    'buenas',
    'postular',
    'mas informacion',
    'más informacion',
    'mas info',
    'más info',
    'informacion',
    'info',
    'confirmo',
    'gracias',
    'tengo disponibilidad',
    'disponibilidad inmediata',
    'cancelar la hora',
    'cancelar',
    'reagendar',
    'cambiar hora',
    'tengo cv',
    'adjunto cv',
    'curriculum',
    'cv',
    'pdf',
    'word',
    'docx',
  ];
  if (patterns.some((p) => lower.includes(normalizeForNameChecks(p)))) return true;
  if (/\b\d{1,2}:\d{2}\b/.test(lower)) return true;
  return false;
}

async function computeWhatsAppWindowStatus(conversationId: string): Promise<WhatsAppWindowStatus> {
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const lastInbound = await prisma.message.findFirst({
    where: { conversationId, direction: 'INBOUND' },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true },
  });
  if (!lastInbound?.timestamp) return 'IN_24H';
  const delta = Date.now() - new Date(lastInbound.timestamp).getTime();
  return delta <= WINDOW_MS ? 'IN_24H' : 'OUTSIDE_24H';
}

function detectAskedFields(text: string): string[] {
  const lower = normalizeForNameChecks(text);
  const fields: string[] = [];
  const add = (f: string) => {
    if (!fields.includes(f)) fields.push(f);
  };
  if (/\bnombre\b/.test(lower)) add('candidateName');
  if (/\b(apellido|nombre y apellido)\b/.test(lower)) add('candidateName');
  if (/\bcomuna\b/.test(lower) || /\bciudad\b/.test(lower)) add('location');
  if (/\brut\b/.test(lower)) add('rut');
  if (/\bemail\b/.test(lower) || /\bcorreo\b/.test(lower)) add('email');
  if (/\bexperienc\b/.test(lower)) add('experience');
  if (/\bdisponibil\b/.test(lower)) add('availability');
  return fields;
}

function buildLoopBreakerQuestion(params: { field: string; contact: any }): string {
  const contact = params.contact || {};
  const candidateName = String(contact.candidateName || '').trim();
  const comuna = String((contact as any).comuna || '').trim();
  const ciudad = String((contact as any).ciudad || '').trim();
  const rut = String((contact as any).rut || '').trim();
  const email = String((contact as any).email || '').trim();
  const experienceYearsRaw = (contact as any).experienceYears;
  const experienceYears =
    typeof experienceYearsRaw === 'number' && Number.isFinite(experienceYearsRaw)
      ? experienceYearsRaw
      : null;
  const availabilityText = String((contact as any).availabilityText || '').trim();

  if (params.field === 'candidateName') {
    if (candidateName) {
      return `Confirmación rápida: ¿Tu nombre es ${candidateName}?\n1) Sí\n2) No (escríbelo completo)`;
    }
    return 'Para avanzar necesito tu nombre y apellido (escríbelo en una sola línea).';
  }
  if (params.field === 'location') {
    if (comuna) {
      return `Confirmación rápida: ¿Tu comuna es ${comuna}?\n1) Sí\n2) No (escríbela)`;
    }
    if (ciudad) {
      return `Confirmación rápida: ¿Tu ciudad es ${ciudad}?\n1) Sí\n2) No (escríbela)`;
    }
    return 'Para avanzar necesito tu comuna y ciudad (Chile). Responde así: Comuna: ___, Ciudad: ___.';
  }
  if (params.field === 'rut') {
    if (rut) {
      return `Confirmación rápida: ¿Tu RUT es ${rut}?\n1) Sí\n2) No (escríbelo)`;
    }
    return 'Para avanzar necesito tu RUT (ej: 12.345.678-9).';
  }
  if (params.field === 'email') {
    if (email) {
      return `Confirmación rápida: ¿Tu email es ${email}?\n1) Sí\n2) No (escríbelo)`;
    }
    return '¿Me indicas tu email? (opcional; si no tienes, escribe “no tengo”).';
  }
  if (params.field === 'experience') {
    if (experienceYears !== null) {
      return `Confirmación rápida: ¿Tienes ${experienceYears} años de experiencia?\n1) Sí\n2) No (cuéntame años y rubros)`;
    }
    return '¿Cuánta experiencia tienes en ventas? (años y rubros; si hiciste terreno, indícalo).';
  }
  if (params.field === 'availability') {
    if (availabilityText) {
      return `Confirmación rápida: ¿Tu disponibilidad es “${availabilityText}”?\n1) Sí\n2) No (indícala)`;
    }
    return '¿Cuál es tu disponibilidad para empezar?';
  }
  return '¿Me confirmas ese dato, por favor?';
}

async function bumpAskedField(conversationId: string, field: string, askedHash: string) {
  const now = new Date();
  await prisma.conversationAskedField.upsert({
    where: { conversationId_field: { conversationId, field } },
    create: {
      conversationId,
      field,
      askCount: 1,
      lastAskedAt: now,
      lastAskedHash: askedHash,
      updatedAt: now,
    },
    update: {
      askCount: { increment: 1 },
      lastAskedAt: now,
      lastAskedHash: askedHash,
      updatedAt: now,
    },
  });
}

async function logOutbound(params: {
  workspaceId: string;
  conversationId: string;
  agentRunId?: string | null;
  type: string;
  templateName?: string | null;
  dedupeKey: string;
  textHash: string;
  blockedReason?: string | null;
  waMessageId?: string | null;
}) {
  await prisma.outboundMessageLog.create({
    data: {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      agentRunId: params.agentRunId || null,
      channel: 'WHATSAPP',
      type: params.type,
      templateName: params.templateName || null,
      dedupeKey: params.dedupeKey,
      textHash: params.textHash,
      blockedReason: params.blockedReason || null,
      waMessageId: params.waMessageId || null,
    },
  });
}

async function shouldBlockOutbound(params: {
  conversationId: string;
  dedupeKey: string;
  textHash: string;
}): Promise<string | null> {
  const since = new Date(Date.now() - 120_000);
  const recentLogs = await prisma.outboundMessageLog.findMany({
    where: {
      conversationId: params.conversationId,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { dedupeKey: true, textHash: true, blockedReason: true, createdAt: true },
  });
  return computeOutboundBlockReason({ recentLogs, dedupeKey: params.dedupeKey, textHash: params.textHash });
}

export async function executeAgentResponse(params: {
  app: FastifyInstance;
  workspaceId: string;
  agentRunId: string;
  response: AgentResponse;
  transportMode: ExecutorTransportMode;
}): Promise<{ results: ExecuteResult[] }> {
  const config = await getSystemConfig();
  const results: ExecuteResult[] = [];

  const conversationIds = new Set(
    params.response.commands
      .filter((cmd) => (cmd as any).conversationId)
      .map((cmd) => String((cmd as any).conversationId)),
  );
  if (conversationIds.size > 1) {
    await prisma.agentRunLog.update({
      where: { id: params.agentRunId },
      data: { status: 'ERROR', error: 'Multi-conversation commands no soportado en v1' },
    });
    throw new Error('Multi-conversation commands no soportado en v1');
  }

  const conversationId =
    conversationIds.size === 1 ? Array.from(conversationIds)[0] : (null as any);

  const baseConversation = conversationId
    ? await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { contact: true, phoneLine: true },
      })
    : null;

  const askedFieldCounts = conversationId
    ? await prisma.conversationAskedField.findMany({
        where: { conversationId },
        select: { field: true, askCount: true },
      })
    : [];
  const askCountByField = new Map<string, number>();
  for (const row of askedFieldCounts) {
    askCountByField.set(row.field, row.askCount);
  }

  const windowStatus = conversationId
    ? await computeWhatsAppWindowStatus(conversationId)
    : ('IN_24H' as WhatsAppWindowStatus);

  for (const cmd of params.response.commands) {
    if (cmd.command === 'UPSERT_PROFILE_FIELDS') {
      const contact = await prisma.contact.findUnique({ where: { id: cmd.contactId } });
      if (!contact) {
        results.push({ ok: false, details: { error: 'contact_not_found', contactId: cmd.contactId } });
        continue;
      }

      const patch: Record<string, any> = { ...cmd.patch };
      if (patch.candidateName) {
        const manual = String((contact as any).candidateNameManual || '').trim();
        if (manual) {
          delete patch.candidateName;
        } else if (isSuspiciousCandidateName(patch.candidateName)) {
          delete patch.candidateName;
        }
      }

      await prisma.contact.update({
        where: { id: cmd.contactId },
        data: patch,
      });
      results.push({ ok: true });
      continue;
    }

    if (cmd.command === 'SET_CONVERSATION_STATUS') {
      await prisma.conversation.update({
        where: { id: cmd.conversationId },
        data: { status: cmd.status, updatedAt: new Date() },
      });
      results.push({ ok: true });
      continue;
    }

    if (cmd.command === 'SET_CONVERSATION_STAGE') {
      await prisma.conversation.update({
        where: { id: cmd.conversationId },
        data: {
          conversationStage: cmd.stage,
          stageReason: cmd.reason || null,
          updatedAt: new Date(),
        },
      });
      results.push({ ok: true });
      continue;
    }

    if (cmd.command === 'SET_CONVERSATION_PROGRAM') {
      await prisma.conversation.update({
        where: { id: cmd.conversationId },
        data: { programId: cmd.programId, updatedAt: new Date() },
      });
      results.push({ ok: true });
      continue;
    }

    if (cmd.command === 'ADD_CONVERSATION_NOTE') {
      await prisma.message.create({
        data: {
          conversationId: cmd.conversationId,
          direction: 'OUTBOUND',
          text: cmd.note,
          rawPayload: serializeJson({ system: true, visibility: cmd.visibility }),
          timestamp: new Date(),
          read: true,
        },
      });
      await prisma.conversation.update({
        where: { id: cmd.conversationId },
        data: { updatedAt: new Date() },
      });
      results.push({ ok: true });
      continue;
    }

    if (cmd.command === 'SET_NO_CONTACTAR') {
      await prisma.contact.update({
        where: { id: cmd.contactId },
        data: {
          noContact: cmd.value,
          noContactAt: cmd.value ? new Date() : null,
          noContactReason: cmd.value ? cmd.reason : null,
        },
      });
      results.push({ ok: true });
      continue;
    }

    if (cmd.command === 'SCHEDULE_INTERVIEW') {
      const convo = await prisma.conversation.findUnique({
        where: { id: cmd.conversationId },
        include: { contact: true },
      });
      if (!convo) {
        results.push({ ok: false, details: { error: 'conversation_not_found', conversationId: cmd.conversationId } });
        continue;
      }

      const fromIso = cmd.datetimeISO ? new Date(cmd.datetimeISO) : null;
      const day = cmd.day || (fromIso ? fromIso.toLocaleDateString('es-CL', { weekday: 'long' }) : null);
      const time = cmd.time || (fromIso ? fromIso.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false }) : null);
      const location = cmd.locationText || null;

      const attempt = await attemptScheduleInterview({
        conversationId: convo.id,
        contactId: convo.contactId,
        day: day ? String(day) : null,
        time: time ? String(time) : null,
        location,
        config,
      });
      results.push({ ok: attempt.ok, details: attempt });
      continue;
    }

    if (cmd.command === 'SEND_MESSAGE') {
      if (!baseConversation) {
        results.push({ ok: false, details: { error: 'missing_conversation_context' } });
        continue;
      }

      const contact = baseConversation.contact;
      if (contact.noContact) {
        const textHash = stableHash(`NO_CONTACT:${cmd.type}:${cmd.text || ''}:${cmd.templateName || ''}`);
        await logOutbound({
          workspaceId: params.workspaceId,
          conversationId: baseConversation.id,
          agentRunId: params.agentRunId,
          type: cmd.type,
          templateName: cmd.type === 'TEMPLATE' ? cmd.templateName || null : null,
          dedupeKey: cmd.dedupeKey,
          textHash,
          blockedReason: 'NO_CONTACTAR',
        });
        results.push({ ok: true, blocked: true, blockedReason: 'NO_CONTACTAR' });
        continue;
      }

      if (windowStatus === 'OUTSIDE_24H' && cmd.type === 'SESSION_TEXT') {
        const textHash = stableHash(`WINDOW:${cmd.type}:${cmd.text || ''}`);
        await logOutbound({
          workspaceId: params.workspaceId,
          conversationId: baseConversation.id,
          agentRunId: params.agentRunId,
          type: cmd.type,
          templateName: null,
          dedupeKey: cmd.dedupeKey,
          textHash,
          blockedReason: 'OUTSIDE_24H_REQUIRES_TEMPLATE',
        });
        results.push({ ok: true, blocked: true, blockedReason: 'OUTSIDE_24H_REQUIRES_TEMPLATE' });
        continue;
      }

      let effectiveText = cmd.text || '';
      let guardrailOverride: any = null;
      if (cmd.type === 'SESSION_TEXT' && effectiveText) {
        const askedFields = detectAskedFields(effectiveText);
        const loopField = askedFields.find((f) => (askCountByField.get(f) || 0) >= 2) || null;
        if (loopField) {
          effectiveText = buildLoopBreakerQuestion({ field: loopField, contact });
          guardrailOverride = { type: 'ASKED_FIELD_LOOP_BREAKER', field: loopField };
        }
      }

      const payloadHash = stableHash(
        cmd.type === 'TEMPLATE'
          ? `TEMPLATE:${cmd.templateName || ''}:${serializeJson(cmd.templateVars || {})}`
          : `TEXT:${effectiveText}`,
      );

      const blockReason = await shouldBlockOutbound({
        conversationId: baseConversation.id,
        dedupeKey: cmd.dedupeKey,
        textHash: payloadHash,
      });
      if (blockReason) {
        await logOutbound({
          workspaceId: params.workspaceId,
          conversationId: baseConversation.id,
          agentRunId: params.agentRunId,
          type: cmd.type,
          templateName: cmd.type === 'TEMPLATE' ? cmd.templateName || null : null,
          dedupeKey: cmd.dedupeKey,
          textHash: payloadHash,
          blockedReason: blockReason,
        });
        results.push({ ok: true, blocked: true, blockedReason: blockReason });
        continue;
      }

      const toWaId =
        contact.waId || contact.phone || (params.transportMode === 'NULL' ? 'sandbox' : null);
      if (!toWaId) {
        results.push({ ok: false, details: { error: 'missing_contact_waid' } });
        continue;
      }

      const phoneNumberId = baseConversation.phoneLine?.waPhoneNumberId || null;

      let sendResult: SendResult = { success: true, messageId: `null-${Date.now()}` };
      if (params.transportMode === 'REAL') {
        sendResult =
          cmd.type === 'TEMPLATE'
            ? await sendWhatsAppTemplate(
                toWaId,
                cmd.templateName || '',
                cmd.templateVars ? Object.values(cmd.templateVars) : undefined,
                { phoneNumberId },
              )
            : await sendWhatsAppText(toWaId, effectiveText, { phoneNumberId });
      }

      await prisma.message.create({
        data: {
          conversationId: baseConversation.id,
          direction: 'OUTBOUND',
          text:
            cmd.type === 'TEMPLATE'
              ? `[TEMPLATE] ${cmd.templateName || ''}`
              : effectiveText,
          rawPayload: serializeJson({
            system: true,
            agentRunId: params.agentRunId,
            dedupeKey: cmd.dedupeKey,
            sendResult,
            templateVars: cmd.templateVars || null,
            guardrailOverride,
          }),
          timestamp: new Date(),
          read: true,
        },
      });
      await prisma.conversation.update({
        where: { id: baseConversation.id },
        data: { updatedAt: new Date() },
      });

      await logOutbound({
        workspaceId: params.workspaceId,
        conversationId: baseConversation.id,
        agentRunId: params.agentRunId,
        type: cmd.type,
        templateName: cmd.type === 'TEMPLATE' ? cmd.templateName || null : null,
        dedupeKey: cmd.dedupeKey,
        textHash: payloadHash,
        blockedReason: sendResult.success ? null : `SEND_FAILED:${sendResult.error || 'unknown'}`,
        waMessageId: sendResult.messageId || null,
      });

      if (params.transportMode === 'REAL' && baseConversation.phoneLineId) {
        await prisma.phoneLine
          .update({
            where: { id: baseConversation.phoneLineId },
            data: { lastOutboundAt: new Date() },
          })
          .catch(() => {});
      }

      const askedFields = cmd.type === 'SESSION_TEXT' ? detectAskedFields(effectiveText) : [];
      const askedHash = payloadHash;
      for (const field of askedFields) {
        await bumpAskedField(baseConversation.id, field, askedHash).catch(() => {});
        askCountByField.set(field, (askCountByField.get(field) || 0) + 1);
      }

      results.push({ ok: true, details: { sendResult } });
      continue;
    }

    if (cmd.command === 'NOTIFY_ADMIN') {
      if (!baseConversation) {
        results.push({ ok: false, details: { error: 'missing_conversation_context' } });
        continue;
      }

      // v1: reuse existing AdminNotificationService for WA + CRM logging.
      const contact = baseConversation.contact;
      const displayName = getContactDisplayName(contact);
      await sendAdminNotification({
        app: params.app,
        eventType: cmd.eventType as any,
        contact,
        summary: cmd.text || `Evento: ${cmd.eventType} para ${displayName}`,
      });
      results.push({ ok: true });
      continue;
    }

    if (cmd.command === 'RUN_TOOL') {
      results.push({ ok: true, details: { ignored: true } });
      continue;
    }

    results.push({ ok: false, details: { error: 'unknown_command', command: (cmd as any).command } });
  }

  await prisma.agentRunLog.update({
    where: { id: params.agentRunId },
    data: { status: 'EXECUTED', resultsJson: serializeJson({ results }) },
  });

  return { results };
}
