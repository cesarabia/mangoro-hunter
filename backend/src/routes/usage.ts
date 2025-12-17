import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { resolveWorkspaceAccess, isWorkspaceAdmin } from '../services/workspaceAuthService';
import { getSystemConfig } from '../services/configService';
import { serializeJson } from '../utils/json';

type OpenAiModelPricing = Record<
  string,
  { promptUsdPer1k: number; completionUsdPer1k: number }
>;

type WhatsappPricing = {
  sessionTextUsd: number;
  templateUsd: number;
  templateByNameUsd?: Record<string, number>;
};

function safeJsonParse(value: string | null | undefined): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseDays(raw: unknown): number {
  const value = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : 7;
  if (value === 1 || value === 7 || value === 30) return value;
  return 7;
}

function normalizeNumber(raw: any): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function validateOpenAiPricing(value: any): OpenAiModelPricing | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: OpenAiModelPricing = {};
  for (const [model, raw] of Object.entries(value)) {
    if (!model || typeof model !== 'string') continue;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const prompt = normalizeNumber((raw as any).promptUsdPer1k);
    const completion = normalizeNumber((raw as any).completionUsdPer1k);
    if (prompt === null || completion === null) continue;
    if (prompt < 0 || completion < 0) continue;
    out[model] = { promptUsdPer1k: prompt, completionUsdPer1k: completion };
  }
  return out;
}

function validateWhatsappPricing(value: any): WhatsappPricing | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sessionTextUsd = normalizeNumber((value as any).sessionTextUsd);
  const templateUsd = normalizeNumber((value as any).templateUsd);
  if (sessionTextUsd === null || templateUsd === null) return null;
  if (sessionTextUsd < 0 || templateUsd < 0) return null;
  const templateByNameUsdRaw = (value as any).templateByNameUsd;
  let templateByNameUsd: Record<string, number> | undefined;
  if (templateByNameUsdRaw && typeof templateByNameUsdRaw === 'object' && !Array.isArray(templateByNameUsdRaw)) {
    templateByNameUsd = {};
    for (const [k, v] of Object.entries(templateByNameUsdRaw)) {
      const cost = normalizeNumber(v);
      if (cost === null || cost < 0) continue;
      templateByNameUsd[k] = cost;
    }
  }
  return { sessionTextUsd, templateUsd, ...(templateByNameUsd ? { templateByNameUsd } : {}) };
}

function computeOpenAiCost(params: {
  log: { model: string; inputTokens: number; outputTokens: number };
  pricing: OpenAiModelPricing | null;
}): { costUsd: number | null } {
  if (!params.pricing) return { costUsd: null };
  const rate = params.pricing[params.log.model];
  if (!rate) return { costUsd: null };
  const cost =
    (params.log.inputTokens / 1000) * rate.promptUsdPer1k +
    (params.log.outputTokens / 1000) * rate.completionUsdPer1k;
  return { costUsd: Number.isFinite(cost) ? cost : null };
}

function computeWhatsappCost(params: {
  type: string;
  templateName?: string | null;
  pricing: WhatsappPricing | null;
}): number | null {
  const pricing = params.pricing;
  if (!pricing) return null;
  const type = String(params.type || '').toUpperCase();
  if (type === 'SESSION_TEXT') return pricing.sessionTextUsd;
  if (type === 'TEMPLATE') {
    const templateName = params.templateName ? String(params.templateName) : null;
    if (templateName && pricing.templateByNameUsd && templateName in pricing.templateByNameUsd) {
      return pricing.templateByNameUsd[templateName];
    }
    return pricing.templateUsd;
  }
  return null;
}

