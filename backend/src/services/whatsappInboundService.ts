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
  normalizeModelId,
  DEFAULT_TEMPLATE_INTERVIEW_INVITE,
} from "./configService";
import { DEFAULT_AI_PROMPT } from "../constants/ai";
import { serializeJson } from "../utils/json";
import { getEffectiveOpenAiKey, getSuggestedReply } from "./aiService";
import { sendWhatsAppText, SendResult } from "./whatsappMessageService";
import { processAdminCommand, fetchConversationByIdentifier, setConversationStatusByWaId } from "./whatsappAdminCommandService";
import { generateAdminAiResponse } from "./whatsappAdminAiService";
import { loadTemplateConfig, resolveTemplateVariables, selectTemplateForMode } from "./templateService";
import { createConversationAndMaybeSend } from "./conversationCreateService";
import { buildWaIdCandidates, normalizeWhatsAppId } from "../utils/whatsapp";

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

const UPLOADS_BASE = path.join(__dirname, "..", "uploads");

type AdminEventType = "RECRUIT_READY" | "INTERVIEW_SCHEDULED" | "INTERVIEW_CONFIRMED";

async function sendAdminNotification(options: {
  app: FastifyInstance;
  eventType: AdminEventType;
  contact: any;
  interviewDay?: string | null;
  interviewTime?: string | null;
  interviewLocation?: string | null;
  summary?: string;
}) {
  const { app, eventType, contact, interviewDay, interviewTime, interviewLocation, summary } = options;
  const config = await getSystemConfig();
  const adminWa = normalizeWhatsAppId(config.adminWaId || "");
  if (!adminWa) return;
  const { conversation } = await ensureAdminConversation(adminWa, adminWa);
  const eventKey = `${eventType}:${contact?.id || contact?.waId || contact?.phone || ""}:${interviewDay || ""}:${interviewTime || ""}`;
  const existing = await prisma.message.findFirst({
    where: {
      conversationId: conversation.id,
      text: { contains: `[REF:${eventKey}]` },
    },
  });
  if (existing) return;

  let text = "";
  if (eventType === "RECRUIT_READY") {
    text = `🟢 Reclutamiento listo: ${contact?.candidateName || contact?.displayName || contact?.waId}\nTel: +${contact?.waId}\nResumen: ${summary || "Datos mínimos recibidos."}\nPróximo paso: revisar y contactar.`;
  } else if (eventType === "INTERVIEW_SCHEDULED") {
    text = `🗓️ Entrevista agendada: ${contact?.candidateName || contact?.displayName || contact?.waId}\nTel: +${contact?.waId}\n${formatInterviewSlot(interviewDay, interviewTime, interviewLocation)}\nEstado: PENDIENTE.`;
  } else {
    text = `✅ Entrevista confirmada: ${contact?.candidateName || contact?.displayName || contact?.waId}\nTel: +${contact?.waId}\n${formatInterviewSlot(interviewDay, interviewTime, interviewLocation)}.`;
  }
  const textWithRef = `${text}\n[REF:${eventKey}]`;
  let sendStatus: "WA_SENT" | "WA_FAILED" = "WA_SENT";
  let sendError: string | null = null;
  try {
    const resp = await sendWhatsAppText(adminWa, textWithRef);
    if (!resp.success) {
      sendStatus = "WA_FAILED";
      sendError = resp.error || "Unknown error";
    }
  } catch (err: any) {
    sendStatus = "WA_FAILED";
    sendError = err?.message || "Unknown error";
    app.log.warn({ err }, "Admin notification WA failed");
  }
  await logAdminMessage(conversation.id, "OUTBOUND", textWithRef, {
    adminNotification: true,
    eventType,
    status: sendStatus,
    error: sendError,
    contactId: contact?.id || null,
  });
}

function formatInterviewSlot(
  day?: string | null,
  time?: string | null,
  location?: string | null,
): string {
  const dayText = (day || "").trim() || "día por definir";
  const timeText = (time || "").trim() || "hora por definir";
  const locationText = (location || "").trim();
  const when = `${dayText} ${timeText}`.trim();
  return locationText ? `${when}, ${locationText}` : when;
}

