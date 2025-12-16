import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { getSuggestedReply } from '../services/aiService';
import {
  getSystemConfig,
  DEFAULT_INTERVIEW_AI_PROMPT,
  DEFAULT_INTERVIEW_AI_MODEL,
  INTERVIEW_AI_POLICY_ADDENDUM,
  DEFAULT_AI_MODEL,
  normalizeModelId,
  DEFAULT_SALES_AI_PROMPT
} from '../services/configService';
import { DEFAULT_AI_PROMPT, DEFAULT_MANUAL_SUGGEST_PROMPT } from '../constants/ai';
import OpenAI from 'openai';

function truncateText(text: string, maxLength: number): string {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function buildAiMessageText(m: {
  text?: string | null;
  transcriptText?: string | null;
  mediaType?: string | null;
}): string {
  const base = (m.text || '').trim();
  const transcript = (m.transcriptText || '').trim();
  if (!transcript || transcript === base) return base || '(sin texto)';
  if (m.mediaType === 'audio' || m.mediaType === 'voice') return transcript || base || '(sin texto)';
  const snippet = truncateText(transcript, 2000);
  if (!base) return `[Adjunto transcrito]\n${snippet}`;
  return `${base}\n[Adjunto transcrito]\n${snippet}`;
}

export async function registerAiRoutes(app: FastifyInstance) {
  app.post('/:id/ai-suggest', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { draft } = request.body as { draft?: string };

    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: {
        program: { select: { slug: true } },
        messages: {
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    const paused = Boolean((conversation as any).aiPaused);
    const programSlug = String((conversation as any)?.program?.slug || '').toLowerCase();
    const inferredMode =
      programSlug === 'interview'
        ? 'INTERVIEW'
        : programSlug === 'sales'
        ? 'SELLER'
        : programSlug === 'recruitment'
        ? 'RECRUIT'
        : null;
    const mode = paused
      ? 'OFF'
      : inferredMode
      ? inferredMode
      : conversation.aiMode === 'INTERVIEW'
      ? 'INTERVIEW'
      : conversation.aiMode === 'OFF'
      ? 'OFF'
      : 'RECRUIT';

    const recentMessages = conversation.messages.slice(-15);
    const context = recentMessages
      .map(m => {
        const line = buildAiMessageText(m);
        return m.direction === 'INBOUND' ? `Candidato: ${line}` : `Agente: ${line}`;
      })
      .join('\n');

    const config = await getSystemConfig();
    let prompt = config.aiPrompt?.trim() || DEFAULT_AI_PROMPT;
    let model: string | undefined = normalizeModelId(config.aiModel?.trim() || DEFAULT_AI_MODEL) || DEFAULT_AI_MODEL;
    if (mode === 'INTERVIEW') {
      prompt = config.interviewAiPrompt?.trim() || DEFAULT_INTERVIEW_AI_PROMPT;
      prompt = `${prompt}\n\n${INTERVIEW_AI_POLICY_ADDENDUM}`;
      model = normalizeModelId(config.interviewAiModel?.trim() || DEFAULT_INTERVIEW_AI_MODEL) || DEFAULT_INTERVIEW_AI_MODEL;
    }
    if (mode === 'SELLER') {
      prompt = config.salesAiPrompt?.trim() || DEFAULT_SALES_AI_PROMPT;
      model = normalizeModelId(config.aiModel?.trim() || DEFAULT_AI_MODEL) || DEFAULT_AI_MODEL;
    }

    if (mode === 'OFF') {
      prompt = DEFAULT_MANUAL_SUGGEST_PROMPT;
      const trimmedDraft = (draft || '').trim();
      if (!trimmedDraft) {
        return reply
          .code(400)
          .send({ error: 'Escribe un borrador para que la IA lo mejore en modo Manual.' });
      }
      const enrichedContext = `${context}\n\nBorrador del agente:\n${trimmedDraft}\n\nMejora el borrador manteniendo el mismo significado. Responde solo con el texto final.`;
      try {
        const suggestion = await getSuggestedReply(enrichedContext, { prompt, model, config });
        return { suggestion };
      } catch (err: any) {
        const { status, message } = formatAiError(err, model);
        request.log.error({ err }, 'ai_suggest manual failed');
        return reply.code(status).send({ error: message });
      }
    }

    const enrichedContext = `${context}\n\nBorrador actual del agente: ${draft?.trim() || '(vacío)'}\nGenera una respuesta corta lista para enviar.`;

    try {
      const suggestion = await getSuggestedReply(enrichedContext, { prompt, model, config });

      return { suggestion };
    } catch (err: any) {
      const { status, message } = formatAiError(err, model);
      request.log.error({ err }, 'ai_suggest failed');
      return reply.code(status).send({ error: message });
    }
  });
}

function formatAiError(err: any, model?: string | null): { status: number; message: string } {
  const defaultMessage = `Modelo inválido o sin acceso${model ? `: ${model}` : ''}`;
  if (err instanceof OpenAI.APIError) {
    const code = (err as any).code || err.status;
    const detail = (err as any).error?.message || err.message;
    const isModelError =
      code === 'invalid_model' ||
      code === 'model_not_found' ||
      detail?.toLowerCase?.().includes('model') ||
      detail?.toLowerCase?.().includes('invalid');
    return { status: isModelError ? 400 : 502, message: detail || defaultMessage };
  }
  const message =
    (err?.response?.data && JSON.stringify(err.response.data)) ||
    err?.message ||
    defaultMessage;
  return { status: 502, message };
}
