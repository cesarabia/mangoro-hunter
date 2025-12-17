import OpenAI from 'openai';
import { prisma } from '../../db/client';
import { getEffectiveOpenAiKey } from '../aiService';
import { getSystemConfig, DEFAULT_AI_MODEL, normalizeModelId } from '../configService';
import { serializeJson } from '../../utils/json';
import { AgentResponse, AgentResponseSchema } from './commandSchema';
import { normalizeText, piiSanitizeText, resolveLocation, stableHash, validateRut } from './tools';
import { validateAgentResponseSemantics } from './semanticValidation';
import { repairAgentResponseBeforeValidation } from './agentResponseRepair';

type WhatsAppWindowStatus = 'IN_24H' | 'OUTSIDE_24H';

export type AgentEvent = {
  workspaceId: string;
  conversationId: string;
  eventType: string;
  inboundMessageId?: string | null;
};

type ToolResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

function buildSystemPrompt(params: {
  programPrompt: string;
  windowStatus: WhatsAppWindowStatus;
}): string {
  const policy = `
Eres un agente de Hunter CRM. NO respondas con texto suelto.
Debes responder SOLO con un JSON válido que cumpla el schema:
{
  "agent": string,
  "version": 1,
  "commands": [ ... ],
  "notes"?: string
}

Commands permitidos (campo "command" EXACTO):
- UPSERT_PROFILE_FIELDS
- SET_CONVERSATION_STATUS
- SET_CONVERSATION_STAGE
- SET_CONVERSATION_PROGRAM
- ADD_CONVERSATION_NOTE
- SET_NO_CONTACTAR
- SCHEDULE_INTERVIEW
- SEND_MESSAGE
- NOTIFY_ADMIN
- RUN_TOOL

Reglas de seguridad y guardrails:
- No inventes datos. Si falta info, pregunta 1 cosa clara.
- No actives NO_CONTACTAR salvo opt-out explícito en el mensaje del usuario (no por contenido de adjuntos).
- Respeta ventana WhatsApp:
  - IN_24H: puedes usar SEND_MESSAGE type=SESSION_TEXT.
  - OUTSIDE_24H: solo SEND_MESSAGE type=TEMPLATE (nunca SESSION_TEXT).
- Para RESPONDER al humano debes usar SEND_MESSAGE. "notes" es SOLO para debug interno (no es un mensaje).
- Nunca sobrescribas candidateName si existe candidateNameManual.
- Evita loops: no repitas la misma pregunta 2+ veces; si necesitas confirmar, pide confirmación en formato 1/2.
`.trim();

  return `${policy}\n\nEstado ventana WhatsApp: ${params.windowStatus}\n\n${params.programPrompt}`.trim();
}

async function computeWhatsAppWindowStatus(conversationId: string): Promise<WhatsAppWindowStatus> {
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const lastInbound = await prisma.message.findFirst({
    where: { conversationId, direction: 'INBOUND' },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true },
  });
  if (!lastInbound?.timestamp) return 'IN_24H';
  const delta = Date.now() - new Date(lastInbound.timestamp).getTime();
  return delta <= WINDOW_MS ? 'IN_24H' : 'OUTSIDE_24H';
}

function toolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'normalize_text',
        description: 'Normaliza texto: lower, sin tildes, sin emojis, trim y espacios compactos.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'resolve_location',
        description:
          'Resuelve comuna/ciudad/región desde texto (Chile). Devuelve confidence y normalized.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            country: { type: 'string', default: 'CL' },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'validate_rut',
        description: 'Valida RUT chileno y retorna normalized (12345678-9) si aplica.',
        parameters: {
          type: 'object',
          properties: { rutText: { type: 'string' } },
          required: ['rutText'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'pii_sanitize',
        description: 'Sanitiza PII en texto (emails, teléfonos, RUT).',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_whatsapp_window_status',
        description: 'Retorna IN_24H u OUTSIDE_24H para una conversación.',
        parameters: {
          type: 'object',
          properties: { conversationId: { type: 'string' } },
          required: ['conversationId'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_available_programs',
        description: 'Lista programs activos por workspace (opcionalmente filtrado por phoneLine).',
        parameters: {
          type: 'object',
          properties: {
            workspaceId: { type: 'string' },
            phoneLineId: { type: 'string' },
          },
          required: ['workspaceId'],
          additionalProperties: false,
        },
      },
    },
  ] as const;
}