async function mergeOrCreateContact(waId: string, preferredId?: string) {
  const candidates = buildWaIdCandidates(waId);
  let contacts = await prisma.contact.findMany({
    where: {
      OR: [
        { waId: { in: candidates } },
        { phone: { in: candidates } },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  if (preferredId && !contacts.find((c) => c.id === preferredId)) {
    const preferred = await prisma.contact.findUnique({ where: { id: preferredId } });
    if (preferred) contacts = [preferred, ...contacts];
  }
  if (contacts.length === 0) {
    return prisma.contact.create({
      data: {
        waId: normalizeWhatsAppId(waId),
        phone: waId,
      },
    });
  }
  let primary =
    contacts.find((c) => c.id === preferredId) ||
    contacts.find((c) => c.candidateName) ||
    contacts[0];
  const secondaries = contacts.filter((c) => c.id !== primary.id);
  const canonicalWaId =
    normalizeWhatsAppId(primary.waId || primary.phone || waId) || primary.waId || waId;
  const canonicalPhone = primary.phone || (canonicalWaId ? `+${canonicalWaId}` : null);

  await prisma.$transaction(async (tx) => {
    for (const sec of secondaries) {
      await tx.conversation.updateMany({
        where: { contactId: sec.id },
        data: { contactId: primary.id },
      });
      await tx.application.updateMany({
        where: { contactId: sec.id },
        data: { contactId: primary.id },
      });
      await tx.contact.update({
        where: { id: sec.id },
        data: { waId: null, phone: null },
      });
      await tx.contact.delete({ where: { id: sec.id } });
    }
    await tx.contact.update({
      where: { id: primary.id },
      data: {
        waId: canonicalWaId,
        phone: canonicalPhone ?? undefined,
      },
    });
  });

  const refreshed = await prisma.contact.findUnique({ where: { id: primary.id } });
  if (refreshed) return refreshed;
  return prisma.contact.create({
    data: {
      waId: normalizeWhatsAppId(waId),
      phone: waId,
    },
  });
}

export async function handleInboundWhatsAppMessage(
  app: FastifyInstance,
  params: InboundMessageParams,
): Promise<{ conversationId: string }> {
  const config = params.config ?? (await getSystemConfig());
  const waId = normalizeWhatsAppId(params.from) || params.from;
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

    const trimmedEffective = (effectiveText || "").trim();
    const pendingAction = parseAdminPendingAction(adminThread.conversation.adminPendingAction);
    if (pendingAction && isCancelPending(trimmedEffective)) {
      await saveAdminPendingAction(adminThread.conversation.id, null);
      await sendAdminReply(app, adminThread.conversation.id, waId, "Envío pendiente cancelado.");
      return { conversationId: adminThread.conversation.id };
    }
    if (pendingAction && isConfirmSend(trimmedEffective)) {
      const executed = await executePendingAction({
        app,
        adminConversationId: adminThread.conversation.id,
        adminWaId: waId,
        pendingAction,
      });
      if (executed) {
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
      config,
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

    const wantsSimpleMessage = /mensaje simple|sin plantilla|no plantilla|solo mensaje|mensaje directo/i.test(
      trimmedEffective,
    );
    if (wantsSimpleMessage) {
      const targetWaId =
        extractWaIdFromText(trimmedEffective) || adminThread.conversation.adminLastCandidateWaId;
      if (!targetWaId) {
        await sendAdminReply(
          app,
          adminThread.conversation.id,
          waId,
          "Indica a qué número debo enviar el mensaje simple (ej: +569...).",
        );
        return { conversationId: adminThread.conversation.id };
      }
      const within24h = await isCandidateWithin24h(targetWaId);
      if (!within24h) {
        await sendAdminReply(
          app,
          adminThread.conversation.id,
          waId,
          "Fuera de ventana 24h: solo puedo enviar plantilla. Responde CONFIRMAR ENVÍO para usar la plantilla o CANCELAR para anular.",
        );
        return { conversationId: adminThread.conversation.id };
      }
      const explicitDraft =
        trimmedEffective.includes(":") && trimmedEffective.split(":").slice(1).join(":").trim();
      const draftText =
        (explicitDraft && explicitDraft.length > 0 ? explicitDraft : null) ||
        (await buildSimpleInterviewMessage(targetWaId, app.log));
      if (!draftText) {
        await sendAdminReply(
          app,
          adminThread.conversation.id,
          waId,
          "No encontré datos para armar el mensaje simple. Dame el texto a enviar o confirma si prefieres plantilla.",
        );
        return { conversationId: adminThread.conversation.id };
      }
      const targetConvo = await fetchConversationByIdentifier(targetWaId, { includeMessages: false });
      const action: AdminPendingAction = {
        type: "send_message",
        targetWaId,
        text: draftText,
        relatedConversationId: targetConvo?.id ?? null,
        awaiting: "confirm",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        needsConfirmation: true,
        reminderSentAt: null,
      };
      await saveAdminPendingAction(adminThread.conversation.id, action);
      await prisma.conversation.update({
        where: { id: adminThread.conversation.id },
        data: { adminLastCandidateWaId: targetWaId },
      });
      adminThread.conversation.adminLastCandidateWaId = targetWaId;
      await sendAdminReply(
        app,
        adminThread.conversation.id,
        waId,
        `Borrador de mensaje simple:\n${draftText}\n\nResponde CONFIRMAR ENVÍO para enviarlo o CANCELAR para anular.`,
      );
      return { conversationId: adminThread.conversation.id };
    }

    const templateIntent = await detectAdminTemplateIntent(
      trimmedEffective,
      config,
      app,
      adminThread.conversation.id,
    );
    if (templateIntent) {
      await saveAdminPendingAction(adminThread.conversation.id, templateIntent.action);
      if (templateIntent.action.targetWaId) {
        await prisma.conversation.update({
          where: { id: adminThread.conversation.id },
          data: { adminLastCandidateWaId: templateIntent.action.targetWaId },
        });
        adminThread.conversation.adminLastCandidateWaId =
          templateIntent.action.targetWaId;
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
    const pendingNoteAction =
      pendingAction || parseAdminPendingAction(adminThread.conversation.adminPendingAction);
  const note =
    pendingNoteAction && (pendingNoteAction.type === "send_template" || pendingNoteAction.type === "send_message")
      ? `\n\nNota: hay un envío pendiente para +${pendingNoteAction.targetWaId}. Responde CONFIRMAR ENVÍO para ejecutarlo o escribe cancelar para anular.`
      : "";
  await sendAdminReply(app, adminThread.conversation.id, waId, `${aiResponse}${note}`);
  return { conversationId: adminThread.conversation.id };
}

const contact = (await mergeOrCreateContact(waId))!;
await maybeUpdateContactName(contact, params.profileName, params.text, config);

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

  const optedIn = await maybeHandleOptIn(app, conversation, contact, effectiveText);
  if (optedIn) {
    contact.noContact = false;
  }

  const optedOut = await maybeHandleOptOut(app, conversation, contact, effectiveText);
  if (optedOut) {
    return { conversationId: conversation.id };
  }

  await maybeUpdateContactName(contact, params.profileName, effectiveText, config);

  if (!conversation.isAdmin) {
    await detectInterviewSignals(app, conversation.id, effectiveText);
  }

  await maybeSendAutoReply(app, conversation.id, contact.waId, config);

  await maybeNotifyRecruitmentReady(app, conversation.id);

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
        contact: true,
        messages: {
          orderBy: { timestamp: "asc" },
        },
      },
    });

    if (!conversation || conversation.isAdmin) return;
    if (conversation.contact?.noContact) return;

    const mode = conversation.aiMode || "RECRUIT";
    if (mode === "OFF" || conversation.aiPaused) return;

    if (mode === "RECRUIT") {
      const inboundMessages = (conversation.messages || []).filter(
        (m) => m.direction === "INBOUND",
      );
      const assessment = assessRecruitmentReadiness(conversation.contact, inboundMessages);
      const alreadyClosed = (conversation.messages || []).some(
        (m) =>
          m.direction === "OUTBOUND" &&
          typeof m.text === "string" &&
          stripAccents(m.text).toLowerCase().includes("equipo revis"),
      );
      if (assessment.ready && !alreadyClosed) {
        const name =
          assessment.fields.name ||
          conversation.contact?.candidateName ||
          conversation.contact?.displayName ||
          null;
        const greeting = name ? `Gracias, ${name}.` : "Gracias.";
        const closingText =
          `${greeting} Ya tenemos los datos mínimos. ` +
          "El equipo revisará tu postulación y te contactará por este medio.";

        let sendResultRaw: SendResult = {
          success: false,
          error: "waId is missing",
        };
        if (waId) {
          sendResultRaw = await sendWhatsAppText(waId, closingText);
        }

        const normalizedSendResult = {
          success: sendResultRaw.success,
          messageId:
            "messageId" in sendResultRaw ? (sendResultRaw.messageId ?? null) : null,
          error: "error" in sendResultRaw ? (sendResultRaw.error ?? null) : null,
        };

        await prisma.message.create({
          data: {
            conversationId,
            direction: "OUTBOUND",
            text: closingText,
            rawPayload: serializeJson({
              autoReply: true,
              recruitmentClosure: true,
              sendResult: normalizedSendResult,
            }),
            timestamp: new Date(),
            read: true,
          },
        });

        return;
      }
    }

    const context = conversation.messages
      .map((m) =>
        m.direction === "INBOUND"
          ? `Candidato: ${m.text}`
          : `Agente: ${m.text}`,
      )
      .join("\n");

    let prompt = config.aiPrompt?.trim() || DEFAULT_AI_PROMPT;
    let model: string | undefined =
      normalizeModelId(config.aiModel?.trim() || DEFAULT_AI_MODEL) || DEFAULT_AI_MODEL;
    if (mode === "INTERVIEW") {
      prompt = config.interviewAiPrompt?.trim() || DEFAULT_INTERVIEW_AI_PROMPT;
      prompt = `${prompt}\n\n${INTERVIEW_AI_POLICY_ADDENDUM}\n\n` +
        "Instrucciones obligatorias de sistema: " +
        "No inventes direcciones; si te piden dirección exacta, responde que se enviará por este medio. " +
        "Cuando propongas o confirmes fecha/hora/lugar de entrevista, agrega al final un bloque <hunter_action>{\"type\":\"interview_update\",\"day\":\"<Día>\",\"time\":\"<HH:mm>\",\"location\":\"<Lugar>\",\"status\":\"<CONFIRMED|PENDING|CANCELLED>\"}</hunter_action>.";
      model =
        normalizeModelId(config.interviewAiModel?.trim() || DEFAULT_INTERVIEW_AI_MODEL) ||
        DEFAULT_INTERVIEW_AI_MODEL;
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

    // Notificación admin: reclutamiento listo cuando estamos en modo RECRUIT y se envía un mensaje de cierre
    const convoForNotif = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: true, messages: { orderBy: { timestamp: "desc" }, take: 5 } },
    });
    if (
      convoForNotif &&
      !convoForNotif.isAdmin &&
      convoForNotif.aiMode === "RECRUIT" &&
      suggestionText.toLowerCase().includes("equipo revisará")
    ) {
      const lastInbound = convoForNotif.messages?.find((m) => m.direction === "INBOUND");
      const summary = lastInbound?.text
        ? `Último mensaje: ${lastInbound.text.slice(0, 120)}`
        : "Datos mínimos recibidos.";
      await sendAdminNotification({
        app,
        eventType: "RECRUIT_READY",
        contact: convoForNotif.contact,
        summary,
      });
    }
  } catch (err) {
    app.log.error({ err, conversationId }, "Auto-reply processing failed");
  }
}

async function maybeNotifyRecruitmentReady(
  app: FastifyInstance,
  conversationId: string,
): Promise<void> {
  try {
    const convo = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        contact: true,
        messages: {
          orderBy: { timestamp: "desc" },
          take: 60,
        },
      },
    });
    if (!convo || convo.isAdmin) return;
    if (convo.contact?.noContact) return;
    if ((convo.aiMode || "RECRUIT") !== "RECRUIT") return;

    const messages = convo.messages || [];
    const hasClosureMessage = messages.some((m) => {
      if (m.direction !== "OUTBOUND") return false;
      if (!m.text) return false;
      return stripAccents(m.text).toLowerCase().includes("equipo revis");
    });
    if (!hasClosureMessage) return;

    const inboundMessages = messages.filter((m) => m.direction === "INBOUND");
    const assessment = assessRecruitmentReadiness(convo.contact, inboundMessages);
    if (!assessment.ready) return;

    await sendAdminNotification({
      app,
      eventType: "RECRUIT_READY",
      contact: convo.contact,
      summary: assessment.summary,
    });
  } catch (err) {
    app.log.warn({ err, conversationId }, "Recruitment readiness check failed");
  }
}