export async function registerUsageRoutes(app: FastifyInstance) {
  app.get('/pricing', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const config = await getSystemConfig();
    const openAiModelPricing = validateOpenAiPricing(safeJsonParse((config as any).openAiModelPricing));
    const whatsappPricing = validateWhatsappPricing(safeJsonParse((config as any).whatsappPricing));
    return { openAiModelPricing, whatsappPricing };
  });

  app.put('/pricing', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const body = request.body as { openAiModelPricing?: any; whatsappPricing?: any };

    const nextOpenAi = typeof body?.openAiModelPricing === 'undefined'
      ? undefined
      : validateOpenAiPricing(body.openAiModelPricing);
    if (typeof body?.openAiModelPricing !== 'undefined' && nextOpenAi === null && body.openAiModelPricing !== null) {
      return reply.code(400).send({ error: 'openAiModelPricing inválido.' });
    }

    const nextWa = typeof body?.whatsappPricing === 'undefined'
      ? undefined
      : validateWhatsappPricing(body.whatsappPricing);
    if (typeof body?.whatsappPricing !== 'undefined' && nextWa === null && body.whatsappPricing !== null) {
      return reply.code(400).send({ error: 'whatsappPricing inválido.' });
    }

    const data: Record<string, any> = {};
    if (typeof nextOpenAi !== 'undefined') {
      data.openAiModelPricing = nextOpenAi ? serializeJson(nextOpenAi) : null;
    }
    if (typeof nextWa !== 'undefined') {
      data.whatsappPricing = nextWa ? serializeJson(nextWa) : null;
    }
    if (Object.keys(data).length === 0) {
      const cfg = await getSystemConfig();
      return {
        openAiModelPricing: validateOpenAiPricing(safeJsonParse((cfg as any).openAiModelPricing)),
        whatsappPricing: validateWhatsappPricing(safeJsonParse((cfg as any).whatsappPricing)),
      };
    }
    const cfg = await getSystemConfig();
    const updated = await prisma.systemConfig.update({ where: { id: cfg.id }, data });
    return {
      openAiModelPricing: validateOpenAiPricing(safeJsonParse((updated as any).openAiModelPricing)),
      whatsappPricing: validateWhatsappPricing(safeJsonParse((updated as any).whatsappPricing)),
    };
  });

  app.get('/overview', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const days = parseDays((request.query as any)?.days);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const config = await getSystemConfig();
    const openAiModelPricing = validateOpenAiPricing(safeJsonParse((config as any).openAiModelPricing));
    const whatsappPricing = validateWhatsappPricing(safeJsonParse((config as any).whatsappPricing));

    const [aiLogs, outboundLogs] = await Promise.all([
      prisma.aiUsageLog.findMany({
        where: { workspaceId: access.workspaceId, createdAt: { gte: since } },
        select: {
          actor: true,
          model: true,
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
        },
      }),
      prisma.outboundMessageLog.findMany({
        where: { workspaceId: access.workspaceId, createdAt: { gte: since } },
        select: {
          type: true,
          templateName: true,
          blockedReason: true,
        },
      }),
    ]);

    const openaiByActor: Record<string, { inputTokens: number; outputTokens: number; totalTokens: number }> = {};
    const missingModelPricing = new Set<string>();
    let openaiInput = 0;
    let openaiOutput = 0;
    let openaiTotal = 0;
    let openaiCostKnown = 0;

    for (const log of aiLogs) {
      openaiInput += log.inputTokens || 0;
      openaiOutput += log.outputTokens || 0;
      openaiTotal += log.totalTokens || 0;
      const actor = log.actor || 'UNKNOWN';
      const entry = openaiByActor[actor] || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      entry.inputTokens += log.inputTokens || 0;
      entry.outputTokens += log.outputTokens || 0;
      entry.totalTokens += log.totalTokens || 0;
      openaiByActor[actor] = entry;

      const { costUsd } = computeOpenAiCost({
        log: { model: log.model, inputTokens: log.inputTokens, outputTokens: log.outputTokens },
        pricing: openAiModelPricing,
      });
      if (costUsd === null) {
        if (openAiModelPricing) missingModelPricing.add(log.model);
      } else {
        openaiCostKnown += costUsd;
      }
    }

    let whatsappSentSessionText = 0;
    let whatsappSentTemplate = 0;
    let whatsappBlocked = 0;
    const whatsappBlockedByReason: Record<string, number> = {};
    let whatsappCostKnown = 0;
    const whatsappMissingPricing = whatsappPricing ? false : true;

    for (const log of outboundLogs) {
      if (log.blockedReason) {
        whatsappBlocked += 1;
        const reason = String(log.blockedReason);
        whatsappBlockedByReason[reason] = (whatsappBlockedByReason[reason] || 0) + 1;
        continue;
      }
      const type = String(log.type || '').toUpperCase();
      if (type === 'SESSION_TEXT') whatsappSentSessionText += 1;
      else if (type === 'TEMPLATE') whatsappSentTemplate += 1;

      const cost = computeWhatsappCost({ type, templateName: log.templateName, pricing: whatsappPricing });
      if (cost !== null) whatsappCostKnown += cost;
    }

    return {
      window: { days, since: since.toISOString(), now: new Date().toISOString() },
      openai: {
        inputTokens: openaiInput,
        outputTokens: openaiOutput,
        totalTokens: openaiTotal,
        costUsdKnown: openAiModelPricing ? openaiCostKnown : null,
        missingPricingModels: openAiModelPricing ? Array.from(missingModelPricing).sort() : null,
        byActor: openaiByActor,
      },
      whatsapp: {
        sentSessionText: whatsappSentSessionText,
        sentTemplate: whatsappSentTemplate,
        blocked: whatsappBlocked,
        blockedByReason: whatsappBlockedByReason,
        costUsdKnown: whatsappPricing ? whatsappCostKnown : null,
        missingPricing: whatsappMissingPricing,
      },
    };
  });

  app.get('/top-programs', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const days = parseDays((request.query as any)?.days);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const config = await getSystemConfig();
    const openAiModelPricing = validateOpenAiPricing(safeJsonParse((config as any).openAiModelPricing));

    const logs = await prisma.aiUsageLog.findMany({
      where: { workspaceId: access.workspaceId, createdAt: { gte: since }, programId: { not: null } },
      select: { programId: true, model: true, inputTokens: true, outputTokens: true, totalTokens: true },
    });

    const agg: Record<string, { totalTokens: number; costUsdKnown: number }> = {};
    for (const log of logs) {
      const programId = String(log.programId);
      const entry = agg[programId] || { totalTokens: 0, costUsdKnown: 0 };
      entry.totalTokens += log.totalTokens || 0;
      const { costUsd } = computeOpenAiCost({
        log: { model: log.model, inputTokens: log.inputTokens, outputTokens: log.outputTokens },
        pricing: openAiModelPricing,
      });
      if (costUsd !== null) entry.costUsdKnown += costUsd;
      agg[programId] = entry;
    }

    const programIds = Object.keys(agg);
    const programs = await prisma.program.findMany({
      where: { workspaceId: access.workspaceId, id: { in: programIds } },
      select: { id: true, name: true, slug: true },
    });
    const programById = new Map(programs.map((p) => [p.id, p]));

    const rows = programIds
      .map((id) => ({
        programId: id,
        program: programById.get(id) || null,
        totalTokens: agg[id].totalTokens,
        costUsdKnown: openAiModelPricing ? agg[id].costUsdKnown : null,
      }))
      .sort((a, b) => (b.costUsdKnown || b.totalTokens) - (a.costUsdKnown || a.totalTokens))
      .slice(0, 20);

    return { window: { days, since: since.toISOString() }, rows };
  });

  app.get('/top-conversations', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const days = parseDays((request.query as any)?.days);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const logs = await prisma.aiUsageLog.findMany({
      where: { workspaceId: access.workspaceId, createdAt: { gte: since }, conversationId: { not: null } },
      select: { conversationId: true, totalTokens: true },
    });

    const agg: Record<string, number> = {};
    for (const log of logs) {
      const conversationId = String(log.conversationId);
      agg[conversationId] = (agg[conversationId] || 0) + (log.totalTokens || 0);
    }

    const rows = Object.entries(agg)
      .map(([conversationId, totalTokens]) => ({ conversationId, totalTokens }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 30);

    return { window: { days, since: since.toISOString() }, rows };
  });
}
