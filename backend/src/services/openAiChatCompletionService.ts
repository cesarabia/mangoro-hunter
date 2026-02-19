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

export class OpenAiRequestTimeoutError extends Error {
  model: string;
  timeoutMs: number;
  constructor(model: string, timeoutMs: number) {
    super(`OpenAI request timeout for model ${model} after ${timeoutMs}ms`);
    this.name = 'OpenAiRequestTimeoutError';
    this.model = model;
    this.timeoutMs = timeoutMs;
  }
}

function withTimeout<T>(promise: Promise<T>, model: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OpenAiRequestTimeoutError(model, timeoutMs)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
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
  models: string[],
  options?: {
    perRequestTimeoutMs?: number;
    totalTimeoutMs?: number;
  }
): Promise<{ completion: any; modelRequested: string; modelResolved: string; fallbackUsed: boolean }> {
  const chain = getUniqueModelFallbackChain(models);
  const first = chain[0] || 'gpt-4.1-mini';
  const perRequestTimeoutMs = Number.isFinite(options?.perRequestTimeoutMs as number)
    ? Math.max(1_000, Math.floor(options?.perRequestTimeoutMs as number))
    : 9_000;
  const totalTimeoutMs = Number.isFinite(options?.totalTimeoutMs as number)
    ? Math.max(2_000, Math.floor(options?.totalTimeoutMs as number))
    : 12_000;
  const startedAt = Date.now();
  let lastError: any = null;
  for (let idx = 0; idx < chain.length; idx += 1) {
    const candidate = chain[idx];
    try {
      const elapsed = Date.now() - startedAt;
      const remainingBudget = totalTimeoutMs - elapsed;
      if (remainingBudget <= 0) {
        throw new OpenAiRequestTimeoutError(candidate, totalTimeoutMs);
      }
      const timeoutForThisAttempt = Math.max(1_000, Math.min(perRequestTimeoutMs, remainingBudget));
      const normalizedArgs = normalizeChatCreateArgsForModel(createArgs, candidate);
      const completion = await withTimeout(
        client.chat.completions.create({ ...normalizedArgs, model: candidate }),
        candidate,
        timeoutForThisAttempt
      );
      return {
        completion,
        modelRequested: first,
        modelResolved: candidate,
        fallbackUsed: idx > 0,
      };
    } catch (err: any) {
      lastError = err;
      const timedOut = err instanceof OpenAiRequestTimeoutError;
      if ((isOpenAiModelError(err) || timedOut) && idx < chain.length - 1) {
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('OpenAI completion failed');
}