function assessRecruitmentReadiness(
  contact: any,
  inboundMessages: Array<{ text?: string | null; transcriptText?: string | null }>,
): {
  ready: boolean;
  summary: string;
  fields: {
    name: string | null;
    location: string | null;
    rut: string | null;
    experience: string | null;
    availability: string | null;
    email: string | null;
  };
} {
  const name =
    (contact?.candidateName && !isSuspiciousCandidateName(contact.candidateName)
      ? String(contact.candidateName)
      : null) ||
    (contact?.displayName && !isSuspiciousCandidateName(contact.displayName)
      ? String(contact.displayName)
      : null) ||
    null;

  const texts = inboundMessages
    .map((m) => (m.transcriptText || m.text || "").trim())
    .filter(Boolean);

  const rut = findFirstValue(texts, extractChileRut);
  const email = findFirstValue(texts, extractEmail);
  const location = findFirstValue(texts, extractLocation);
  const experience = findFirstValue(texts, extractExperienceSnippet);
  const availability = findFirstValue(texts, extractAvailabilitySnippet);

  const ready = Boolean(name && location && rut && experience && availability);

  const summaryLines = [
    name ? `Nombre: ${name}` : null,
    location ? `Comuna/Ciudad: ${location}` : null,
    rut ? `RUT: ${rut}` : null,
    experience ? `Experiencia: ${experience}` : null,
    availability ? `Disponibilidad: ${availability}` : null,
    email ? `Email: ${email}` : null,
  ].filter(Boolean) as string[];

  return {
    ready,
    summary: summaryLines.length > 0 ? summaryLines.join(" | ") : "Datos mínimos recibidos.",
    fields: { name, location, rut, experience, availability, email },
  };
}

function findFirstValue(
  texts: string[],
  extractor: (text: string) => string | null,
): string | null {
  for (const text of texts) {
    const value = extractor(text);
    if (value) return value;
  }
  return null;
}

function extractChileRut(text: string): string | null {
  if (!text) return null;
  const match =
    text.match(/\b\d{1,2}\.?\d{3}\.?\d{3}-?[\dkK]\b/) ||
    text.match(/\b\d{7,8}-?[\dkK]\b/);
  if (!match) return null;
  return match[0].toUpperCase();
}

function extractEmail(text: string): string | null {
  if (!text) return null;
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : null;
}

function extractLocation(text: string): string | null {
  if (!text) return null;
  const labelMatch = text.match(
    /\b(?:comuna|ciudad|localidad|sector|zona)\s*[:\-]\s*([A-Za-zÁÉÍÓÚáéíóúÑñ\s]{2,60})/i,
  );
  if (labelMatch?.[1]) {
    return normalizeName(labelMatch[1]) || labelMatch[1].trim();
  }
  const verbMatch = text.match(
    /\b(?:vivo|resido|soy)\s+(?:en|de)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ\s]{2,60})/i,
  );
  if (verbMatch?.[1]) {
    return normalizeName(verbMatch[1]) || verbMatch[1].trim();
  }
  return null;
}

function extractExperienceSnippet(text: string): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (/no tengo experiencia|sin experiencia/.test(lower)) return "sin experiencia";
  const yearsMatch = text.match(/\b(\d{1,2})\s*(?:año|años)\b/i);
  if (yearsMatch?.[1]) return `${yearsMatch[1]} años`;
  if (/experienc/.test(lower)) return "con experiencia";
  if (/trabaj|ventas/.test(lower)) return "menciona trabajo/ventas";
  return null;
}

function extractAvailabilitySnippet(text: string): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (/inmediata|inmediato/.test(lower)) return "inmediata";
  if (/disponibil/.test(lower)) return "menciona disponibilidad";
  if (/full\s*time|part\s*time/.test(lower)) return "full/part time";
  if (/turno|horario/.test(lower)) return "menciona horario";
  return null;
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
    if (media.type === "image" || media.type === "document") {
      const fallback =
        media.type === "image"
          ? "Recibimos tu imagen. Si es tu CV, por favor envía un PDF legible o texto con experiencia y disponibilidad."
          : "Recibimos tu archivo. Si es tu CV, asegúrate que sea legible en PDF y envía un resumen breve de experiencia y disponibilidad.";
      await prisma.message.update({
        where: { id: options.messageId },
        data: {
          transcriptText: fallback,
          text: fallback,
        },
      });
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
  config?: SystemConfig,
) {
  const updates: Record<string, string | null> = {};
  if (contact.candidateName && isSuspiciousCandidateName(contact.candidateName)) {
    updates.candidateName = null;
  }
  const display = normalizeName(profileName);
  if (display && display !== contact.displayName) {
    updates.displayName = display;
  }
  const existingCandidate = contact.candidateName?.trim() || null;
  const labeledParts = extractLabeledNameParts(fallbackText);
  const candidateFromLabels = buildCandidateNameFromLabels({
    existingCandidate,
    display,
    labeledParts,
  });
  const candidate = candidateFromLabels || extractNameFromText(fallbackText);
  if (candidate && isValidName(candidate) && !isSuspiciousCandidateName(candidate)) {
    const existing = existingCandidate;
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
  let currentCandidate = updates.candidateName ?? contact.candidateName ?? null;
  if (
    (!currentCandidate || isSuspiciousCandidateName(currentCandidate)) &&
    config &&
    shouldTryAiNameExtraction(fallbackText)
  ) {
    const aiName = await extractNameWithAi(fallbackText || "", config);
    if (aiName && isValidName(aiName) && !isSuspiciousCandidateName(aiName)) {
      updates.candidateName = aiName;
      if (!updates.name && !contact.name) {
        updates.name = aiName;
      }
      currentCandidate = aiName;
    }
  }
  if (
    currentCandidate &&
    !isSuspiciousCandidateName(currentCandidate) &&
    contact.candidateName &&
    contact.candidateName !== currentCandidate
  ) {
    updates.candidateName = currentCandidate;
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
    if (isValidName(normalized) && normalized && !containsDataLabel(normalized)) return normalized;
  }
  // pattern: "Ignacio, Santiago", take first part
  const firstChunk = cleaned.split(/[,;-]/)[0]?.trim();
  if (isValidName(firstChunk)) {
    const normalized = normalizeName(firstChunk);
    if (normalized && !containsDataLabel(normalized)) return normalized;
    return null;
  }
  if (
    /^[A-Za-zÁÉÍÓÚáéíóúÑñ\s]{2,60}$/i.test(cleaned) &&
    cleaned.split(/\s+/).filter(Boolean).length <= 4
  ) {
    const normalized = normalizeName(cleaned);
    if (isValidName(normalized) && normalized && !containsDataLabel(normalized)) return normalized;
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
  const blacklist = [
    "hola",
    "buenas",
    "buenos",
    "gracias",
    "ok",
    "vale",
    "hello",
    "hey",
    "hi",
    "confirmo",
    "postular",
  ];
  if (blacklist.includes(lower)) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 3) return false;
  if (!trimmed.includes(" ") && trimmed.length < 3) return false;
  return true;
}

function shouldTryAiNameExtraction(text?: string | null): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (/(me llamo|mi nombre|soy\s+[a-záéíóúñ])/i.test(lower)) return true;
  if (/nombre\s*[:\-]/i.test(lower)) return true;
  if (/,/.test(text)) return true;
  return false;
}

async function extractNameWithAi(text: string, config: SystemConfig): Promise<string | null> {
  const apiKey = getEffectiveOpenAiKey(config);
  if (!apiKey) return null;
  const client = new OpenAI({ apiKey });
  const model =
    normalizeModelId(config.aiModel?.trim() || DEFAULT_AI_MODEL) || DEFAULT_AI_MODEL;
  try {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Extrae el nombre propio del candidato solo si se identifica explícitamente (ej: \"me llamo X\", \"soy X\"). Devuelve JSON {\"full_name\": string|null, \"confidence\": number}. No inventes ni supongas; si no hay nombre claro, usa null.",
        },
        { role: "user", content: text },
      ],
      max_tokens: 60,
      response_format: { type: "json_object" },
    });
    const raw = completion.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(raw);
    const fullName: string | null = parsed?.full_name || parsed?.name || null;
    const confidence: number = typeof parsed?.confidence === "number" ? parsed.confidence : 0;
    if (!fullName || confidence < 0.4) return null;
    const normalized = normalizeName(fullName);
    if (!normalized || !isValidName(normalized) || isSuspiciousCandidateName(normalized)) {
      return null;
    }
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 3) return null;
    return normalized;
  } catch (err) {
    console.warn("AI name extraction failed", err);
  }
  return null;
}

