import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import {
  getAdminWaIdAllowlist,
  getEffectiveOutboundAllowlist,
  getOutboundPolicy,
  getSystemConfig,
  getTestWaIdAllowlist,
} from '../services/configService';
import { serializeJson } from '../utils/json';
import { resolveWorkspaceAccess, isWorkspaceAdmin } from '../services/workspaceAuthService';

type DodStatus = 'PASS' | 'FAIL' | 'PENDING';

type ReleaseNotes = {
  changed: string[];
  todo: string[];
  risks: string[];
  dod?: Record<string, DodStatus>;
  dodEvaluatedAt?: string;
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

function normalizeDod(value: any): Record<string, DodStatus> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, DodStatus> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = String(k).trim();
    if (!key) continue;
    if (typeof v === 'boolean') {
      out[key] = v ? 'PASS' : 'FAIL';
      continue;
    }
    if (typeof v === 'string') {
      const upper = v.trim().toUpperCase();
      if (upper === 'PASS' || upper === 'FAIL' || upper === 'PENDING') {
        out[key] = upper as DodStatus;
      }
    }
  }
  return out;
}

function normalizeReleaseNotes(value: any): ReleaseNotes | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const changed = normalizeStringList((value as any).changed);
  const todo = normalizeStringList((value as any).todo);
  const risks = normalizeStringList((value as any).risks);
  const dod = normalizeDod((value as any).dod);
  const dodEvaluatedAt =
    typeof (value as any).dodEvaluatedAt === 'string' && (value as any).dodEvaluatedAt.trim()
      ? (value as any).dodEvaluatedAt.trim()
      : undefined;
  return {
    changed,
    todo,
    risks,
    ...(Object.keys(dod).length > 0 ? { dod } : {}),
    ...(dodEvaluatedAt ? { dodEvaluatedAt } : {}),
  };
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

  app.post('/evaluate-dod', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const cfg = await getSystemConfig();
    const current = normalizeReleaseNotes(safeJsonParse((cfg as any).devReleaseNotes)) || {
      changed: [],
      todo: [],
      risks: [],
    };

    const existingDod = normalizeDod((current as any).dod);

    const admin = getAdminWaIdAllowlist(cfg);
    const test = getTestWaIdAllowlist(cfg);
    const allowedSet = new Set([...admin, ...test].map((v) => String(v)));
    const effective = getEffectiveOutboundAllowlist(cfg).map((v) => String(v));
    const unexpected = effective.filter((n) => !allowedSet.has(String(n)));
    const safeModePass =
      getOutboundPolicy(cfg) === 'ALLOWLIST_ONLY' &&
      unexpected.length === 0 &&
      effective.length === allowedSet.size &&
      admin.length >= 1 &&
      test.length >= 1;

    const requiredScenarioIds = [
      'admin_hola_responde',
      'test_hola_responde',
      'location_loop_rm',
      'safe_mode_block',
      'program_switch_suggest_and_inbound',
    ];

    const scenarioRuns = await prisma.scenarioRunLog
      .findMany({
        where: { workspaceId: 'sandbox', scenarioId: { in: requiredScenarioIds } },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { scenarioId: true, ok: true, createdAt: true },
      })
      .catch(() => []);

    const latestByScenario = new Map<string, { ok: boolean; createdAt: Date }>();
    for (const row of scenarioRuns) {
      if (!row?.scenarioId) continue;
      if (latestByScenario.has(row.scenarioId)) continue;
      latestByScenario.set(row.scenarioId, { ok: Boolean(row.ok), createdAt: row.createdAt });
    }

    const missingScenarios = requiredScenarioIds.filter((id) => !latestByScenario.has(id));
    const anyScenarioFail = requiredScenarioIds.some((id) => {
      const r = latestByScenario.get(id);
      return r ? !r.ok : false;
    });

    const smokeScenariosStatus: DodStatus =
      missingScenarios.length > 0 ? 'PENDING' : anyScenarioFail ? 'FAIL' : 'PASS';

    // Program consistency se valida por el scenario combinado.
    const programConsistencyStatus: DodStatus = (() => {
      const r = latestByScenario.get('program_switch_suggest_and_inbound');
      if (!r) return 'PENDING';
      return r.ok ? 'PASS' : 'FAIL';
    })();

    // Review Pack: check via internal request (best-effort).
    let reviewPackStatus: DodStatus = 'PENDING';
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/review-pack/',
        headers: {
          authorization: (request.headers as any)?.authorization || '',
          'x-workspace-id': access.workspaceId,
        },
      });
      reviewPackStatus = res.statusCode === 200 ? 'PASS' : 'FAIL';
    } catch {
      reviewPackStatus = 'FAIL';
    }

    const next: ReleaseNotes = {
      ...current,
      dod: {
        ...existingDod,
        safeMode: safeModePass ? 'PASS' : 'FAIL',
        smokeScenarios: smokeScenariosStatus,
        reviewPack: reviewPackStatus,
        programConsistency: programConsistencyStatus,
      },
      dodEvaluatedAt: new Date().toISOString(),
    };

    const updated = await prisma.systemConfig.update({
      where: { id: cfg.id },
      data: { devReleaseNotes: serializeJson(next) },
    });

    return {
      notes: normalizeReleaseNotes(safeJsonParse((updated as any).devReleaseNotes)),
      updatedAt: updated.updatedAt.toISOString(),
    };
  });
}
