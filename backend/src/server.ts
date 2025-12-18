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
import { registerReviewPackRoutes } from './routes/reviewPack';
import { registerConnectorRoutes } from './routes/connectors';
import { registerInviteRoutes } from './routes/invites';
import { registerPlatformRoutes } from './routes/platform';
import { isWorkspaceAdmin, isWorkspaceOwner, resolveWorkspaceAccess } from './services/workspaceAuthService';
import { checkRateLimit } from './services/rateLimitService';

export async function buildServer() {
  const app = Fastify({
    logger: true,
    trustProxy: true,
    bodyLimit: 2_000_000,
  });

  app.addHook('onRequest', async (request: any, reply: any) => {
    const url = String(request?.url || '');
    const ipHeader = String(request?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = ipHeader || String(request?.ip || '');

    // Security headers (API)
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

    // Basic rate limiting (in-memory; DEV baseline)
    const pick = (() => {
      if (url.startsWith('/whatsapp/webhook') || url.startsWith('/webhook/whatsapp')) {
        return { name: 'wa_webhook', limit: 600, windowMs: 60_000 };
      }
      if (url.startsWith('/api/copilot')) {
        return { name: 'copilot', limit: 120, windowMs: 60_000 };
      }
      if (url.startsWith('/api/simulate')) {
        return { name: 'simulate', limit: 120, windowMs: 60_000 };
      }
      if (url.includes('/ai/suggest')) {
        return { name: 'ai_suggest', limit: 60, windowMs: 60_000 };
      }
      return null;
    })();

    if (!pick) return;
    const key = `${pick.name}:${ip || 'unknown'}`;
    const res = checkRateLimit({ key, limit: pick.limit, windowMs: pick.windowMs });
    if (!res.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(res.retryAfterMs / 1000));
      reply.header('Retry-After', String(retryAfterSeconds));
      return reply.code(429).send({
        error: 'Rate limit exceeded',
        scope: pick.name,
        retryAfterSeconds,
      });
    }
  });

  app.register(fastifyJwt, {
    secret: env.jwtSecret
  });

  app.decorate('authenticate', async function (request: any, reply: any) {
    try {
      await request.jwtVerify();
      try {
        const access = await resolveWorkspaceAccess(request);
        request.workspaceAccess = access;
        request.workspaceId = access.workspaceId;
        request.workspaceRole = access.role;
        request.workspaceAssignedOnly = access.assignedOnly;
        request.isWorkspaceAdmin = isWorkspaceAdmin(request, access);
        request.isWorkspaceOwner = isWorkspaceOwner(request, access);
      } catch {
        request.workspaceAccess = null;
        request.workspaceId = 'default';
        request.workspaceRole = null;
        request.workspaceAssignedOnly = false;
        request.isWorkspaceAdmin = request.user?.role === 'ADMIN';
        request.isWorkspaceOwner = request.user?.role === 'ADMIN';
      }
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
  app.register(registerInviteRoutes, { prefix: '/api/invites' });
  app.register(registerConversationRoutes, { prefix: '/api/conversations' });
  app.register(registerAiRoutes, { prefix: '/api/conversations' });
  app.register(registerConfigRoutes, { prefix: '/api/config' });
  app.register(registerPhoneLineRoutes, { prefix: '/api/phone-lines' });
  app.register(registerProgramRoutes, { prefix: '/api/programs' });
  app.register(registerConnectorRoutes, { prefix: '/api/connectors' });
  app.register(registerAutomationRoutes, { prefix: '/api/automations' });
  app.register(registerLogRoutes, { prefix: '/api/logs' });
  app.register(registerUsageRoutes, { prefix: '/api/usage' });
  app.register(registerReleaseNotesRoutes, { prefix: '/api/release-notes' });
  app.register(registerCopilotRoutes, { prefix: '/api/copilot' });
  app.register(registerReviewPackRoutes, { prefix: '/api/review-pack' });
  app.register(registerAgendaRoutes, { prefix: '/api/agenda' });
  app.register(registerSimulationRoutes, { prefix: '/api/simulate' });
  app.register(registerMessageRoutes, { prefix: '/api/messages' });
  app.register(registerPlatformRoutes, { prefix: '/api/platform' });
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
