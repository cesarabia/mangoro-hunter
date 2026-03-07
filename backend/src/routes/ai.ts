import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import OpenAI from 'openai';
import { resolveWorkspaceAccess } from '../services/workspaceAuthService';
import { runAgent } from '../services/agent/agentRuntimeService';
import { getEffectiveOpenAiKey } from '../services/aiService';
import { DEFAULT_AI_MODEL, getSystemConfig } from '../services/configService';
import { resolveModelChain } from '../services/modelResolutionService';
import { createChatCompletionWithModelFallback } from '../services/openAiChatCompletionService';

function truncateText(text: string, maxLength: number): string {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function buildAiMessageText(m: {
  text?: string | null;
  transcriptText?: string | null;
  mediaType?: string | null;
}): string {
  const base = (m.text || '').trim();
  const transcript = (m.transcriptText || '').trim();
  if (!transcript || transcript === base) return base || '(sin texto)';
  if (m.mediaType === 'audio' || m.mediaType === 'voice') return transcript || base || '(sin texto)';
  const snippet = truncateText(transcript, 2000);
  if (!base) return `[Adjunto transcrito]\n${snippet}`;
  return `${base}\n[Adjunto transcrito]\n${snippet}`;
}

function isWeakSuggestion(text: string, draft?: string | null): boolean {
  const value = String(text || '').trim();
  if (!value) return true;
  const low = value.toLowerCase();
  const draftNorm = String(draft || '').trim().toLowerCase();
  if (draftNorm && low === draftNorm) return true;
  if (value.length < 8) return true;
  if (/^(hola|ok|dale|si|sí|gracias)\.?$/i.test(value)) return true;
  if (/problema técnico para generar la sugerencia/i.test(value)) return true;
  return false;
}

function normalizeComparableText(text: string): string {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isInternalContextMessage(m: { rawPayload?: string | null; isInternalEvent?: boolean | null; text?: string | null }): boolean {
  if (Boolean(m?.isInternalEvent)) return true;
  const text = String(m?.text || '').trim().toLowerCase();
  if (text.startsWith('📝 respuesta propuesta enviada a revisión') || text.startsWith('🏷️ stage actualizado')) return true;
  const payloadRaw = String(m?.rawPayload || '').trim();
  if (!payloadRaw) return false;
  try {
    const payload = JSON.parse(payloadRaw) as any;
    if (payload?.internalEvent === true || payload?.systemEvent === true) return true;
    if (payload?.system === true && !payload?.sendResult && !payload?.attachment && !payload?.templateVars) return true;
  } catch {
    // ignore malformed payload
  }
  return false;
}

function hasForbiddenMetaPhrases(text: string): boolean {
  const low = String(text || '').toLowerCase();
  if (!low) return false;
  return (
    /\bte sugiero\b/.test(low) ||
    /\bcomo recomendaci[oó]n\b/.test(low) ||
    /\bpara avanzar en\b/.test(low) ||
    /\bprograma actual\b/.test(low) ||
    /\binstrucciones del programa\b/.test(low) ||
    /\bborrador actual\b/.test(low) ||
    /\bhistorial reciente\b/.test(low) ||
    /\bestoy obteniendo\b/.test(low) ||
    /\bun momento\b/.test(low)
  );
}

const SUGGEST_SLANG_BLOCKLIST = [
  'wena',
  'wenas',
  'tinca',
  'bacan',
  'bacán',
  'compa',
  'bro',
  'weon',
  'weón',
  'po',
  'cachai',
];

function containsBlockedSlang(text: string): boolean {
  const normalized = normalizeComparableText(String(text || ''));
  if (!normalized) return false;
  return SUGGEST_SLANG_BLOCKLIST.some((term) => {
    const needle = normalizeComparableText(term);
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'i').test(normalized);
  });
}

function mentionsProgramIdentity(text: string, programName?: string | null, programSlug?: string | null): boolean {
  const low = String(text || '').toLowerCase();
  const pName = String(programName || '').trim().toLowerCase();
  const pSlug = String(programSlug || '').trim().toLowerCase();
  if (!low) return false;
  if (pName && pName.length >= 5 && low.includes(pName)) return true;
  if (pSlug && pSlug.length >= 5 && low.includes(pSlug)) return true;
  return false;
}

function validateSendableSuggestion(params: {
  suggestion: string;
  draft?: string | null;
  lastInboundText?: string | null;
  programName?: string | null;
  programSlug?: string | null;
}): { ok: boolean; reason?: string } {
  const suggestion = String(params.suggestion || '').trim();
  if (!suggestion) return { ok: false, reason: 'EMPTY' };
  if (isWeakSuggestion(suggestion, params.draft || null)) return { ok: false, reason: 'WEAK' };
  if (hasForbiddenMetaPhrases(suggestion)) return { ok: false, reason: 'META_PHRASE' };
  if (mentionsProgramIdentity(suggestion, params.programName, params.programSlug)) return { ok: false, reason: 'PROGRAM_IDENTITY' };
  if (containsBlockedSlang(suggestion)) return { ok: false, reason: 'SLANG' };
  const inboundNorm = normalizeComparableText(String(params.lastInboundText || ''));
  const suggestionNorm = normalizeComparableText(suggestion);
  if (inboundNorm && suggestionNorm && inboundNorm === suggestionNorm) {
    return { ok: false, reason: 'ECHO_INBOUND' };
  }
  return { ok: true };
}

function looksLikeCandidateVoice(text: string): boolean {
  const low = String(text || '').trim().toLowerCase();
  if (!low) return false;
  return (
    /\bme interesa postular\b/.test(low) ||
    /\bme llamo\b/.test(low) ||
    /\bsoy de\b/.test(low) ||
    /\bvivo en\b/.test(low) ||
    /\btengo licencia\b/.test(low) ||
    /\btengo experiencia\b/.test(low) ||
    /\bestoy buscando trabajo\b/.test(low)
  );
}

async function rewriteSuggestionProfessional(params: {
  workspaceId: string;
  conversationId: string;
  text: string;
  draft?: string | null;
  lastInboundText?: string | null;
  programName?: string | null;
}): Promise<string | null> {
  const [config, conversation] = await Promise.all([
    getSystemConfig().catch(() => null),
    prisma.conversation.findFirst({
      where: { id: params.conversationId, workspaceId: params.workspaceId },
      include: {
        messages: {
          orderBy: { timestamp: 'desc' },
          take: 30,
          select: { direction: true, text: true, transcriptText: true, mediaType: true, rawPayload: true as any, isInternalEvent: true as any },
        },
      },
    }),
  ]);
  if (!config || !conversation) return null;
  const apiKey = getEffectiveOpenAiKey(config);
  if (!apiKey) return null;

  const modelChain = resolveModelChain({
    modelOverride: (config as any)?.aiModelOverride || null,
    modelAlias: (config as any)?.aiModelAlias || null,
    legacyModel: (config as any)?.aiModel || null,
    defaultModel: DEFAULT_AI_MODEL,
  });
  const models = modelChain.modelChain.filter((m, idx, arr) => m && arr.indexOf(m) === idx) as string[];
  if (models.length === 0) return null;

  const transcript = (conversation.messages || [])
    .slice()
    .reverse()
    .filter((m: any) => !isInternalContextMessage(m))
    .map((m: any) => `${String(m.direction || '').toUpperCase() === 'INBOUND' ? 'CANDIDATO' : 'STAFF'}: ${truncateText(buildAiMessageText(m), 300)}`)
    .slice(-12)
    .join('\n');
  const client = new OpenAI({ apiKey });
  try {
    const completion = await createChatCompletionWithModelFallback(
      client,
      {
        messages: [
          {
            role: 'system',
            content:
              'Reescribe mensajes para WhatsApp en español profesional y amable. Elimina modismos/slang y muletillas. Mantén intención y contexto. Devuelve SOLO el texto final enviable.',
          },
          {
            role: 'user',
            content: `Texto a reescribir:
${params.text}

Contexto:
Programa: ${String(params.programName || 'Program actual')}
Último inbound: ${String(params.lastInboundText || '(sin inbound)')}
Borrador original del staff: ${String(params.draft || '(vacío)')}
Historial:
${transcript || '(sin historial)'}

Regla obligatoria: no usar modismos como "wena", "me tinca", "bacán", "compa", "bro", "po", "cachai".`,
          },
        ],
        temperature: 0.2,
        max_tokens: 240,
      },
      models,
      {
        perRequestTimeoutMs: 4500,
        totalTimeoutMs: 7000,
      }
    );
    const rewritten = String(completion?.completion?.choices?.[0]?.message?.content || '').trim();
    if (!rewritten) return null;
    if (containsBlockedSlang(rewritten)) return null;
    return rewritten;
  } catch {
    return null;
  }
}

export async function registerAiRoutes(app: FastifyInstance) {
  app.post('/:id/ai-suggest', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const { id } = request.params as { id: string };
    const body = (request.body || {}) as {
      draft?: string;
      draftText?: string;
      programId?: string;
      programSlug?: string;
      mode?: string;
    };
    const draftTextRaw = typeof body?.draftText === 'string' ? body.draftText : body?.draft;
    const draftText = typeof draftTextRaw === 'string' ? draftTextRaw.trim() : '';
    const usedDraftText = draftText.length > 0;
    const userId = request.user?.userId ? String(request.user.userId) : null;

    const conversation = await prisma.conversation.findFirst({
      where: { id, workspaceId: access.workspaceId },
      include: {
        assignedTo: { select: { id: true } },
        program: { select: { id: true, slug: true, name: true } },
        messages: {
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    if (!conversation) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }
    const role = String((access as any).role || '').toUpperCase();
    const assignedOnly = role === 'MEMBER' && Boolean((access as any).assignedOnly) && Boolean(userId);
    if (assignedOnly && String((conversation as any).assignedToId || '') !== String(userId)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    try {
      const lastInbound = (conversation.messages || [])
        .slice()
        .reverse()
        .find((m: any) => String(m?.direction || '').toUpperCase() === 'INBOUND');
      const lastInboundText = lastInbound ? buildAiMessageText(lastInbound as any).trim() : '';
      const programName = String((conversation as any)?.program?.name || '').trim();
      const programSlug = String((conversation as any)?.program?.slug || '').trim();
      const agent = await runAgent({
        workspaceId: access.workspaceId,
        conversationId: conversation.id,
        eventType: 'AI_SUGGEST',
        inboundMessageId: null,
        draftText: draftText || null,
      });
      const [runLog, usageLog] = await Promise.all([
        prisma.agentRunLog
          .findUnique({
            where: { id: agent.runId },
            select: { programId: true, conversationId: true, resultsJson: true },
          })
          .catch(() => null),
        prisma.aiUsageLog
          .findFirst({
            where: { agentRunId: agent.runId },
            orderBy: { createdAt: 'desc' },
            select: {
              inputTokens: true,
              outputTokens: true,
              totalTokens: true,
              modelRequested: true,
              modelResolved: true,
            },
          })
          .catch(() => null),
      ]);
      const runResults = (() => {
        try {
          return runLog?.resultsJson ? JSON.parse(String(runLog.resultsJson || '{}')) : null;
        } catch {
          return null;
        }
      })();
      const modelRequested =
        String(usageLog?.modelRequested || runResults?.modelRequested || '').trim() || null;
      const modelResolved =
        String(usageLog?.modelResolved || runResults?.modelResolved || '').trim() || null;
      const meta = {
        usedDraftText,
        modelRequested,
        modelResolved,
        tokens: usageLog
          ? {
              input: Number(usageLog.inputTokens || 0),
              output: Number(usageLog.outputTokens || 0),
              total: Number(usageLog.totalTokens || 0),
            }
          : {
              input: 0,
              output: 0,
              total: 0,
            },
        programId: String((runLog as any)?.programId || (conversation as any)?.program?.id || '').trim() || null,
        conversationId: String((runLog as any)?.conversationId || conversation.id || '').trim() || null,
        mode: String(body?.mode || 'SUGGEST').trim() || 'SUGGEST',
      };
      const send = agent.response.commands.find((c: any) => c && typeof c === 'object' && c.command === 'SEND_MESSAGE') as any;
      if (!send) {
        return reply.code(502).send({ error: 'El agente no devolvió un SEND_MESSAGE para sugerencia.' });
      }
      if (send.type === 'TEMPLATE') {
        const templateName = String(send.templateName || '').trim() || 'enviorapido_postulacion_menu_v1';
        const vars =
          send.templateVars && typeof send.templateVars === 'object'
            ? Object.entries(send.templateVars)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n')
            : '';
        const suggestedText = [`(Fuera de ventana 24h) Debes usar plantilla: ${templateName}`, vars]
          .filter(Boolean)
          .join('\n')
          .trim();
        return {
          suggestedText,
          suggestion: suggestedText,
          suggestedTemplateName: templateName,
          meta,
        };
      }
      const suggestion = typeof send.text === 'string' ? send.text : '';
      if (!suggestion.trim()) {
        return reply.code(502).send({ error: 'El agente devolvió un SEND_MESSAGE sin texto.' });
      }
      const validation = validateSendableSuggestion({
        suggestion,
        draft: draftText,
        lastInboundText,
        programName,
        programSlug,
      });
      if (containsBlockedSlang(suggestion)) {
        const rewritten = await rewriteSuggestionProfessional({
          workspaceId: access.workspaceId,
          conversationId: conversation.id,
          text: suggestion,
          draft: draftText,
          lastInboundText,
          programName,
        });
        if (rewritten) {
          const rewrittenValidation = validateSendableSuggestion({
            suggestion: rewritten,
            draft: draftText,
            lastInboundText,
            programName,
            programSlug,
          });
          if (rewrittenValidation.ok && !looksLikeCandidateVoice(rewritten)) {
            return { suggestedText: rewritten, suggestion: rewritten, meta: { ...meta, toneRewrite: true } as any };
          }
        }
      }
      const weakOrOffRole =
        !validation.ok || looksLikeCandidateVoice(suggestion);
      if (weakOrOffRole) {
        const backup = await buildBackupSuggestion({
          workspaceId: access.workspaceId,
          conversationId: conversation.id,
          draft: draftText,
          lastInboundText,
          programName,
          programSlug,
          rejectReason: validation.reason || (looksLikeCandidateVoice(suggestion) ? 'CANDIDATE_VOICE' : 'WEAK'),
        });
        if (backup) {
          const backupValidation = validateSendableSuggestion({
            suggestion: backup,
            draft: draftText,
            lastInboundText,
            programName,
            programSlug,
          });
          if (backupValidation.ok && !looksLikeCandidateVoice(backup)) {
            return { suggestedText: backup, suggestion: backup, meta };
          }
        }
        return reply.code(502).send({ error: 'No pude generar una sugerencia contextual ahora. Inténtalo de nuevo en unos segundos.' });
      }
      return { suggestedText: suggestion, suggestion, meta };
    } catch (err: any) {
      const backup = await buildBackupSuggestion({
        workspaceId: access.workspaceId,
        conversationId: conversation.id,
        draft: draftText,
        rejectReason: 'AGENT_RUNTIME_ERROR',
      }).catch(() => null);
      if (backup) return { suggestedText: backup, suggestion: backup, meta: { usedDraftText, mode: String(body?.mode || 'SUGGEST') } };
      const { status, message } = formatAiError(err, null);
      request.log.error({ err }, 'ai_suggest failed');
      return reply.code(status).send({ error: message });
    }
  });
}

async function buildBackupSuggestion(params: {
  workspaceId: string;
  conversationId: string;
  draft: string;
  lastInboundText?: string | null;
  programName?: string | null;
  programSlug?: string | null;
  rejectReason?: string | null;
}): Promise<string | null> {
  const [config, conversation] = await Promise.all([
    getSystemConfig().catch(() => null),
    prisma.conversation.findFirst({
      where: { id: params.conversationId, workspaceId: params.workspaceId },
      include: {
        program: {
          select: { id: true, name: true, slug: true, agentSystemPrompt: true },
        },
        messages: {
          orderBy: { timestamp: 'asc' },
          take: 120,
          select: { direction: true, text: true, transcriptText: true, mediaType: true, rawPayload: true as any, isInternalEvent: true as any },
        },
      },
    }),
  ]);
  if (!config || !conversation) return null;
  const apiKey = getEffectiveOpenAiKey(config);
  if (!apiKey) return null;

  const modelChain = resolveModelChain({
    modelOverride: (config as any)?.aiModelOverride || null,
    modelAlias: (config as any)?.aiModelAlias || null,
    legacyModel: (config as any)?.aiModel || null,
    defaultModel: DEFAULT_AI_MODEL,
  });
  const models = modelChain.modelChain.filter(
    (m, idx, arr) => m && arr.indexOf(m) === idx
  ) as string[];
  if (models.length === 0) return null;

  const messages = conversation.messages || [];
  const transcript = messages
    .filter((m) => !isInternalContextMessage(m as any))
    .map((m) => {
      const role = m.direction === 'INBOUND' ? 'CANDIDATO' : 'STAFF';
      const text = buildAiMessageText(m as any).trim();
      return `${role}: ${truncateText(text, 500)}`;
    })
    .filter(Boolean)
    .slice(-35)
    .join('\n');
  const lastInbound = messages
    .slice()
    .reverse()
    .find((m) => String(m.direction || '').toUpperCase() === 'INBOUND');
  const lastInboundText = String(params.lastInboundText || (lastInbound ? buildAiMessageText(lastInbound as any) : '')).trim();
  const programPrompt = String((conversation as any)?.program?.agentSystemPrompt || '').trim();
  const programName =
    String(params.programName || (conversation as any)?.program?.name || (conversation as any)?.program?.slug || '').trim() || 'Program actual';
  const programSlug = String(params.programSlug || (conversation as any)?.program?.slug || '').trim();

  const client = new OpenAI({ apiKey });
  const deterministicFallback = 'Gracias por tu mensaje. Para continuar, cuéntame un poco más y te ayudo.';
  let cleaned = '';
  try {
    const completion = await createChatCompletionWithModelFallback(
      client,
      {
        messages: [
          {
            role: 'system',
            content:
              'Eres copiloto de CRM para operadores humanos. Devuelve SOLO un mensaje final enviable al contacto (sin encabezados, sin notas). No copies textual el último mensaje del contacto. No uses frases meta como "te sugiero", "como recomendación", "para avanzar en". No menciones el nombre del programa ni detalles de sistema. Debes escribir como operador/agente, nunca como candidato/postulante. Mantén tono profesional y amable, sin modismos/slang.',
          },
          {
            role: 'user',
            content: `Programa actual: ${programName}
Instrucciones del programa (resumen): ${truncateText(programPrompt || '(sin prompt)', 1400)}

Último mensaje del candidato: ${lastInboundText || '(sin mensaje)'}

Historial reciente:
${transcript || '(sin historial)'}

Borrador actual: ${params.draft || '(vacío)'}
Rechazo previo: ${String(params.rejectReason || 'N/A')}
Slug del programa (no mencionar en salida): ${programSlug || '(sin slug)'}

Entrega solo el texto sugerido final.
Si falta información para avanzar, pide SOLO el siguiente dato faltante en lenguaje natural.`,
          },
        ],
        temperature: 0.3,
        max_tokens: 260,
      },
      models,
      {
        perRequestTimeoutMs: 5000,
        totalTimeoutMs: 8000,
      }
    );
    const text = String(completion.completion.choices?.[0]?.message?.content || '').trim();
    cleaned = text.replace(/```[\s\S]*?```/g, '').trim();
  } catch {
    cleaned = deterministicFallback;
  }
  if (!cleaned) return deterministicFallback;
  if (isWeakSuggestion(cleaned, params.draft || '')) return null;
  if (hasForbiddenMetaPhrases(cleaned)) return null;
  if (containsBlockedSlang(cleaned)) return null;
  if (looksLikeCandidateVoice(cleaned)) return null;
  if (mentionsProgramIdentity(cleaned, programName, programSlug)) return null;
  const inboundNorm = normalizeComparableText(lastInboundText);
  const cleanedNorm = normalizeComparableText(cleaned);
  if (inboundNorm && cleanedNorm && inboundNorm === cleanedNorm) return null;
  return cleaned;
}

function formatAiError(err: any, model?: string | null): { status: number; message: string } {
  const defaultMessage = `Modelo inválido o sin acceso${model ? `: ${model}` : ''}`;
  if (err instanceof OpenAI.APIError) {
    const code = (err as any).code || err.status;
    const detail = (err as any).error?.message || err.message;
    const isModelError =
      code === 'invalid_model' ||
      code === 'model_not_found' ||
      detail?.toLowerCase?.().includes('model') ||
      detail?.toLowerCase?.().includes('invalid');
    return { status: isModelError ? 400 : 502, message: detail || defaultMessage };
  }
  const message =
    (err?.response?.data && JSON.stringify(err.response.data)) ||
    err?.message ||
    defaultMessage;
  return { status: 502, message };
}
