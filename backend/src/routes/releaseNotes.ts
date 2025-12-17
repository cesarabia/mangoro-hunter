import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { getSystemConfig } from '../services/configService';
import { serializeJson } from '../utils/json';
import { resolveWorkspaceAccess, isWorkspaceAdmin } from '../services/workspaceAuthService';

type ReleaseNotes = {
  changed: string[];
  todo: string[];
  risks: string[];
};

function safeJsonParse(value: string | null | undefined): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeStringList(value: any): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed);
  }
  return out;
}

function normalizeReleaseNotes(value: any): ReleaseNotes | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const changed = normalizeStringList((value as any).changed);
  const todo = normalizeStringList((value as any).todo);
  const risks = normalizeStringList((value as any).risks);
  return { changed, todo, risks };
}

export async function registerReleaseNotesRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const cfg = await getSystemConfig();
    const notes = normalizeReleaseNotes(safeJsonParse((cfg as any).devReleaseNotes));

    const lastRuns = await prisma.scenarioRunLog
      .findMany({
        where: { workspaceId: 'sandbox' },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, scenarioId: true, ok: true, createdAt: true, startedAt: true, finishedAt: true },
      })
      .catch(() => []);

    const lastQa = lastRuns.length > 0 ? lastRuns[0] : null;

    return {
      notes,
      updatedAt: cfg.updatedAt.toISOString(),
      lastQa: lastQa
        ? {
            id: lastQa.id,
            scenarioId: lastQa.scenarioId,
            ok: lastQa.ok,
            createdAt: lastQa.createdAt.toISOString(),
            startedAt: lastQa.startedAt.toISOString(),
            finishedAt: lastQa.finishedAt.toISOString(),
          }
        : null,
      lastScenarioRuns: lastRuns.map((r) => ({
        id: r.id,
        scenarioId: r.scenarioId,
        ok: r.ok,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  app.put('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const body = request.body as { notes?: any | null };

    if (typeof body?.notes === 'undefined') {
      return reply.code(400).send({ error: '"notes" es obligatorio.' });
    }
    const next = body.notes === null ? null : normalizeReleaseNotes(body.notes);
    if (body.notes !== null && !next) {
      return reply.code(400).send({ error: 'notes inválido. Usa { changed:[], todo:[], risks:[] }' });
    }

    const cfg = await getSystemConfig();
    const updated = await prisma.systemConfig.update({
      where: { id: cfg.id },
      data: { devReleaseNotes: next ? serializeJson(next) : null },
    });
    return { notes: normalizeReleaseNotes(safeJsonParse((updated as any).devReleaseNotes)), updatedAt: updated.updatedAt.toISOString() };
  });
}