function isSuspiciousCandidateName(value?: string | null): boolean {
  if (!value) return true;
  if (containsDataLabel(value)) return true;
  const lower = stripAccents(value).toLowerCase();
  // Never treat intent/commands as names (prevents candidateName degradation).
  if (/\b(cancelar|cancelacion|cancelación|reagend|reagendar|reprogram|reprogramar|cambiar|cambio|modificar|mover)\b/.test(lower)) {
    return true;
  }
  if (/\b(entrevista|hora|horario|reagendar|reagendemos|reagenden)\b/.test(lower) && /\b(cancelar|cambiar|reagend|reprogram|mover)\b/.test(lower)) {
    return true;
  }
  const patterns = [
    "hola quiero postular",
    "hola",
    "quiero postular",
    "postular",
    "no puedo",
    "no me sirve",
    "confirmo",
    "medio dia",
    "mediodia",
    "confirmar",
    "gracias",
    "inmediata",
    "inmediato",
    "toda esa informacion",
    "toda esa información",
  ];
  if (patterns.some(p => lower.includes(p))) return true;
  if (/(lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)/i.test(value)) return true;
  if (/medio ?d[ií]a/i.test(value)) return true;
  if (/\b\d{1,2}:\d{2}\b/.test(value)) return true;
  return false;
}

function containsDataLabel(value: string): boolean {
  const lowered = stripAccents(value).toLowerCase();
  const labels = [
    "apellido",
    "apellidos",
    "nombre",
    "nombres",
    "comuna",
    "ciudad",
    "region",
    "rut",
    "run",
    "correo",
    "email",
    "mail",
    "disponibilidad",
    "experiencia",
    "edad",
    "telefono",
    "celular",
    "direccion",
  ];
  return labels.some((label) => new RegExp(`\\b${label}\\b`, "i").test(lowered));
}

function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function extractLabeledNameParts(text?: string): { givenName: string | null; familyName: string | null } {
  if (!text) return { givenName: null, familyName: null };
  const givenName = extractLabeledNameValue(text, ["nombre", "nombres"], 3);
  const familyName = extractLabeledNameValue(text, ["apellido", "apellidos"], 3);
  return { givenName, familyName };
}

function extractLabeledNameValue(text: string, labels: string[], maxWords: number): string | null {
  const labelPattern = new RegExp(`(?:^|\\b)(?:${labels.join("|")})\\s*[:\\-]?\\s*`, "i");
  const match = labelPattern.exec(text);
  if (!match) return null;
  const start = match.index + match[0].length;
  const remainder = text.slice(start);
  const firstChunk = remainder.split(/[\n,;|]/)[0] || "";
  if (!firstChunk.trim()) return null;
  const tokens = firstChunk
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ]/g, ""))
    .filter(Boolean);
  const stopWords = new Set(
    [
      "rut",
      "run",
      "correo",
      "email",
      "mail",
      "comuna",
      "ciudad",
      "region",
      "dirección",
      "direccion",
      "telefono",
      "teléfono",
      "celular",
      "experiencia",
      "disponibilidad",
      "edad",
    ].map((w) => stripAccents(w).toLowerCase()),
  );
  const accepted: string[] = [];
  for (const token of tokens) {
    const normalized = stripAccents(token).toLowerCase();
    if (!normalized) continue;
    if (stopWords.has(normalized)) break;
    accepted.push(token);
    if (accepted.length >= maxWords) break;
  }
  const candidate = accepted.join(" ").trim();
  if (!candidate) return null;
  const normalizedCandidate = normalizeName(candidate);
  if (!normalizedCandidate || !isValidName(normalizedCandidate) || containsDataLabel(normalizedCandidate)) {
    return null;
  }
  return normalizedCandidate;
}

function buildCandidateNameFromLabels(params: {
  existingCandidate: string | null;
  display: string | null;
  labeledParts: { givenName: string | null; familyName: string | null };
}): string | null {
  const { existingCandidate, display, labeledParts } = params;
  const givenName = labeledParts.givenName;
  const familyName = labeledParts.familyName;
  if (givenName && familyName) {
    const merged = normalizeName(`${givenName} ${familyName}`);
    return merged && isValidName(merged) && !isSuspiciousCandidateName(merged) ? merged : null;
  }

  if (givenName && !familyName) {
    const normalized = normalizeName(givenName);
    if (!normalized || !isValidName(normalized) || isSuspiciousCandidateName(normalized)) {
      return null;
    }
    if (!existingCandidate) return normalized;
    const existingNormalized = normalizeName(existingCandidate);
    if (!existingNormalized || isSuspiciousCandidateName(existingNormalized)) return normalized;
    return null;
  }

  if (!familyName) return null;

  const existingNormalized = existingCandidate ? normalizeName(existingCandidate) : null;
  if (existingNormalized && !isSuspiciousCandidateName(existingNormalized)) {
    const words = existingNormalized.split(/\s+/).filter(Boolean);
    if (words.length === 1) {
      const merged = normalizeName(`${existingNormalized} ${familyName}`);
      return merged && isValidName(merged) && !isSuspiciousCandidateName(merged) ? merged : null;
    }
  }

  if (display && !existingNormalized) {
    const displayWords = display.split(/\s+/).filter(Boolean);
    if (displayWords.length === 1) {
      const merged = normalizeName(`${display} ${familyName}`);
      return merged && isValidName(merged) && !isSuspiciousCandidateName(merged) ? merged : null;
    }
  }

  return null;
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
  app: FastifyInstance,
  conversationId: string,
  text: string,
): Promise<void> {
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { contact: true },
  });
  if (!convo || !convo.contact?.waId) return;
  const isInterviewContext =
    convo.aiMode === "INTERVIEW" ||
    Boolean(convo.interviewDay || convo.interviewTime || convo.interviewLocation || convo.interviewStatus);
  if (!isInterviewContext) return;

  const lower = text.toLowerCase();
  const updates: Record<string, string | null> = {};
  let statusUpdate: string | null = null;

  const isYes =
    /\bconfirm(o|ar)?\b/.test(lower) ||
    /^(si|sí|ok|dale|listo|perfecto)\b/.test(lower) ||
    /\b(me sirve|de acuerdo)\b/.test(lower);
  const isNo =
    /\bno (puedo|sirve|voy|asistir|ir)\b/.test(lower) ||
    /^no\s*[,!.?¿¡]*\s*$/.test(lower) ||
    /^no\b(?!\s+tengo\b)/.test(lower);

  if (isYes) {
    statusUpdate = "CONFIRMED";
  } else if (isNo) {
    statusUpdate = "CANCELLED";
  }

  const parsed = parseDayTime(text);
  if (parsed.day) updates.interviewDay = parsed.day;
  if (parsed.time) updates.interviewTime = parsed.time;

  if (statusUpdate) {
    updates.interviewStatus = statusUpdate;
  }

  if (Object.keys(updates).length === 0) return;
  await applyConversationInterviewUpdate(convo.contact.waId, updates, {
    byConversationId: conversationId,
    app,
  });
}

