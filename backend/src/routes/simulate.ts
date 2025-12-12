import { FastifyInstance } from 'fastify';
import { handleInboundWhatsAppMessage } from '../services/whatsappInboundService';

export async function registerSimulationRoutes(app: FastifyInstance) {
  app.post('/whatsapp', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { from, text } = request.body as { from?: string; text?: string };

    if (!from || !text) {
      return reply.code(400).send({ error: '"from" y "text" son obligatorios' });
    }

    const result = await handleInboundWhatsAppMessage(app, {
      from,
      text,
      rawPayload: { simulated: true, text }
    });

    return reply.send({ status: 'ok', conversationId: result.conversationId });
  });
}
