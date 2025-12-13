import { FastifyInstance } from "fastify";
import { SystemConfig } from "@prisma/client";
import { prisma } from "../db/client";
import {
  getSystemConfig,
  DEFAULT_INTERVIEW_AI_PROMPT,
  DEFAULT_INTERVIEW_AI_MODEL,
  INTERVIEW_AI_POLICY_ADDENDUM,
  DEFAULT_AI_MODEL,
} from "./configService";
import { DEFAULT_AI_PROMPT } from "../constants/ai";
import { serializeJson } from "../utils/json";
import { getSuggestedReply } from "./aiService";
import { sendWhatsAppText, SendResult } from "./whatsappMessageService";
import { normalizeWhatsAppId } from "../utils/whatsapp";
import { processAdminCommand } from "./whatsappAdminCommandService";
import { generateAdminAiResponse } from "./whatsappAdminAiService";

interface InboundMessageParams {
  from: string;
  text?: string;
  timestamp?: number;
  rawPayload?: any;
  profileName?: string;
  config?: SystemConfig;
}

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
    await logAdminMessage(
      adminThread.conversation.id,
      "INBOUND",
      params.text || "",
      params.rawPayload,
    );

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

    const aiResponse = await generateAdminAiResponse(app, {
      waId,
      text: params.text || "",
      config,
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

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: "INBOUND",
      text: params.text || "",
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
    if (mode === "OFF") return;

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

function isAdminCommandText(text?: string): boolean {
  if (!text) return false;
  const trimmed = text.trim().toLowerCase();
  return ["/pendientes", "/resumen", "/estado", "/ayuda"].some((cmd) =>
    trimmed.startsWith(cmd),
  );
}

async function maybeUpdateContactName(
  contact: { id: string; name: string | null },
  profileName?: string,
  fallbackText?: string,
) {
  if (contact.name) return;
  const candidate =
    normalizeName(profileName) || extractNameFromText(fallbackText);
  if (!candidate) return;
  await prisma.contact.update({
    where: { id: contact.id },
    data: { name: candidate },
  });
  contact.name = candidate;
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
    if (normalized) return normalized;
  }
  if (
    /^[A-Za-zÁÉÍÓÚáéíóúÑñ\s]{2,60}$/i.test(cleaned) &&
    cleaned.split(/\s+/).filter(Boolean).length <= 4
  ) {
    const normalized = normalizeName(cleaned);
    if (normalized) return normalized;
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