async function runTool(toolName: string, args: any): Promise<ToolResult> {
  try {
    if (toolName === 'normalize_text') {
      return { ok: true, result: { normalized: normalizeText(String(args?.text || '')) } };
    }
    if (toolName === 'resolve_location') {
      const text = String(args?.text || '');
      const country = typeof args?.country === 'string' ? args.country : 'CL';
      return { ok: true, result: resolveLocation(text, country) };
    }
    if (toolName === 'validate_rut') {
      const rutText = String(args?.rutText || '');
      return { ok: true, result: validateRut(rutText) };
    }
    if (toolName === 'pii_sanitize') {
      const text = String(args?.text || '');
      return { ok: true, result: { text: piiSanitizeText(text) } };
    }
    if (toolName === 'get_whatsapp_window_status') {
      const conversationId = String(args?.conversationId || '');
      if (!conversationId) return { ok: false, error: 'conversationId requerido' };
      return { ok: true, result: { status: await computeWhatsAppWindowStatus(conversationId) } };
    }
    if (toolName === 'get_available_programs') {
      const workspaceId = String(args?.workspaceId || '');
      if (!workspaceId) return { ok: false, error: 'workspaceId requerido' };
      const programs = await prisma.program.findMany({
        where: { workspaceId, isActive: true, archivedAt: null },
        select: { id: true, name: true, slug: true },
        orderBy: { name: 'asc' },
      });
      return { ok: true, result: { programs } };
    }
    return { ok: false, error: `toolName desconocido: ${toolName}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'tool error' };
  }
}

function parseJsonLoose(value: string | null | undefined): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function canonicalizeEnum(value: any): any {
  if (typeof value !== 'string') return value;
  return value.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function normalizeAgentResponseShape(value: any): any {
  if (!value || typeof value !== 'object') return value;
  const out: any = Array.isArray(value) ? [...value] : { ...value };
  if (typeof out.version === 'string') {
    const parsed = parseInt(out.version, 10);
    if (Number.isFinite(parsed)) out.version = parsed;
  }
  if (Array.isArray(out.commands)) {
    out.commands = out.commands.map((cmd: any) => {
      if (!cmd || typeof cmd !== 'object') return cmd;
      let next: any = { ...cmd };
      if (next.parameters && typeof next.parameters === 'object' && !Array.isArray(next.parameters)) {
        next = { ...next, ...(next.parameters as any) };
        delete next.parameters;
      }
      if ('command' in next) next.command = canonicalizeEnum(next.command);
      if ('type' in next) next.type = canonicalizeEnum(next.type);
      if ('channel' in next) next.channel = canonicalizeEnum(next.channel);
      if ('status' in next) next.status = canonicalizeEnum(next.status);
      if ('severity' in next) next.severity = canonicalizeEnum(next.severity);
      if ('visibility' in next) next.visibility = canonicalizeEnum(next.visibility);
      if (next.templateVars && typeof next.templateVars === 'object' && !Array.isArray(next.templateVars)) {
        const normalizedVars: Record<string, string> = {};
        for (const [k, v] of Object.entries(next.templateVars)) {
          normalizedVars[String(k)] = typeof v === 'string' ? v : String(v);
        }
        next.templateVars = normalizedVars;
      }
      if (next.dedupeKey && typeof next.dedupeKey !== 'string') {
        next.dedupeKey = String(next.dedupeKey);
      }
      return next;
    });
  }
  return out;
}

function applyCommandDefaults(
  value: any,
  defaults: {
    workspaceId: string;
    conversationId: string;
    contactId: string;
    windowStatus: WhatsAppWindowStatus;
    inboundMessageId?: string | null;
    eventType: string;
  },
): any {
  if (!value || typeof value !== 'object' || !Array.isArray((value as any).commands)) return value;
  const out: any = { ...(value as any) };
  out.commands = (value as any).commands.map((cmd: any) => {
    if (!cmd || typeof cmd !== 'object') return cmd;
    const next: any = { ...cmd };
    const command = String(next.command || '').trim();

    const needsConversationId = new Set([
      'SET_CONVERSATION_STATUS',
      'SET_CONVERSATION_STAGE',
      'SET_CONVERSATION_PROGRAM',
      'ADD_CONVERSATION_NOTE',
      'SCHEDULE_INTERVIEW',
      'SEND_MESSAGE',
    ]);
    const needsContactId = new Set(['UPSERT_PROFILE_FIELDS', 'SET_NO_CONTACTAR']);

    if (needsConversationId.has(command) && !next.conversationId) {
      next.conversationId = defaults.conversationId;
    }
    if (needsContactId.has(command) && !next.contactId) {
      next.contactId = defaults.contactId;
    }
    if (command === 'NOTIFY_ADMIN' && !next.workspaceId) {
      next.workspaceId = defaults.workspaceId;
    }
    if (command === 'SEND_MESSAGE') {
      next.channel = 'WHATSAPP';
      if (!next.type) {
        next.type = defaults.windowStatus === 'OUTSIDE_24H' ? 'TEMPLATE' : 'SESSION_TEXT';
      }
      if (!next.dedupeKey) {
        const seed = `${defaults.conversationId}:${defaults.eventType}:${defaults.inboundMessageId || ''}:${next.type}:${next.text || ''}:${next.templateName || ''}`;
        next.dedupeKey = `auto:${stableHash(seed).slice(0, 16)}`;
      }
    }
    return next;
  });
  return out;
}

export async function runAgent(event: AgentEvent): Promise<{
  runId: string;
  windowStatus: WhatsAppWindowStatus;
  response: AgentResponse;
}> {
  const config = await getSystemConfig();
  const apiKey = getEffectiveOpenAiKey(config);
  if (!apiKey) {
    const run = await prisma.agentRunLog.create({
      data: {
        workspaceId: event.workspaceId,
        conversationId: event.conversationId,
        eventType: event.eventType,
        status: 'ERROR',
        inputContextJson: serializeJson({ error: 'missing_openai_key' }),
        error: 'OpenAI key no configurada',
      },
    });
    throw new Error('OpenAI key no configurada');
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: event.conversationId },
    include: { contact: true },
  });
  if (!conversation) {
    throw new Error('Conversation no encontrada');
  }

  const windowStatus = await computeWhatsAppWindowStatus(event.conversationId);
  const asked = await prisma.conversationAskedField.findMany({
    where: { conversationId: event.conversationId },
    select: { field: true, askCount: true, lastAskedAt: true, lastAskedHash: true },
  });
  const askedFieldsHistory: Record<
    string,
    { count: number; lastAskedAt: string | null; lastAskedHash: string | null }
  > = {};
  for (const row of asked) {
    askedFieldsHistory[row.field] = {
      count: row.askCount,
      lastAskedAt: row.lastAskedAt ? row.lastAskedAt.toISOString() : null,
      lastAskedHash: row.lastAskedHash || null,
    };
  }

  const lastOutbound = await prisma.outboundMessageLog.findFirst({
    where: { conversationId: event.conversationId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, textHash: true, dedupeKey: true },
  });

  const lastMessages = await prisma.message.findMany({
    where: { conversationId: event.conversationId },
    orderBy: { timestamp: 'desc' },
    take: 25,
    select: {
      id: true,
      direction: true,
      text: true,
      transcriptText: true,
      mediaType: true,
      timestamp: true,
      waMessageId: true,
    },
  });

  const contextJson = {
    workspaceId: event.workspaceId,
    event: { type: event.eventType, inboundMessageId: event.inboundMessageId || null },
    conversation: {
      id: conversation.id,
      status: conversation.status,
      stage: conversation.conversationStage,
      programId: conversation.programId,
      phoneLineId: conversation.phoneLineId,
      isAdmin: conversation.isAdmin,
    },
    contact: {
      id: conversation.contactId,
      waId: conversation.contact.waId,
      phone: conversation.contact.phone,
      displayName: conversation.contact.displayName || conversation.contact.name,
      candidateName: conversation.contact.candidateName,
      candidateNameManual: (conversation.contact as any).candidateNameManual,
      email: (conversation.contact as any).email,
      rut: (conversation.contact as any).rut,
      comuna: (conversation.contact as any).comuna,
      ciudad: (conversation.contact as any).ciudad,
      region: (conversation.contact as any).region,
      experienceYears: (conversation.contact as any).experienceYears,
      terrainExperience: (conversation.contact as any).terrainExperience,
      availabilityText: (conversation.contact as any).availabilityText,
      flags: { NO_CONTACTAR: conversation.contact.noContact },
    },
    askedFieldsHistory,
    lastOutbound: lastOutbound
      ? {
          lastOutboundHash: lastOutbound.textHash,
          lastOutboundAt: lastOutbound.createdAt.toISOString(),
          lastDedupeKey: lastOutbound.dedupeKey,
        }
      : null,
    whatsappWindowStatus: windowStatus,
    lastMessages: lastMessages
      .slice()
      .reverse()
      .map((m) => ({
        id: m.id,
        waMessageId: m.waMessageId,
        direction: m.direction,
        text: m.transcriptText || m.text,
        mediaType: m.mediaType || null,
        timestamp: m.timestamp.toISOString(),
      })),
    config: {
      botAutoReply: config.botAutoReply,
    },
  };

  const programPrompt = await (async () => {
    if (conversation.programId) {
      const program = await prisma.program.findUnique({
        where: { id: conversation.programId },
        select: { agentSystemPrompt: true },
      });
      if (program?.agentSystemPrompt) return program.agentSystemPrompt;
    }
    return (
      config.aiPrompt?.trim() ||
      'Programa default: coordina reclutamiento/entrevista/ventas según contexto. Responde corto y humano.'
    );
  })();

  const runLog = await prisma.agentRunLog.create({
    data: {
      workspaceId: event.workspaceId,
      conversationId: conversation.id,
      programId: conversation.programId,
      phoneLineId: conversation.phoneLineId,
      eventType: event.eventType,
      status: 'RUNNING',
      inputContextJson: serializeJson(contextJson),
    },
  });

  const client = new OpenAI({ apiKey });
  const model = normalizeModelId(config.aiModel?.trim() || DEFAULT_AI_MODEL) || DEFAULT_AI_MODEL;
  let usagePromptTokens = 0;
  let usageCompletionTokens = 0;
  let usageTotalTokens = 0;

  const tools = toolDefinitions();

  const messages: any[] = [
    { role: 'system', content: buildSystemPrompt({ programPrompt, windowStatus }) },
    {
      role: 'user',
      content: serializeJson(contextJson),
    },
  ];

  let lastInvalidRaw: string | null = null;
  let lastInvalidIssues: any = null;

  try {
    let safetyIterations = 0;
    let invalidAttempts = 0;
    while (safetyIterations < 6) {
      safetyIterations += 1;
      const completion = await client.chat.completions.create({
        model,
        messages,
        tools: tools as any,
        tool_choice: 'auto',
        temperature: 0.2,
        max_tokens: 900,
        response_format: { type: 'json_object' } as any,
      });
      const usage: any = (completion as any)?.usage;
      if (usage) {
        usagePromptTokens += Number(usage.prompt_tokens || 0) || 0;
        usageCompletionTokens += Number(usage.completion_tokens || 0) || 0;
        usageTotalTokens += Number(usage.total_tokens || 0) || 0;
      }

      const message = completion.choices[0]?.message;
      if (!message) throw new Error('Respuesta vacía del modelo');

      const toolCalls = (message as any).tool_calls as
        | Array<{ id: string; function: { name: string; arguments: string } }>
        | undefined;

      if (toolCalls && toolCalls.length > 0) {
        messages.push(message);
        for (const call of toolCalls) {
          const toolName = call.function?.name;
          const argsRaw = call.function?.arguments || '{}';
          const args = parseJsonLoose(argsRaw) || {};
          const result = await runTool(toolName, args);
          await prisma.toolCallLog.create({
            data: {
              agentRunId: runLog.id,
              toolName,
              argsJson: serializeJson(args),
              resultJson: result.ok ? serializeJson(result.result) : null,
              error: result.ok ? null : result.error,
            },
          });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: serializeJson(result.ok ? result.result : { error: result.error }),
          });
        }
        continue;
      }

      const raw = String((message as any).content || '').trim();
      const parsedRaw = applyCommandDefaults(normalizeAgentResponseShape(parseJsonLoose(raw)), {
        workspaceId: event.workspaceId,
        conversationId: conversation.id,
        contactId: conversation.contactId,
        windowStatus,
        inboundMessageId: event.inboundMessageId || null,
        eventType: event.eventType,
      });
      const parsed = repairAgentResponseBeforeValidation(parsedRaw);
      const validated = AgentResponseSchema.safeParse(parsed);
      if (!validated.success) {
        invalidAttempts += 1;
        lastInvalidRaw = raw || null;
        lastInvalidIssues = validated.error.issues;
        if (invalidAttempts <= 2) {
          messages.push({ role: 'assistant', content: raw || '{}' });
          messages.push({
            role: 'user',
            content: serializeJson({
              error: 'INVALID_SCHEMA',
              issues: validated.error.issues,
              instruction:
                'Tu JSON anterior NO cumple el schema. Devuelve SOLO un JSON válido con "commands[].command" usando EXACTAMENTE uno de los valores permitidos (en mayúsculas): ' +
                'UPSERT_PROFILE_FIELDS, SET_CONVERSATION_STATUS, SET_CONVERSATION_STAGE, SET_CONVERSATION_PROGRAM, ADD_CONVERSATION_NOTE, SET_NO_CONTACTAR, SCHEDULE_INTERVIEW, SEND_MESSAGE, NOTIFY_ADMIN, RUN_TOOL. ' +
                'Si usas SEND_MESSAGE, incluye: conversationId, channel=\"WHATSAPP\", type=\"SESSION_TEXT\"|\"TEMPLATE\", text (o templateName+templateVars), dedupeKey.',
            }),
          });
          continue;
        }
        throw new Error(`Respuesta del agente inválida: ${validated.error.message}`);
      }

      const semanticIssues = validateAgentResponseSemantics(validated.data);
      const hasSendMessage = validated.data.commands.some((c: any) => c && typeof c === 'object' && c.command === 'SEND_MESSAGE');
      if (event.eventType === 'INBOUND_MESSAGE' && !hasSendMessage) {
        const notesText = typeof validated.data.notes === 'string' ? validated.data.notes.trim() : '';
        if (notesText && windowStatus === 'IN_24H') {
          const seed = `${conversation.id}:${event.eventType}:${event.inboundMessageId || ''}:AUTO_NOTES_SEND:${notesText}`;
          const dedupeKey = `auto:${stableHash(seed).slice(0, 16)}`;
          (validated.data.commands as any[]).push({
            command: 'SEND_MESSAGE',
            conversationId: conversation.id,
            channel: 'WHATSAPP',
            type: 'SESSION_TEXT',
            text: notesText,
            dedupeKey,
          });
        } else {
          semanticIssues.push({
            path: ['commands'],
            message: 'INBOUND_MESSAGE requiere al menos 1 SEND_MESSAGE (para no dejar al humano sin respuesta).',
          });
        }
      }
      if (semanticIssues.length > 0) {
        invalidAttempts += 1;
        lastInvalidRaw = raw || null;
        lastInvalidIssues = semanticIssues;
        if (invalidAttempts <= 2) {
          messages.push({ role: 'assistant', content: raw || '{}' });
          messages.push({
            role: 'user',
            content: serializeJson({
              error: 'INVALID_SEMANTICS',
              issues: semanticIssues,
              instruction:
                'Tu JSON es válido, pero faltan campos requeridos. Corrige los comandos. ' +
                'En SEND_MESSAGE: si type=SESSION_TEXT debes incluir "text". Si type=TEMPLATE debes incluir "templateName" (y variables si aplica).',
            }),
          });
          continue;
        }
        throw new Error(`Respuesta del agente inválida: ${serializeJson(semanticIssues)}`);
      }

      await prisma.agentRunLog.update({
        where: { id: runLog.id },
        data: { status: 'PLANNED', commandsJson: serializeJson(validated.data) },
      });

      await prisma.aiUsageLog
        .create({
          data: {
            workspaceId: event.workspaceId,
            actor: 'AGENT_RUNTIME',
            model,
            inputTokens: usagePromptTokens,
            outputTokens: usageCompletionTokens,
            totalTokens: usageTotalTokens,
            agentRunId: runLog.id,
            conversationId: conversation.id,
            programId: conversation.programId,
          },
        })
        .catch(() => {});

      return { runId: runLog.id, windowStatus, response: validated.data };
    }

    throw new Error('Loop de tools excedido');
  } catch (err) {
    const errorText = err instanceof Error ? err.message : 'unknown';
    await prisma.agentRunLog.update({
      where: { id: runLog.id },
      data: {
        status: 'ERROR',
        error: errorText,
        resultsJson: serializeJson({
          error: errorText,
          lastInvalidRaw,
          lastInvalidIssues,
        }),
      },
    });
    await prisma.aiUsageLog
      .create({
        data: {
          workspaceId: event.workspaceId,
          actor: 'AGENT_RUNTIME',
          model,
          inputTokens: usagePromptTokens,
          outputTokens: usageCompletionTokens,
          totalTokens: usageTotalTokens,
          agentRunId: runLog.id,
          conversationId: conversation.id,
          programId: conversation.programId,
        },
      })
      .catch(() => {});
    throw err;
  }
}
