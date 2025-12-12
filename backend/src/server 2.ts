import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { env } from './config/env';
import { registerAuthRoutes } from './routes/auth';
import { registerConversationRoutes } from './routes/conversations';
import { registerWhatsAppWebhookRoutes } from './routes/whatsappWebhook';
import { registerAiRoutes } from './routes/ai';
import { ensureAdminUser } from './services/bootstrapService';
import { registerConfigRoutes } from './routes/config';
import { registerSimulationRoutes } from './routes/simulate';

export async function buildServer() {
  const app = Fastify({ logger: true });

  app.register(fastifyJwt, {
    secret: env.jwtSecret
  });

  app.decorate('authenticate', async function (request: any, reply: any) {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  await ensureAdminUser();
  app.log.info('Admin bootstrap ok');

  app.register(registerAuthRoutes, { prefix: '/api/auth' });
  app.register(registerConversationRoutes, { prefix: '/api/conversations' });
  app.register(registerAiRoutes, { prefix: '/api/conversations' });
  app.register(registerConfigRoutes, { prefix: '/api/config' });
  app.register(registerSimulationRoutes, { prefix: '/api/simulate' });
  registerWhatsAppWebhookRoutes(app);

  return app;
}

if (require.main === module) {
  buildServer()
    .then(app =>
      app.listen({ port: env.port, host: '0.0.0.0' })
    )
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: any;
  }
}
