import OpenAI from 'openai';
import { env } from '../config/env';
import { getSystemConfig } from './configService';
import { DEFAULT_AI_PROMPT } from '../constants/ai';

export async function getSuggestedReply(conversationContext: string): Promise<string> {
  const config = await getSystemConfig();
  const prompt = config.aiPrompt?.trim() || DEFAULT_AI_PROMPT;
  const apiKey = getEffectiveOpenAiKey(config);

  if (!apiKey) {
    return fallbackReply();
  }

  const client = new OpenAI({ apiKey });

  const completion = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [
      {
        role: 'system',
        content: prompt
      },
      {
        role: 'user',
        content: conversationContext || 'Conversación previa del candidato'
      }
    ],
    max_tokens: 180
  });

  const text = completion.choices[0]?.message?.content || '';
  return text.trim();
}

export function getEffectiveOpenAiKey(
  config: Awaited<ReturnType<typeof getSystemConfig>>
): string | null {
  if (config.openAiApiKey && config.openAiApiKey.trim().length > 0) {
    return config.openAiApiKey.trim();
  }
  if (env.openAIApiKey && env.openAIApiKey.trim().length > 0) {
    return env.openAIApiKey.trim();
  }
  return null;
}

function fallbackReply(): string {
  return 'Gracias por escribir a Postulaciones. Cuéntame en qué ciudad o comuna estás, qué experiencia tienes en ventas y tu disponibilidad. Revisaremos tu perfil para una posible entrevista.';
}

export async function summarizeConversationForAdmin(
  conversationLines: string[],
  configOverride?: Awaited<ReturnType<typeof getSystemConfig>>
): Promise<string | null> {
  const config = configOverride ?? (await getSystemConfig());
  const apiKey = getEffectiveOpenAiKey(config);
  if (!apiKey) {
    return null;
  }

  const client = new OpenAI({ apiKey });
  const conversationText = conversationLines.slice(-30).join('\n') || 'Sin mensajes recientes';

  const completion = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [
      {
        role: 'system',
        content: 'Eres un coordinador de reclutamiento. Resume la conversación en 2 a 5 líneas claras con contexto y próximos pasos.'
      },
      {
        role: 'user',
        content: conversationText
      }
    ],
    max_tokens: 150,
    temperature: 0.4
  });

  const summary = completion.choices[0]?.message?.content?.trim();
  return summary && summary.length > 0 ? summary : null;
}
