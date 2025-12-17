import { FastifyInstance } from 'fastify';
import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import { prisma } from '../db/client';
import { resolveWorkspaceAccess, isWorkspaceAdmin } from '../services/workspaceAuthService';
import { getEffectiveOutboundAllowlist, getOutboundPolicy, getSystemConfig } from '../services/configService';

function safeReadFile(filePath: string): Buffer | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

function safeJsonParse(value: string | null | undefined): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function registerReviewPackRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const cfg = await getSystemConfig();
    const policy = getOutboundPolicy(cfg);
    const allowlist = getEffectiveOutboundAllowlist(cfg);

    const repoRoot = path.resolve(__dirname, '../../..');
    const docsRoot = path.join(repoRoot, 'docs');

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `review-pack-${access.workspaceId}-${stamp}.zip`;

    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('warning', (err) => {
      app.log.warn({ err }, 'review-pack zip warning');
    });
    archive.on('error', (err) => {
      app.log.error({ err }, 'review-pack zip error');
      throw err;
    });

    // Docs bundle (best effort).
    const docs = ['PLATFORM_DESIGN.md', 'STATUS.md', 'DEPLOY.md', 'RUNBOOK.md', 'DEV_PACKET.md'];
    for (const doc of docs) {
      const fp = path.join(docsRoot, doc);
      const buf = safeReadFile(fp);
      if (buf) {
        archive.append(buf, { name: `docs/${doc}` });
      } else {
        archive.append(`Missing file: ${doc}\n`, { name: `docs/${doc}.missing.txt` });
      }
    }

    // Snapshot metadata.
    const meta = {
      generatedAt: new Date().toISOString(),
      workspaceId: access.workspaceId,
      safeOutbound: { policy, effectiveAllowlist: allowlist },
      releaseNotes: safeJsonParse((cfg as any).devReleaseNotes),
    };
    archive.append(JSON.stringify(meta, null, 2), { name: 'meta.json' });

    // Logs snapshot (best effort).
    const [agentRuns, automationRuns, outboundLogs, copilotRuns, scenarioRuns] = await Promise.all([
      prisma.agentRunLog.findMany({
        where: { workspaceId: access.workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.automationRunLog.findMany({
        where: { workspaceId: access.workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.outboundMessageLog.findMany({
        where: { workspaceId: access.workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.copilotRunLog.findMany({
        where: { workspaceId: access.workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.scenarioRunLog.findMany({
        where: { workspaceId: 'sandbox' },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    archive.append(
      JSON.stringify(
        agentRuns.map((r) => ({
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          conversationId: r.conversationId,
          programId: r.programId,
          phoneLineId: r.phoneLineId,
          eventType: r.eventType,
          status: r.status,
          error: r.error,
        })),
        null,
        2,
      ),
      { name: 'logs/agent-runs.json' },
    );

    archive.append(
      JSON.stringify(
        automationRuns.map((r) => ({
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          ruleId: r.ruleId,
          conversationId: r.conversationId,
          eventType: r.eventType,
          status: r.status,
          error: r.error,
        })),
        null,
        2,
      ),
      { name: 'logs/automation-runs.json' },
    );

    archive.append(
      JSON.stringify(
        outboundLogs.map((o) => ({
          id: o.id,
          createdAt: o.createdAt.toISOString(),
          conversationId: o.conversationId,
          channel: o.channel,
          type: o.type,
          templateName: o.templateName,
          dedupeKey: o.dedupeKey,
          blockedReason: o.blockedReason,
          waMessageId: o.waMessageId,
        })),
        null,
        2,
      ),
      { name: 'logs/outbound-messages.json' },
    );

    archive.append(
      JSON.stringify(
        copilotRuns.map((r) => ({
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          userId: r.userId,
          threadId: (r as any).threadId || null,
          conversationId: r.conversationId,
          view: r.view,
          status: r.status,
          error: r.error,
        })),
        null,
        2,
      ),
      { name: 'logs/copilot-runs.json' },
    );

    archive.append(
      JSON.stringify(
        scenarioRuns.map((s) => ({
          id: s.id,
          createdAt: s.createdAt.toISOString(),
          scenarioId: s.scenarioId,
          ok: s.ok,
          sessionConversationId: s.sessionConversationId,
          startedAt: s.startedAt.toISOString(),
          finishedAt: s.finishedAt.toISOString(),
        })),
        null,
        2,
      ),
      { name: 'logs/scenario-runs.json' },
    );

    reply.send(archive);
    archive.finalize();
  });
}
