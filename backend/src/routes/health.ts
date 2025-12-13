import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get('/health', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return {
        ok: true,
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      app.log.error({ err }, 'Health check failed');
      return reply.code(503).send({
        ok: false,
        timestamp: new Date().toISOString()
      });
    }
  });
}

