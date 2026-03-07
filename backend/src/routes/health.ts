import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getInboundQueueHealthSnapshot } from '../services/automationRunnerService';

const startedAt = new Date().toISOString();
let gitSha: string | null = String(process.env.HUNTER_BUILD_SHA || '').trim() || null;
let repoDirty: boolean | null =
  typeof process.env.HUNTER_BUILD_DIRTY === 'string'
    ? String(process.env.HUNTER_BUILD_DIRTY).toLowerCase().trim() === 'true'
    : null;
if (!gitSha) {
  try {
    const repoRoot = path.resolve(__dirname, '../../..');
    const gitDir = path.join(repoRoot, '.git');
    if (!fs.existsSync(gitDir)) throw new Error('no-git');
    gitSha = execSync('git rev-parse --short HEAD', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const status = execSync('git status --porcelain', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    repoDirty = Boolean(status);
  } catch {
    gitSha = null;
    if (repoDirty === null) repoDirty = null;
  }
}

let backendVersion: string | null = null;
try {
  const pkgPath = path.resolve(__dirname, '../../package.json');
  const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgRaw);
  backendVersion = typeof pkg?.version === 'string' ? pkg.version : null;
} catch {
  backendVersion = null;
}

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get('/health', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      const inboundQueue = await getInboundQueueHealthSnapshot().catch(() => ({
        inboundPlannedCount: 0,
        oldestPlannedAgeMs: null,
      }));
      return {
        ok: true,
        timestamp: new Date().toISOString(),
        startedAt,
        gitSha,
        repoDirty,
        backendVersion,
        inboundPlannedCount: inboundQueue.inboundPlannedCount,
        oldestPlannedAgeMs: inboundQueue.oldestPlannedAgeMs,
      };
    } catch (err) {
      app.log.error({ err }, 'Health check failed');
      return reply.code(503).send({
        ok: false,
        timestamp: new Date().toISOString(),
        startedAt,
        gitSha,
        repoDirty,
        backendVersion
      });
    }
  });
}
