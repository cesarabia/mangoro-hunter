import OpenAI from 'openai';
import { FastifyInstance } from 'fastify';
import { SystemConfig } from '@prisma/client';
import {
  adminGetConversationDetails,
  adminGetStats,
  adminListConversations,
  getAdminHelpText,
  setConversationStatusByWaId,
  summarizeConversationByWaId
} from './whatsappAdminCommandService';
import { getSystemConfig, DEFAULT_ADMIN_AI_PROMPT, DEFAULT_ADMIN_AI_MODEL } from './configService';
import { getEffectiveOpenAiKey } from './aiService';
import { normalizeWhatsAppId } from '../utils/whatsapp';

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
  params: { waId: string; text: string; config?: SystemConfig }
): Promise<string> {
  const config = params.config ?? (await getSystemConfig());
  const apiKey = getEffectiveOpenAiKey(config);
  if (!apiKey) {
    return 'Configura una clave de OpenAI para usar el asistente admin.';
  }

  const client = new OpenAI({ apiKey });
  const model = config.adminAiModel?.trim() || DEFAULT_ADMIN_AI_MODEL;
  const prompt = config.adminAiPrompt?.trim() || DEFAULT_ADMIN_AI_PROMPT;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content:
        `${prompt}\n` +
        'Habla siempre en español. Usa los datos de las herramientas para responder con números concretos y acciones claras.'
    },
    { role: 'user', content: params.text }
  ];

  const reply = await runWithTools(client, model, messages, config);
  return reply?.trim() || 'No pude generar la respuesta en este momento.';
}

async function runWithTools(
  client: OpenAI,
  model: string,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  config: SystemConfig
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
        const result = await executeAdminTool(toolCall.function.name, toolCall.function.arguments, config);
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

async function executeAdminTool(name: string, argumentString: string | undefined, config: SystemConfig) {
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
      const waId = ensureWaId(args?.waId);
      if (!waId) return { error: 'Debes indicar el número del candidato.' };
      const details = await adminGetConversationDetails(waId);
      return details ?? { error: 'No encontré esa conversación.' };
    }
    case 'admin_summarize_conversation': {
      const waId = ensureWaId(args?.waId);
      if (!waId) return { error: 'Debes indicar el número del candidato.' };
      const { summary, label } = await summarizeConversationByWaId(waId, config);
      if (!summary) return { error: 'No encontré esa conversación.' };
      return { summary, label };
    }
    case 'admin_set_status': {
      const waId = ensureWaId(args?.waId);
      const status = typeof args?.status === 'string' ? args.status.toUpperCase() : null;
      if (!waId || !status || !['NEW', 'OPEN', 'CLOSED'].includes(status)) {
        return { error: 'Debes indicar número y estado (NEW, OPEN o CLOSED).' };
      }
      const result = await setConversationStatusByWaId(waId, status as 'NEW' | 'OPEN' | 'CLOSED');
      if (!result) return { error: 'No encontré esa conversación.' };
      return { success: true, label: result.label, status };
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

function normalizeNumber(value: any, fallback?: number, min?: number, max?: number): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  let final = Math.floor(value);
  if (typeof min === 'number') final = Math.max(min, final);
  if (typeof max === 'number') final = Math.min(max, final);
  return final;
}