function parseDayTime(text: string): { day: string | null; time: string | null } {
  const dayMatch = text.match(
    /(lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)/i,
  );
  const wordTimeMatch = text.match(/\b(una|once|diez|nueve|ocho|siete|seis|cinco|cuatro|tres|dos)\b/i);
  const timeMatch = text.match(
    /\b(\d{1,2})(?:[:\s](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i,
  );
  let time: string | null = null;
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    if (hour > 23 || minutes > 59) {
      return { day: dayMatch ? capitalize(dayMatch[1]) : null, time: null };
    }
    const suffix = timeMatch[3]?.toLowerCase();
    if (suffix?.includes("p") && hour < 12) hour += 12;
    if (suffix?.includes("a") && hour === 12) hour = 0;
    if (!suffix && hour >= 1 && hour <= 7) hour += 12;
    const hh = hour.toString().padStart(2, "0");
    const mm = minutes.toString().padStart(2, "0");
    time = `${hh}:${mm}`;
  } else if (/medio ?d[ií]a/i.test(text)) {
    time = "12:00";
  } else if (wordTimeMatch) {
    const map: Record<string, string> = {
      una: "13:00",
      once: "11:00",
      diez: "10:00",
      nueve: "09:00",
      ocho: "20:00",
      siete: "19:00",
      seis: "18:00",
      cinco: "17:00",
      cuatro: "16:00",
      tres: "15:00",
      dos: "14:00",
    };
    const key = wordTimeMatch[1].toLowerCase();
    time = map[key] || null;
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
      createdAt: number;
      updatedAt: number;
      needsConfirmation: boolean;
      reminderSentAt?: number | null;
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
      createdAt: number;
      updatedAt: number;
      needsConfirmation: boolean;
      reminderSentAt?: number | null;
    }
  | {
      type: "send_template";
      targetWaId: string;
      templateName: string;
      variables?: string[];
      templateLanguageCode?: string | null;
      relatedConversationId?: string | null;
      mode?: "RECRUIT" | "INTERVIEW" | "OFF";
      awaiting: "confirm";
      createdAt: number;
      updatedAt: number;
      needsConfirmation: boolean;
      draftText?: string | null;
      reminderSentAt?: number | null;
    }
  | {
      type: "send_message";
      targetWaId: string;
      text: string;
      relatedConversationId?: string | null;
      awaiting: "confirm";
      createdAt: number;
      updatedAt: number;
      needsConfirmation: boolean;
      reminderSentAt?: number | null;
    }
  | {
      type: "reactivate";
      targetWaId: string | null;
      awaiting: "confirm";
      createdAt: number;
      updatedAt: number;
      needsConfirmation: boolean;
      reminderSentAt?: number | null;
    }
  | {
      type: "reset_chat";
      targetWaId: string | null;
      awaiting: "confirm";
      createdAt: number;
      updatedAt: number;
      needsConfirmation: boolean;
      reminderSentAt?: number | null;
    };

function parseAdminPendingAction(raw?: string | null): AdminPendingAction | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.type === "string") {
      if (!parsed.createdAt) {
        parsed.createdAt = Date.now();
      }
      if (!parsed.updatedAt) {
        parsed.updatedAt = parsed.createdAt;
      }
      if (typeof parsed.needsConfirmation === "undefined") {
        parsed.needsConfirmation = true;
      }
      if (typeof parsed.reminderSentAt === "undefined") {
        parsed.reminderSentAt = null;
      }
      return parsed as AdminPendingAction;
    }
  } catch {
    return null;
  }
  return null;
}

async function saveAdminPendingAction(conversationId: string, action: AdminPendingAction | null) {
  if (action) {
    action.updatedAt = Date.now();
  }
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { adminPendingAction: action ? JSON.stringify(action) : null },
  });
}

function isConfirmSend(text: string): boolean {
  const normalized = text.toLowerCase();
  return /confirmar\s*env[ií]o/.test(normalized);
}

function isCancelPending(text: string): boolean {
  const normalized = text.toLowerCase();
  return /(cancelar|anular|olvidar)/.test(normalized);
}

async function refreshPendingBeforeSend(action: AdminPendingAction, text: string, logger: any) {
  if (action.type !== "send_template") return;
  const config = await getSystemConfig();
  const templates = await loadTemplateConfig(logger);
  const parsed = parseLooseSchedule(text.toLowerCase());
  if (parsed && action.mode === "INTERVIEW" && (parsed.day || parsed.time || parsed.location)) {
    await applyConversationInterviewUpdate(action.targetWaId, {
      interviewDay: parsed.day,
      interviewTime: parsed.time,
      interviewLocation: parsed.location,
      interviewStatus: "PENDING",
    });
  }
  const convo = await fetchConversationByIdentifier(action.targetWaId, { includeMessages: false });
  const finalVars = resolveTemplateVariables(
    action.templateName,
    action.variables,
    templates,
    {
      interviewDay: convo?.interviewDay,
      interviewTime: convo?.interviewTime,
      interviewLocation: convo?.interviewLocation,
    },
  );
  action.variables = finalVars;
  action.relatedConversationId = convo?.id || action.relatedConversationId || null;
}

