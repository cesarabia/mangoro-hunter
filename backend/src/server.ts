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
import { registerHealthRoutes } from './routes/health';
import { registerMessageRoutes } from './routes/messages';
import { registerAgendaRoutes } from './routes/agenda';
import { startWorkflowSchedulers } from './services/workflowSchedulerService';
import { registerWorkspaceRoutes } from './routes/workspaces';
import { registerPhoneLineRoutes } from './routes/phoneLines';
import { registerProgramRoutes } from './routes/programs';
import { registerAutomationRoutes } from './routes/automations';
import { registerLogRoutes } from './routes/logs';
import { registerUserRoutes } from './routes/users';
import { registerUsageRoutes } from './routes/usage';
import { registerReleaseNotesRoutes } from './routes/releaseNotes';
import { registerCopilotRoutes } from './routes/copilot';

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
  startWorkflowSchedulers(app);

  app.register(registerAuthRoutes, { prefix: '/api/auth' });
  app.register(registerHealthRoutes, { prefix: '/api' });
  app.register(registerWorkspaceRoutes, { prefix: '/api/workspaces' });
  app.register(registerUserRoutes, { prefix: '/api/users' });
  app.register(registerConversationRoutes, { prefix: '/api/conversations' });
  app.register(registerAiRoutes, { prefix: '/api/conversations' });
  app.register(registerConfigRoutes, { prefix: '/api/config' });
  app.register(registerPhoneLineRoutes, { prefix: '/api/phone-lines' });
  app.register(registerProgramRoutes, { prefix: '/api/programs' });
  app.register(registerAutomationRoutes, { prefix: '/api/automations' });
  app.register(registerLogRoutes, { prefix: '/api/logs' });
  app.register(registerUsageRoutes, { prefix: '/api/usage' });
  app.register(registerReleaseNotesRoutes, { prefix: '/api/release-notes' });
  app.register(registerCopilotRoutes, { prefix: '/api/copilot' });
  app.register(registerAgendaRoutes, { prefix: '/api/agenda' });
  app.register(registerSimulationRoutes, { prefix: '/api/simulate' });
  app.register(registerMessageRoutes, { prefix: '/api/messages' });
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
