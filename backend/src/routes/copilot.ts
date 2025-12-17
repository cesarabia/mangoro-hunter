import { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { z } from 'zod';
import { prisma } from '../db/client';
import { getEffectiveOpenAiKey } from '../services/aiService';
import { DEFAULT_AI_MODEL, getEffectiveOutboundAllowlist, getOutboundPolicy, getSystemConfig, normalizeModelId } from '../services/configService';
import { resolveWorkspaceAccess, isWorkspaceAdmin } from '../services/workspaceAuthService';
import { serializeJson } from '../utils/json';

const ViewSchema = z.enum(['inbox', 'inactive', 'simulator', 'agenda', 'config', 'review']);
const ConfigTabSchema = z.enum(['workspace', 'integrations', 'users', 'phoneLines', 'programs', 'automations', 'logs', 'usage']);

const CopilotActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('NAVIGATE'),
    view: ViewSchema,
    configTab: ConfigTabSchema.optional(),
    label: z.string().optional(),
  }),
]);

const CopilotResponseSchema = z.object({
  reply: z.string().min(1),
  actions: z.array(CopilotActionSchema).optional(),
});

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferNavigation(text: string): z.infer<typeof CopilotActionSchema> | null {
  const t = normalizeText(text);
  const go = (view: z.infer<typeof ViewSchema>, configTab?: z.infer<typeof ConfigTabSchema>, label?: string) =>
    ({ type: 'NAVIGATE', view, ...(configTab ? { configTab } : {}), ...(label ? { label } : {}) }) as const;

  const wantsNav = /(ll[eé]vame|lleva(me)?|ir|abre|abrir|vamos|ve a|entra a|mostrar?)/i.test(text);
  if (wantsNav) {
    if (/\b(inbox|bandeja)\b/i.test(text) || t === 'inbox') return go('inbox', undefined, 'Abrir Inbox');
    if (/\b(inactivos|archivados)\b/i.test(text) || t === 'inactivos') return go('inactive', undefined, 'Abrir Inactivos');
    if (/\b(simulador|simulator)\b/i.test(text) || t === 'simulador') return go('simulator', undefined, 'Abrir Simulador');
    if (/\b(agenda|calendario)\b/i.test(text) || t === 'agenda') return go('agenda', undefined, 'Abrir Agenda');
    // Config tabs (más específicos primero para evitar caer en "config" genérico).
    if (/\b(integraciones|integracion)\b/i.test(text)) return go('config', 'integrations', 'Ir a Integraciones');
    if (/\b(program|programa|programs)\b/i.test(text)) return go('config', 'programs', 'Ir a Programs');
    if (/\b(automation|automat|regla)\b/i.test(text)) return go('config', 'automations', 'Ir a Automations');
    if (/\b(numeros|numero|whatsapp|phoneline|linea)\b/i.test(text)) return go('config', 'phoneLines', 'Ir a Números WhatsApp');
    if (/\b(usuario|usuarios|users)\b/i.test(text)) return go('config', 'users', 'Ir a Usuarios');
    if (/\b(logs?|bitacora)\b/i.test(text)) return go('config', 'logs', 'Ir a Logs');
    if (/\b(uso|costos|consumo)\b/i.test(text)) return go('config', 'usage', 'Ir a Uso & Costos');
    if (/\b(config|configuracion|settings)\b/i.test(text)) return go('config', undefined, 'Abrir Configuración');
  }
  if (/\b(ayuda|qa|owner review)\b/i.test(text)) return go('review', undefined, 'Abrir Ayuda / QA');
  return null;
}

function explainBlockedReason(blockedReason: string): string {
  const reason = String(blockedReason || '').toUpperCase();
  if (!reason) return 'El envío quedó bloqueado por una regla de seguridad.';
  if (reason.includes('SAFE_OUTBOUND')) return 'El envío fue bloqueado por SAFE MODE (allowlist-only).';
  if (reason.includes('NO_CONTACT')) return 'El contacto está marcado como NO_CONTACTAR.';
  if (reason.includes('OUTSIDE_24H')) return 'La conversación está fuera de la ventana de 24h de WhatsApp (requiere plantilla).';
  if (reason.includes('DEDUP')) return 'El sistema evitó un duplicado (dedupe/idempotencia).';
  if (reason.includes('ANTI_LOOP')) return 'Se bloqueó para evitar loops (mensaje repetido).';
  return `El envío quedó bloqueado: ${blockedReason}`;
}

