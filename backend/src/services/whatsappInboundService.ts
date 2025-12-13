import { FastifyInstance } from "fastify";
import { SystemConfig } from "@prisma/client";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import OpenAI from "openai";
import { prisma } from "../db/client";
import {
  getSystemConfig,
  DEFAULT_INTERVIEW_AI_PROMPT,
  DEFAULT_INTERVIEW_AI_MODEL,
  INTERVIEW_AI_POLICY_ADDENDUM,
  DEFAULT_AI_MODEL,
  DEFAULT_WHATSAPP_BASE_URL,
  updateAdminAiConfig,
} from "./configService";
import { DEFAULT_AI_PROMPT } from "../constants/ai";
import { serializeJson } from "../utils/json";
import { getEffectiveOpenAiKey, getSuggestedReply } from "./aiService";
import { sendWhatsAppText, SendResult } from "./whatsappMessageService";
import { normalizeWhatsAppId } from "../utils/whatsapp";
import { processAdminCommand, fetchConversationByIdentifier, setConversationStatusByWaId } from "./whatsappAdminCommandService";
import { generateAdminAiResponse } from "./whatsappAdminAiService";
import { loadTemplateConfig, resolveTemplateVariables, selectTemplateForMode } from "./templateService";
import { createConversationAndMaybeSend } from "./conversationCreateService";

interface InboundMedia {
  type: string;
  id: string;
  mimeType?: string;
  sha256?: string;
  filename?: string;
  caption?: string;
}

interface InboundMessageParams {
  from: string;
  text?: string;
  timestamp?: number;
  rawPayload?: any;
  profileName?: string;
  media?: InboundMedia | null;
  config?: SystemConfig;
}

interface PendingAdminSend {
  targetWaId: string;
  mode: "RECRUIT" | "INTERVIEW" | "OFF";
  templateName: string;
  variables: string[];
  previewText: string;
  createdAt: number;
  allowed: boolean;
}

const pendingAdminSends = new Map<string, PendingAdminSend>();
const UPLOADS_BASE = path.join(__dirname, "..", "uploads");
const ADMIN_PENDING_TTL_MS = 30 * 60 * 1000;

