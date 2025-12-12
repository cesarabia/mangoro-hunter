import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { getSuggestedReply } from '../services/aiService';
import {
  getSystemConfig,
  DEFAULT_INTERVIEW_AI_PROMPT,
  DEFAULT_INTERVIEW_AI_MODEL
} from '../services/configService';
import { DEFAULT_AI_PROMPT } from '../constants/ai';

export async function registerAiRoutes(app: FastifyInstance) {
  app.post('/:id/ai-suggest', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { draft } = request.body as { draft?: string };

    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: {
        messages: {
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }

    if (conversation.aiMode === 'OFF') {
      return reply.code(400).send({ error: 'Modo manual no permite sugerencias automáticas' });
    }

    const recentMessages = conversation.messages.slice(-15);
    const context = recentMessages
      .map(m => (m.direction === 'INBOUND' ? `Candidato: ${m.text}` : `Agente: ${m.text}`))
      .join('\n');

    const config = await getSystemConfig();
    let prompt = config.aiPrompt?.trim() || DEFAULT_AI_PROMPT;
    let model: string | undefined;
    if (conversation.aiMode === 'INTERVIEW') {
      prompt = config.interviewAiPrompt?.trim() || DEFAULT_INTERVIEW_AI_PROMPT;
      model = config.interviewAiModel?.trim() || DEFAULT_INTERVIEW_AI_MODEL;
    }

    const enrichedContext = `${context}\n\nBorrador actual del agente: ${draft?.trim() || '(vacío)'}\nGenera una respuesta corta lista para enviar.`;

    const suggestion = await getSuggestedReply(enrichedContext, { prompt, model, config });

    return { suggestion };
  });
}
