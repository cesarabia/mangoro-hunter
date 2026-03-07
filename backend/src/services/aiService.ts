import OpenAI from 'openai';
import { env } from '../config/env';
import { getSystemConfig, DEFAULT_AI_MODEL, DEFAULT_ADMIN_AI_MODEL } from './configService';
import { DEFAULT_AI_PROMPT } from '../constants/ai';
import { createChatCompletionWithModelFallback } from './openAiChatCompletionService';
import { resolveModelChain } from './modelResolutionService';

interface SuggestedOptions {
  prompt?: string;
  model?: string;
  config?: Awaited<ReturnType<typeof getSystemConfig>>;
}

export async function getSuggestedReply(
  conversationContext: string,
  options?: SuggestedOptions
): Promise<string> {
  const config = options?.config ?? (await getSystemConfig());
  const prompt = options?.prompt?.trim() || config.aiPrompt?.trim() || DEFAULT_AI_PROMPT;
  const apiKey = getEffectiveOpenAiKey(config);

  if (!apiKey) {
    return fallbackReply();
  }

  const client = new OpenAI({ apiKey });
  const resolvedModels = resolveModelChain({
    modelOverride: typeof options?.model === 'string' ? options.model : (config as any).aiModelOverride,
    modelAlias: (config as any).aiModelAlias,
    legacyModel: config.aiModel,
    defaultModel: DEFAULT_AI_MODEL,
  });
  const modelChain = resolvedModels.modelChain;

  const completionResult = await createChatCompletionWithModelFallback(
    client,
    {
      messages: [
        {
          role: 'system',
          content: prompt,
        },
        {
          role: 'user',
          content: conversationContext || 'Conversación previa del candidato',
        },
      ],
      max_tokens: 180,
    },
    modelChain
  );
  const completion = completionResult.completion;

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
  return 'Estoy con un problema técnico para generar una sugerencia ahora (OPENAI_NOT_CONFIGURED).';
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
    model: DEFAULT_ADMIN_AI_MODEL,
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
