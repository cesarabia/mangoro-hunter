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
} from "./configService";
import { DEFAULT_AI_PROMPT } from "../constants/ai";
import { serializeJson } from "../utils/json";
import { getEffectiveOpenAiKey, getSuggestedReply } from "./aiService";
import { sendWhatsAppText, SendResult } from "./whatsappMessageService";
import { normalizeWhatsAppId } from "../utils/whatsapp";
import { processAdminCommand } from "./whatsappAdminCommandService";
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
    const candidateFromText = extractWaIdFromText(params.text);
    if (candidateFromText) {
      await prisma.conversation.update({
        where: { id: adminThread.conversation.id },
        data: { adminLastCandidateWaId: candidateFromText },
      });
      adminThread.conversation.adminLastCandidateWaId = candidateFromText;
    }
    await logAdminMessage(
      adminThread.conversation.id,
      "INBOUND",
      params.text || "",
      params.rawPayload,
    );

    clearStaleAdminIntent(normalizedAdmin);
    if (trimmedText.toUpperCase() === "CONFIRMAR ENVÍO") {
      const handled = await maybeConfirmAdminSend(
        app,
        adminThread.conversation.id,
        normalizedAdmin,
      );
      if (handled) {
        return { conversationId: adminThread.conversation.id };
      }
    }

    if (trimmedText.startsWith("/")) {
      const response = await processAdminCommand({
        waId,
        text: params.text,
        config,
      });
      if (response) {
        await sendAdminReply(app, adminThread.conversation.id, waId, response);
      }
      return { conversationId: adminThread.conversation.id };
    }

    const templateIntent = await detectAdminTemplateIntent(
      trimmedText,
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
      text: params.text || "",
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
      prompt = `${prompt}\n\n${INTERVIEW_AI_POLICY_ADDENDUM}`;
      model = config.interviewAiModel?.trim() || DEFAULT_INTERVIEW_AI_MODEL;
    }

    const suggestion = await getSuggestedReply(context, {
      prompt,
      model,
      config,
    });
    if (!suggestion?.trim()) {
      return;
    }

    let sendResultRaw: SendResult = {
      success: false,
      error: "waId is missing",
    };
    if (waId) {
      sendResultRaw = await sendWhatsAppText(waId, suggestion);
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
        text: suggestion,
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
  const display = normalizeName(profileName);
  if (display && display !== contact.displayName) {
    updates.displayName = display;
  }
  const candidate = extractNameFromText(fallbackText);
  if (candidate && isValidName(candidate)) {
    const existing = contact.candidateName?.trim() || null;
    const sameAsDisplay =
      contact.displayName && candidate.toLowerCase() === contact.displayName.toLowerCase();
    if (!sameAsDisplay && candidate.length > 1) {
      updates.candidateName = candidate;
    }
    if (!existing) {
      updates.name = candidate;
    }
  }
  if (display && !contact.name && !updates.name) {
    updates.candidateName = candidate;
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
