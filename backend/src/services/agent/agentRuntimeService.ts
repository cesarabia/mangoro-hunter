import OpenAI from 'openai';
import { prisma } from '../../db/client';
import { getEffectiveOpenAiKey } from '../aiService';
import { getSystemConfig, DEFAULT_AI_MODEL, normalizeModelId } from '../configService';
import { serializeJson } from '../../utils/json';
import { AgentResponse, AgentResponseSchema } from './commandSchema';
import { normalizeText, piiSanitizeText, resolveLocation, stableHash, validateRut } from './tools';
import { validateAgentResponseSemantics } from './semanticValidation';
import { repairAgentResponseBeforeValidation } from './agentResponseRepair';
import { normalizeWhatsAppId } from '../../utils/whatsapp';

type WhatsAppWindowStatus = 'IN_24H' | 'OUTSIDE_24H';

export type AgentEvent = {
  workspaceId: string;
  conversationId: string;
  eventType: string;
  inboundMessageId?: string | null;
  draftText?: string | null;
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
- Si event.type == "AI_SUGGEST": NO cambies estado/perfil (no UPSERT_PROFILE_FIELDS ni SET_CONVERSATION_*). Devuelve SOLO 1 SEND_MESSAGE con el texto sugerido. Si existe event.draftText, mejora ese borrador manteniendo el significado.
- El Program actual (incluido en el prompt) es la fuente única de verdad. Si el historial de la conversación parece de otro Program, igual debes responder siguiendo el Program actual.
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

export async function resolveReplyContextForInboundMessage(params: {
  workspaceId: string;
  inboundMessageId: string;
}): Promise<{
  replyToWaMessageId: string | null;
  relatedConversationId: string | null;
  outboundLogId: string | null;
}> {
  const inboundMessageId = String(params.inboundMessageId || '').trim();
  if (!inboundMessageId) return { replyToWaMessageId: null, relatedConversationId: null, outboundLogId: null };

  const msg = await prisma.message
    .findUnique({
      where: { id: inboundMessageId },
      select: { rawPayload: true },
    })
    .catch(() => null);
  const payload = parseJsonLoose(msg?.rawPayload || null);
  const replyToWaMessageId =
    payload && typeof payload === 'object' && payload.context && typeof payload.context === 'object'
      ? String((payload.context as any).id || '').trim() || null
      : null;
  if (!replyToWaMessageId) return { replyToWaMessageId: null, relatedConversationId: null, outboundLogId: null };

  const outbound = await prisma.outboundMessageLog
    .findFirst({
      where: { workspaceId: params.workspaceId, waMessageId: replyToWaMessageId },
      select: { id: true, relatedConversationId: true },
      orderBy: { createdAt: 'desc' },
    })
    .catch(() => null);

  return {
    replyToWaMessageId,
    relatedConversationId: outbound?.relatedConversationId ? String(outbound.relatedConversationId) : null,
    outboundLogId: outbound?.id ? String(outbound.id) : null,
  };
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
      if (next.payload && typeof next.payload === 'object' && !Array.isArray(next.payload)) {
        next = { ...next, ...(next.payload as any) };
        delete next.payload;
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

  const replyCtx = event.inboundMessageId
    ? await resolveReplyContextForInboundMessage({
        workspaceId: event.workspaceId,
        inboundMessageId: String(event.inboundMessageId),
      }).catch(() => ({ replyToWaMessageId: null, relatedConversationId: null, outboundLogId: null }))
    : { replyToWaMessageId: null, relatedConversationId: null, outboundLogId: null };
  const replyToWaMessageId = replyCtx.replyToWaMessageId;
  const relatedConversationId = replyCtx.relatedConversationId;
  const relatedConversation = relatedConversationId
    ? await prisma.conversation
        .findFirst({
          where: { id: relatedConversationId, workspaceId: event.workspaceId, archivedAt: null, isAdmin: false },
          include: {
            contact: true,
            messages: {
              orderBy: { timestamp: 'desc' },
              take: 6,
              select: { id: true, direction: true, text: true, transcriptText: true, mediaType: true, timestamp: true },
            },
          },
        })
        .catch(() => null)
    : null;

  const staffContext = await (async () => {
    if (String((conversation as any).conversationKind || '').toUpperCase() !== 'STAFF') return null;
    const waId = normalizeWhatsAppId(conversation.contact.waId || conversation.contact.phone || '') || null;
    if (!waId) return null;
    const memberships = await prisma.membership
      .findMany({
        where: {
          workspaceId: event.workspaceId,
          archivedAt: null,
          OR: [{ staffWhatsAppE164: { not: null } }, { staffWhatsAppExtraE164sJson: { not: null } as any }],
        } as any,
        include: { user: { select: { id: true, email: true, name: true } } },
      })
      .catch(() => []);
    const match = memberships.find((m) => {
      const primary = normalizeWhatsAppId(String((m as any).staffWhatsAppE164 || '')) === waId;
      if (primary) return true;
      const extraRaw = String((m as any).staffWhatsAppExtraE164sJson || '').trim();
      if (!extraRaw) return false;
      try {
        const parsed = JSON.parse(extraRaw);
        if (Array.isArray(parsed)) {
          return parsed.some((v) => normalizeWhatsAppId(String(v || '')) === waId);
        }
      } catch {
        // ignore
      }
      return extraRaw
        .split(/[,\n]/g)
        .map((v) => normalizeWhatsAppId(String(v || '')) || '')
        .filter(Boolean)
        .includes(waId);
    });
    if (!match?.user?.id) return null;
    return {
      userId: match.user.id,
      email: match.user.email,
      name: match.user.name,
      role: String((match as any).role || ''),
      membershipId: match.id,
      staffWhatsAppE164: String((match as any).staffWhatsAppE164 || '').trim() || null,
    };
  })();

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
    event: {
      type: event.eventType,
      inboundMessageId: event.inboundMessageId || null,
      draftText: event.draftText || null,
      replyToWaMessageId,
      relatedConversationId,
    },
    conversation: {
      id: conversation.id,
      status: conversation.status,
      stage: conversation.conversationStage,
      kind: (conversation as any).conversationKind || 'CLIENT',
      stageChangedAt: (conversation as any).stageChangedAt ? new Date((conversation as any).stageChangedAt).toISOString() : null,
      programId: conversation.programId,
      phoneLineId: conversation.phoneLineId,
      isAdmin: conversation.isAdmin,
    },
    staff: staffContext,
    relatedConversation: relatedConversation
      ? {
          id: relatedConversation.id,
          status: relatedConversation.status,
          stage: relatedConversation.conversationStage,
          assignedToId: relatedConversation.assignedToId,
          contact: {
            id: relatedConversation.contactId,
            displayName: relatedConversation.contact.displayName || relatedConversation.contact.name,
            candidateName: (relatedConversation.contact as any).candidateName,
            candidateNameManual: (relatedConversation.contact as any).candidateNameManual,
            phone: relatedConversation.contact.phone,
            waId: relatedConversation.contact.waId,
            comuna: (relatedConversation.contact as any).comuna,
            ciudad: (relatedConversation.contact as any).ciudad,
            region: (relatedConversation.contact as any).region,
            availabilityText: (relatedConversation.contact as any).availabilityText,
            flags: { NO_CONTACTAR: Boolean((relatedConversation.contact as any).noContact) },
          },
          lastMessages: (relatedConversation.messages || [])
            .slice()
            .reverse()
            .map((m: any) => ({
              id: m.id,
              direction: m.direction,
              text: m.transcriptText || m.text,
              mediaType: m.mediaType || null,
              timestamp: m.timestamp.toISOString(),
            })),
        }
      : null,
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

  const programPromptBase = await (async () => {
    const truncate = (text: string, maxChars: number) => {
      const value = String(text || '').trim();
      if (!value) return '';
      if (value.length <= maxChars) return value;
      return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
    };

    const loadProgram = async (programId: string) =>
      prisma.program.findFirst({
        where: { id: programId, workspaceId: event.workspaceId, archivedAt: null },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          goal: true as any,
          audience: true as any,
          tone: true as any,
          language: true as any,
          agentSystemPrompt: true,
        },
      });

    let program = conversation.programId ? await loadProgram(conversation.programId) : null;
    if (!program && String((conversation as any).conversationKind || '').toUpperCase() === 'STAFF') {
      const ws = await prisma.workspace
        .findUnique({
          where: { id: event.workspaceId },
          select: { staffDefaultProgramId: true as any },
        } as any)
        .catch(() => null);
      const staffProgramId = String((ws as any)?.staffDefaultProgramId || '').trim();
      if (staffProgramId) {
        program = await loadProgram(staffProgramId).catch(() => null);
      }
    }
    if (!program && conversation.phoneLineId) {
      const line = await prisma.phoneLine
        .findFirst({
          where: { id: conversation.phoneLineId, workspaceId: event.workspaceId, archivedAt: null },
          select: { defaultProgramId: true },
        })
        .catch(() => null);
      if (line?.defaultProgramId) {
        program = await loadProgram(line.defaultProgramId).catch(() => null);
      }
    }

    if (program?.agentSystemPrompt) {
      const [assets, perms] = await Promise.all([
        prisma.programKnowledgeAsset
          .findMany({
            where: { workspaceId: event.workspaceId, programId: program.id, archivedAt: null },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: { type: true, title: true, url: true, contentText: true },
          })
          .catch(() => []),
        prisma.programConnectorPermission
          .findMany({
            where: { workspaceId: event.workspaceId, programId: program.id, archivedAt: null },
            include: { connector: { select: { name: true, slug: true, actionsJson: true } } },
            take: 30,
          })
          .catch(() => []),
      ]);

      const knowledgeLines: string[] = [];
      let knowledgeChars = 0;
      for (const a of assets) {
        const header = `- [${a.type}] ${a.title}${a.url ? ` (${a.url})` : ''}`.trim();
        const body = a.contentText ? `\n${truncate(a.contentText, 2000)}` : '';
        const chunk = `${header}${body}`.trim();
        if (!chunk) continue;
        if (knowledgeChars + chunk.length > 9000) break;
        knowledgeLines.push(chunk);
        knowledgeChars += chunk.length;
      }

      const toolsLines: string[] = [];
      for (const p of perms as any[]) {
        const connector = p.connector;
        if (!connector) continue;
        const available = (() => {
          try {
            const parsed = JSON.parse(String(connector.actionsJson || ''));
            return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
          } catch {
            return [];
          }
        })();
        const allowed = (() => {
          try {
            const parsed = JSON.parse(String((p as any).allowedActionsJson || ''));
            return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
          } catch {
            return [];
          }
        })();
        const availableLabel = available.length > 0 ? available.join(', ') : '(sin acciones declaradas)';
        const allowedLabel = allowed.length > 0 ? allowed.join(', ') : '(todos)';
        toolsLines.push(`- ${connector.name} (${connector.slug})\n  acciones disponibles: ${availableLabel}\n  acciones permitidas: ${allowedLabel}`);
      }

      const profileLines: string[] = [];
      if ((program as any).language) profileLines.push(`Idioma: ${(program as any).language}`);
      if ((program as any).goal) profileLines.push(`Objetivo: ${(program as any).goal}`);
      if ((program as any).audience) profileLines.push(`Público: ${(program as any).audience}`);
      if ((program as any).tone) profileLines.push(`Tono: ${(program as any).tone}`);
      if (program.description) profileLines.push(`Descripción: ${program.description}`);

      const blocks: string[] = [
        `Program: ${program.name} (${program.slug})`,
        profileLines.length > 0 ? profileLines.join('\n') : '',
        toolsLines.length > 0 ? `Tools permitidos:\n${toolsLines.join('\n')}` : '',
        knowledgeLines.length > 0 ? `Knowledge Pack:\n${knowledgeLines.join('\n\n')}` : '',
        `Instrucciones del agente:\n${program.agentSystemPrompt}`,
      ].filter(Boolean);

      return blocks.join('\n\n').trim();
    }

    return (
      config.aiPrompt?.trim() ||
      'Programa default: coordina reclutamiento/entrevista/ventas según contexto. Responde corto y humano.'
    );
  })();

  const kind = String((conversation as any).conversationKind || '').toUpperCase();
  const isStaffConversation = kind === 'STAFF';
  const isPartnerConversation = kind === 'PARTNER';
  const programPrompt = isStaffConversation
    ? [
        `STAFF MODE (WhatsApp)`,
        `- Estás conversando con un miembro del staff por WhatsApp.`,
        `- Si event.relatedConversationId existe, este mensaje es respuesta a una notificación sobre ese caso (no requiere que el staff copie IDs).`,
        `- Puedes operar casos usando RUN_TOOL (determinista):`,
        `  - LIST_CASES (filtros: stageSlug, assignedToMe, status, limit)`,
        `  - GET_CASE_SUMMARY (conversationId)`,
        `  - ADD_NOTE (conversationId, text)`,
        `  - SET_STAGE (conversationId, stageSlug, reason?)`,
        `  - SEND_CUSTOMER_MESSAGE (conversationId, text) [respeta SAFE MODE + 24h + NO_CONTACTAR]`,
        `- Regla: no alucines. Si falta información del caso, usa GET_CASE_SUMMARY o pide una aclaración breve.`,
        '',
        programPromptBase,
      ]
        .filter(Boolean)
        .join('\n')
        .trim()
    : isPartnerConversation
      ? [
          `PARTNER MODE (WhatsApp)`,
          `- Estás conversando con un proveedor/partner por WhatsApp.`,
          `- Si event.relatedConversationId existe, este mensaje es respuesta a una notificación sobre un caso.`,
          `- No uses RUN_TOOL (no está disponible para partners). Si falta información, pregunta 1 cosa clara o pide que el staff te confirme.`,
          '',
          programPromptBase,
        ]
          .filter(Boolean)
          .join('\n')
          .trim()
      : programPromptBase;

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
    const buildFallbackResponse = (reason: string): AgentResponse => {
      const fallbackText = (() => {
        if (event.eventType === 'AI_SUGGEST') {
          const draft = String(event.draftText || '').trim();
          if (draft) return draft;
          return '¿Qué respuesta quieres enviar? Escribe un borrador y lo mejoro.';
        }
        return 'Gracias por tu mensaje. ¿Me puedes contar un poco más para ayudarte?';
      })();
      const dedupeSeed = `${conversation.id}:${event.eventType}:${event.inboundMessageId || ''}:FALLBACK:${fallbackText}`;
      return {
        agent: 'fallback',
        version: 1,
        commands: [
          {
            command: 'SEND_MESSAGE',
            conversationId: conversation.id,
            channel: 'WHATSAPP',
            type: 'SESSION_TEXT',
            text: fallbackText,
            dedupeKey: `fallback:${stableHash(dedupeSeed).slice(0, 16)}`,
          } as any,
        ],
        notes: `fallback:${reason}`,
      };
    };

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
        const fallback = buildFallbackResponse('INVALID_SCHEMA');
        await prisma.agentRunLog.update({
          where: { id: runLog.id },
          data: {
            status: 'PLANNED',
            commandsJson: serializeJson(fallback),
            resultsJson: serializeJson({
              fallbackUsed: true,
              reason: 'INVALID_SCHEMA',
              lastInvalidRaw,
              lastInvalidIssues,
            }),
          },
        });
        return { runId: runLog.id, windowStatus, response: fallback };
      }

      const semanticIssues = validateAgentResponseSemantics(validated.data);
      const hasSendMessage = validated.data.commands.some((c: any) => c && typeof c === 'object' && c.command === 'SEND_MESSAGE');
      if ((event.eventType === 'INBOUND_MESSAGE' || event.eventType === 'AI_SUGGEST') && !hasSendMessage) {
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
        const fallback = buildFallbackResponse('INVALID_SEMANTICS');
        await prisma.agentRunLog.update({
          where: { id: runLog.id },
          data: {
            status: 'PLANNED',
            commandsJson: serializeJson(fallback),
            resultsJson: serializeJson({
              fallbackUsed: true,
              reason: 'INVALID_SEMANTICS',
              lastInvalidRaw,
              lastInvalidIssues,
            }),
          },
        });
        return { runId: runLog.id, windowStatus, response: fallback };
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