export async function registerCopilotRoutes(app: FastifyInstance) {
  app.get('/threads', { preValidation: [app.authenticate] }, async (request) => {
    const access = await resolveWorkspaceAccess(request);
    const userId = request.user?.userId || null;
    if (!userId) return [];

    const threads = await prisma.copilotThread.findMany({
      where: { workspaceId: access.workspaceId, userId, archivedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        runs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { inputText: true, responseText: true, createdAt: true },
        },
      },
    });

    return threads.map((t) => ({
      id: t.id,
      title: t.title,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      lastRunAt: t.runs?.[0]?.createdAt ? t.runs[0].createdAt.toISOString() : null,
      lastUserText: t.runs?.[0]?.inputText || null,
      lastAssistantText: t.runs?.[0]?.responseText || null,
    }));
  });

  app.post('/threads', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const userId = request.user?.userId || null;
    if (!userId) return reply.code(400).send({ error: 'Usuario inválido.' });
    const body = request.body as { title?: string | null };
    const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 80) : null;

    const created = await prisma.copilotThread.create({
      data: { workspaceId: access.workspaceId, userId, title: title || null } as any,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
    return {
      id: created.id,
      title: created.title,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  });

  app.get('/threads/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const userId = request.user?.userId || null;
    const { id } = request.params as { id: string };
    if (!userId) return reply.code(400).send({ error: 'Usuario inválido.' });

    const thread = await prisma.copilotThread.findFirst({
      where: { id, workspaceId: access.workspaceId, userId, archivedAt: null },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        runs: {
          orderBy: { createdAt: 'asc' },
          take: 200,
          select: { id: true, inputText: true, responseText: true, actionsJson: true, status: true, error: true, createdAt: true },
        },
      },
    });
    if (!thread) return reply.code(404).send({ error: 'Thread no encontrado.' });

    return {
      id: thread.id,
      title: thread.title,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
      runs: thread.runs.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        inputText: r.inputText,
        responseText: r.responseText,
        actions: safeJsonParse(r.actionsJson || '') || null,
        status: r.status,
        error: r.error,
      })),
    };
  });

  app.patch('/threads/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const userId = request.user?.userId || null;
    const { id } = request.params as { id: string };
    if (!userId) return reply.code(400).send({ error: 'Usuario inválido.' });

    const body = request.body as { archived?: boolean | null };
    const archived = typeof body?.archived === 'boolean' ? body.archived : null;
    if (archived === null) {
      return reply.code(400).send({ error: '"archived" es obligatorio (true/false).' });
    }

    const existing = await prisma.copilotThread.findFirst({
      where: { id, workspaceId: access.workspaceId, userId },
      select: { id: true },
    });
    if (!existing) return reply.code(404).send({ error: 'Thread no encontrado.' });

    const updated = await prisma.copilotThread.update({
      where: { id },
      data: { archivedAt: archived ? new Date() : null, updatedAt: new Date() } as any,
      select: { id: true, archivedAt: true, updatedAt: true },
    });
    return {
      id: updated.id,
      archivedAt: updated.archivedAt ? updated.archivedAt.toISOString() : null,
      updatedAt: updated.updatedAt.toISOString(),
    };
  });

  app.post('/chat', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const isAdmin = isWorkspaceAdmin(request, access);
    const body = request.body as { text?: string; conversationId?: string | null; view?: string | null; threadId?: string | null };
    const text = String(body?.text || '').trim();
    const conversationId = body?.conversationId ? String(body.conversationId) : null;
    const view = typeof body?.view === 'string' ? body.view : null;
    const userId = request.user?.userId || null;

    if (!text) return reply.code(400).send({ error: '"text" es obligatorio.' });

    let threadId: string | null = body?.threadId ? String(body.threadId).trim() : null;
    if (threadId && userId) {
      const exists = await prisma.copilotThread.findFirst({
        where: { id: threadId, workspaceId: access.workspaceId, userId, archivedAt: null },
        select: { id: true },
      });
      if (!exists) threadId = null;
    }
    if (!threadId && userId) {
      const title = text.slice(0, 80);
      const created = await prisma.copilotThread.create({
        data: { workspaceId: access.workspaceId, userId, title } as any,
        select: { id: true },
      });
      threadId = created.id;
    }

    const run = await prisma.copilotRunLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId,
          threadId,
          conversationId,
          view: view || null,
          inputText: text,
          status: 'RUNNING',
        } as any,
      })
      .catch(() => null);

    if (threadId) {
      await prisma.copilotThread
        .update({ where: { id: threadId }, data: { updatedAt: new Date() } })
        .catch(() => {});
    }

    const directNav = inferNavigation(text);
    if (directNav && (!directNav.configTab || isAdmin)) {
      const response = { reply: `Listo. ${directNav.label || 'Te llevo ahí.'}`, actions: [directNav], threadId };
      if (run?.id) {
        await prisma.copilotRunLog.update({
          where: { id: run.id },
          data: { status: 'SUCCESS', responseText: response.reply, actionsJson: serializeJson(response.actions) },
        });
      }
      return response;
    }

    const config = await getSystemConfig();
    const apiKey = getEffectiveOpenAiKey(config);

    const outboundPolicy = getOutboundPolicy(config);
    const effectiveAllowlist = getEffectiveOutboundAllowlist(config);

    let conversationSnapshot: any | null = null;
    let programIdForUsage: string | null = null;
    let recentAgentRuns: any[] = [];
    let recentOutbound: any[] = [];

    if (isAdmin && conversationId) {
      const convo = await prisma.conversation.findFirst({
        where: { id: conversationId, workspaceId: access.workspaceId },
        include: { contact: true, program: true, phoneLine: true },
      });
      if (convo) {
        programIdForUsage = convo.programId ? String(convo.programId) : null;
        conversationSnapshot = {
          id: convo.id,
          status: convo.status,
          stage: convo.conversationStage,
          program: convo.program ? { id: convo.program.id, name: convo.program.name, slug: convo.program.slug } : null,
          phoneLine: convo.phoneLine ? { id: convo.phoneLine.id, alias: convo.phoneLine.alias } : null,
          contact: {
            id: convo.contactId,
            displayName: convo.contact.displayName,
            candidateName: convo.contact.candidateName,
            candidateNameManual: (convo.contact as any).candidateNameManual,
            noContact: convo.contact.noContact,
            noContactReason: (convo.contact as any).noContactReason,
          },
        };
      }

      recentAgentRuns = await prisma.agentRunLog.findMany({
        where: { workspaceId: access.workspaceId, conversationId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, status: true, eventType: true, createdAt: true, error: true },
      });
      recentOutbound = await prisma.outboundMessageLog.findMany({
        where: { workspaceId: access.workspaceId, conversationId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, type: true, templateName: true, blockedReason: true, createdAt: true, dedupeKey: true },
      });
    }

    const lastOutbound = recentOutbound.length > 0 ? recentOutbound[0] : null;
    const lastAgentRun = recentAgentRuns.length > 0 ? recentAgentRuns[0] : null;

    const defaultDiagnosis = (() => {
      if (!isAdmin || !conversationSnapshot) return null;
      if (conversationSnapshot.contact?.noContact) {
        return 'Este contacto está marcado como NO_CONTACTAR, por lo que el sistema no enviará mensajes automáticos.';
      }
      if (lastOutbound?.blockedReason) {
        return explainBlockedReason(lastOutbound.blockedReason);
      }
      if (!lastAgentRun) {
        return 'No veo corridas recientes del agente para esta conversación. Puede ser que no se haya disparado la automation o que el inbound no haya entrado.';
      }
      if (lastAgentRun.status === 'ERROR') {
        return `La última corrida del agente falló: ${lastAgentRun.error || 'error'}.`;
      }
      if (recentOutbound.length === 0) {
        return 'El agente corrió, pero no veo mensajes outbound recientes asociados. Puede que haya decidido no enviar o que un guardrail lo haya bloqueado.';
      }
      return null;
    })();

    if (!apiKey) {
      const replyText =
        defaultDiagnosis ||
        'Puedo ayudarte a navegar y diagnosticar. Para respuestas con IA, configura la API Key de OpenAI en Configuración → Integraciones.';
      const actions = isAdmin
        ? [
            { type: 'NAVIGATE' as const, view: 'config' as const, configTab: 'integrations' as const, label: 'Ir a Integraciones' },
            { type: 'NAVIGATE' as const, view: 'review' as const, label: 'Abrir Ayuda / QA' },
          ]
        : [];
      if (run?.id) {
        await prisma.copilotRunLog.update({
          where: { id: run.id },
          data: { status: 'SUCCESS', responseText: replyText, actionsJson: serializeJson(actions) },
        });
      }
      return { reply: replyText, actions, threadId };
    }

    const client = new OpenAI({ apiKey });
    const model = normalizeModelId(config.aiModel || DEFAULT_AI_MODEL) || DEFAULT_AI_MODEL;

    const system = `
Eres el Copilot interno de Hunter CRM (Agent OS).
Objetivo: ayudar a un humano a usar la plataforma, navegar y diagnosticar problemas.

Reglas:
- Responde SIEMPRE en español, corto y claro.
- NO envíes WhatsApp ni propongas enviar WhatsApp.
- Puedes sugerir navegación con actions[].type="NAVIGATE" (views permitidos: inbox, inactive, simulator, agenda, config, review).
- Si el usuario pide "por qué no respondió", usa logs/contexto y explica causas comunes (SAFE MODE, NO_CONTACTAR, ventana 24h, dedupe, error de agente).
- Si falta información, pregunta 1 cosa concreta.
- No inventes datos.

Tu salida debe ser SOLO un JSON válido con el shape:
{ "reply": string, "actions"?: [ { "type":"NAVIGATE", "view": "...", "configTab"?: "...", "label"?: "..." } ] }
`.trim();

    const context = {
      workspaceId: access.workspaceId,
      userRole: request.user?.role || access.role || null,
      view,
      safeMode: { outboundPolicy, effectiveAllowlist },
      conversation: conversationSnapshot,
      recentAgentRuns: recentAgentRuns.map((r) => ({
        id: r.id,
        status: r.status,
        eventType: r.eventType,
        createdAt: r.createdAt.toISOString(),
        error: r.error,
      })),
      recentOutbound: recentOutbound.map((o) => ({
        id: o.id,
        type: o.type,
        templateName: o.templateName,
        blockedReason: o.blockedReason,
        createdAt: o.createdAt.toISOString(),
        dedupeKey: o.dedupeKey,
      })),
      defaultDiagnosis,
    };

    let responseText = '';
    let actionsJson: any[] = [];
    let usagePrompt = 0;
    let usageCompletion = 0;
    let usageTotal = 0;

    try {
      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: serializeJson({ userMessage: text, context }) },
        ],
        temperature: 0.2,
        max_tokens: 350,
      });

      usagePrompt = completion.usage?.prompt_tokens || 0;
      usageCompletion = completion.usage?.completion_tokens || 0;
      usageTotal = completion.usage?.total_tokens || 0;

      const raw = String(completion.choices[0]?.message?.content || '').trim();
      const parsed = safeJsonParse(raw) || {};
      const validated = CopilotResponseSchema.safeParse(parsed);
      if (!validated.success) {
        throw new Error('Respuesta inválida del Copilot (schema).');
      }
      responseText = validated.data.reply.trim();
      const actions = Array.isArray(validated.data.actions) ? validated.data.actions : [];
      actionsJson = actions.filter((a) => {
        if (a.type !== 'NAVIGATE') return false;
        if (!isAdmin && a.view !== 'inbox' && a.view !== 'inactive' && a.view !== 'review') return false;
        if (a.view === 'config' && !isAdmin) return false;
        if (a.view === 'config' && a.configTab && !ConfigTabSchema.safeParse(a.configTab).success) return false;
        return true;
      });
    } catch (err) {
      const errorText = err instanceof Error ? err.message : 'Error';
      const actionable =
        /api key|apikey|unauthorized|401/i.test(errorText)
          ? 'No pude usar OpenAI: la API Key parece inválida o no autorizada.'
          : /model/i.test(errorText) && /not found|invalid/i.test(errorText)
            ? 'No pude usar OpenAI: el modelo configurado parece inválido.'
            : /timeout|timed out|504/i.test(errorText)
              ? 'No pude usar OpenAI: timeout al consultar el proveedor.'
              : null;
      const fallback = defaultDiagnosis
        ? `${defaultDiagnosis}\n\nSi quieres, dime “ver logs” y te llevo a Ayuda / QA.`
        : `${actionable ? `${actionable} ` : ''}Puedes intentar de nuevo o abrir Ayuda / QA para ver el motivo exacto en Logs.`;
      responseText = fallback;
      actionsJson = isAdmin
        ? [
            { type: 'NAVIGATE', view: 'config', configTab: 'integrations', label: 'Ir a Integraciones' },
            { type: 'NAVIGATE', view: 'review', label: 'Abrir Ayuda / QA' },
          ]
        : [];

      if (run?.id) {
        await prisma.copilotRunLog.update({
          where: { id: run.id },
          data: { status: 'ERROR', error: errorText, responseText, actionsJson: serializeJson(actionsJson) },
        });
      }
      if (run?.id) {
        await prisma.aiUsageLog
          .create({
            data: {
              workspaceId: access.workspaceId,
              actor: 'COPILOT',
              model,
              inputTokens: usagePrompt,
              outputTokens: usageCompletion,
              totalTokens: usageTotal,
              copilotRunId: run.id,
              conversationId,
              programId: programIdForUsage,
            },
          })
          .catch(() => {});
      }
      return { reply: responseText, actions: actionsJson, threadId };
    }

    if (run?.id) {
      await prisma.copilotRunLog.update({
        where: { id: run.id },
        data: { status: 'SUCCESS', responseText, actionsJson: serializeJson(actionsJson) },
      });
      await prisma.aiUsageLog
        .create({
          data: {
            workspaceId: access.workspaceId,
            actor: 'COPILOT',
            model,
            inputTokens: usagePrompt,
            outputTokens: usageCompletion,
            totalTokens: usageTotal,
            copilotRunId: run.id,
            conversationId,
            programId: programIdForUsage,
          },
        })
        .catch(() => {});
    }

    return { reply: responseText, actions: actionsJson, threadId };
  });
}