export async function handleInboundWhatsAppMessage(
  app: FastifyInstance,
  params: InboundMessageParams,
): Promise<{ conversationId: string }> {
  const config = params.config ?? (await getSystemConfig());
  const waId = params.from;
  const normalizedAdmin = normalizeWhatsAppId(config.adminWaId);
  const normalizedSender = normalizeWhatsAppId(waId);
  const isAdminSender =
    normalizedAdmin && normalizedSender && normalizedAdmin === normalizedSender;
  const trimmedText = (params.text || "").trim();

  if (isAdminSender && normalizedAdmin) {
    const adminThread = await ensureAdminConversation(waId, normalizedAdmin);
    const baseText = buildInboundText(params.text, params.media);
    const adminMessage = await prisma.message.create({
      data: {
        conversationId: adminThread.conversation.id,
        direction: "INBOUND",
        text: baseText,
        mediaType: params.media?.type || null,
        mediaMime: params.media?.mimeType || null,
        rawPayload: serializeJson(params.rawPayload ?? { admin: true }),
        timestamp: new Date(params.timestamp ? params.timestamp * 1000 : Date.now()),
        read: false,
      },
    });

    await processMediaAttachment(app, {
      conversationId: adminThread.conversation.id,
      waId: normalizedAdmin,
      media: params.media,
      messageId: adminMessage.id,
      config,
    });

    const refreshedAdminMessage = await prisma.message.findUnique({
      where: { id: adminMessage.id },
    });
    const effectiveText =
      refreshedAdminMessage?.transcriptText ||
      refreshedAdminMessage?.text ||
      params.text ||
      "";

    const candidateFromText = extractWaIdFromText(effectiveText);
    if (candidateFromText) {
      await prisma.conversation.update({
        where: { id: adminThread.conversation.id },
        data: { adminLastCandidateWaId: candidateFromText },
      });
      adminThread.conversation.adminLastCandidateWaId = candidateFromText;
    }
    await prisma.conversation.update({
      where: { id: adminThread.conversation.id },
      data: { updatedAt: new Date() },
    });

    clearStaleAdminIntent(normalizedAdmin);
    const trimmedEffective = (effectiveText || "").trim();
    if (trimmedEffective.toUpperCase() === "CONFIRMAR ENVÍO") {
      const handled = await maybeConfirmAdminSend(
        app,
        adminThread.conversation.id,
        normalizedAdmin,
      );
      if (handled) {
        return { conversationId: adminThread.conversation.id };
      }
    }

    if (trimmedEffective.startsWith("/")) {
      const response = await processAdminCommand({
        waId,
        text: effectiveText,
        config,
      });
      if (response) {
        await sendAdminReply(app, adminThread.conversation.id, waId, response);
      }
      return { conversationId: adminThread.conversation.id };
    }

    const handledPending = await handleAdminPendingAction(
      app,
      adminThread.conversation.id,
      adminThread.conversation.adminLastCandidateWaId || null,
      trimmedEffective,
      normalizedAdmin,
    );
    if (handledPending) {
      return { conversationId: adminThread.conversation.id };
    }

    const learningResponse = await handleAdminLearning(
      trimmedEffective,
      config,
      adminThread.conversation.id,
      app,
      waId,
    );
    if (learningResponse) {
      return { conversationId: adminThread.conversation.id };
    }

    const templateIntent = await detectAdminTemplateIntent(
      trimmedEffective,
      config,
      app,
    );
    if (templateIntent) {
      pendingAdminSends.set(normalizedAdmin, templateIntent);
      if (templateIntent.targetWaId) {
        await prisma.conversation.update({
          where: { id: adminThread.conversation.id },
          data: { adminLastCandidateWaId: templateIntent.targetWaId },
        });
        adminThread.conversation.adminLastCandidateWaId =
          templateIntent.targetWaId;
      }
      await sendAdminReply(
        app,
        adminThread.conversation.id,
        waId,
        templateIntent.previewText,
      );
      return { conversationId: adminThread.conversation.id };
    }

    const aiResponse = await generateAdminAiResponse(app, {
      waId,
      text: effectiveText || "",
      config,
      lastCandidateWaId: adminThread.conversation.adminLastCandidateWaId,
    });
    await sendAdminReply(app, adminThread.conversation.id, waId, aiResponse);
    return { conversationId: adminThread.conversation.id };
  }

  let contact = await prisma.contact.findUnique({ where: { waId } });
  if (!contact) {
    contact = await prisma.contact.create({
      data: { waId, phone: waId },
    });
  }
  await maybeUpdateContactName(contact, params.profileName, params.text);

  let conversation = await prisma.conversation.findFirst({
    where: { contactId: contact.id, isAdmin: false },
    orderBy: { updatedAt: "desc" },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        contactId: contact.id,
        status: "NEW",
        channel: "whatsapp",
      },
    });
  } else if (conversation.status === "CLOSED") {
    conversation = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { status: "OPEN" },
    });
  }

  const messageText = buildInboundText(params.text, params.media);
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: "INBOUND",
      text: messageText,
      mediaType: params.media?.type || null,
      mediaMime: params.media?.mimeType || null,
      rawPayload: serializeJson(params.rawPayload ?? { simulated: true }),
      timestamp: new Date(
        params.timestamp ? params.timestamp * 1000 : Date.now(),
      ),
      read: false,
    },
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { updatedAt: new Date() },
  });

  await processMediaAttachment(app, {
    conversationId: conversation.id,
    waId: contact.waId,
    media: params.media,
    messageId: message.id,
    config,
  });

  const latestMessage = await prisma.message.findUnique({
    where: { id: message.id },
  });
  const effectiveText =
    latestMessage?.transcriptText ||
    latestMessage?.text ||
    params.text ||
    "";

  await maybeUpdateContactName(contact, params.profileName, effectiveText);

  if (conversation.aiMode === "INTERVIEW") {
    await detectInterviewSignals(conversation.id, effectiveText);
  }

  await maybeSendAutoReply(app, conversation.id, contact.waId, config);

  if (!isAdminSender && isAdminCommandText(params.text)) {
    await sendWhatsAppText(waId, "Comando no reconocido");
  }

  return { conversationId: conversation.id };
}

