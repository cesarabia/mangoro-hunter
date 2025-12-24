import { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { prisma } from '../db/client';
import { resolveWorkspaceAccess, isWorkspaceAdmin } from '../services/workspaceAuthService';
import { serializeJson } from '../utils/json';
import { getEffectiveOpenAiKey } from '../services/aiService';
import { DEFAULT_AI_MODEL, getSystemConfig } from '../services/configService';
import { createChatCompletionWithModelFallback } from '../services/openAiChatCompletionService';
import { resolveModelChain } from '../services/modelResolutionService';

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function safeJsonParse(value: string | null | undefined): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function safeStringList(value: any): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function normalizeLanguage(value: any): string | null {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!raw) return null;
  if (raw === 'ES' || raw === 'EN') return raw;
  return null;
}

export async function registerProgramRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request) => {
    const access = await resolveWorkspaceAccess(request);
    const programs = await prisma.program.findMany({
      where: { workspaceId: access.workspaceId, archivedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        goal: true as any,
        audience: true as any,
        tone: true as any,
        language: true as any,
        isActive: true,
        agentSystemPrompt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return programs.map((p) => ({
      ...p,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }));
  });

  app.post('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as {
      name?: string;
      slug?: string;
      description?: string | null;
      goal?: string | null;
      audience?: string | null;
      tone?: string | null;
      language?: string | null;
      isActive?: boolean;
      agentSystemPrompt?: string;
    };

    const name = String(body.name || '').trim();
    if (!name) return reply.code(400).send({ error: '"name" es requerido.' });

    const slug = body.slug ? slugify(String(body.slug)) : slugify(name);
    if (!slug) return reply.code(400).send({ error: '"slug" inválido.' });

    const agentSystemPrompt = String(body.agentSystemPrompt || '').trim();
    if (!agentSystemPrompt) return reply.code(400).send({ error: '"agentSystemPrompt" es requerido.' });

    const language = normalizeLanguage(body.language);

    const created = await prisma.program.create({
      data: {
        workspaceId: access.workspaceId,
        name,
        slug,
        description: body.description ? String(body.description).trim() : null,
        goal: body.goal ? String(body.goal).trim() : null,
        audience: body.audience ? String(body.audience).trim() : null,
        tone: body.tone ? String(body.tone).trim() : null,
        language,
        isActive: typeof body.isActive === 'boolean' ? body.isActive : true,
        agentSystemPrompt,
      },
    });

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId: request.user?.userId || null,
          type: 'PROGRAM_CREATED',
          beforeJson: null,
          afterJson: serializeJson({ programId: created.id, slug: created.slug }),
        },
      })
      .catch(() => {});

    return {
      ...created,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  });

  app.patch('/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string;
      slug?: string;
      description?: string | null;
      isActive?: boolean;
      agentSystemPrompt?: string;
      goal?: string | null;
      audience?: string | null;
      tone?: string | null;
      language?: string | null;
      archivedAt?: string | null;
    };

    const existing = await prisma.program.findFirst({
      where: { id, workspaceId: access.workspaceId },
      select: { id: true, name: true, slug: true, description: true, agentSystemPrompt: true, goal: true as any, audience: true as any, tone: true as any, language: true as any, isActive: true, archivedAt: true },
    });
    if (!existing) return reply.code(404).send({ error: 'No encontrado' });

    const data: Record<string, any> = {};
    if (typeof body.name === 'string') data.name = body.name.trim();
    if (typeof body.slug === 'string') data.slug = slugify(body.slug);
    if (typeof body.description !== 'undefined') data.description = body.description ? String(body.description).trim() : null;
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive;
    if (typeof body.agentSystemPrompt === 'string') data.agentSystemPrompt = body.agentSystemPrompt;
    if (typeof body.goal !== 'undefined') data.goal = body.goal ? String(body.goal).trim() : null;
    if (typeof body.audience !== 'undefined') data.audience = body.audience ? String(body.audience).trim() : null;
    if (typeof body.tone !== 'undefined') data.tone = body.tone ? String(body.tone).trim() : null;
    if (typeof body.language !== 'undefined') data.language = normalizeLanguage(body.language);
    if (typeof body.archivedAt !== 'undefined') {
      data.archivedAt = body.archivedAt ? new Date(body.archivedAt) : null;
    }

    const updated = await prisma.program.update({ where: { id }, data });

    if (typeof body.agentSystemPrompt === 'string' && body.agentSystemPrompt.trim() && body.agentSystemPrompt.trim() !== String(existing.agentSystemPrompt || '').trim()) {
      const truncate = (t: string) => (t.length > 6000 ? `${t.slice(0, 5997)}...` : t);
      await prisma.configChangeLog
        .create({
          data: {
            workspaceId: access.workspaceId,
            userId: request.user?.userId || null,
            type: 'PROGRAM_PROMPT_APPLIED',
            beforeJson: serializeJson({ programId: existing.id, prompt: truncate(String(existing.agentSystemPrompt || '')) }),
            afterJson: serializeJson({ programId: updated.id, prompt: truncate(String(updated.agentSystemPrompt || '')) }),
          },
        })
        .catch(() => {});
    }

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId: request.user?.userId || null,
          type: 'PROGRAM_UPDATED',
          beforeJson: serializeJson({
            id: existing.id,
            name: existing.name,
            slug: existing.slug,
            isActive: existing.isActive,
            goal: (existing as any).goal || null,
            audience: (existing as any).audience || null,
            tone: (existing as any).tone || null,
            language: (existing as any).language || null,
          }),
          afterJson: serializeJson({
            id: updated.id,
            name: updated.name,
            slug: updated.slug,
            isActive: updated.isActive,
            goal: (updated as any).goal || null,
            audience: (updated as any).audience || null,
            tone: (updated as any).tone || null,
            language: (updated as any).language || null,
          }),
        },
      })
      .catch(() => {});

    return {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
      archivedAt: updated.archivedAt ? updated.archivedAt.toISOString() : null,
    };
  });

  // Knowledge Pack (archive-only)
  app.get('/:id/knowledge', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const { id } = request.params as { id: string };

    const program = await prisma.program.findFirst({
      where: { id, workspaceId: access.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!program) return reply.code(404).send({ error: 'No encontrado' });

    const assets = await prisma.programKnowledgeAsset.findMany({
      where: { workspaceId: access.workspaceId, programId: program.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return assets.map((a) => ({
      id: a.id,
      programId: a.programId,
      type: a.type,
      title: a.title,
      url: a.url,
      contentText: a.contentText,
      tags: a.tags,
      archivedAt: a.archivedAt ? a.archivedAt.toISOString() : null,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    }));
  });

  app.post('/:id/knowledge', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const { id } = request.params as { id: string };
    const body = request.body as { type?: string; title?: string; url?: string; contentText?: string; tags?: string | null };

    const program = await prisma.program.findFirst({
      where: { id, workspaceId: access.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!program) return reply.code(404).send({ error: 'No encontrado' });

    const type = String(body?.type || '').trim().toUpperCase();
    if (!['LINK', 'TEXT', 'FILE'].includes(type)) return reply.code(400).send({ error: 'type inválido (LINK|TEXT|FILE).' });
    const title = String(body?.title || '').trim();
    if (!title) return reply.code(400).send({ error: '"title" es requerido.' });

    const url = body?.url ? String(body.url).trim() : '';
    const contentText = body?.contentText ? String(body.contentText).trim() : '';
    if (type === 'LINK' && !url) return reply.code(400).send({ error: '"url" es requerido para LINK.' });
    if (type === 'TEXT' && !contentText) return reply.code(400).send({ error: '"contentText" es requerido para TEXT.' });

    const created = await prisma.programKnowledgeAsset.create({
      data: {
        workspaceId: access.workspaceId,
        programId: program.id,
        type,
        title,
        url: url || null,
        contentText: contentText || null,
        tags: body?.tags ? String(body.tags).trim() : null,
      } as any,
    });

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId: request.user?.userId || null,
          type: 'PROGRAM_KNOWLEDGE_ADDED',
          beforeJson: null,
          afterJson: serializeJson({ programId: program.id, assetId: created.id, type }),
        },
      })
      .catch(() => {});

    return {
      id: created.id,
      programId: created.programId,
      type: created.type,
      title: created.title,
      url: created.url,
      contentText: created.contentText,
      tags: created.tags,
      archivedAt: created.archivedAt ? created.archivedAt.toISOString() : null,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  });

  app.patch('/:id/knowledge/:assetId', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const { id, assetId } = request.params as { id: string; assetId: string };
    const body = request.body as { title?: string; tags?: string | null; archived?: boolean | null };

    const program = await prisma.program.findFirst({
      where: { id, workspaceId: access.workspaceId },
      select: { id: true },
    });
    if (!program) return reply.code(404).send({ error: 'No encontrado' });

    const existing = await prisma.programKnowledgeAsset.findFirst({
      where: { id: assetId, programId: program.id, workspaceId: access.workspaceId },
      select: { id: true, title: true, tags: true, archivedAt: true },
    });
    if (!existing) return reply.code(404).send({ error: 'Asset no encontrado' });

    const data: Record<string, any> = {};
    if (typeof body.title === 'string') data.title = body.title.trim();
    if (typeof body.tags !== 'undefined') data.tags = body.tags ? String(body.tags).trim() : null;
    if (typeof body.archived === 'boolean') data.archivedAt = body.archived ? new Date() : null;

    const updated = await prisma.programKnowledgeAsset.update({ where: { id: existing.id }, data });

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId: request.user?.userId || null,
          type: 'PROGRAM_KNOWLEDGE_UPDATED',
          beforeJson: serializeJson({ assetId: existing.id, title: existing.title, tags: existing.tags, archivedAt: existing.archivedAt }),
          afterJson: serializeJson({ assetId: updated.id, title: updated.title, tags: updated.tags, archivedAt: updated.archivedAt }),
        },
      })
      .catch(() => {});

    return {
      id: updated.id,
      programId: updated.programId,
      type: updated.type,
      title: updated.title,
      url: updated.url,
      contentText: updated.contentText,
      tags: updated.tags,
      archivedAt: updated.archivedAt ? updated.archivedAt.toISOString() : null,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  });

  // Program Tools / Connector permissions
  app.get('/:id/tools', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const { id } = request.params as { id: string };

    const program = await prisma.program.findFirst({
      where: { id, workspaceId: access.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!program) return reply.code(404).send({ error: 'No encontrado' });

    const [connectors, perms] = await Promise.all([
      prisma.workspaceConnector.findMany({
        where: { workspaceId: access.workspaceId, archivedAt: null },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, slug: true, description: true, actionsJson: true, isActive: true },
      }),
      prisma.programConnectorPermission.findMany({
        where: { workspaceId: access.workspaceId, programId: program.id, archivedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true, connectorId: true, allowedActionsJson: true, createdAt: true, updatedAt: true },
      }),
    ]);

    return {
      connectors: connectors.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        description: c.description,
        isActive: c.isActive,
        actions: safeStringList(safeJsonParse(c.actionsJson)),
      })),
      permissions: perms.map((p) => ({
        id: p.id,
        connectorId: p.connectorId,
        allowedActions: safeStringList(safeJsonParse(p.allowedActionsJson)),
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      })),
    };
  });

  app.put('/:id/tools', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const { id } = request.params as { id: string };
    const body = request.body as { permissions?: Array<{ connectorId: string; allowedActions?: string[] | null }> };

    const program = await prisma.program.findFirst({
      where: { id, workspaceId: access.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!program) return reply.code(404).send({ error: 'No encontrado' });

    const desired = Array.isArray(body?.permissions) ? body.permissions : [];
    const validConnectors = await prisma.workspaceConnector.findMany({
      where: { workspaceId: access.workspaceId, archivedAt: null },
      select: { id: true },
    });
    const validConnectorIds = new Set(validConnectors.map((c) => c.id));
    const desiredConnectorIds = desired
      .map((p) => String(p.connectorId || '').trim())
      .filter((cid) => Boolean(cid) && validConnectorIds.has(cid));

    const existing = await prisma.programConnectorPermission.findMany({
      where: { workspaceId: access.workspaceId, programId: program.id },
      select: { id: true, connectorId: true, archivedAt: true, allowedActionsJson: true },
    });

    const now = new Date();
    const touched: string[] = [];

    for (const entry of desired) {
      const connectorId = String(entry.connectorId || '').trim();
      if (!connectorId) continue;
      if (!validConnectorIds.has(connectorId)) continue;
      const allowedActions = safeStringList(entry.allowedActions ?? []);
      const found = existing.find((e) => e.connectorId === connectorId);
      if (found) {
        await prisma.programConnectorPermission.update({
          where: { id: found.id },
          data: {
            archivedAt: null,
            allowedActionsJson: allowedActions.length > 0 ? serializeJson(allowedActions) : null,
            updatedAt: now,
          } as any,
        });
        touched.push(found.id);
      } else {
        const created = await prisma.programConnectorPermission.create({
          data: {
            workspaceId: access.workspaceId,
            programId: program.id,
            connectorId,
            allowedActionsJson: allowedActions.length > 0 ? serializeJson(allowedActions) : null,
            updatedAt: now,
          } as any,
          select: { id: true },
        });
        touched.push(created.id);
      }
    }

    // Archive removed connectors (never delete).
    const toArchive = existing.filter((e) => !desiredConnectorIds.includes(e.connectorId) && e.archivedAt === null);
    if (toArchive.length > 0) {
      await prisma.programConnectorPermission.updateMany({
        where: { id: { in: toArchive.map((e) => e.id) } },
        data: { archivedAt: now, updatedAt: now } as any,
      });
    }

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId: request.user?.userId || null,
          type: 'PROGRAM_TOOLS_UPDATED',
          beforeJson: serializeJson({ programId: program.id, existingCount: existing.length }),
          afterJson: serializeJson({ programId: program.id, permissions: desiredConnectorIds }),
        },
      })
      .catch(() => {});

    return { ok: true };
  });

  // Prompt Builder (preview)
  app.post('/:id/generate-prompt', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const { id } = request.params as { id: string };

    const program = await prisma.program.findFirst({
      where: { id, workspaceId: access.workspaceId, archivedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        agentSystemPrompt: true,
        goal: true as any,
        audience: true as any,
        tone: true as any,
        language: true as any,
      },
    });
    if (!program) return reply.code(404).send({ error: 'No encontrado' });

    const [assets, perms] = await Promise.all([
      prisma.programKnowledgeAsset.findMany({
        where: { workspaceId: access.workspaceId, programId: program.id, archivedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { type: true, title: true, url: true, contentText: true },
      }),
      prisma.programConnectorPermission.findMany({
        where: { workspaceId: access.workspaceId, programId: program.id, archivedAt: null },
        include: { connector: { select: { name: true, slug: true, actionsJson: true } } },
        take: 20,
      }),
    ]);

    const config = await getSystemConfig();
    const apiKey = getEffectiveOpenAiKey(config);
    if (!apiKey) return reply.code(400).send({ error: 'OpenAI key no configurada (Config → Integraciones).' });

    const resolvedModels = resolveModelChain({
      modelOverride: (config as any).aiModelOverride,
      modelAlias: (config as any).aiModelAlias,
      legacyModel: config.aiModel,
      defaultModel: DEFAULT_AI_MODEL,
    });
    const modelChain = resolvedModels.modelChain;
    const modelRequested = resolvedModels.modelRequested;
    const client = new OpenAI({ apiKey });

    const knowledgeText = (() => {
      const chunks: string[] = [];
      let total = 0;
      for (const a of assets) {
        const header = `- [${a.type}] ${a.title}${a.url ? ` (${a.url})` : ''}`.trim();
        const body = a.contentText ? `\n${a.contentText}` : '';
        const chunk = `${header}${body}`.trim();
        if (!chunk) continue;
        const nextTotal = total + chunk.length;
        if (nextTotal > 9000) break;
        chunks.push(chunk);
        total = nextTotal;
      }
      return chunks.join('\n\n');
    })();

    const toolsText = perms
      .map((p: any) => {
        const connector = p.connector;
        const actions = safeStringList(safeJsonParse(connector?.actionsJson));
        const allowed = safeStringList(safeJsonParse(p.allowedActionsJson));
        const allowedLabel = allowed.length > 0 ? allowed.join(', ') : '(todos)';
        const availableLabel = actions.length > 0 ? actions.join(', ') : '(sin acciones declaradas)';
        return `- ${connector?.name || 'Connector'} (${connector?.slug || '—'})\n  acciones disponibles: ${availableLabel}\n  acciones permitidas por este Program: ${allowedLabel}`;
      })
      .join('\n');

    const system = `
Eres un asistente que redacta "Instrucciones del Agente" (agentSystemPrompt) para Hunter CRM (Agent OS).
Estas instrucciones se usan en un runtime que exige que el agente responda SOLO con JSON de comandos (no texto suelto).
Objetivo: generar un prompt claro, práctico, en español, con tono indicado y usando Knowledge Pack + tools permitidos.

Reglas:
- NO inventes políticas ni datos. Si falta info, deja un placeholder de "preguntar/confirmar".
- Mantén el prompt conciso y operacional (secciones + bullets).
- No incluyas backticks ni markdown fences. Devuelve SOLO el texto del prompt final.
`.trim();

    const user = serializeJson({
      program: {
        name: program.name,
        slug: program.slug,
        description: program.description,
        goal: (program as any).goal || null,
        audience: (program as any).audience || null,
        tone: (program as any).tone || null,
        language: (program as any).language || null,
      },
      currentPrompt: program.agentSystemPrompt,
      knowledgePack: knowledgeText || null,
      tools: toolsText || null,
    });

    const completionResult = await createChatCompletionWithModelFallback(
      client,
      {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        max_tokens: 1200,
      },
      modelChain
    );
    const completion = completionResult.completion;
    const modelResolved = completionResult.modelResolved;

    const suggestionRaw = String(completion.choices[0]?.message?.content || '').trim();
    const suggestion = suggestionRaw.replace(/```[\s\S]*?```/g, '').trim();
    if (!suggestion) return reply.code(502).send({ error: 'Respuesta vacía del modelo.' });

    const usage: any = (completion as any)?.usage;
    await prisma.aiUsageLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          actor: 'PROGRAM_PROMPT_BUILDER',
          model: modelResolved,
          modelRequested,
          modelResolved,
          inputTokens: Number(usage?.prompt_tokens || 0) || 0,
          outputTokens: Number(usage?.completion_tokens || 0) || 0,
          totalTokens: Number(usage?.total_tokens || 0) || 0,
          programId: program.id,
        },
      })
      .catch(() => {});

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId: request.user?.userId || null,
          type: 'PROGRAM_PROMPT_GENERATED',
          beforeJson: serializeJson({
            programId: program.id,
            slug: program.slug,
            input: {
              goal: (program as any).goal || null,
              audience: (program as any).audience || null,
              tone: (program as any).tone || null,
              language: (program as any).language || null,
              knowledgeAssetsCount: assets.length,
              connectorsCount: perms.length,
            },
          }),
          afterJson: serializeJson({
            programId: program.id,
            suggestion: suggestion.length > 6000 ? `${suggestion.slice(0, 5997)}...` : suggestion,
          }),
        },
      })
      .catch(() => {});

    return { suggestion };
  });
}
