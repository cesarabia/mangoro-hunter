import { FastifyInstance } from 'fastify';
import { handleInboundWhatsAppMessage } from '../services/whatsappInboundService';
import { getSystemConfig } from '../services/configService';
import { normalizeWhatsAppId } from '../utils/whatsapp';

export async function registerSimulationRoutes(app: FastifyInstance) {
  app.post('/whatsapp', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { from, text, media } = request.body as {
      from?: string;
      text?: string;
      media?: {
        type?: string;
        id?: string;
        mimeType?: string;
        filename?: string;
        caption?: string;
        dataBase64?: string;
      } | null;
    };

    const trimmedText = (text || '').trim();
    const hasMedia = Boolean(media && media.type);
    if (!from || (!trimmedText && !hasMedia)) {
      return reply
        .code(400)
        .send({ error: '"from" es obligatorio y debes enviar "text" o "media".' });
    }

    const config = await getSystemConfig();
    const normalizedFrom = normalizeWhatsAppId(from);
    const testWaId = normalizeWhatsAppId(config.testPhoneNumber || '');
    const adminWaId = normalizeWhatsAppId(config.adminWaId || '');
    const allowed = new Set([testWaId, adminWaId].filter(Boolean) as string[]);
    if (!normalizedFrom) {
      return reply.code(400).send({ error: '"from" inválido (usa E.164).' });
    }
    // Guardrail: simulation is TEST-ONLY and must never introduce synthetic candidate numbers in PROD.
    if (allowed.size > 0 && !allowed.has(normalizedFrom)) {
      return reply.code(400).send({
        error:
          'Simulación bloqueada: /api/simulate/whatsapp solo permite testPhoneNumber/adminWaId configurados.'
      });
    }

    const result = await handleInboundWhatsAppMessage(app, {
      from: normalizedFrom,
      text: trimmedText,
      media: hasMedia
        ? {
          type: String(media?.type || ''),
          id: String(media?.id || `sim-${Date.now()}`),
            mimeType: media?.mimeType,
            filename: media?.filename,
            caption: media?.caption,
            dataBase64: media?.dataBase64
          }
        : null,
      rawPayload: {
        simulated: true,
        text: trimmedText || null,
        media: hasMedia
          ? {
              type: media?.type || null,
              mimeType: media?.mimeType || null,
              filename: media?.filename || null,
              caption: media?.caption || null
            }
          : null
      }
    });

    return reply.send({ status: 'ok', conversationId: result.conversationId });
  });
}
