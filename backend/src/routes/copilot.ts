import { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { z } from 'zod';
import { prisma } from '../db/client';
import { getEffectiveOpenAiKey } from '../services/aiService';
import { DEFAULT_AI_MODEL, getEffectiveOutboundAllowlist, getOutboundPolicy, getSystemConfig, normalizeModelId } from '../services/configService';
import { resolveWorkspaceAccess, isWorkspaceAdmin } from '../services/workspaceAuthService';
import { serializeJson } from '../utils/json';

const ViewSchema = z.enum(['inbox', 'inactive', 'simulator', 'agenda', 'config', 'review']);
const ConfigTabSchema = z.enum(['workspace', 'users', 'phoneLines', 'programs', 'automations', 'logs', 'usage']);

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

  if (/(ll[eé]vame|ir|abre|abrir|vamos a)\s+(inbox|bandeja)/i.test(text) || t === 'inbox') return go('inbox', undefined, 'Abrir Inbox');
  if (/(ll[eé]vame|ir|abre|abrir|vamos a)\s+(inactivos|archivados)/i.test(text) || t === 'inactivos') return go('inactive', undefined, 'Abrir Inactivos');
  if (/(ll[eé]vame|ir|abre|abrir|vamos a)\s+(simulador|simulator)/i.test(text) || t === 'simulador') return go('simulator', undefined, 'Abrir Simulador');
  if (/(ll[eé]vame|ir|abre|abrir|vamos a)\s+(agenda|calendario)/i.test(text) || t === 'agenda') return go('agenda', undefined, 'Abrir Agenda');
  if (/(ll[eé]vame|ir|abre|abrir|vamos a)\s+(config|configuracion|settings)/i.test(text)) return go('config', undefined, 'Abrir Configuración');
  if (/(ll[eé]vame|ir|abre|abrir|vamos a)\s+(programs?|programas)/i.test(text)) return go('config', 'programs', 'Ir a Programs');
  if (/(ll[eé]vame|ir|abre|abrir|vamos a)\s+(automations?|reglas|automat)/i.test(text)) return go('config', 'automations', 'Ir a Automations');
  if (/(ll[eé]vame|ir|abre|abrir|vamos a)\s+(numeros|whatsapp|phoneline)/i.test(text)) return go('config', 'phoneLines', 'Ir a Números WhatsApp');
  if (/(ll[eé]vame|ir|abre|abrir|vamos a)\s+(usuarios|users)/i.test(text)) return go('config', 'users', 'Ir a Usuarios');
  if (/(ll[eé]vame|ir|abre|abrir|vamos a)\s+(logs?)/i.test(text)) return go('config', 'logs', 'Ir a Logs');
  if (/(ll[eé]vame|ir|abre|abrir|vamos a)\s+(uso|costos|consumo)/i.test(text)) return go('config', 'usage', 'Ir a Uso & Costos');
  if (/(ayuda|qa|owner review)/i.test(text)) return go('review', undefined, 'Abrir Ayuda / QA');
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
  app.post('/chat', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const isAdmin = isWorkspaceAdmin(request, access);
    const body = request.body as { text?: string; conversationId?: string | null; view?: string | null };
    const text = String(body?.text || '').trim();
    const conversationId = body?.conversationId ? String(body.conversationId) : null;
    const view = typeof body?.view === 'string' ? body.view : null;

    if (!text) return reply.code(400).send({ error: '"text" es obligatorio.' });

    const run = await prisma.copilotRunLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId: request.user?.userId || null,
          conversationId,
          view: view || null,
          inputText: text,
          status: 'RUNNING',
        } as any,
      })
      .catch(() => null);

    const directNav = inferNavigation(text);
    if (directNav && (!directNav.configTab || isAdmin)) {
      const response = { reply: `Listo. ${directNav.label || 'Te llevo ahí.'}`, actions: [directNav] };
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
        'Puedo ayudarte a navegar y diagnosticar. Si necesitas IA avanzada, configura la API Key de OpenAI en Configuración → IA.';
      const actions = isAdmin ? [{ type: 'NAVIGATE' as const, view: 'review' as const, label: 'Abrir Ayuda / QA' }] : [];
      if (run?.id) {
        await prisma.copilotRunLog.update({
          where: { id: run.id },
          data: { status: 'SUCCESS', responseText: replyText, actionsJson: serializeJson(actions) },
        });
      }
      return { reply: replyText, actions };
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
      const fallback = defaultDiagnosis
        ? `${defaultDiagnosis}\n\nSi quieres, dime “ver logs” y te llevo a Ayuda / QA.`
        : 'Tuve un error al responder. Intenta de nuevo o revisa Ayuda / QA para ver logs.';
      responseText = fallback;
      actionsJson = isAdmin ? [{ type: 'NAVIGATE', view: 'review', label: 'Abrir Ayuda / QA' }] : [];

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
      return { reply: responseText, actions: actionsJson };
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

    return { reply: responseText, actions: actionsJson };
  });
}
