import OpenAI from 'openai';

export function getUniqueModelFallbackChain(models: Array<string | null | undefined>): string[] {
  const unique: string[] = [];
  for (const raw of models) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    if (!unique.includes(value)) unique.push(value);
  }
  return unique;
}

export function isOpenAiModelError(err: any): boolean {
  if (!(err instanceof OpenAI.APIError)) return false;
  const code = (err as any).code || err.status;
  if (code === 'invalid_model' || code === 'model_not_found') return true;
  const detail = (err as any).error?.message || err.message;
  return typeof detail === 'string' && /model/i.test(detail) && /(not found|invalid)/i.test(detail);
}

function requiresMaxCompletionTokens(model: string): boolean {
  const normalized = String(model || '').trim().toLowerCase();
  return normalized.startsWith('gpt-5');
}

export function normalizeChatCreateArgsForModel(createArgs: any, model: string): any {
  const next = { ...(createArgs || {}) } as any;
  if (requiresMaxCompletionTokens(model)) {
    if (typeof next.max_completion_tokens === 'undefined' && typeof next.max_tokens !== 'undefined') {
      next.max_completion_tokens = next.max_tokens;
    }
    delete next.max_tokens;
    // GPT-5 chat endpoints currently only accept the default temperature.
    // Omit explicit temperature to avoid request errors.
    delete next.temperature;
  }
  return next;
}

export async function createChatCompletionWithModelFallback(
  client: OpenAI,
  createArgs: any,
  models: string[]
): Promise<{ completion: any; modelRequested: string; modelResolved: string; fallbackUsed: boolean }> {
  const chain = getUniqueModelFallbackChain(models);
  const first = chain[0] || 'gpt-4.1-mini';
  let lastError: any = null;
  for (let idx = 0; idx < chain.length; idx += 1) {
    const candidate = chain[idx];
    try {
      const normalizedArgs = normalizeChatCreateArgsForModel(createArgs, candidate);
      const completion = await client.chat.completions.create({ ...normalizedArgs, model: candidate });
      return {
        completion,
        modelRequested: first,
        modelResolved: candidate,
        fallbackUsed: idx > 0,
      };
    } catch (err: any) {
      lastError = err;
      if (isOpenAiModelError(err) && idx < chain.length - 1) {
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('OpenAI completion failed');
}
