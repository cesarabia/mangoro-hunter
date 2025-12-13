import { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { prisma } from '../db/client';

export async function registerMessageRoutes(app: FastifyInstance) {
  app.get('/:id/download', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const message = await prisma.message.findUnique({ where: { id } });
    if (!message || !message.mediaPath) {
      return reply.code(404).send({ error: 'Archivo no disponible' });
    }

    const absolutePath = path.join(__dirname, '..', message.mediaPath);
    if (!fs.existsSync(absolutePath)) {
      return reply.code(404).send({ error: 'Archivo no encontrado' });
    }

    reply.header('Content-Type', message.mediaMime || 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${path.basename(absolutePath)}"`);
    return reply.send(fs.createReadStream(absolutePath));
  });
}