export async function maybeSendAutoReply(
  app: FastifyInstance,
  conversationId: string,
  waId: string | null | undefined,
  config: SystemConfig,
): Promise<void> {
  try {
    if (!config?.botAutoReply) return;

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        messages: {
          orderBy: { timestamp: "asc" },
        },
      },
    });

    if (!conversation || conversation.isAdmin) return;

    const mode = conversation.aiMode || "RECRUIT";
    if (mode === "OFF" || conversation.aiPaused) return;

    const context = conversation.messages
      .map((m) =>
        m.direction === "INBOUND"
          ? `Candidato: ${m.text}`
          : `Agente: ${m.text}`,
      )
      .join("\n");

    let prompt = config.aiPrompt?.trim() || DEFAULT_AI_PROMPT;
    let model: string | undefined = config.aiModel?.trim() || DEFAULT_AI_MODEL;
    if (mode === "INTERVIEW") {
      prompt = config.interviewAiPrompt?.trim() || DEFAULT_INTERVIEW_AI_PROMPT;
      prompt = `${prompt}\n\n${INTERVIEW_AI_POLICY_ADDENDUM}\n\n` +
        "Instrucciones obligatorias de sistema: " +
        "No inventes direcciones; si te piden dirección exacta, responde que se enviará por este medio. " +
        "Cuando propongas o confirmes fecha/hora/lugar de entrevista, agrega al final un bloque <hunter_action>{\"type\":\"interview_update\",\"day\":\"<Día>\",\"time\":\"<HH:mm>\",\"location\":\"<Lugar>\",\"status\":\"<CONFIRMED|PENDING|CANCELLED>\"}</hunter_action>.";
      model = config.interviewAiModel?.trim() || DEFAULT_INTERVIEW_AI_MODEL;
    }

    const suggestionRaw = await getSuggestedReply(context, {
      prompt,
      model,
      config,
    });

    const { cleanedText, actions } = parseHunterActions(suggestionRaw || "");
    let suggestionText = cleanedText;
    if (!suggestionText?.trim()) {
      return;
    }

    if (actions.length > 0) {
      for (const action of actions) {
        if (action.type === "interview_update") {
          await applyInterviewAction(conversationId, action);
        }
      }
      const hasInterviewAction = actions.some(a => a.type === "interview_update");
      if (hasInterviewAction) {
        const convo = await prisma.conversation.findUnique({
          where: { id: conversationId },
          select: {
            interviewDay: true,
            interviewTime: true,
            interviewLocation: true,
          },
        });
        const locationText =
          convo?.interviewLocation || "Te enviaremos la dirección exacta por este medio.";
        const dayText = convo?.interviewDay || "día por definir";
        const timeText = convo?.interviewTime || "hora por definir";
        suggestionText = `Quedamos para ${dayText} a las ${timeText} en ${locationText}.`;
      }
    }

    let sendResultRaw: SendResult = {
      success: false,
      error: "waId is missing",
    };
    if (waId) {
      sendResultRaw = await sendWhatsAppText(waId, suggestionText);
    }

    const normalizedSendResult = {
      success: sendResultRaw.success,
      messageId:
        "messageId" in sendResultRaw ? (sendResultRaw.messageId ?? null) : null,
      error: "error" in sendResultRaw ? (sendResultRaw.error ?? null) : null,
    };

    if (!normalizedSendResult.success) {
      app.log.warn(
        { conversationId, error: normalizedSendResult.error },
        "Auto-reply send failed",
      );
    }

    await prisma.message.create({
      data: {
        conversationId,
        direction: "OUTBOUND",
        text: suggestionText,
        rawPayload: serializeJson({
          autoReply: true,
          sendResult: normalizedSendResult,
        }),
        timestamp: new Date(),
        read: true,
      },
    });
  } catch (err) {
    app.log.error({ err, conversationId }, "Auto-reply processing failed");
  }
}

function buildInboundText(text?: string, media?: InboundMedia | null): string {
  const trimmed = (text || "").trim();
  if (trimmed) return trimmed;
  const mediaLabel = renderMediaLabel(media);
  return mediaLabel || "(mensaje recibido)";
}

function renderMediaLabel(media?: InboundMedia | null): string | null {
  if (!media) return null;
  if (media.type === "voice" || media.type === "audio") {
    return "Audio recibido";
  }
  if (media.type === "image") {
    return media.caption ? `Imagen: ${media.caption}` : "Imagen recibida";
  }
  if (media.type === "document") {
    const base = media.filename
      ? `Documento ${media.filename}`
      : "Documento recibido";
    return media.caption ? `${base} - ${media.caption}` : base;
  }
  if (media.type === "sticker") {
    return "Sticker recibido";
  }
  return "Mensaje multimedia recibido";
}

