import { prisma } from '../../db/client';
import { resolveWorkspaceProgramForKind } from '../programRoutingService';
import { stripAccents } from './tools';

type WhatsAppWindowStatus = 'IN_24H' | 'OUTSIDE_24H';

type BuildLlmContextParams = {
  workspaceId: string;
  conversationId: string;
  mode: 'INBOUND' | 'SUGGEST' | 'COMPOSE';
  eventType: string;
  inboundMessageId?: string | null;
  draftText?: string | null;
  windowStatus: WhatsAppWindowStatus;
  askedFieldsHistory?: Record<string, { count: number; lastAskedAt: string | null; lastAskedHash: string | null }>;
  lastOutbound?: { lastOutboundHash: string | null; lastOutboundAt: string | null; lastDedupeKey: string | null } | null;
  relatedConversation?: any | null;
  replyToWaMessageId?: string | null;
  staffContext?: any | null;
  botAutoReply?: boolean;
};

type BuildLlmContextResult = {
  contextJson: any;
  programPrompt: string;
  resolvedProgramId: string | null;
  resolvedProgramSlug: string | null;
  latestInboundText: string;
  lastOutboundComparable: string;
  conversationalMessagesCount: number;
};

function normalizeComparableText(value: string | null | undefined): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLoose(value: string): string {
  return stripAccents(String(value || '')).toLowerCase().replace(/\s+/g, ' ').trim();
}