async function executePendingAction(params: {
  app: FastifyInstance;
  adminConversationId: string;
  adminWaId: string;
  pendingAction: AdminPendingAction;
}): Promise<boolean> {
  const { pendingAction, app, adminConversationId, adminWaId } = params;
  if (pendingAction.targetWaId && pendingAction.type !== "reactivate") {
    const candidates = buildWaIdCandidates(pendingAction.targetWaId);
    const contact = await prisma.contact.findFirst({
      where: {
        OR: [
          { waId: { in: candidates } },
          { phone: { in: candidates } },
        ],
      },
    });
    if (contact?.noContact) {
      await sendAdminReply(
        app,
        adminConversationId,
        adminWaId,
        `No puedo enviar a +${pendingAction.targetWaId}: contacto marcado NO_CONTACTAR.`,
      );
      await saveAdminPendingAction(adminConversationId, null);
      return true;
    }
  }
  if (pendingAction.type === "send_template") {
    try {
      const within24 = await isCandidateWithin24h(pendingAction.targetWaId);
      if (within24) {
        const simpleDraft = await buildSimpleInterviewMessage(
          pendingAction.targetWaId,
          app.log,
        );
        if (simpleDraft) {
          const targetConvo =
            pendingAction.relatedConversationId ||
            (await fetchConversationByIdentifier(pendingAction.targetWaId, {
              includeMessages: false,
            }))?.id ||
            null;
          const sendResult = await sendWhatsAppText(pendingAction.targetWaId, simpleDraft);
          if (sendResult.success && targetConvo) {
            await prisma.message.create({
              data: {
                conversationId: targetConvo,
                direction: "OUTBOUND",
                text: simpleDraft,
                rawPayload: serializeJson({ adminSend: true, sendResult }),
                timestamp: new Date(),
                read: true,
              },
            });
          }
          await saveAdminPendingAction(adminConversationId, null);
          await sendAdminReply(
            app,
            adminConversationId,
            adminWaId,
            `Mensaje simple enviado a +${pendingAction.targetWaId} (dentro de 24h).`,
          );
          return true;
        }
      }
      const mode =
        pendingAction.mode ||
        (pendingAction.templateName?.includes("entrevista") ? "INTERVIEW" : "RECRUIT");
      const result = await createConversationAndMaybeSend({
        phoneE164: pendingAction.targetWaId,
        mode,
        status: "OPEN",
        sendTemplateNow: true,
        variables: pendingAction.variables,
        templateNameOverride: pendingAction.templateName,
      });
      const success = result.sendResult?.success;
      if (success) {
        await prisma.conversation.updateMany({
          where: { isAdmin: true },
          data: { adminLastCandidateWaId: pendingAction.targetWaId },
        });
        await saveAdminPendingAction(adminConversationId, null);
        await sendAdminReply(
          app,
          adminConversationId,
          adminWaId,
          `Plantilla ${pendingAction.templateName} enviada a +${pendingAction.targetWaId}.`,
        );
      } else {
        await sendAdminReply(
          app,
          adminConversationId,
          adminWaId,
          `No se pudo enviar a +${pendingAction.targetWaId}: ${
            result.sendResult?.error || "Error"
          }`,
        );
      }
      return true;
    } catch (err: any) {
      app.log.error({ err, pendingAction }, "Error ejecutando envío pendiente");
      await sendAdminReply(
        app,
        adminConversationId,
        adminWaId,
        `Error al enviar: ${err?.message || "No se pudo ejecutar el envío pendiente"}`,
      );
      return true;
    }
  }
  if (pendingAction.type === "send_message") {
    try {
      const sendResult = await sendWhatsAppText(pendingAction.targetWaId, pendingAction.text);
      if (sendResult.success) {
        if (pendingAction.relatedConversationId) {
          await prisma.message.create({
            data: {
              conversationId: pendingAction.relatedConversationId,
              direction: "OUTBOUND",
              text: pendingAction.text,
              rawPayload: serializeJson({ adminSend: true, sendResult }),
              timestamp: new Date(),
              read: true,
            },
          });
        }
        await saveAdminPendingAction(adminConversationId, null);
        await sendAdminReply(
          app,
          adminConversationId,
          adminWaId,
          `Mensaje enviado a +${pendingAction.targetWaId}.`,
        );
      } else {
        await sendAdminReply(
          app,
          adminConversationId,
          adminWaId,
          `No se pudo enviar a +${pendingAction.targetWaId}: ${
            (sendResult as any).error || "Error"
          }`,
        );
      }
      return true;
    } catch (err: any) {
      app.log.error({ err, pendingAction }, "Error ejecutando mensaje pendiente");
      await sendAdminReply(
        app,
        adminConversationId,
        adminWaId,
        `Error al enviar mensaje: ${err?.message || "No se pudo enviar"}`,
      );
      return true;
    }
  }
  if (pendingAction.type === "interview_update") {
    if (!pendingAction.targetWaId) return false;
    try {
      await applyConversationInterviewUpdate(pendingAction.targetWaId, pendingAction.updates, {
        app,
      });
      const templates = await loadTemplateConfig(app.log);
      const templateName =
        templates.templateInterviewInvite || DEFAULT_TEMPLATE_INTERVIEW_INVITE;
      const result = await createConversationAndMaybeSend({
        phoneE164: pendingAction.targetWaId,
        mode: "INTERVIEW",
        status: "OPEN",
        sendTemplateNow: true,
        variables: [],
        templateNameOverride: templateName,
      });
      if (result.sendResult?.success) {
        await saveAdminPendingAction(adminConversationId, null);
        await sendAdminReply(
          app,
          adminConversationId,
          adminWaId,
          `Entrevista actualizada y plantilla ${templateName} enviada a +${pendingAction.targetWaId}.`,
        );
      } else {
        await sendAdminReply(
          app,
          adminConversationId,
          adminWaId,
          `Entrevista actualizada, pero no se pudo enviar la plantilla: ${
            result.sendResult?.error || "Error"
          }`,
        );
      }
      return true;
    } catch (err: any) {
      app.log.error({ err, pendingAction }, "Error ejecutando entrevista pendiente");
      await sendAdminReply(
        app,
        adminConversationId,
        adminWaId,
        `Error al actualizar/enviar: ${err?.message || "No se pudo completar la acción"}`,
      );
      return true;
    }
  }
  if (pendingAction.type === "reactivate") {
    const waId = pendingAction.targetWaId;
    if (!waId) return true;
    try {
      const candidates = buildWaIdCandidates(waId);
      const contacts = await prisma.contact.findMany({
        where: {
          OR: [
            { waId: { in: candidates } },
            { phone: { in: candidates } },
          ],
        },
      });
      const contactIds = contacts.map((c) => c.id);
      if (contactIds.length === 0) {
        await sendAdminReply(app, adminConversationId, adminWaId, `No encontré el contacto +${waId}.`);
        await saveAdminPendingAction(adminConversationId, null);
        return true;
      }
      await prisma.contact.updateMany({
        where: { id: { in: contactIds } },
        data: { noContact: false, noContactAt: null, noContactReason: null },
      });
      await prisma.conversation.updateMany({
        where: { contactId: { in: contactIds } },
        data: { aiPaused: false },
      });
      await saveAdminPendingAction(adminConversationId, null);
      await sendAdminReply(
        app,
        adminConversationId,
        adminWaId,
        `Contacto +${waId} reactivado. Puedes volver a enviar mensajes.`,
      );
    } catch (err: any) {
      app.log.error({ err }, "Reactivar contacto fallo");
      await sendAdminReply(app, adminConversationId, adminWaId, "No se pudo reactivar el contacto.");
    }
    return true;
  }
  if (pendingAction.type === "reset_chat") {
    const target = pendingAction.targetWaId;
    if (!target) return true;
    const config = await getSystemConfig();
    const configuredTest = config.testPhoneNumber ? normalizeWhatsAppId(config.testPhoneNumber) : null;
    if (!configuredTest || target !== configuredTest) {
      await sendAdminReply(
        app,
        adminConversationId,
        adminWaId,
        "Acción bloqueada: reset permitido solo para el número de pruebas configurado.",
      );
      await saveAdminPendingAction(adminConversationId, null);
      return true;
    }
    const candidates = buildWaIdCandidates(target);
    const contacts = await prisma.contact.findMany({
      where: {
        OR: [
          { waId: { in: candidates } },
          { phone: { in: candidates } },
        ],
      },
    });
    if (contacts.length === 0) {
      await sendAdminReply(
        app,
        adminConversationId,
        adminWaId,
        `No encontré el contacto +${target}. Igual dejé el chat de pruebas limpio.`,
      );
      await saveAdminPendingAction(adminConversationId, null);
      return true;
    }
    const contactIds = contacts.map((c) => c.id);
    const conversations = await prisma.conversation.findMany({
      where: { contactId: { in: contactIds } },
      select: { id: true },
    });
    const conversationIds = conversations.map((c) => c.id);
    await prisma.$transaction(async (tx) => {
      if (conversationIds.length > 0) {
        await tx.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
        await tx.conversation.deleteMany({ where: { id: { in: conversationIds } } });
      }
      await tx.application.deleteMany({ where: { contactId: { in: contactIds } } });
      await tx.contact.deleteMany({ where: { id: { in: contactIds } } });
    });
    await saveAdminPendingAction(adminConversationId, null);
    await sendAdminReply(
      app,
      adminConversationId,
      adminWaId,
      `Conversación de +${target} reiniciada solo para pruebas.`,
    );
    return true;
  }
  return false;
}