async function processMediaAttachment(
  app: FastifyInstance,
  options: {
    conversationId: string;
    waId?: string | null;
    media?: InboundMedia | null;
    messageId: string;
    config: SystemConfig;
  },
): Promise<void> {
  const media = options.media;
  if (!media || !media.id || !options.waId) return;
  if (!options.config?.whatsappToken) return;

  try {
    const baseUrl = (options.config.whatsappBaseUrl || DEFAULT_WHATSAPP_BASE_URL)
      .replace(/\/$/, "");
    const infoRes = await fetch(`${baseUrl}/${media.id}`, {
      headers: { Authorization: `Bearer ${options.config.whatsappToken}` },
    });
    if (!infoRes.ok) {
      app.log.warn(
        { conversationId: options.conversationId, mediaId: media.id },
        "No se pudo obtener metadata de media",
      );
      return;
    }
    const mediaInfo = (await infoRes.json()) as any;
    const mediaUrl = mediaInfo.url;
    const mimeType = media.mimeType || mediaInfo.mime_type;
    if (!mediaUrl) return;

    const downloadRes = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${options.config.whatsappToken}` },
    });
    if (!downloadRes.ok) {
      app.log.warn(
        { conversationId: options.conversationId, mediaId: media.id },
        "No se pudo descargar media",
      );
      return;
    }

    const buffer = Buffer.from(await downloadRes.arrayBuffer());
    const extension = pickExtension(mimeType, media.type);
    const dir = path.join(UPLOADS_BASE, options.waId);
    await fs.mkdir(dir, { recursive: true });
    const filename = `${options.messageId}.${extension}`;
    const absolutePath = path.join(dir, filename);
    await fs.writeFile(absolutePath, buffer);
    const relativePath = path.relative(path.join(__dirname, ".."), absolutePath);

    await prisma.message.update({
      where: { id: options.messageId },
      data: { mediaPath: relativePath, mediaMime: mimeType || null },
    });

    if (media.type === "audio" || media.type === "voice") {
      const transcription = await transcribeAudio(
        absolutePath,
        options.config,
        app,
      );
      if (transcription.text) {
        await prisma.message.update({
          where: { id: options.messageId },
          data: { transcriptText: transcription.text, text: transcription.text },
        });
        await prisma.conversation.update({
          where: { id: options.conversationId },
          data: { updatedAt: new Date() },
        });
      } else if (transcription.error) {
        const fallback =
          "Audio recibido pero no se pudo transcribir. Envía el detalle por texto, por favor.";
        await prisma.message.update({
          where: { id: options.messageId },
          data: { text: fallback, transcriptText: null },
        });
      }
    }
  } catch (err) {
    app.log.error(
      { err, conversationId: options.conversationId },
      "Media processing failed",
    );
  }
}

function pickExtension(
  mimeType?: string | null,
  mediaType?: string | null,
): string {
  if (mimeType) {
    const lower = mimeType.toLowerCase();
    if (lower.includes("ogg")) return "ogg";
    if (lower.includes("mpeg")) return "mp3";
    if (lower.includes("wav")) return "wav";
    if (lower.includes("mp4")) return "mp4";
    if (lower.includes("pdf")) return "pdf";
    if (lower.includes("png")) return "png";
    if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
    const parts = lower.split("/");
    if (parts[1]) return parts[1];
  }
  if (mediaType === "image") return "jpg";
  if (mediaType === "document") return "pdf";
  if (mediaType === "audio" || mediaType === "voice") return "ogg";
  return "bin";
}

async function transcribeAudio(
  filePath: string,
  config: SystemConfig,
  app: FastifyInstance,
): Promise<{ text: string | null; error?: string | null }> {
  try {
    const apiKey = getEffectiveOpenAiKey(config);
    if (!apiKey) return { text: null, error: "Sin clave de OpenAI" };
    const client = new OpenAI({ apiKey });
    const response = await client.audio.transcriptions.create({
      file: createReadStream(filePath),
      model: "gpt-4o-mini-transcribe",
    });
    const text = (response as any)?.text || (response as any)?.segments?.[0];
    const trimmed = typeof text === "string" ? text.trim() : null;
    const finalText = trimmed && trimmed.length > 0 ? trimmed : null;
    return { text: finalText, error: finalText ? null : "Sin texto" };
  } catch (err) {
    app.log.warn({ err }, "Audio transcription failed");
    const message = err instanceof Error ? err.message : "Transcripción fallida";
    return { text: null, error: message };
  }
}

function isAdminCommandText(text?: string): boolean {
  if (!text) return false;
  const trimmed = text.trim().toLowerCase();
  return ["/pendientes", "/resumen", "/estado", "/ayuda"].some((cmd) =>
    trimmed.startsWith(cmd),
  );
}

async function maybeUpdateContactName(
  contact: {
    id: string;
    name: string | null;
    displayName?: string | null;
    candidateName?: string | null;
  },
  profileName?: string,
  fallbackText?: string,
) {
  const updates: Record<string, string | null> = {};
  if (contact.candidateName && isSuspiciousCandidateName(contact.candidateName)) {
    updates.candidateName = null;
  }
  const display = normalizeName(profileName);
  if (display && display !== contact.displayName) {
    updates.displayName = display;
  }
  const candidate = extractNameFromText(fallbackText);
  if (candidate && isValidName(candidate) && !isSuspiciousCandidateName(candidate)) {
    const existing = contact.candidateName?.trim() || null;
    const existingScore = scoreName(existing);
    const candidateScore = scoreName(candidate);
    const sameAsDisplay =
      contact.displayName &&
      candidate.toLowerCase() === contact.displayName.toLowerCase();
    const existingSuspicious = isSuspiciousCandidateName(existing);
    if (
      !sameAsDisplay &&
      candidate.length > 1 &&
      (candidateScore >= existingScore || existingSuspicious)
    ) {
      updates.candidateName = candidate;
    }
    if (!existing && !updates.candidateName) {
      updates.name = candidate;
    }
  }
  if (!updates.candidateName && !contact.candidateName && display && !updates.name && !contact.name) {
    updates.name = display;
  }
  if (Object.keys(updates).length === 0) return;
  await prisma.contact.update({
    where: { id: contact.id },
    data: updates,
  });
  Object.assign(contact, updates);
}

function extractNameFromText(text?: string): string | null {
  if (!text) return null;
  const cleaned = text.trim();
  if (!cleaned) return null;
  const match = cleaned.match(
    /(?:mi nombre es|me llamo|soy)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ\s]{2,60})/i,
  );
  if (match && match[1]) {
    const normalized = normalizeName(match[1]);
    if (isValidName(normalized)) return normalized;
  }
  // pattern: "Ignacio, Santiago", take first part
  const firstChunk = cleaned.split(/[,;-]/)[0]?.trim();
  if (isValidName(firstChunk)) {
    return normalizeName(firstChunk);
  }
  if (
    /^[A-Za-zÁÉÍÓÚáéíóúÑñ\s]{2,60}$/i.test(cleaned) &&
    cleaned.split(/\s+/).filter(Boolean).length <= 4
  ) {
    const normalized = normalizeName(cleaned);
    if (isValidName(normalized)) return normalized;
  }
  return null;
}

function normalizeName(value?: string | null): string | null {
  if (!value) return null;
  const sanitized = value
    .replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!sanitized) return null;
  const words = sanitized.split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 4) return null;
  return words
    .map(
      (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
}

function isValidName(value?: string | null): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length < 2) return false;
  if (/[^A-Za-zÁÉÍÓÚáéíóúÑñ\s]/.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  const blacklist = ["hola", "buenas", "buenos", "gracias", "ok", "vale", "hello", "hey", "hi"];
  if (blacklist.includes(lower)) return false;
  if (!trimmed.includes(" ") && trimmed.length < 3) return false;
  return true;
}

function isSuspiciousCandidateName(value?: string | null): boolean {
  if (!value) return true;
  const lower = value.toLowerCase();
  const patterns = [
    "hola quiero postular",
    "quiero postular",
    "postular",
    "no puedo",
    "no me sirve",
    "confirmo",
    "medio dia",
    "mediodia",
    "confirmar",
    "gracias",
  ];
  if (patterns.some(p => lower.includes(p))) return true;
  if (/(lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)/i.test(value)) return true;
  if (/medio ?d[ií]a/i.test(value)) return true;
  return false;
}

function scoreName(value?: string | null): number {
  if (!value) return 0;
  const words = value.trim().split(/\s+/).filter(Boolean);
  let score = words.length;
  if (value.length >= 6) score += 1;
  if (words.length >= 2) score += 1;
  return score;
}

async function detectInterviewSignals(
  conversationId: string,
  text: string,
): Promise<void> {
  const lower = text.toLowerCase();
  const updates: Record<string, string | null> = {};
  let statusUpdate: string | null = null;

  if (/\bconfirm(o|ar)?\b/.test(lower)) {
    statusUpdate = "CONFIRMED";
  }
  if (/\bno (puedo|sirve|voy|asistir|ir)\b/.test(lower) || /^no\b/.test(lower)) {
    statusUpdate = "CANCELLED";
  }

  const parsed = parseDayTime(text);
  if (parsed.day) updates.interviewDay = parsed.day;
  if (parsed.time) updates.interviewTime = parsed.time;

  if (statusUpdate) {
    updates.interviewStatus = statusUpdate;
  }

  if (Object.keys(updates).length === 0) return;
  await prisma.conversation.update({
    where: { id: conversationId },
    data: updates,
  });
}

function parseDayTime(text: string): { day: string | null; time: string | null } {
  const dayMatch = text.match(
    /(lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)/i,
  );
  const timeMatch = text.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i,
  );
  let time: string | null = null;
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const suffix = timeMatch[3]?.toLowerCase();
    if (suffix?.includes("p") && hour < 12) hour += 12;
    if (suffix?.includes("a") && hour === 12) hour = 0;
    const hh = hour.toString().padStart(2, "0");
    const mm = minutes.toString().padStart(2, "0");
    time = `${hh}:${mm}`;
  } else if (/medio ?d[ií]a/i.test(text)) {
    time = "12:00";
  }
  const day = dayMatch ? capitalize(dayMatch[1]) : null;
  return { day, time };
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

type AdminPendingAction =
  | {
      type: "status";
      targetWaId: string | null;
      awaiting: "status";
    }
  | {
      type: "interview_update";
      targetWaId: string | null;
      awaiting: "confirm" | null;
      updates: {
        interviewDay?: string | null;
        interviewTime?: string | null;
        interviewLocation?: string | null;
        interviewStatus?: string | null;
      };
    };

async function handleAdminPendingAction(
  app: FastifyInstance,
  adminConversationId: string,
  lastCandidateWaId: string | null,
  text: string,
  adminWaId: string,
): Promise<boolean> {
  const trimmed = text.trim().toLowerCase();
  const adminConvo = await prisma.conversation.findUnique({
    where: { id: adminConversationId },
    select: { adminPendingAction: true },
  });
  const pending = adminConvo?.adminPendingAction
    ? (JSON.parse(adminConvo.adminPendingAction) as AdminPendingAction)
    : null;

  const statusFromText = detectStatusKeyword(trimmed);
  if (!pending && !statusFromText && /estado/.test(trimmed)) {
    await prisma.conversation.update({
      where: { id: adminConversationId },
      data: {
        adminPendingAction: JSON.stringify({
          type: "status",
          targetWaId: lastCandidateWaId || null,
          awaiting: "status",
        }),
      },
    });
    await sendAdminReply(
      app,
      adminConversationId,
      adminWaId,
      "¿Qué estado deseas dejar? (Nuevo/Seguimiento/Cerrado)",
    );
    return true;
  }

  if (pending && pending.type === "status" && pending.awaiting === "status") {
    if (statusFromText && pending.targetWaId) {
      await setConversationStatusByWaId(pending.targetWaId, statusFromText);
      await prisma.conversation.update({
        where: { id: adminConversationId },
        data: { adminPendingAction: null, adminLastCandidateWaId: pending.targetWaId },
      });
      await sendAdminReply(
        app,
        adminConversationId,
        adminWaId,
        `Estado actualizado a ${statusFromText} para +${pending.targetWaId}.`,
      );
      return true;
    }
  }

  if (pending && pending.type === "interview_update" && pending.awaiting === "confirm") {
    if (/^(si|sí|ok|ya|dale)/i.test(trimmed)) {
      if (pending.targetWaId) {
      await prisma.conversation.update({
        where: { id: adminConversationId },
        data: { adminPendingAction: null, adminLastCandidateWaId: pending.targetWaId },
      });
      await applyConversationInterviewUpdate(pending.targetWaId, pending.updates);
      await sendAdminReply(
        app,
        adminConversationId,
        adminWaId,
        "Entrevista actualizada. ¿Quieres que envíe la plantilla de entrevista? Responde CONFIRMAR ENVÍO.",
      );
      return true;
    }
  }
  }

  if (!pending && statusFromText && lastCandidateWaId) {
    await setConversationStatusByWaId(lastCandidateWaId, statusFromText);
    await prisma.conversation.update({
      where: { id: adminConversationId },
      data: { adminLastCandidateWaId: lastCandidateWaId },
    });
    await sendAdminReply(
      app,
      adminConversationId,
      adminWaId,
      `Estado actualizado a ${statusFromText} para +${lastCandidateWaId}.`,
    );
    return true;
  }

  const parsedInterview = parseInterviewInstruction(trimmed);
  if (parsedInterview && lastCandidateWaId) {
    await applyConversationInterviewUpdate(lastCandidateWaId, {
      interviewDay: parsedInterview.day,
      interviewTime: parsedInterview.time,
      interviewLocation: parsedInterview.location,
      interviewStatus: "PENDING",
    });
    await prisma.conversation.update({
      where: { id: adminConversationId },
      data: {
        adminLastCandidateWaId: lastCandidateWaId,
        adminPendingAction: JSON.stringify({
          type: "interview_update",
          targetWaId: lastCandidateWaId,
          awaiting: "confirm",
          updates: {
            interviewDay: parsedInterview.day,
            interviewTime: parsedInterview.time,
            interviewLocation: parsedInterview.location,
            interviewStatus: "PENDING",
          },
        }),
      },
    });
    const locationText = parsedInterview.location || "Te enviaremos la dirección exacta por este medio.";
    await sendAdminReply(
      app,
      adminConversationId,
      adminWaId,
      `Actualicé a modo Entrevista: ${parsedInterview.day || "día por definir"} a ${
        parsedInterview.time || "hora por definir"
      } en ${locationText}. ¿Deseas que envíe la plantilla de entrevista? Responde CONFIRMAR ENVÍO.`,
    );
    return true;
  }

  return false;
}

function detectStatusKeyword(text: string): "NEW" | "OPEN" | "CLOSED" | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (/nuevo/.test(lower)) return "NEW";
  if (/seguimiento|abierto|open/.test(lower)) return "OPEN";
  if (/cerrado|close/.test(lower)) return "CLOSED";
  return null;
}

function parseInterviewInstruction(text: string): { day: string | null; time: string | null; location: string | null } | null {
  if (!/entrevista|agenda|agendar|coordinar/.test(text)) return null;
  const { day, time } = parseDayTime(text);
  let location: string | null = null;
  const locMatch = text.match(/en\s+([A-Za-zÁÉÍÓÚáéíóúÑñ0-9\s,.-]{3,60})$/i);
  if (locMatch) {
    location = locMatch[1].trim();
  }
  if (!day && !time && !location) return null;
  return { day, time, location };
}

async function applyConversationInterviewUpdate(
  waId: string,
  updates: { interviewDay?: string | null; interviewTime?: string | null; interviewLocation?: string | null; interviewStatus?: string | null },
) {
  const convo = await fetchConversationByIdentifier(waId, { includeMessages: false });
  if (!convo) return;
  await prisma.conversation.update({
    where: { id: convo.id },
    data: {
      aiMode: "INTERVIEW",
      interviewDay: typeof updates.interviewDay !== "undefined" ? updates.interviewDay : convo.interviewDay,
      interviewTime: typeof updates.interviewTime !== "undefined" ? updates.interviewTime : convo.interviewTime,
      interviewLocation:
        typeof updates.interviewLocation !== "undefined" ? updates.interviewLocation : convo.interviewLocation,
      interviewStatus:
        typeof updates.interviewStatus !== "undefined" ? updates.interviewStatus : convo.interviewStatus,
    },
  });
}

async function handleAdminLearning(
  text: string,
  config: SystemConfig,
  adminConversationId: string,
  app: FastifyInstance,
  waId: string,
): Promise<boolean> {
  const learnMatch = text.match(/^aprender:\s*(.+)/i);
  if (learnMatch) {
    const now = new Date().toISOString();
    const entry = `${now}: ${learnMatch[1]}`.trim();
    const existing = config.adminAiAddendum || "";
    const combined = `${existing}\n${entry}`.trim();
    const trimmed = combined.slice(-8000);
    await updateAdminAiConfig({ addendum: trimmed });
    await sendAdminReply(app, adminConversationId, waId, "Aprendido y guardado.");
    return true;
  }
  if (/^listar aprendizajes/i.test(text)) {
    const liveConfig = await getSystemConfig();
    const items = (liveConfig.adminAiAddendum || "").split("\n").filter(Boolean);
    const body =
      items.length === 0
        ? "No hay aprendizajes guardados."
        : items.map((line, idx) => `${idx + 1}. ${line}`).join("\n");
    await sendAdminReply(app, adminConversationId, waId, body);
    return true;
  }
  const forgetMatch = text.match(/^olvidar:\s*(\d+)/i);
  if (forgetMatch) {
    const idx = parseInt(forgetMatch[1], 10) - 1;
    const liveConfig = await getSystemConfig();
    const items = (liveConfig.adminAiAddendum || "").split("\n").filter(Boolean);
    if (idx >= 0 && idx < items.length) {
      items.splice(idx, 1);
      const trimmed = items.join("\n");
      await updateAdminAiConfig({ addendum: trimmed });
      await sendAdminReply(app, adminConversationId, waId, "Aprendizaje eliminado.");
    } else {
      await sendAdminReply(app, adminConversationId, waId, "Índice inválido.");
    }
    return true;
  }
  return false;
}
type InterviewAction = {
  type: "interview_update";
  day?: string | null;
  time?: string | null;
  location?: string | null;
  status?: string | null;
};

function parseHunterActions(text: string): {
  cleanedText: string;
  actions: InterviewAction[];
} {
  const actions: InterviewAction[] = [];
  let cleaned = text;
  const regex = /<hunter_action>([\s\S]*?)<\/hunter_action>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed?.type === "interview_update") {
        actions.push({
          type: "interview_update",
          day: parsed.day || null,
          time: parsed.time || null,
          location: parsed.location || null,
          status: parsed.status || null,
        });
      }
    } catch {
      // ignore bad JSON
    }
  }
  cleaned = cleaned.replace(regex, "").trim();
  return { cleanedText: cleaned, actions };
}

async function applyInterviewAction(
  conversationId: string,
  action: InterviewAction,
) {
  const data: Record<string, string | null> = {};
  if (typeof action.day !== "undefined") data.interviewDay = action.day || null;
  if (typeof action.time !== "undefined") data.interviewTime = action.time || null;
  if (typeof action.location !== "undefined")
    data.interviewLocation = action.location || null;
  if (typeof action.status !== "undefined")
    data.interviewStatus = action.status || null;
  if (Object.keys(data).length === 0) return;
  await prisma.conversation.update({
    where: { id: conversationId },
    data,
  });
}

function extractWaIdFromText(text?: string | null): string | null {
  if (!text) return null;
  const match = text.match(/\+?\d{9,15}/);
  if (!match) return null;
  return normalizeWhatsAppId(match[0]);
}

function clearStaleAdminIntent(normalizedAdmin: string) {
  const pending = pendingAdminSends.get(normalizedAdmin);
  if (pending && Date.now() - pending.createdAt > ADMIN_PENDING_TTL_MS) {
    pendingAdminSends.delete(normalizedAdmin);
  }
}

async function maybeConfirmAdminSend(
  app: FastifyInstance,
  conversationId: string,
  normalizedAdmin: string,
): Promise<boolean> {
  const pending = pendingAdminSends.get(normalizedAdmin);
  if (!pending) return false;

  try {
    const result = await createConversationAndMaybeSend({
      phoneE164: pending.targetWaId,
      mode: pending.mode,
      status: "NEW",
      sendTemplateNow: true,
      variables: pending.variables,
      templateNameOverride: pending.templateName,
    });

    pendingAdminSends.delete(normalizedAdmin);
    const success = result.sendResult?.success;
    const sendText = success
      ? `Plantilla ${pending.templateName} enviada a +${pending.targetWaId}.`
      : `No se pudo enviar a +${pending.targetWaId}: ${
          result.sendResult?.error || "Error"
        }`;
    await sendAdminReply(app, conversationId, normalizedAdmin, sendText);
  } catch (err) {
    pendingAdminSends.delete(normalizedAdmin);
    const message =
      err instanceof Error ? err.message : "No se pudo enviar la plantilla";
    await sendAdminReply(
      app,
      conversationId,
      normalizedAdmin,
      `Error al enviar: ${message}`,
    );
  }

  return true;
}

async function detectAdminTemplateIntent(
  text: string,
  config: SystemConfig,
  app: FastifyInstance,
): Promise<PendingAdminSend | null> {
  if (!text) return null;
  const normalized = text.trim();
  const phoneMatch = normalized.match(/\+?\d{9,15}/);
  const hasIntent = /plantilla|postulaci[oó]n|entrevista/i.test(normalized);
  if (!hasIntent || !phoneMatch) return null;

  const targetWaId = normalizeWhatsAppId(phoneMatch[0]);
  if (!targetWaId) return null;

  const lower = normalized.toLowerCase();
  const mode: "RECRUIT" | "INTERVIEW" = lower.includes("entrevista")
    ? "INTERVIEW"
    : "RECRUIT";
  const templates = await loadTemplateConfig(app.log);
  const templateName = selectTemplateForMode(mode, templates);
  const variables = resolveTemplateVariables(templateName, [], templates);
  const whitelist = [
    normalizeWhatsAppId(config.adminWaId),
    normalizeWhatsAppId(templates.testPhoneNumber),
  ].filter(Boolean) as string[];
  const allowed = whitelist.includes(targetWaId);

  const variablesPreview =
    variables.length > 0
      ? variables.map((v, idx) => `{{${idx + 1}}}=${v}`).join(", ")
      : "sin variables";
  const previewLines = [
    `Destino: +${targetWaId}`,
    `Modo: ${mode === "INTERVIEW" ? "Entrevista" : "Reclutamiento"}`,
    `Plantilla: ${templateName} (${templates.templateLanguageCode || "es_CL"})`,
    `Variables: ${variablesPreview}`,
  ];
  const warning = allowed
    ? ""
    : "\n⚠️ Destino fuera de whitelist, requiere CONFIRMAR ENVÍO.";
  const previewText = `${previewLines.join(
    "\n",
  )}\nResponde "CONFIRMAR ENVÍO" para enviar.${warning}`;

  return {
    targetWaId,
    mode,
    templateName,
    variables,
    previewText,
    createdAt: Date.now(),
    allowed,
  };
}

async function ensureAdminConversation(waId: string, normalizedAdmin: string) {
  let contact = await prisma.contact.findUnique({
    where: { waId: normalizedAdmin },
  });
  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        waId: normalizedAdmin,
        phone: normalizedAdmin,
        name: "Administrador",
      },
    });
  }

  let conversation = await prisma.conversation.findFirst({
    where: { contactId: contact.id, isAdmin: true },
    orderBy: { updatedAt: "desc" },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        contactId: contact.id,
        status: "OPEN",
        channel: "admin",
        isAdmin: true,
        aiMode: "OFF",
      },
    });
  }

  return { contact, conversation };
}

async function logAdminMessage(
  conversationId: string,
  direction: "INBOUND" | "OUTBOUND",
  text: string,
  rawPayload?: any,
) {
  await prisma.message.create({
    data: {
      conversationId,
      direction,
      text,
      rawPayload: serializeJson(rawPayload ?? { admin: true }),
      timestamp: new Date(),
      read: direction === "OUTBOUND",
    },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });
}

async function sendAdminReply(
  app: FastifyInstance,
  conversationId: string,
  waId: string,
  text: string,
) {
  let sendResultRaw: SendResult = await sendWhatsAppText(waId, text);
  const normalizedSendResult = {
    success: sendResultRaw.success,
    messageId:
      "messageId" in sendResultRaw ? (sendResultRaw.messageId ?? null) : null,
    error: "error" in sendResultRaw ? (sendResultRaw.error ?? null) : null,
  };
  if (!normalizedSendResult.success) {
    app.log.warn(
      { conversationId, error: normalizedSendResult.error },
      "Admin reply send failed",
    );
  }
  await logAdminMessage(conversationId, "OUTBOUND", text, {
    adminReply: true,
    sendResult: normalizedSendResult,
  });
}