function parseJsonLoose(raw: unknown): any {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildMessageText(m: { text?: string | null; transcriptText?: string | null; mediaType?: string | null }): string {
  const base = String(m.text || '').trim();
  const transcript = String(m.transcriptText || '').trim();
  if (!transcript || transcript === base) return base || '(sin texto)';
  if (m.mediaType === 'audio' || m.mediaType === 'voice') return transcript || base || '(sin texto)';
  if (!base) return `[Adjunto transcrito]\n${transcript}`;
  return `${base}\n[Adjunto transcrito]\n${transcript}`;
}

function isInternalEventMessage(m: {
  direction?: string | null;
  text?: string | null;
  rawPayload?: string | null;
  isInternalEvent?: boolean | null;
}): boolean {
  if (Boolean(m.isInternalEvent)) return true;

  const payload = parseJsonLoose(m.rawPayload);
  if (payload && typeof payload === 'object') {
    const hasSendResult = Boolean((payload as any).sendResult);
    const hasAttachmentSend = Boolean((payload as any).attachment && (payload as any).sendResult);
    const hasOutboundTransport = hasSendResult || hasAttachmentSend || Boolean((payload as any).templateVars);
    if ((payload as any).internalEvent === true || (payload as any).systemEvent === true) return true;
    if ((payload as any).system === true && !hasOutboundTransport) return true;
    if ((payload as any).noteType === 'INTERNAL' || (payload as any).visibility === 'SYSTEM') return true;
    if ((payload as any).automationRuleId && !hasOutboundTransport) return true;
  }

  const text = String(m.text || '').trim();
  if (!text) return false;
  const low = normalizeLoose(text);
  const internalPatterns = [
    /^📝\s*respuesta propuesta enviada a revision/,
    /^🏷️\s*stage actualizado/,
    /^✏️\s*nombre manual/,
    /^✅\s*contacto reactivado/,
    /^🔕\s*marcado como no_contactar/,
    /^opt-in detectado:/,
    /^inbound debounce:/,
    /^automation:/,
  ];
  if (internalPatterns.some((re) => re.test(low))) return true;

  if (String(m.direction || '').toUpperCase() === 'OUTBOUND' && /(^|\s)(\[system\]|\[interno\]|\[log\])/.test(low)) {
    return true;
  }

  return false;
}

async function resolveProgramContext(params: {
  workspaceId: string;
  conversation: any;
}): Promise<{ promptBase: string; resolvedProgramId: string | null; resolvedProgramSlug: string | null }> {
  const { workspaceId, conversation } = params;

  const loadProgram = async (programId: string) =>
    prisma.program.findFirst({
      where: { id: programId, workspaceId, archivedAt: null },
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
    const staffProgramId = await resolveWorkspaceProgramForKind({
      workspaceId,
      kind: 'STAFF',
      phoneLineId: conversation.phoneLineId,
    })
      .then((r) => r.programId)
      .catch(() => null);
    if (staffProgramId) program = await loadProgram(staffProgramId).catch(() => null);
  }

  if (!program && String((conversation as any).conversationKind || '').toUpperCase() === 'PARTNER') {
    const partnerProgramId = await resolveWorkspaceProgramForKind({
      workspaceId,
      kind: 'PARTNER',
      phoneLineId: conversation.phoneLineId,
    })
      .then((r) => r.programId)
      .catch(() => null);
    if (partnerProgramId) program = await loadProgram(partnerProgramId).catch(() => null);
  }

  if (!program && conversation.phoneLineId) {
    const line = await prisma.phoneLine
      .findFirst({
        where: { id: conversation.phoneLineId, workspaceId, archivedAt: null },
        select: { defaultProgramId: true },
      })
      .catch(() => null);
    if (line?.defaultProgramId) program = await loadProgram(line.defaultProgramId).catch(() => null);
  }

  if (!program?.agentSystemPrompt) {
    return {
      promptBase:
        'Programa default: coordina reclutamiento/entrevista/ventas según contexto. Responde corto, humano y accionable.',
      resolvedProgramId: null,
      resolvedProgramSlug: null,
    };
  }

  const [knowledgeAssets, perms, workspaceAssets] = await Promise.all([
    prisma.programKnowledgeAsset
      .findMany({
        where: { workspaceId, programId: program.id, archivedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: { type: true, title: true, url: true, contentText: true },
      })
      .catch(() => []),
    prisma.programConnectorPermission
      .findMany({
        where: { workspaceId, programId: program.id, archivedAt: null },
        include: { connector: { select: { name: true, slug: true, actionsJson: true } } },
        take: 30,
      })
      .catch(() => []),
    prisma.workspaceAsset
      .findMany({
        where: { workspaceId, archivedAt: null, audience: 'PUBLIC' },
        select: { slug: true, title: true, description: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      })
      .catch(() => []),
  ]);

  const knowledgeLines: string[] = [];
  let knowledgeChars = 0;
  for (const a of knowledgeAssets as any[]) {
    const header = `- [${a.type}] ${a.title}${a.url ? ` (${a.url})` : ''}`.trim();
    const body = a.contentText ? `\n${String(a.contentText).slice(0, 2000)}` : '';
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

  const workspaceAssetsLines = workspaceAssets.length
    ? workspaceAssets
        .map((a: any) => `- ${a.slug}: ${a.title}${a.description ? ` (${String(a.description).slice(0, 160)})` : ''}`)
        .join('\n')
    : '';

  const blocks: string[] = [
    `Program: ${program.name} (${program.slug})`,
    profileLines.length > 0 ? profileLines.join('\n') : '',
    toolsLines.length > 0 ? `Tools permitidos:\n${toolsLines.join('\n')}` : '',
    knowledgeLines.length > 0 ? `Knowledge Pack:\n${knowledgeLines.join('\n\n')}` : '',
    workspaceAssetsLines ? `Assets PDF públicos disponibles (usa SEND_PDF con assetSlug):\n${workspaceAssetsLines}` : '',
    `Instrucciones del agente:\n${program.agentSystemPrompt}`,
  ].filter(Boolean);

  return {
    promptBase: blocks.join('\n\n').trim(),
    resolvedProgramId: String(program.id || '').trim() || null,
    resolvedProgramSlug: String(program.slug || '').trim() || null,
  };
}

export async function buildLLMContext(params: BuildLlmContextParams): Promise<BuildLlmContextResult> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: params.conversationId, workspaceId: params.workspaceId },
    include: {
      contact: true,
      program: { select: { id: true, slug: true, name: true } },
      phoneLine: { select: { id: true, alias: true, waPhoneNumberId: true } },
    },
  });
  if (!conversation) throw new Error('Conversation no encontrada');

  const maxMessages = params.mode === 'SUGGEST' ? 120 : 60;
  const allMessages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { timestamp: 'desc' },
    take: maxMessages,
    select: {
      id: true,
      waMessageId: true,
      direction: true,
      text: true,
      transcriptText: true,
      mediaType: true,
      timestamp: true,
      rawPayload: true,
      isInternalEvent: true,
    } as any,
  });

  const conversational = allMessages
    .slice()
    .reverse()
    .filter((m: any) => !isInternalEventMessage(m));

  const lastInbound = [...conversational]
    .reverse()
    .find((m: any) => String(m.direction || '').toUpperCase() === 'INBOUND');
  const latestInboundText = String(lastInbound ? buildMessageText(lastInbound as any) : params.draftText || '').trim();

  const lastOutbound = [...conversational]
    .reverse()
    .find((m: any) => String(m.direction || '').toUpperCase() === 'OUTBOUND');
  const lastOutboundComparable = normalizeComparableText(lastOutbound ? buildMessageText(lastOutbound as any) : '');

  const relatedConversationPayload = params.relatedConversation
    ? {
        id: params.relatedConversation.id,
        status: params.relatedConversation.status,
        stage: params.relatedConversation.conversationStage,
        assignedToId: params.relatedConversation.assignedToId,
        contact: {
          id: params.relatedConversation.contactId,
          displayName:
            params.relatedConversation.contact?.displayName || params.relatedConversation.contact?.name || null,
          candidateName: (params.relatedConversation.contact as any)?.candidateName || null,
          candidateNameManual: (params.relatedConversation.contact as any)?.candidateNameManual || null,
          phone: params.relatedConversation.contact?.phone || null,
          waId: params.relatedConversation.contact?.waId || null,
          comuna: (params.relatedConversation.contact as any)?.comuna || null,
          ciudad: (params.relatedConversation.contact as any)?.ciudad || null,
          region: (params.relatedConversation.contact as any)?.region || null,
          availabilityText: (params.relatedConversation.contact as any)?.availabilityText || null,
          flags: { NO_CONTACTAR: Boolean((params.relatedConversation.contact as any)?.noContact) },
        },
      }
    : null;

  const programContext = await resolveProgramContext({ workspaceId: params.workspaceId, conversation });

  const contextJson = {
    workspaceId: params.workspaceId,
    event: {
      type: params.eventType,
      mode: params.mode,
      inboundMessageId: params.inboundMessageId || null,
      draftText: params.draftText || null,
      replyToWaMessageId: params.replyToWaMessageId || null,
      relatedConversationId: params.relatedConversation?.id || null,
    },
    conversation: {
      id: conversation.id,
      status: conversation.status,
      stage: conversation.conversationStage,
      kind: (conversation as any).conversationKind || 'CLIENT',
      applicationRole: String((conversation as any).applicationRole || '').trim() || null,
      applicationState: String((conversation as any).applicationState || '').trim() || null,
      stageChangedAt: (conversation as any).stageChangedAt ? new Date((conversation as any).stageChangedAt).toISOString() : null,
      programId: conversation.programId,
      programSlug: String((conversation as any)?.program?.slug || '').trim() || programContext.resolvedProgramSlug,
      phoneLineId: conversation.phoneLineId,
      isAdmin: conversation.isAdmin,
      availabilityRaw: String((conversation as any).availabilityRaw || '').trim() || null,
      availabilityParsedJson: String((conversation as any).availabilityParsedJson || '').trim() || null,
      availabilityConfirmedAt: (conversation as any).availabilityConfirmedAt
        ? new Date((conversation as any).availabilityConfirmedAt).toISOString()
        : null,
    },
    staff: params.staffContext || null,
    relatedConversation: relatedConversationPayload,
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
      jobRole: (conversation.contact as any).jobRole || null,
      flags: { NO_CONTACTAR: conversation.contact.noContact },
    },
    askedFieldsHistory: params.askedFieldsHistory || {},
    lastOutbound: params.lastOutbound || null,
    whatsappWindowStatus: params.windowStatus,
    lastMessages: conversational.map((m: any) => ({
      id: m.id,
      waMessageId: m.waMessageId,
      direction: m.direction,
      text: buildMessageText(m),
      mediaType: m.mediaType || null,
      timestamp: m.timestamp.toISOString(),
    })),
    config: {
      botAutoReply: typeof params.botAutoReply === 'boolean' ? params.botAutoReply : true,
    },
  };

  return {
    contextJson,
    programPrompt: programContext.promptBase,
    resolvedProgramId: programContext.resolvedProgramId,
    resolvedProgramSlug: programContext.resolvedProgramSlug,
    latestInboundText,
    lastOutboundComparable,
    conversationalMessagesCount: conversational.length,
  };
}
