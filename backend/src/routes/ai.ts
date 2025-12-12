import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { getSuggestedReply } from '../services/aiService';

export async function registerAiRoutes(app: FastifyInstance) {
  app.post('/:id/ai-suggest', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

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

    const context = conversation.messages
      .map(m => (m.direction === 'INBOUND' ? `Candidato: ${m.text}` : `Agente: ${m.text}`))
      .join('\n');

    const suggestion = await getSuggestedReply(context);

    return { suggestion };
  });
}