async function handleAdminPendingAction(
  app: FastifyInstance,
  adminConversationId: string,
  lastCandidateWaId: string | null,
  text: string,
  adminWaId: string,
  config: SystemConfig,
): Promise<boolean> {
  const trimmed = text.trim().toLowerCase();
  const adminConvo = await prisma.conversation.findUnique({
    where: { id: adminConversationId },
    select: { adminPendingAction: true },
  });
  const pending = parseAdminPendingAction(adminConvo?.adminPendingAction);
  if (pending && isCancelPending(trimmed)) {
    await saveAdminPendingAction(adminConversationId, null);
    await sendAdminReply(app, adminConversationId, adminWaId, "Acción pendiente cancelada.");
    return true;
  }
  if (
    pending &&
    pending.needsConfirmation &&
    (isConfirmSend(trimmed) || /^(si|sí|ok|dale|confirmo)/i.test(trimmed))
  ) {
    await refreshPendingBeforeSend(pending, text, app.log);
    const executed = await executePendingAction({
      app,
      adminConversationId,
      adminWaId,
      pendingAction: pending,
    });
    return executed;
  }

  if (
    pending &&
    pending.type === "send_template" &&
    /mensaje simple|sin plantilla|no plantilla|solo mensaje|mensaje directo/.test(trimmed)
  ) {
    const within24h = await isCandidateWithin24h(pending.targetWaId);
    if (!within24h) {
      await sendAdminReply(
        app,
        adminConversationId,
        adminWaId,
        "Fuera de ventana 24h: solo puedo enviar plantilla. Responde CONFIRMAR ENVÍO para enviar la plantilla o CANCELAR para anular."
      );
      return true;
    }
    const simpleDraft = await buildSimpleInterviewMessage(pending.targetWaId, app.log);
    if (!simpleDraft) {
      await sendAdminReply(
        app,
        adminConversationId,
        adminWaId,
        "No encontré datos suficientes para armar el mensaje simple. Indícame día/hora/lugar o envía CONFIRMAR ENVÍO para la plantilla."
      );
      return true;
    }
    const action: AdminPendingAction = {
      type: "send_message",
      targetWaId: pending.targetWaId,
      text: simpleDraft,
      relatedConversationId: pending.relatedConversationId,
      awaiting: "confirm",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      needsConfirmation: true,
      reminderSentAt: null,
    };
    await saveAdminPendingAction(adminConversationId, action);
    await sendAdminReply(
      app,
      adminConversationId,
      adminWaId,
      `Borrador de mensaje simple:\n${simpleDraft}\n\nResponde CONFIRMAR ENVÍO para enviarlo o CANCELAR para anular.`
    );
    return true;
  }

  if (!pending) {
    const trimmedNormalized = stripAccents(trimmed).toLowerCase();
    const reactivateIntent =
      /\b(reactivar|reactiva|habilitar|habilita|permitir|permite|activar|activa|desbloquear|desbloquea|quitar|quita|sacar|saca|levantar|levanta|remover|remove)\b/.test(
        trimmedNormalized,
      ) &&
      /\b(no\s*contactar|no\s*contacto|contacto|contactar|n[uú]mero|numero|whatsapp|bloqueo|bloquead[oa])\b/.test(
        trimmedNormalized,
      );
    if (reactivateIntent) {
      const target = extractWaIdFromText(text) || lastCandidateWaId;
      if (!target) {
        await sendAdminReply(
          app,
          adminConversationId,
          adminWaId,
          "Indica el número que deseas reactivar (ej: +569...).",
        );
        return true;
      }
      await saveAdminPendingAction(adminConversationId, {
        type: "reactivate",
        targetWaId: target,
        awaiting: "confirm",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        needsConfirmation: true,
        reminderSentAt: null,
      });
      await sendAdminReply(
        app,
        adminConversationId,
        adminWaId,
        `¿Confirmas reactivar el contacto +${target}? Responde CONFIRMAR ENVÍO para proceder o CANCELAR para anular.`,
      );
      return true;
    }

    const resetIntent = /(reset|reiniciar|borrar).*conversaci[oó]n|reset chat/i.test(trimmed);
    if (resetIntent) {
      const configuredTest = config.testPhoneNumber ? normalizeWhatsAppId(config.testPhoneNumber) : null;
      const target =
        extractWaIdFromText(text) ||
        configuredTest;
      if (!configuredTest) {
        await sendAdminReply(
          app,
          adminConversationId,
          adminWaId,
          "No hay número de pruebas configurado. Ve a Configuración → Plantillas y define 'testPhoneNumber'.",
        );
        return true;
      }
      if (!target || target !== configuredTest) {
        await sendAdminReply(
          app,
          adminConversationId,
          adminWaId,
          `Solo puedo resetear el chat del número de pruebas configurado (+${configuredTest}).`,
        );
        return true;
      }
      await saveAdminPendingAction(adminConversationId, {
        type: "reset_chat",
        targetWaId: target,
        awaiting: "confirm",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        needsConfirmation: true,
        reminderSentAt: null,
      });
      await sendAdminReply(
        app,
        adminConversationId,
        adminWaId,
        `¿Confirmas resetear SOLO el chat de pruebas (+${target})? Responde CONFIRMAR ENVÍO para proceder o CANCELAR para anular.`,
      );
      return true;
    }
  }

  const statusFromText = detectStatusKeyword(trimmed);
  if (!pending && !statusFromText && /estado/.test(trimmed)) {
    await saveAdminPendingAction(adminConversationId, {
      type: "status",
      targetWaId: lastCandidateWaId || null,
      awaiting: "status",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      needsConfirmation: false,
    });
    await sendAdminReply(
      app,
      adminConversationId,
      adminWaId,
      "¿Qué estado deseas dejar? (Nuevo/Seguimiento/Cerrado)",
    );
    return true;
  }

  if (!pending && lastCandidateWaId && /fecha guardada|confirmar entrevista|mensaje.*entrevista|usa ese texto/.test(trimmed)) {
    const prep = await buildInterviewTemplatePending(lastCandidateWaId, app.log);
    if (prep) {
      await saveAdminPendingAction(adminConversationId, prep.action);
      await prisma.conversation.update({
        where: { id: adminConversationId },
        data: { adminLastCandidateWaId: lastCandidateWaId },
      });
      await sendAdminReply(app, adminConversationId, adminWaId, prep.preview);
      return true;
    }
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
      await applyConversationInterviewUpdate(pending.targetWaId, pending.updates, { app });
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
    await applyConversationInterviewUpdate(
      lastCandidateWaId,
      {
        interviewDay: parsedInterview.day,
        interviewTime: parsedInterview.time,
        interviewLocation: parsedInterview.location,
        interviewStatus: "PENDING",
      },
      { app },
    );
    const convo = await fetchConversationByIdentifier(lastCandidateWaId, { includeMessages: false });
    const templates = await loadTemplateConfig(app.log);
    const templateName = templates.templateInterviewInvite || DEFAULT_TEMPLATE_INTERVIEW_INVITE;
    await prisma.conversation.update({
      where: { id: adminConversationId },
      data: { adminLastCandidateWaId: lastCandidateWaId },
    });
    await saveAdminPendingAction(adminConversationId, {
      type: "send_template",
      targetWaId: lastCandidateWaId,
      templateName,
      variables: [],
      templateLanguageCode: templates.templateLanguageCode || null,
      relatedConversationId: convo?.id || null,
      awaiting: "confirm",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      needsConfirmation: true,
      mode: "INTERVIEW",
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
  const normalized = stripAccents(text || "").toLowerCase();
  if (!/entrevista|entrevistad|agenda|agendar|coordinar/.test(normalized)) return null;
  const { day, time } = parseDayTime(normalized);
  let location: string | null = null;
  const locMatch = normalized.match(
    /en\s+([a-z0-9\s,.-]{3,80}?)(?:\s+para\b.*)?$/i,
  );
  if (locMatch) {
    location = normalizeInterviewLocation(locMatch[1]);
  }
  if (!day && !time && !location) return null;
  return { day, time, location };
}

function normalizeInterviewLocation(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value
    .replace(/\s+/g, " ")
    .replace(/^[,.\-–—\s]+/, "")
    .replace(/[,.\-–—\s]+$/, "")
    .trim();
  if (!trimmed) return null;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return words
    .map((word) => {
      if (!word) return word;
      const first = word.charAt(0);
      const rest = word.slice(1);
      if (/[a-z]/i.test(first)) {
        return `${first.toUpperCase()}${rest}`;
      }
      return word;
    })
    .join(" ");
}

async function buildInterviewTemplatePending(targetWaId: string, logger: any): Promise<{ action: AdminPendingAction; preview: string } | null> {
  const convo = await fetchConversationByIdentifier(targetWaId, { includeMessages: false });
  if (!convo) return null;
  const templates = await loadTemplateConfig(logger);
  const templateName = templates.templateInterviewInvite || DEFAULT_TEMPLATE_INTERVIEW_INVITE;
  const variables = resolveTemplateVariables(templateName, [], templates, {
    interviewDay: convo.interviewDay,
    interviewTime: convo.interviewTime,
    interviewLocation: convo.interviewLocation,
  });
  const preview = [
    `Destino: +${targetWaId}`,
    `Plantilla: ${templateName}`,
    `Vars: {{1}}=${variables[0] || "día"}, {{2}}=${variables[1] || "hora"}, {{3}}=${variables[2] || "lugar"}`,
    'Responde CONFIRMAR ENVÍO para enviarla o CANCELAR para anular.'
  ].join('\n');
  return {
    action: {
      type: "send_template",
      targetWaId,
      templateName,
      variables,
      templateLanguageCode: templates.templateLanguageCode || null,
      relatedConversationId: convo.id,
      awaiting: "confirm",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      needsConfirmation: true,
      mode: "INTERVIEW",
    },
    preview,
  };
}

async function buildSimpleInterviewMessage(targetWaId: string, logger: any): Promise<string | null> {
  const convo = await fetchConversationByIdentifier(targetWaId, { includeMessages: false });
  if (!convo) return null;
  const templates = await loadTemplateConfig(logger);
  const day = convo.interviewDay || templates.defaultInterviewDay || "día por definir";
  const time = convo.interviewTime || templates.defaultInterviewTime || "hora por definir";
  const location = convo.interviewLocation || templates.defaultInterviewLocation || "Te enviaremos la dirección exacta por este medio.";
  return `Hola, queremos coordinar tu entrevista para ${day} a las ${time} en ${location}. ¿Puedes? Responde sí/no y si no te acomoda, propón 2 alternativas de día y hora.`;
}

async function isCandidateWithin24h(waId: string): Promise<boolean> {
  const convo = await fetchConversationByIdentifier(waId, { includeMessages: true });
  if (!convo || !convo.messages) return true;
  const lastInbound = convo.messages
    .filter((m: any) => m.direction === "INBOUND")
    .sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
  if (!lastInbound) return true;
  const diff = Date.now() - new Date(lastInbound.timestamp).getTime();
  return diff <= 24 * 60 * 60 * 1000;
}

function parseLooseSchedule(text: string): { day: string | null; time: string | null; location: string | null } | null {
  const { day, time } = parseDayTime(text);
  let location: string | null = null;
  const locMatch = text.match(/en\s+([A-Za-zÁÉÍÓÚáéíóúÑñ0-9\s,.-]{3,60})/i);
  if (locMatch) {
    location = locMatch[1].trim();
  }
  if (!day && !time && !location) return null;
  return { day, time, location };
}

async function applyConversationInterviewUpdate(
  waId: string,
  updates: { interviewDay?: string | null; interviewTime?: string | null; interviewLocation?: string | null; interviewStatus?: string | null },
  opts?: { byConversationId?: string; app?: FastifyInstance },
) {
  let convo = opts?.byConversationId
    ? await prisma.conversation.findUnique({
        where: { id: opts.byConversationId },
        include: { contact: true },
      })
    : await fetchConversationByIdentifier(waId, { includeMessages: false });
  if (!convo) return;
  const previous = {
    interviewDay: convo.interviewDay || null,
    interviewTime: convo.interviewTime || null,
    interviewLocation: convo.interviewLocation || null,
    interviewStatus: convo.interviewStatus || null,
  };
  const nextStatus =
    typeof updates.interviewStatus !== "undefined"
      ? updates.interviewStatus
      : convo.interviewStatus ||
        ((updates.interviewDay || updates.interviewTime || updates.interviewLocation) ? "PENDING" : null);
  const data: any = {
    aiMode: !convo.isAdmin ? "INTERVIEW" : convo.aiMode,
    interviewDay:
      typeof updates.interviewDay !== "undefined" ? updates.interviewDay : convo.interviewDay,
    interviewTime:
      typeof updates.interviewTime !== "undefined" ? updates.interviewTime : convo.interviewTime,
    interviewLocation:
      typeof updates.interviewLocation !== "undefined"
        ? updates.interviewLocation
        : convo.interviewLocation,
    interviewStatus: nextStatus,
  };
  if (!convo.isAdmin && (nextStatus === "CONFIRMED" || updates.interviewDay || updates.interviewTime)) {
    data.status = "OPEN";
  }
  await prisma.conversation.update({
    where: { id: convo.id },
    data,
  });

  if (opts?.app && convo.contact && !convo.isAdmin) {
    const scheduleChanged =
      (data.interviewDay || null) !== previous.interviewDay ||
      (data.interviewTime || null) !== previous.interviewTime ||
      (data.interviewLocation || null) !== previous.interviewLocation;
    const statusBecameConfirmed =
      nextStatus === "CONFIRMED" && previous.interviewStatus !== "CONFIRMED";
    const hasCompleteSchedule = Boolean(data.interviewDay && data.interviewTime);

    if (statusBecameConfirmed) {
      await sendAdminNotification({
        app: opts.app,
        eventType: "INTERVIEW_CONFIRMED",
        contact: convo.contact,
        interviewDay: data.interviewDay,
        interviewTime: data.interviewTime,
        interviewLocation: data.interviewLocation,
      });
    } else if (scheduleChanged && nextStatus !== "CONFIRMED" && hasCompleteSchedule) {
      await sendAdminNotification({
        app: opts.app,
        eventType: "INTERVIEW_SCHEDULED",
        contact: convo.contact,
        interviewDay: data.interviewDay,
        interviewTime: data.interviewTime,
        interviewLocation: data.interviewLocation,
      });
    }
  }
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

function isOptOutText(text: string): boolean {
  const lower = stripAccents(text).toLowerCase();
  // NO_CONTACTAR only for explicit opt-out / compliance intent.
  if (/\b(stop|unsubscribe)\b/.test(lower)) return true;
  if (/no me envien mas|no me escriban mas|no quiero recibir( mas)? mensajes/.test(lower)) return true;
  if (/no quiero que me escriban|no quiero que me contacten/.test(lower)) return true;
  if (/darme de baja|darse de baja|quiero darme de baja/.test(lower)) return true;
  if (/borrar mis datos|eliminar mis datos/.test(lower)) return true;
  if (/\bno contactar\b|\bno contacto\b/.test(lower)) return true;
  if (/no.*contactar/.test(lower)) return true;
  if (/quiero dejar de postular/.test(lower)) return true;
  return false;
}

function getOptOutReason(text: string): string {
  const lower = stripAccents(text).toLowerCase();
  if (/\bstop\b/.test(lower)) return "STOP";
  if (/\bunsubscribe\b/.test(lower)) return "UNSUBSCRIBE";
  if (/darme de baja|darse de baja/.test(lower)) return "DAR_DE_BAJA";
  if (/no me envien mas|no me escriban mas|no quiero recibir( mas)? mensajes/.test(lower)) return "NO_MAS_MENSAJES";
  if (/no quiero que me escriban|no quiero que me contacten/.test(lower)) return "NO_CONTACTAR";
  if (/\bno contactar\b|\bno contacto\b/.test(lower) || /no.*contactar/.test(lower)) return "NO_CONTACTAR";
  if (/borrar mis datos|eliminar mis datos/.test(lower)) return "BORRAR_DATOS";
  if (/quiero dejar de postular/.test(lower)) return "DEJAR_DE_POSTULAR";
  return "OPTOUT_EXPLICITO";
}

function isOptInText(text: string): boolean {
  const lower = stripAccents(text).toLowerCase().trim();
  if (!lower) return false;
  if (/no quiero que me contacten|no quiero que me escriban|no me contacten|no me escriban/.test(lower)) {
    return false;
  }
  if (/^(start|iniciar|reactivar)\b/.test(lower)) return true;
  return (
    /ahora (si|sí) quiero que me (contacten|escriban)/.test(lower) ||
    /quiero que me (contacten|escriban)/.test(lower) ||
    /pueden (contactarme|contactar|escribirme|escribir|hablarme|llamarme)/.test(lower) ||
    /pueden volver a (contactarme|escribirme)/.test(lower) ||
    /reactivar (mi )?contacto/.test(lower) ||
    /quitar (el )?no contactar|quitar no contactar/.test(lower) ||
    /desbloquear/.test(lower)
  );
}

async function maybeHandleOptIn(
  app: FastifyInstance,
  conversation: any,
  contact: any,
  text: string,
): Promise<boolean> {
  if (!contact?.noContact) return false;
  if (!text || !isOptInText(text)) return false;
  try {
    const candidates = buildWaIdCandidates(contact.waId || contact.phone);
    const contacts = await prisma.contact.findMany({
      where: {
        OR: [
          { waId: { in: candidates } },
          { phone: { in: candidates } },
          { id: contact.id },
        ],
      },
      select: { id: true },
    });
    const contactIds = contacts.map((c) => c.id);
    if (contactIds.length === 0) {
      contactIds.push(contact.id);
    }
    await prisma.contact.updateMany({
      where: { id: { in: contactIds } },
      data: { noContact: false, noContactAt: null, noContactReason: null },
    });
    await prisma.conversation.updateMany({
      where: { contactId: { in: contactIds } },
      data: { aiPaused: false },
    });
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "OUTBOUND",
        text: "Opt-in detectado: contacto reactivado automáticamente.",
        rawPayload: serializeJson({ system: true, noContactAction: "AUTO_OPTIN" }),
        timestamp: new Date(),
        read: true,
      },
    });
  } catch (err) {
    app.log.error({ err }, "Failed to auto-reactivate NO_CONTACTAR contact");
    return false;
  }
  return true;
}

async function maybeHandleOptOut(
  app: FastifyInstance,
  conversation: any,
  contact: any,
  text: string,
): Promise<boolean> {
  if (!text || !isOptOutText(text)) return false;
  try {
    const candidates = buildWaIdCandidates(contact.waId || contact.phone);
    const contacts = await prisma.contact.findMany({
      where: {
        OR: [
          { waId: { in: candidates } },
          { phone: { in: candidates } },
          { id: contact.id },
        ],
      },
      select: { id: true },
    });
    const contactIds = contacts.map((c) => c.id);
    if (contactIds.length === 0) {
      contactIds.push(contact.id);
    }
    const now = new Date();
    const reason = `Opt-out candidato: ${getOptOutReason(text)}`;
    await prisma.contact.updateMany({
      where: { id: { in: contactIds } },
      data: { noContact: true, noContactAt: now, noContactReason: reason },
    });
    await prisma.conversation.updateMany({
      where: { contactId: { in: contactIds } },
      data: { aiPaused: true },
    });
    if (contact.waId) {
      await sendWhatsAppText(contact.waId, "Entendido, detendremos los mensajes.");
    }
    await logAdminMessage(
      conversation.id,
      "OUTBOUND",
      "Marcado como NO_CONTACTAR por solicitud del candidato.",
      { system: true },
    );
  } catch (err) {
    app.log.error({ err }, "Failed to mark NO_CONTACTAR");
  }
  return true;
}

async function detectAdminTemplateIntent(
  text: string,
  config: SystemConfig,
  app: FastifyInstance,
  adminConversationId: string,
): Promise<{ previewText: string; action: AdminPendingAction } | null> {
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
    previewText,
    action: {
      type: "send_template",
      targetWaId,
      templateName,
      variables: [],
      templateLanguageCode: templates.templateLanguageCode || null,
      relatedConversationId: null,
      awaiting: "confirm",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      needsConfirmation: true,
      mode,
    },
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
