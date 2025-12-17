import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import OpenAI from 'openai';
import { resolveWorkspaceAccess } from '../services/workspaceAuthService';
import { runAgent } from '../services/agent/agentRuntimeService';

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
    const access = await resolveWorkspaceAccess(request);
    const { id } = request.params as { id: string };
    const { draft } = request.body as { draft?: string };

    const conversation = await prisma.conversation.findFirst({
      where: { id, workspaceId: access.workspaceId },
      include: {
        program: { select: { id: true, slug: true } },
        messages: {
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    try {
      const agent = await runAgent({
        workspaceId: access.workspaceId,
        conversationId: conversation.id,
        eventType: 'AI_SUGGEST',
        inboundMessageId: null,
        draftText: typeof draft === 'string' ? draft.trim() : null,
      });
      const send = agent.response.commands.find((c: any) => c && typeof c === 'object' && c.command === 'SEND_MESSAGE') as any;
      if (!send) {
        return reply.code(502).send({ error: 'El agente no devolvió un SEND_MESSAGE para sugerencia.' });
      }
      if (send.type === 'TEMPLATE') {
        const vars =
          send.templateVars && typeof send.templateVars === 'object'
            ? Object.entries(send.templateVars)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n')
            : '';
        const suggestion = [`(Fuera de ventana 24h) Debes usar plantilla: ${send.templateName || '(sin nombre)'}`, vars].filter(Boolean).join('\n');
        return { suggestion: suggestion.trim() };
      }
      const suggestion = typeof send.text === 'string' ? send.text : '';
      if (!suggestion.trim()) {
        return reply.code(502).send({ error: 'El agente devolvió un SEND_MESSAGE sin texto.' });
      }
      return { suggestion };
    } catch (err: any) {
      const { status, message } = formatAiError(err, null);
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
