import OpenAI from 'openai';
import { FastifyInstance } from 'fastify';
import { SystemConfig } from '@prisma/client';
import { prisma } from '../db/client';
import {
  adminGetConversationDetails,
  adminGetStats,
  adminListConversations,
  fetchConversationByIdentifier,
  getAdminHelpText,
  setConversationStatusByWaId,
  summarizeConversationByWaId
} from './whatsappAdminCommandService';
import { getSystemConfig, DEFAULT_ADMIN_AI_PROMPT, DEFAULT_ADMIN_AI_MODEL, normalizeModelId } from './configService';
import { getEffectiveOpenAiKey } from './aiService';
import { normalizeWhatsAppId } from '../utils/whatsapp';
import {
  attemptScheduleInterview,
  confirmActiveReservation,
  formatSlotHuman,
  releaseActiveReservation
} from './interviewSchedulerService';

const toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'admin_list_conversations',
      description:
        'Lista conversaciones activas con filtros opcionales (estado, solo no leídos, últimos días). Devuelve nombres, waId, estado y preview.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          filterStatus: { type: 'string', enum: ['NEW', 'OPEN', 'CLOSED'] },
          onlyUnread: { type: 'boolean' },
          activeWithinDays: { type: 'integer', minimum: 1, maximum: 90 }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'admin_set_interview',
      description:
        'Actualiza la conversación de un candidato: modo entrevista, día/hora/lugar y estado de la entrevista.',
      parameters: {
        type: 'object',
        properties: {
          waId: { type: 'string', description: 'Número de WhatsApp, con o sin +' },
          day: { type: 'string', nullable: true },
          time: { type: 'string', nullable: true },
          location: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['PENDING', 'CONFIRMED', 'CANCELLED', 'ON_HOLD'], nullable: true }
        },
        required: [],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'admin_get_conversation_by_waid',
      description: 'Obtiene la conversación (mensajes recientes) para un waId concreto.',
      parameters: {
        type: 'object',
        properties: {
          waId: { type: 'string', description: 'Número de WhatsApp, con o sin +' }
        },
        required: ['waId'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'admin_summarize_conversation',
      description: 'Genera un resumen corto de una conversación identificada por waId.',
      parameters: {
        type: 'object',
        properties: {
          waId: { type: 'string' }
        },
        required: ['waId'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'admin_set_status',
      description: 'Actualiza el estado de una conversación (NEW, OPEN, CLOSED).',
      parameters: {
        type: 'object',
        properties: {
          waId: { type: 'string' },
          status: { type: 'string', enum: ['NEW', 'OPEN', 'CLOSED'] }
        },
        required: ['waId', 'status'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'admin_stats',
      description: 'Devuelve métricas agregadas: totales por estado, activos últimos 7 días y mensajes sin leer.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  }
];

export async function generateAdminAiResponse(
  app: FastifyInstance,
  params: { waId: string; text: string; config?: SystemConfig; lastCandidateWaId?: string | null }
): Promise<string> {
  const config = params.config ?? (await getSystemConfig());
  const apiKey = getEffectiveOpenAiKey(config);
  if (!apiKey) {
    return 'Configura una clave de OpenAI para usar el asistente admin.';
  }

  const client = new OpenAI({ apiKey });
  const model = normalizeModelId(config.adminAiModel?.trim() || DEFAULT_ADMIN_AI_MODEL) || DEFAULT_ADMIN_AI_MODEL;
  const prompt = config.adminAiPrompt?.trim() || DEFAULT_ADMIN_AI_PROMPT;
  const adminConversation = await prisma.conversation.findFirst({
    where: { isAdmin: true },
    orderBy: { updatedAt: 'desc' },
    select: { adminLastCandidateWaId: true }
  });
  const lastCandidate = params.lastCandidateWaId || adminConversation?.adminLastCandidateWaId || null;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content:
        `${prompt}\n` +
        'Habla siempre en español. Usa los datos de las herramientas para responder con números concretos y acciones claras.' +
        (config.adminAiAddendum
          ? `\n\nAprendizajes recientes:\n${config.adminAiAddendum.slice(-4000)}`
          : '')
    },
    lastCandidate
      ? {
          role: 'system',
          content: `Último candidato referenciado: +${lastCandidate}. Si el usuario pregunta sin número, asume ese candidato salvo que se indique otro. Si el usuario responde "sí/ok/ya" después de pedirle confirmación, trátalo como confirmación para el mismo candidato.`
        }
      : null,
    { role: 'user', content: params.text }
  ].filter(Boolean) as OpenAI.Chat.Completions.ChatCompletionMessageParam[];

  const reply = await runWithTools(client, model, messages, config, lastCandidate);
  return reply?.trim() || 'No pude generar la respuesta en este momento.';
}

async function runWithTools(
  client: OpenAI,
  model: string,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  config: SystemConfig,
  lastCandidateWaId?: string | null
): Promise<string | null> {
  for (let iteration = 0; iteration < 4; iteration++) {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.2,
      messages,
      tools: toolDefinitions
    });

    const choice = completion.choices[0];
    const assistantMessage = choice.message;

    if (choice.finish_reason === 'tool_calls' && assistantMessage?.tool_calls?.length) {
      messages.push(assistantMessage);
      for (const toolCall of assistantMessage.tool_calls) {
        const result = await executeAdminTool(
          toolCall.function.name,
          toolCall.function.arguments,
          config,
          lastCandidateWaId
        );
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      }
      continue;
    }

    return assistantMessage?.content || null;
  }
  return null;
}

async function executeAdminTool(
  name: string,
  argumentString: string | undefined,
  config: SystemConfig,
  lastCandidateWaId?: string | null
) {
  let args: any = {};
  if (argumentString) {
    try {
      args = JSON.parse(argumentString);
    } catch {
      args = {};
    }
  }

  switch (name) {
    case 'admin_list_conversations': {
      const items = await adminListConversations({
        limit: normalizeNumber(args?.limit, 10, 1, 50),
        filterStatus: typeof args?.filterStatus === 'string' ? args.filterStatus.toUpperCase() : undefined,
        onlyUnread: Boolean(args?.onlyUnread),
        activeWithinDays: normalizeNumber(args?.activeWithinDays, undefined, 1, 90)
      });
      return { items };
    }
    case 'admin_get_conversation_by_waid': {
      const waId = ensureWaId(args?.waId || lastCandidateWaId);
      if (!waId) return { error: 'Debes indicar el número del candidato.' };
      await setAdminLastCandidate(waId);
      const details = await adminGetConversationDetails(waId);
      return details ?? { error: 'No encontré esa conversación.' };
    }
    case 'admin_summarize_conversation': {
      const waId = ensureWaId(args?.waId || lastCandidateWaId);
      if (!waId) return { error: 'Debes indicar el número del candidato.' };
      await setAdminLastCandidate(waId);
      const { summary, label } = await summarizeConversationByWaId(waId, config);
      if (!summary) return { error: 'No encontré esa conversación.' };
      return { summary, label };
    }
    case 'admin_set_status': {
      const waId = ensureWaId(args?.waId || lastCandidateWaId);
      const status = typeof args?.status === 'string' ? args.status.toUpperCase() : null;
      if (!waId || !status || !['NEW', 'OPEN', 'CLOSED'].includes(status)) {
        return { error: 'Debes indicar número y estado (NEW, OPEN o CLOSED).' };
      }
      await setAdminLastCandidate(waId);
      const result = await setConversationStatusByWaId(waId, status as 'NEW' | 'OPEN' | 'CLOSED');
      if (!result) return { error: 'No encontré esa conversación.' };
      return { success: true, label: result.label, status };
    }
    case 'admin_set_interview': {
      const waId = ensureWaId(args?.waId || lastCandidateWaId);
      if (!waId) return { error: 'Debes indicar el número del candidato.' };
      const conversation = await fetchConversationByIdentifier(waId, { includeMessages: false });
      if (!conversation) return { error: 'No encontré esa conversación.' };
      await setAdminLastCandidate(waId);

      const data: any = { aiMode: 'INTERVIEW', status: 'OPEN' };
      const requestedDay = typeof args?.day === 'string' ? args.day : null;
      const requestedTime = typeof args?.time === 'string' ? args.time : null;
      const requestedLocation = typeof args?.location === 'string' ? args.location : null;
      const requestedStatus =
        typeof args?.status === 'string' ? String(args.status).toUpperCase() : null;

      if (requestedDay && requestedTime) {
        const scheduleAttempt = await attemptScheduleInterview({
          conversationId: conversation.id,
          contactId: conversation.contactId,
          day: requestedDay,
          time: requestedTime,
          location: requestedLocation,
          config
        });
        if (!scheduleAttempt.ok) {
          const alternatives = scheduleAttempt.alternatives.map(slot => formatSlotHuman(slot));
          return { error: scheduleAttempt.message, alternatives };
        }
        data.interviewDay = scheduleAttempt.slot.day;
        data.interviewTime = scheduleAttempt.slot.time;
        data.interviewLocation = scheduleAttempt.slot.location;
        data.interviewStatus = requestedStatus || 'PENDING';
      } else {
        if (typeof args?.day !== 'undefined') data.interviewDay = requestedDay;
        if (typeof args?.time !== 'undefined') data.interviewTime = requestedTime;
        if (typeof args?.location !== 'undefined') data.interviewLocation = requestedLocation;
        if (typeof args?.status !== 'undefined') data.interviewStatus = requestedStatus;
      }

      if (requestedStatus === 'CONFIRMED') {
        await confirmActiveReservation(conversation.id);
      }
      if (requestedStatus === 'CANCELLED' || requestedStatus === 'ON_HOLD') {
        await releaseActiveReservation({
          conversationId: conversation.id,
          status: requestedStatus as 'CANCELLED' | 'ON_HOLD'
        });
      }

      await prisma.conversation.update({
        where: { id: conversation.id },
        data
      });

      return { success: true, waId, updated: data };
    }
    case 'admin_stats': {
      const stats = await adminGetStats();
      return stats;
    }
    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
}

function ensureWaId(value?: string | null): string | null {
  if (!value) return null;
  return normalizeWhatsAppId(value);
}

async function setAdminLastCandidate(waId: string) {
  await prisma.conversation.updateMany({
    where: { isAdmin: true },
    data: { adminLastCandidateWaId: waId }
  });
}

function normalizeNumber(value: any, fallback?: number, min?: number, max?: number): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  let final = Math.floor(value);
  if (typeof min === 'number') final = Math.max(min, final);
  if (typeof max === 'number') final = Math.min(max, final);
  return final;
}
