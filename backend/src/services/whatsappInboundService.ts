import { FastifyInstance } from "fastify";
import { Prisma, SystemConfig } from "@prisma/client";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import OpenAI from "openai";
import { prisma } from "../db/client";
import {
  getSystemConfig,
  getAdminWaIdAllowlist,
  getTestWaIdAllowlist,
  DEFAULT_INTERVIEW_AI_PROMPT,
  DEFAULT_INTERVIEW_AI_MODEL,
  INTERVIEW_AI_POLICY_ADDENDUM,
  DEFAULT_AI_MODEL,
  DEFAULT_WHATSAPP_BASE_URL,
  updateAdminAiConfig,
  normalizeModelId,
  DEFAULT_TEMPLATE_INTERVIEW_INVITE,
  DEFAULT_RECRUIT_JOB_SHEET,
  DEFAULT_SALES_AI_PROMPT,
  DEFAULT_SALES_KNOWLEDGE_BASE,
} from "./configService";
import { DEFAULT_AI_PROMPT } from "../constants/ai";
import { serializeJson } from "../utils/json";
import { getContactDisplayName } from "../utils/contactDisplay";
import { getEffectiveOpenAiKey, getSuggestedReply } from "./aiService";
import { sendWhatsAppText, SendResult } from "./whatsappMessageService";
import { processAdminCommand, fetchConversationByIdentifier, setConversationStatusByWaId } from "./whatsappAdminCommandService";
import { generateAdminAiResponse } from "./whatsappAdminAiService";
import { loadTemplateConfig, resolveTemplateVariables, selectTemplateForMode } from "./templateService";
import { createConversationAndMaybeSend } from "./conversationCreateService";
import { archiveConversation } from "./conversationArchiveService";
import { buildWaIdCandidates, normalizeWhatsAppId } from "../utils/whatsapp";
import { logInboundRoutingError, resolveInboundPhoneLineRouting } from "./phoneLineRoutingService";
import { coerceStageSlug, getWorkspaceDefaultStageSlug } from "./workspaceStageService";
import {
  attemptScheduleInterview,
  confirmActiveReservation,
  formatInterviewExactAddress,
  formatSlotHuman,
  releaseActiveReservation,
} from "./interviewSchedulerService";
import { sendAdminNotification } from "./adminNotificationService";
import { loadWorkflowRules, matchRule, WorkflowStage } from "./workflowService";
import {
  buildSellerSummary,
  createSellerEvent,
  detectSellerEvent,
  isDailySummaryRequest,
  isPitchRequest,
  isWeeklySummaryRequest,
} from "./sellerService";
import { runAutomations } from "./automationRunnerService";
import { ensurePartnerConversation, ensureStaffConversation } from "./staffConversationService";
import { stableHash } from "./agent/tools";
import { resolveWorkspaceProgramForKind } from "./programRoutingService";
import { normalizeChatCreateArgsForModel } from "./openAiChatCompletionService";

interface InboundMedia {
  type: string;
  id: string;
  mimeType?: string;
  sha256?: string;
  filename?: string;
  caption?: string;
  dataBase64?: string;
}

interface InboundMessageParams {
  from: string;
  waMessageId?: string;
  waPhoneNumberId?: string;
  text?: string;
  timestamp?: number;
  rawPayload?: any;
  profileName?: string;
  media?: InboundMedia | null;
  config?: SystemConfig;
}

const UPLOADS_BASE = path.join(__dirname, "..", "uploads");

async function mergeOrCreateContact(params: { workspaceId: string; waId: string; preferredId?: string }) {
  const candidates = buildWaIdCandidates(params.waId);
  let contacts = await prisma.contact.findMany({
    where: {
      workspaceId: params.workspaceId,
      OR: [{ waId: { in: candidates } }, { phone: { in: candidates } }],
    },
    orderBy: { createdAt: "asc" },
  });
  if (params.preferredId && !contacts.find((c) => c.id === params.preferredId)) {
    const preferred = await prisma.contact.findUnique({ where: { id: params.preferredId } });
    if (preferred) contacts = [preferred, ...contacts];
  }
  if (contacts.length === 0) {
    return prisma.contact.create({
      data: {
        workspaceId: params.workspaceId,
        waId: normalizeWhatsAppId(params.waId),
        phone: params.waId,
      },
    });
  }
  let primary =
    contacts.find((c) => c.id === params.preferredId) ||
    contacts.find((c) => (c as any).candidateNameManual) ||
    contacts.find((c) => c.candidateName) ||
    contacts[0];
  const secondaries = contacts.filter((c) => c.id !== primary.id);
  const canonicalWaId =
    normalizeWhatsAppId(primary.waId || primary.phone || params.waId) || primary.waId || params.waId;
  const canonicalPhone = primary.phone || (canonicalWaId ? `+${canonicalWaId}` : null);

  await prisma.$transaction(async (tx) => {
    const primaryUpdates: Record<string, any> = {};
    for (const sec of secondaries) {
      const secAny = sec as any;
      const primaryAny = primary as any;
      if (!primaryAny.candidateNameManual && secAny.candidateNameManual) {
        primaryUpdates.candidateNameManual = secAny.candidateNameManual;
        primaryAny.candidateNameManual = secAny.candidateNameManual;
      }
      if (!primaryAny.candidateName && secAny.candidateName) {
        primaryUpdates.candidateName = secAny.candidateName;
        primaryAny.candidateName = secAny.candidateName;
      }
      if (!primaryAny.displayName && secAny.displayName) {
        primaryUpdates.displayName = secAny.displayName;
        primaryAny.displayName = secAny.displayName;
      }
      if (!primaryAny.name && secAny.name) {
        primaryUpdates.name = secAny.name;
        primaryAny.name = secAny.name;
      }
      if (!primaryAny.noContact && secAny.noContact) {
        primaryUpdates.noContact = true;
        primaryUpdates.noContactAt = secAny.noContactAt ?? primaryAny.noContactAt ?? new Date();
        primaryUpdates.noContactReason = secAny.noContactReason ?? primaryAny.noContactReason ?? null;
        primaryAny.noContact = true;
        primaryAny.noContactAt = primaryUpdates.noContactAt;
        primaryAny.noContactReason = primaryUpdates.noContactReason;
      }

      await tx.conversation.updateMany({
        where: { contactId: sec.id, workspaceId: params.workspaceId },
        data: { contactId: primary.id },
      });
      await tx.application.updateMany({
        where: { contactId: sec.id },
        data: { contactId: primary.id },
      });
      await tx.contact.update({
        where: { id: sec.id },
        data: {
          waId: null,
          phone: null,
          mergedIntoContactId: primary.id,
          mergedAt: new Date(),
          mergedReason: 'DEDUPE_MERGE',
          archivedAt: new Date(),
        },
      });
    }
    if (Object.keys(primaryUpdates).length > 0) {
      await tx.contact.update({
        where: { id: primary.id },
        data: primaryUpdates,
      });
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
      workspaceId: params.workspaceId,
      waId: normalizeWhatsAppId(params.waId),
      phone: params.waId,
    },
  });
}

export async function handleInboundWhatsAppMessage(
  app: FastifyInstance,
  params: InboundMessageParams,
): Promise<{ conversationId: string }> {
  const config = params.config ?? (await getSystemConfig());
  const routing = await resolveInboundPhoneLineRouting({ waPhoneNumberId: params.waPhoneNumberId });
  if (routing.kind !== "RESOLVED") {
    await logInboundRoutingError({
      app,
      kind: routing.kind,
      waPhoneNumberId: routing.waPhoneNumberId,
      waMessageId: params.waMessageId ? String(params.waMessageId) : null,
      from: params.from,
      ...(routing.kind === "AMBIGUOUS" ? { matches: routing.matches } : {}),
    });
    return { conversationId: "" };
  }
  const { workspaceId, phoneLineId } = routing;
  const phoneLine = await prisma.phoneLine
    .findFirst({
      where: { id: phoneLineId, workspaceId, archivedAt: null },
      select: { defaultProgramId: true, inboundMode: true as any },
    })
    .catch(() => null);
  const inboundMode = String((phoneLine as any)?.inboundMode || 'DEFAULT').toUpperCase();
  const useDefaultProgram = inboundMode !== 'MENU';
  const defaultProgramId = useDefaultProgram ? phoneLine?.defaultProgramId || null : null;
  const waId = normalizeWhatsAppId(params.from) || params.from;
  const normalizedSender = normalizeWhatsAppId(waId);
  const adminAllowlist = getAdminWaIdAllowlist(config);
  const isAdminSender = Boolean(normalizedSender && adminAllowlist.includes(normalizedSender));
  const inboundWaMessageId =
    typeof params.waMessageId === "string" && params.waMessageId.trim()
      ? params.waMessageId.trim()
      : null;
  const trimmedText = (params.text || "").trim();

  if (inboundWaMessageId) {
    const existing = await prisma.message.findFirst({
      where: { waMessageId: inboundWaMessageId },
      select: { conversationId: true },
    });
    if (existing?.conversationId) {
      return { conversationId: existing.conversationId };
    }
  }

  const workspace = await prisma.workspace
    .findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        archivedAt: true,
        staffDefaultProgramId: true as any,
        clientDefaultProgramId: true as any,
        partnerDefaultProgramId: true as any,
        allowPersonaSwitchByWhatsApp: true as any,
        personaSwitchTtlMinutes: true as any,
        partnerPhoneE164sJson: true as any,
      } as any,
    })
    .catch(() => null);
  if (!workspace || (workspace as any).archivedAt) return { conversationId: "" };

  const replyToWaMessageId = (() => {
    const payload = params.rawPayload as any;
    if (!payload || typeof payload !== "object") return null;
    if (payload.context && typeof payload.context === "object") {
      const id = String((payload.context as any).id || "").trim();
      return id || null;
    }
    // Some webhook payloads nest reply context differently; tolerate common shapes.
    const ctxId =
      payload?.message?.context?.id ||
      payload?.messages?.[0]?.context?.id ||
      payload?.value?.messages?.[0]?.context?.id;
    const id = typeof ctxId === "string" ? ctxId.trim() : "";
    return id || null;
  })();

  const replyRoute =
    replyToWaMessageId && replyToWaMessageId.trim()
      ? await (async () => {
          const outbound = await prisma.outboundMessageLog
            .findFirst({
              where: { workspaceId, waMessageId: replyToWaMessageId.trim() },
              select: { conversationId: true },
              orderBy: { createdAt: "desc" },
            })
            .catch(() => null);
          if (!outbound?.conversationId) return null;
          const convo = await prisma.conversation
            .findFirst({
              where: { id: outbound.conversationId, workspaceId, phoneLineId, archivedAt: null, isAdmin: false } as any,
              include: { contact: true },
            })
            .catch(() => null);
          if (!convo?.id) return null;
          const kind = String((convo as any).conversationKind || "").toUpperCase();
          if (kind !== "STAFF" && kind !== "PARTNER") return null;
          return { conversation: convo, contact: convo.contact, kind };
        })()
      : null;

  const staffMemberships =
    normalizedSender
      ? await prisma.membership
          .findMany({
            where: {
              workspaceId,
              archivedAt: null,
              OR: [{ staffWhatsAppE164: { not: null } }, { staffWhatsAppExtraE164sJson: { not: null } as any }],
            } as any,
            include: { user: { select: { id: true, email: true, name: true } } },
          })
          .catch(() => [])
      : [];
  const staffMatch =
    normalizedSender && staffMemberships.length > 0
      ? staffMemberships.find((m) => {
          const primary = normalizeWhatsAppId(String((m as any).staffWhatsAppE164 || "")) === normalizedSender;
          if (primary) return true;
          const extraRaw = String((m as any).staffWhatsAppExtraE164sJson || "").trim();
          if (!extraRaw) return false;
          try {
            const parsed = JSON.parse(extraRaw);
            if (Array.isArray(parsed)) {
              return parsed.some((v) => normalizeWhatsAppId(String(v || "")) === normalizedSender);
            }
          } catch {
            // ignore
          }
          return extraRaw
            .split(/[,\n]/g)
            .map((v) => normalizeWhatsAppId(String(v || "")) || "")
            .filter(Boolean)
            .includes(normalizedSender);
        })
      : null;

  const partnerMatch = (() => {
    if (!normalizedSender) return false;
    const raw = String((workspace as any).partnerPhoneE164sJson || "").trim();
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.some((v) => normalizeWhatsAppId(String(v || "")) === normalizedSender);
      }
    } catch {
      // ignore
    }
    return raw
      .split(/[,\n]/g)
      .map((v) => normalizeWhatsAppId(String(v || "")) || "")
      .filter(Boolean)
      .includes(normalizedSender);
  })();

  const contactForRouting = replyRoute?.contact || (await mergeOrCreateContact({ workspaceId, waId }))!;
  const activeOverride = await prisma.conversation
    .findFirst({
      where: {
        workspaceId,
        phoneLineId,
        contactId: contactForRouting.id,
        archivedAt: null,
        activePersonaKind: { not: null },
        activePersonaUntilAt: { gt: new Date() },
      } as any,
      select: { activePersonaKind: true as any, activePersonaUntilAt: true as any },
      orderBy: { activePersonaUntilAt: "desc" },
    })
    .catch(() => null);
  const overrideKindRaw = String((activeOverride as any)?.activePersonaKind || "").trim().toUpperCase();
  const overrideKind = overrideKindRaw || null;

  const allowedKinds = (() => {
    if (staffMatch) {
      const raw = String((staffMatch as any).allowedPersonaKindsJson || "").trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.map((v) => String(v || "").trim().toUpperCase()).filter(Boolean);
          }
        } catch {
          // ignore
        }
      }
      return ["STAFF", "CLIENT"];
    }
    if (partnerMatch) return ["PARTNER"];
    if (isAdminSender) return ["ADMIN"];
    return ["CLIENT"];
  })();

  const baseKind = staffMatch ? "STAFF" : partnerMatch ? "PARTNER" : isAdminSender ? "ADMIN" : "CLIENT";
  const effectiveKind = replyRoute?.kind
    ? replyRoute.kind
    : overrideKind && allowedKinds.includes(overrideKind)
      ? overrideKind
      : baseKind;

  if (effectiveKind === "ADMIN" && normalizedSender) {
    const adminThread = await ensureAdminConversation({ workspaceId, waId, normalizedAdmin: normalizedSender, phoneLineId });
    const baseText = buildInboundText(params.text, params.media);
    let adminMessage;
    try {
      adminMessage = await prisma.message.create({
        data: {
          conversationId: adminThread.conversation.id,
          waMessageId: inboundWaMessageId,
          direction: "INBOUND",
          text: baseText,
          mediaType: params.media?.type || null,
          mediaMime: params.media?.mimeType || null,
          rawPayload: serializeJson(params.rawPayload ?? { admin: true }),
          timestamp: new Date(params.timestamp ? params.timestamp * 1000 : Date.now()),
          read: false,
        },
      });
    } catch (err: any) {
      const isUnique =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
      if (isUnique && inboundWaMessageId) {
        const existing = await prisma.message.findFirst({
          where: { waMessageId: inboundWaMessageId },
          select: { conversationId: true },
        });
        if (existing?.conversationId) return { conversationId: existing.conversationId };
      }
      throw err;
    }

    await processMediaAttachment(app, {
      conversationId: adminThread.conversation.id,
      waId: normalizedSender,
      media: params.media,
      messageId: adminMessage.id,
      config,
    });

    const refreshedAdminMessage = await prisma.message.findUnique({
      where: { id: adminMessage.id },
    });
    const effectiveText = buildPolicyText(params, refreshedAdminMessage);

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
    if (adminThread.conversation.phoneLineId) {
      await prisma.phoneLine
        .update({
          where: { id: adminThread.conversation.phoneLineId },
          data: { lastInboundAt: new Date() },
        })
        .catch(() => {});
    }

    const trimmedEffective = (effectiveText || "").trim();

    // Agent OS: if there are enabled automations for inbound messages, let them handle the reply
    // and avoid running the legacy admin command pipeline.
    const hasAgentAutomations = await prisma.automationRule.count({
      where: { workspaceId: adminThread.conversation.workspaceId, trigger: "INBOUND_MESSAGE", enabled: true, archivedAt: null },
    });
    if (hasAgentAutomations > 0) {
      await runAutomations({
        app,
        workspaceId: adminThread.conversation.workspaceId,
        eventType: "INBOUND_MESSAGE",
        conversationId: adminThread.conversation.id,
        inboundMessageId: adminMessage.id,
        inboundText: trimmedEffective,
        transportMode: "REAL",
      });
      return { conversationId: adminThread.conversation.id };
    }
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

    const normalizedEffective = stripAccents(trimmedEffective).toLowerCase();
    const wantsAttachmentSummary =
      !trimmedEffective.startsWith("/") &&
      isAttachmentSummaryRequest(trimmedEffective) &&
      (params.media?.type === "image" ||
        params.media?.type === "document" ||
        /\b(documento|archivo|imagen|adjunto)\b/.test(normalizedEffective));
    if (wantsAttachmentSummary) {
      const currentIsAttachment =
        params.media?.type === "image" || params.media?.type === "document";
      if (currentIsAttachment) {
        const extractedText = (refreshedAdminMessage?.transcriptText || "").trim();
        const replyText = extractedText
          ? buildAdminAttachmentSummary(extractedText)
          : "Recibí el adjunto, pero no pude extraer texto. ¿Puedes reenviarlo en PDF legible o una imagen más nítida?";
        await sendAdminReply(app, adminThread.conversation.id, waId, replyText);
        return { conversationId: adminThread.conversation.id };
      }

      const recentMedia = await prisma.message.findFirst({
        where: {
          conversationId: adminThread.conversation.id,
          direction: "INBOUND",
          mediaType: { in: ["image", "document"] },
          transcriptText: { not: null },
        },
        orderBy: { timestamp: "desc" },
      });
      const extractedText = (recentMedia?.transcriptText || "").trim();
      const replyText = extractedText
        ? buildAdminAttachmentSummary(extractedText)
        : "No encuentro un adjunto reciente con texto extraído. ¿Puedes reenviarlo en PDF legible o imagen más nítida?";
      await sendAdminReply(app, adminThread.conversation.id, waId, replyText);
      return { conversationId: adminThread.conversation.id };
    }

    const handledPending = await handleAdminPendingAction(
      app,
      adminThread.conversation.id,
      adminThread.conversation.adminLastCandidateWaId || null,
      trimmedEffective,
      normalizedSender,
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

    if (isAdminRecruitmentSummaryRequest(trimmedEffective)) {
      const result = await buildAdminRecruitmentSummaryReply({
        adminConversationId: adminThread.conversation.id,
        text: trimmedEffective,
        lastCandidateWaId: adminThread.conversation.adminLastCandidateWaId || null,
        config,
      });
      if (result.resolvedWaId) {
        await prisma.conversation.update({
          where: { id: adminThread.conversation.id },
          data: { adminLastCandidateWaId: result.resolvedWaId },
        });
        adminThread.conversation.adminLastCandidateWaId = result.resolvedWaId;
      }
      await sendAdminReply(app, adminThread.conversation.id, waId, result.replyText);
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

  let contact: any = null;
  let conversation: any = null;
  const staffDefaultProgramId = (
    await resolveWorkspaceProgramForKind({
      workspaceId,
      kind: "STAFF",
      phoneLineId,
    }).catch(() => ({ programId: null }))
  ).programId;
  const partnerDefaultProgramId = (
    await resolveWorkspaceProgramForKind({
      workspaceId,
      kind: "PARTNER",
      phoneLineId,
    }).catch(() => ({ programId: null }))
  ).programId;
  const clientDefaultProgramId = useDefaultProgram
    ? (
        await resolveWorkspaceProgramForKind({
          workspaceId,
          kind: "CLIENT",
          phoneLineId,
          preferredProgramId: phoneLine?.defaultProgramId || null,
        }).catch(() => ({ programId: null }))
      ).programId
    : null;
  const isStaffConversation = effectiveKind === "STAFF";
  const isPartnerConversation = effectiveKind === "PARTNER";

  if (replyRoute?.conversation?.id) {
    contact = replyRoute.contact;
    conversation = replyRoute.conversation;
    const kind = String((conversation as any).conversationKind || "").toUpperCase();
    const desiredProgramId =
      kind === "STAFF" ? staffDefaultProgramId : kind === "PARTNER" ? partnerDefaultProgramId : null;
    if (!conversation.programId && desiredProgramId) {
      conversation = await prisma.conversation
        .update({
          where: { id: conversation.id },
          data: { programId: desiredProgramId, updatedAt: new Date() },
        })
        .catch(() => conversation);
    }
  } else if (isStaffConversation && normalizedSender) {
    const staffLabel = String(staffMatch?.user?.name || staffMatch?.user?.email || "Staff");
    const staffThread = await ensureStaffConversation({
      workspaceId,
      phoneLineId,
      staffWaId: normalizedSender,
      staffLabel,
      staffProgramId: staffDefaultProgramId,
    }).catch((err) => {
      app.log.warn({ err, workspaceId, phoneLineId }, "ensureStaffConversation failed");
      return null;
    });
    if (!staffThread?.conversation?.id) {
      return { conversationId: "" };
    }
    contact = staffThread.contact;
    conversation = staffThread.conversation;
  } else if (isPartnerConversation && normalizedSender) {
    const partnerLabel = "Partner";
    const partnerThread = await ensurePartnerConversation({
      workspaceId,
      phoneLineId,
      partnerWaId: normalizedSender,
      partnerLabel,
      partnerProgramId: partnerDefaultProgramId,
    }).catch((err) => {
      app.log.warn({ err, workspaceId, phoneLineId }, "ensurePartnerConversation failed");
      return null;
    });
    if (!partnerThread?.conversation?.id) {
      return { conversationId: "" };
    }
    contact = partnerThread.contact;
    conversation = partnerThread.conversation;
  } else {
    contact = contactForRouting;
    await maybeUpdateContactName(contact, params.profileName, params.text, config);

    conversation = await prisma.conversation.findFirst({
      where: { contactId: contact.id, isAdmin: false, workspaceId, phoneLineId, conversationKind: "CLIENT" } as any,
      orderBy: { updatedAt: "desc" },
    });

    if (!conversation) {
      const defaultStageSlug = await getWorkspaceDefaultStageSlug(workspaceId).catch(
        () => "NEW_INTAKE",
      );
      conversation = await prisma.conversation.create({
        data: {
          workspaceId,
          phoneLineId,
          programId: clientDefaultProgramId,
          contactId: contact.id,
          status: "NEW",
          conversationStage: defaultStageSlug,
          stageChangedAt: new Date(),
          channel: "whatsapp",
          conversationKind: "CLIENT",
        } as any,
      });
    } else if (conversation.status === "CLOSED") {
      conversation = await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: "OPEN" },
      });
    }
    // Ensure conversationStage is valid for this workspace; if not, coerce to workspace default.
    try {
      const coerced = await coerceStageSlug({
        workspaceId,
        stageSlug: conversation.conversationStage,
      });
      if (coerced && String(conversation.conversationStage || "") !== String(coerced)) {
        conversation = await prisma.conversation.update({
          where: { id: conversation.id },
          data: {
            conversationStage: coerced,
            stageReason: "auto_default",
            stageChangedAt: new Date(),
            updatedAt: new Date(),
          } as any,
        });
      }
    } catch {
      // ignore
    }
    if (!conversation.programId && clientDefaultProgramId) {
      conversation = await prisma.conversation.update({
        where: { id: conversation.id },
        data: { programId: clientDefaultProgramId },
      });
    }
  }

  const messageText = buildInboundText(params.text, params.media);
  let message;
  try {
    message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        waMessageId: inboundWaMessageId,
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
  } catch (err: any) {
    const isUnique =
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
    if (isUnique && inboundWaMessageId) {
      const existing = await prisma.message.findFirst({
        where: { waMessageId: inboundWaMessageId },
        select: { conversationId: true },
      });
      if (existing?.conversationId) return { conversationId: existing.conversationId };
    }
    throw err;
  }

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { updatedAt: new Date() },
  });
  if (conversation.phoneLineId) {
    await prisma.phoneLine
      .update({
        where: { id: conversation.phoneLineId },
        data: { lastInboundAt: new Date() },
      })
      .catch(() => {});
  }

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
  const effectiveText = buildPolicyText(params, latestMessage);

  if (!isStaffConversation && !isPartnerConversation) {
    const optedIn = await maybeHandleOptIn(app, conversation, contact, effectiveText);
    if (optedIn) {
      contact.noContact = false;
      return { conversationId: conversation.id };
    }

    const optedOut = await maybeHandleOptOut(app, conversation, contact, effectiveText);
    if (optedOut) {
      return { conversationId: conversation.id };
    }
  }

  const personaPrompted = await maybeHandlePersonaAutoPrompt(app, {
    workspaceId,
    phoneLineId,
    conversation,
    contact,
    inboundText: effectiveText,
    effectiveKind,
    baseKind,
    allowedKinds,
    hasActiveOverride: Boolean(overrideKind && allowedKinds.includes(overrideKind)),
    autoReplyEnabled: Boolean(config?.botAutoReply),
    ttlMinutes: Number.isFinite((workspace as any)?.personaSwitchTtlMinutes)
      ? Number((workspace as any).personaSwitchTtlMinutes)
      : 360,
    allowPersonaSwitch: typeof (workspace as any)?.allowPersonaSwitchByWhatsApp === "boolean"
      ? Boolean((workspace as any).allowPersonaSwitchByWhatsApp)
      : true,
  }).catch(() => false);
  if (personaPrompted) {
    return { conversationId: conversation.id };
  }

  const personaHandled = await maybeHandlePersonaSwitchCommand(app, {
    workspaceId,
    phoneLineId,
    conversation,
    contact,
    inboundText: effectiveText,
    effectiveKind,
    allowedKinds,
    baseKind,
    autoReplyEnabled: Boolean(config?.botAutoReply),
    ttlMinutes: Number.isFinite((workspace as any)?.personaSwitchTtlMinutes)
      ? Number((workspace as any).personaSwitchTtlMinutes)
      : 360,
    allowPersonaSwitch: typeof (workspace as any)?.allowPersonaSwitchByWhatsApp === "boolean"
      ? Boolean((workspace as any).allowPersonaSwitchByWhatsApp)
      : true,
  }).catch(() => false);
  if (personaHandled) {
    return { conversationId: conversation.id };
  }

  const mediaType = params.media?.type || null;
  const isAttachment = mediaType === "image" || mediaType === "document";
  const extractedText = (latestMessage?.transcriptText || "").trim();
  if (isAttachment && !extractedText && !isStaffConversation && !isPartnerConversation) {
    const lastOutbound = await prisma.message.findFirst({
      where: { conversationId: conversation.id, direction: "OUTBOUND" },
      orderBy: { timestamp: "desc" },
    });
    const lastOutboundText = stripAccents((lastOutbound?.text || "").toLowerCase());
    const alreadyAsked = lastOutboundText.includes("no pude leer el adjunto");
    if (!alreadyAsked) {
      const question =
        mediaType === "image"
          ? "Recibí tu imagen, pero no pude leer el adjunto con claridad. ¿Puedes reenviarla más nítida o escribir en un mensaje: nombre y apellido, comuna/ciudad, RUT, experiencia y disponibilidad?"
          : "Recibí tu archivo, pero no pude leer el adjunto. ¿Puedes reenviarlo en PDF legible o escribir en un mensaje: nombre y apellido, comuna/ciudad, RUT, experiencia y disponibilidad?";
      let sendResultRaw: SendResult = { success: false, error: "waId is missing" };
      if (contact.waId) {
        const line = await prisma.phoneLine
          .findUnique({
            where: { id: conversation.phoneLineId },
            select: { waPhoneNumberId: true },
          })
          .catch(() => null);
        sendResultRaw = await sendWhatsAppText(contact.waId, question, {
          phoneNumberId: line?.waPhoneNumberId || null,
        });
      }
      const normalizedSendResult = {
        success: sendResultRaw.success,
        messageId:
          "messageId" in sendResultRaw ? (sendResultRaw.messageId ?? null) : null,
        error: "error" in sendResultRaw ? (sendResultRaw.error ?? null) : null,
      };
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction: "OUTBOUND",
          text: question,
          rawPayload: serializeJson({
            autoReply: true,
            attachmentUnreadable: true,
            sendResult: normalizedSendResult,
          }),
          timestamp: new Date(),
          read: true,
        },
      });
      await prisma.conversation
        .update({
          where: { id: conversation.id },
          data: { updatedAt: new Date() },
        })
        .catch(() => {});
    }
    return { conversationId: conversation.id };
  }

  // Agent OS: if there are enabled automations for inbound messages, let them handle the reply
  // and avoid running the legacy candidate pipeline (name extraction, missing-fields, etc).
  const hasAgentAutomations = await prisma.automationRule.count({
    where: { workspaceId: conversation.workspaceId, trigger: "INBOUND_MESSAGE", enabled: true, archivedAt: null },
  });
  if (hasAgentAutomations > 0 && config.botAutoReply && !conversation.aiPaused) {
    await runAutomations({
      app,
      workspaceId: conversation.workspaceId,
      eventType: "INBOUND_MESSAGE",
      conversationId: conversation.id,
      inboundMessageId: message.id,
      inboundText: effectiveText,
      transportMode: "REAL",
    });
    return { conversationId: conversation.id };
  }

  if (isStaffConversation || isPartnerConversation) {
    // Staff conversations should not fall back to legacy candidate pipelines.
    return { conversationId: conversation.id };
  }

  await maybeUpdateContactName(contact, params.profileName, effectiveText, config);

  if (!conversation.isAdmin) {
    await detectInterviewSignals(app, conversation.id, effectiveText);
  }

  await maybeSendAutoReply(app, conversation.id, contact.waId, config);

  await maybeNotifyRecruitmentReady(app, conversation.id);

  await applyRecruitmentWorkflowRules(app, conversation.id, config).catch((err) => {
    app.log.warn({ err, conversationId: conversation.id }, "Workflow rules evaluation failed");
  });

  if (!isAdminSender && isAdminCommandText(params.text)) {
    const line = await prisma.phoneLine
      .findUnique({ where: { id: conversation.phoneLineId }, select: { waPhoneNumberId: true } })
      .catch(() => null);
    await sendWhatsAppText(waId, "Comando no reconocido", { phoneNumberId: line?.waPhoneNumberId || null });
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
    const phoneLine = await prisma.phoneLine
      .findUnique({ where: { id: conversation.phoneLineId }, select: { id: true, waPhoneNumberId: true } })
      .catch(() => null);
    const phoneNumberId = phoneLine?.waPhoneNumberId || null;

    const mode = conversation.aiMode || "RECRUIT";
    if (mode === "OFF" || conversation.aiPaused) return;

    if (mode === "RECRUIT") {
      const inboundMessages = (conversation.messages || []).filter(
        (m) => m.direction === "INBOUND",
      );
      const assessment = assessRecruitmentReadiness(conversation.contact, inboundMessages);
      const alreadyClosed = (conversation.messages || []).some((m) => {
        if (m.direction !== "OUTBOUND" || typeof m.text !== "string") return false;
        const normalized = stripAccents(m.text).toLowerCase();
        if (normalized.includes("ya tenemos los datos minimo") || normalized.includes("ya tenemos los datos minimos")) {
          return true;
        }
        if (normalized.includes("ya registre tu postulacion") || normalized.includes("ya registraste tu postulacion")) {
          return true;
        }
        if (normalized.includes("equipo revisara tu postulacion")) return true;
        return false;
      });

      const lastInbound = inboundMessages.slice(-1)[0];
      const lastInboundText = (lastInbound?.transcriptText || lastInbound?.text || "").trim();
      const lastInboundTranscript = (lastInbound?.transcriptText || "").trim();
      const lastInboundHasAttachment =
        Boolean(lastInbound) &&
        (lastInbound?.mediaType === "image" || lastInbound?.mediaType === "document") &&
        Boolean(lastInboundTranscript);

      // Attachments should be handled contextually first (OCR/PDF extraction), so candidates don't get a generic menu when
      // they sent a file. This also improves conversion for "tengo CV" + adjunto.
      if (!assessment.ready && !alreadyClosed && lastInboundHasAttachment && lastInboundTranscript) {
        const handled = await maybeHandleContextualAttachmentReply({
          app,
          conversation,
          conversationId,
          waId,
          mode: "RECRUIT",
          extractedText: lastInboundTranscript,
        });
        if (handled) return;
      }

      const lastOutbound = (conversation.messages || []).filter((m) => m.direction === "OUTBOUND").slice(-1)[0];
      const lastOutboundText = stripAccents((lastOutbound?.text || "").toLowerCase());
      const lastOutboundWasInfoMenu = (() => {
        try {
          const payload = lastOutbound?.rawPayload ? JSON.parse(lastOutbound.rawPayload) : null;
          if (payload?.recruitFlow === "INFO_MENU") return true;
        } catch {
          // ignore
        }
        return (
          (lastOutboundText.includes("responde") || lastOutboundText.includes("quieres")) &&
          lastOutboundText.includes("postular") &&
          lastOutboundText.includes("2") &&
          lastOutboundText.includes("info")
        );
      })();
      const jobSheet = String((config as any)?.recruitJobSheet || DEFAULT_RECRUIT_JOB_SHEET);
      const faq = String((config as any)?.recruitFaq || "");

      if (!assessment.ready && !alreadyClosed && lastInboundText) {
        const missing: string[] = [];
        if (!assessment.fields.name) missing.push("nombre y apellido");
        if (!assessment.fields.location) missing.push("comuna/ciudad");
        if (!assessment.fields.rut) missing.push("RUT");
        if (!assessment.fields.experience) missing.push("experiencia en ventas (años/rubros/terreno)");
        if (!assessment.fields.availability) missing.push("disponibilidad");

        const hasOutbound = Boolean(lastOutbound);
        const isFirstMessage = inboundMessages.length === 1 && !hasOutbound;
        const wantsApply = isRecruitChoiceOne(lastInboundText) || isRecruitApplyIntent(lastInboundText);
        const wantsInfo = isRecruitChoiceTwo(lastInboundText) || isRecruitInfoIntent(lastInboundText);

        let replyText: string | null = null;
        let meta: Record<string, any> | null = null;

        if (lastOutboundWasInfoMenu) {
          if (isRecruitChoiceOne(lastInboundText)) {
            replyText = buildRecruitApplyRequestReply();
            meta = { recruitFlow: "APPLY_REQUEST_FROM_MENU" };
          } else if (isRecruitChoiceTwo(lastInboundText)) {
            replyText = buildRecruitInfoFollowupReply(jobSheet, faq);
            meta = { recruitFlow: "INFO_FOLLOWUP" };
          }
        } else if (isFirstMessage && wantsInfo) {
          const title = String((config as any)?.defaultJobTitle || "").trim() || null;
          replyText = buildRecruitInfoMenuReply(title, jobSheet);
          meta = { recruitFlow: "INFO_MENU" };
        } else if (wantsApply) {
          // If the candidate hasn't provided any data yet, ask the full one-shot form; otherwise ask only for missing fields.
          replyText = missing.length >= 5 ? buildRecruitApplyRequestReply() : buildRecruitMissingFieldsReply(missing);
          meta = { recruitFlow: missing.length >= 5 ? "APPLY_REQUEST" : "MISSING_FIELDS", missing };
        } else {
          const hasAnyData =
            Boolean(assessment.fields.location) ||
            Boolean(assessment.fields.rut) ||
            Boolean(assessment.fields.experience) ||
            Boolean(assessment.fields.availability) ||
            Boolean(assessment.fields.email);
          if (hasAnyData && missing.length > 0) {
            replyText = buildRecruitMissingFieldsReply(missing);
            meta = { recruitFlow: "MISSING_FIELDS", missing };
          }
        }

        if (replyText) {
          let sendResultRaw: SendResult = { success: false, error: "waId is missing" };
          if (waId) {
            sendResultRaw = await sendWhatsAppText(waId, replyText, { phoneNumberId });
          }
          const normalizedSendResult = {
            success: sendResultRaw.success,
            messageId: "messageId" in sendResultRaw ? (sendResultRaw.messageId ?? null) : null,
            error: "error" in sendResultRaw ? (sendResultRaw.error ?? null) : null,
          };
          await prisma.message.create({
            data: {
              conversationId,
              direction: "OUTBOUND",
              text: replyText,
              rawPayload: serializeJson({
                autoReply: true,
                mode: "RECRUIT",
                ...(meta || {}),
                sendResult: normalizedSendResult,
              }),
              timestamp: new Date(),
              read: true,
            },
          });
          return;
        }
      }

      if (assessment.ready && !alreadyClosed) {
        const name =
          assessment.fields.name ||
          conversation.contact?.candidateName ||
          conversation.contact?.displayName ||
          null;
        const greeting = name ? `Gracias, ${name}.` : "Gracias.";
        const lastInbound = inboundMessages.slice(-1)[0];
        const lastInboundIsAttachment =
          lastInbound &&
          (lastInbound.mediaType === "image" || lastInbound.mediaType === "document") &&
          Boolean((lastInbound.transcriptText || "").trim());
        const detectedSummary =
          assessment.summary && assessment.summary !== "Datos mínimos recibidos."
            ? assessment.summary
            : null;
        const closingText = lastInboundIsAttachment
          ? `${greeting} Pude leer tu adjunto${detectedSummary ? ` y detecté: ${detectedSummary}` : ""}. Ya tenemos los datos mínimos. ` +
            "El equipo revisará tu postulación y te contactará por este medio."
          : `${greeting} Ya tenemos los datos mínimos. ` +
            "El equipo revisará tu postulación y te contactará por este medio.";

        let sendResultRaw: SendResult = {
          success: false,
          error: "waId is missing",
        };
        if (waId) {
          sendResultRaw = await sendWhatsAppText(waId, closingText, { phoneNumberId });
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

    const lastInbound = (conversation.messages || [])
      .filter((m) => m.direction === "INBOUND")
      .slice(-1)[0];
    const lastInboundTranscript = (lastInbound?.transcriptText || "").trim();
    const lastInboundHasAttachment =
      lastInbound?.direction === "INBOUND" &&
      (lastInbound?.mediaType === "image" || lastInbound?.mediaType === "document");
    if (lastInboundHasAttachment && lastInboundTranscript) {
      const handled = await maybeHandleContextualAttachmentReply({
        app,
        conversation,
        conversationId,
        waId,
        mode,
        extractedText: lastInboundTranscript,
      });
      if (handled) return;
    }

    if (mode === "INTERVIEW") {
      const lastInboundText = (lastInbound?.transcriptText || lastInbound?.text || "").trim();
      const lastInboundLower = stripAccents(lastInboundText).toLowerCase();
      const parsedInbound = lastInboundText ? parseDayTime(lastInboundText) : { day: null, time: null };
      const hasScheduleDetails = Boolean(parsedInbound.day || parsedInbound.time);
      const isYes =
        /\bconfirm(o|ar)?\b/.test(lastInboundLower) ||
        /^(si|sí|ok|dale|listo|perfecto)\b/.test(lastInboundLower) ||
        /\b(me sirve|de acuerdo)\b/.test(lastInboundLower);
      const isNo =
        /\bno (puedo|sirve|voy|asistir|ir)\b/.test(lastInboundLower) ||
        /^no\s*[,!.?¿¡]*\s*$/.test(lastInboundLower) ||
        /^no\b(?!\s+tengo\b)/.test(lastInboundLower);
      const wantsPause = /\b(en\s+pausa|pausa|mas\s+adelante|por\s+ahora\s+no)\b/.test(lastInboundLower);
      const wantsReschedule =
        /\b(reagend|reagendar|reprogram|reprogramar|cambiar|cambio|modificar|mover|cancelar|cancelacion|cancelación)\b/.test(
          lastInboundLower,
        ) &&
        /\b(hora|horario|entrevista)\b/.test(lastInboundLower);

      if (isYes && !hasScheduleDetails && !wantsReschedule) {
        const replyText = buildInterviewConfirmedReply({
          day: conversation.interviewDay || null,
          time: conversation.interviewTime || null,
          location: conversation.interviewLocation || config.defaultInterviewLocation || null,
          config,
        });

        let sendResultRaw: SendResult = { success: false, error: "waId is missing" };
        if (waId) {
          sendResultRaw = await sendWhatsAppText(waId, replyText, { phoneNumberId });
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
            text: replyText,
            rawPayload: serializeJson({ autoReply: true, interviewConfirmAck: true, sendResult: normalizedSendResult }),
            timestamp: new Date(),
            read: true,
          },
        });
        return;
      }

      if (wantsPause && !isYes) {
        const lastOutbound = (conversation.messages || [])
          .filter((m) => m.direction === "OUTBOUND")
          .slice(-1)[0];
        const lastOutboundText = stripAccents((lastOutbound?.text || "").toLowerCase());
        const alreadyAcknowledgedPause =
          lastOutboundText.includes("coordinación en pausa") || lastOutboundText.includes("coordinacion en pausa");
        if (!alreadyAcknowledgedPause) {
          const replyText =
            "Listo, dejo la coordinación de la entrevista en pausa.\n" +
            "Cuando quieras retomarla, escríbeme y dime 2 alternativas de día y hora.";
          let sendResultRaw: SendResult = { success: false, error: "waId is missing" };
          if (waId) {
            sendResultRaw = await sendWhatsAppText(waId, replyText, { phoneNumberId });
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
              text: replyText,
              rawPayload: serializeJson({ autoReply: true, interviewOnHoldAck: true, sendResult: normalizedSendResult }),
              timestamp: new Date(),
              read: true,
            },
          });
        }
        return;
      }

      if ((wantsReschedule || isNo) && !isYes) {
        const lastOutbound = (conversation.messages || [])
          .filter((m) => m.direction === "OUTBOUND")
          .slice(-1)[0];
        const lastOutboundText = stripAccents((lastOutbound?.text || "").toLowerCase());
        const alreadyAskedAlternatives =
          lastOutboundText.includes("2 alternativas") ||
          lastOutboundText.includes("dos alternativas") ||
          lastOutboundText.includes("2 horarios") ||
          lastOutboundText.includes("dos horarios");

        if (!alreadyAskedAlternatives) {
          const replyText =
            "Entiendo perfecto. ¿Qué 2 horarios (día y hora) te acomodan para proponerte una alternativa?\n" +
            "Si prefieres, también puedo dejar la coordinación en pausa.";
          let sendResultRaw: SendResult = { success: false, error: "waId is missing" };
          if (waId) {
            sendResultRaw = await sendWhatsAppText(waId, replyText, { phoneNumberId });
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
              text: replyText,
              rawPayload: serializeJson({ autoReply: true, rescheduleRequest: true, sendResult: normalizedSendResult }),
              timestamp: new Date(),
              read: true,
            },
          });
        }
        return;
      }
    }

    if (mode === "SELLER") {
      const lastInboundText = (lastInbound?.transcriptText || lastInbound?.text || "").trim();
      const lastInboundLower = stripAccents(lastInboundText).toLowerCase();

      if (!lastInboundText) return;

      const pitchRequest = isPitchRequest(lastInboundLower);
      const dailySummary = isDailySummaryRequest(lastInboundLower);
      const weeklySummary = isWeeklySummaryRequest(lastInboundLower);
      const event = detectSellerEvent(lastInboundText);

      let replyText: string | null = null;

      const salesPromptBase = (config.salesAiPrompt || DEFAULT_SALES_AI_PROMPT).trim() || DEFAULT_SALES_AI_PROMPT;
      const salesKnowledgeBase =
        (config.salesKnowledgeBase || DEFAULT_SALES_KNOWLEDGE_BASE).trim() || DEFAULT_SALES_KNOWLEDGE_BASE;
      const salesPrompt = `${salesPromptBase}\n\nBase de conocimiento (editable):\n${salesKnowledgeBase}`.trim();
      const canUseSalesAi = Boolean(getEffectiveOpenAiKey(config));

      if (dailySummary || weeklySummary) {
        const range = weeklySummary ? "WEEK" : "DAY";
        const summary = await buildSellerSummary({
          contactId: conversation.contactId,
          config,
          range,
        });
        const amountPart =
          typeof summary.totalAmountClp === "number" ? `\nTotal CLP: $${summary.totalAmountClp}` : "";
        const detail = summary.lines.length > 0 ? `\n\nÚltimos eventos:\n${summary.lines.join("\n")}` : "";
        const adminBody = `${summary.label}\nVisitas: ${summary.visits}\nVentas: ${summary.sales}${amountPart}${detail}`;

        await sendAdminNotification({
          app,
          eventType: weeklySummary ? "SELLER_WEEKLY_SUMMARY" : "SELLER_DAILY_SUMMARY",
          contact: conversation.contact,
          reservationId: summary.refKey,
          summary: adminBody,
        });

        replyText = `Listo. ${summary.label} enviado al administrador.\nVisitas: ${summary.visits} · Ventas: ${summary.sales}`;
      } else if (event) {
        await createSellerEvent({
          conversationId,
          contactId: conversation.contactId,
          type: event.type,
          rawText: lastInboundText,
          data: event.data,
        });

        if (event.type === "VISIT") {
          replyText =
            "Visita registrada.\n" +
            "Si quieres, agrega: comuna/sector, resultado (interesado/no interesado) y próximo paso.";
        } else {
          const amount = typeof event.data?.amountClp === "number" ? ` ($${event.data.amountClp} CLP)` : "";
          replyText =
            `Venta registrada${amount}.\n` +
            "Si quieres, agrega: producto/plan, cantidad y si quedó pago/pendiente.";
        }
      } else {
        const fallbackPitch =
          "Pitch corto (Postulaciones):\n" +
          "Hola, ¿cómo estás? Trabajo con Postulaciones y estoy ayudando a personas/negocios a resolver [necesidad] de forma simple.\n" +
          "En 20 segundos: te muestro el beneficio principal, el precio/plan y coordinamos el siguiente paso.\n" +
          "¿Te interesaría que te cuente en 1 minuto y ver si calza contigo?";
        const fallbackObjection =
          "Objeción precio (respuesta corta):\n" +
          "Te entiendo. Para que lo compares bien: lo clave es [beneficio principal] y [ahorro/resultado].\n" +
          "¿Qué te importa más: bajar el costo mensual o maximizar el resultado?";
        const fallbackHelp =
          "Puedo ayudarte con:\n" +
          "- Pitch/guiones\n" +
          "- Respuestas a objeciones\n" +
          "- Registrar visita/venta (escribe: \"registro visita ...\" o \"registro venta ...\")\n" +
          "- Resumen diario/semanal (pídeme \"resumen diario\" o \"resumen semanal\")\n" +
          "¿Qué necesitas ahora?";

        if (!canUseSalesAi) {
          if (pitchRequest) replyText = fallbackPitch;
          else if (/\b(objecion|objeción|caro|precio)\b/.test(lastInboundLower)) replyText = fallbackObjection;
          else replyText = fallbackHelp;
        } else {
          const history = await prisma.message.findMany({
            where: { conversationId },
            orderBy: { timestamp: "desc" },
            take: 28,
          });
          const lines = history
            .slice()
            .reverse()
            .map((m) => {
              const line = buildAiMessageText(m);
              return m.direction === "INBOUND" ? `Vendedor: ${line}` : `Hunter: ${line}`;
            })
            .join("\n");
          const taskHint = pitchRequest
            ? "Tarea: generar un pitch corto."
            : /\b(objecion|objeción|caro|precio)\b/.test(lastInboundLower)
              ? "Tarea: responder objeción de precio."
              : "Tarea: responder y ayudar al vendedor.";
          const context = `${taskHint}\n\n${lines || `Vendedor: ${lastInboundText}`}`.trim();
          try {
            const suggestionRaw = await getSuggestedReply(context, {
              prompt: salesPrompt,
              model:
                normalizeModelId(config.aiModel?.trim() || DEFAULT_AI_MODEL) || DEFAULT_AI_MODEL,
              config,
            });
            const cleaned = (suggestionRaw || "").trim();
            replyText = cleaned.length > 0 ? cleaned : fallbackHelp;
          } catch (err: any) {
            app.log.warn({ err }, "Sales AI reply failed; using fallback");
            replyText = pitchRequest ? fallbackPitch : fallbackHelp;
          }
        }
      }

      if (!replyText) return;

      let sendResultRaw: SendResult = { success: false, error: "waId is missing" };
      if (waId) {
        sendResultRaw = await sendWhatsAppText(waId, replyText, { phoneNumberId });
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
          text: replyText,
          rawPayload: serializeJson({ autoReply: true, mode: "SELLER", sendResult: normalizedSendResult }),
          timestamp: new Date(),
          read: true,
        },
      });
      return;
    }

    const context = conversation.messages
      .map((m) => {
        const line = buildAiMessageText(m);
        return m.direction === "INBOUND" ? `Candidato: ${line}` : `Agente: ${line}`;
      })
      .join("\n");

    let prompt = config.aiPrompt?.trim() || DEFAULT_AI_PROMPT;
    let model: string | undefined =
      normalizeModelId(config.aiModel?.trim() || DEFAULT_AI_MODEL) || DEFAULT_AI_MODEL;
    if (mode === "RECRUIT") {
      const jobSheet = String((config as any)?.recruitJobSheet || "").trim();
      const faq = String((config as any)?.recruitFaq || "").trim();
      const jobPart = jobSheet ? `\n\nFicha del cargo (editable):\n${truncateText(jobSheet, 2000)}` : "";
      const faqPart = faq ? `\n\nFAQ (editable):\n${truncateText(faq, 1500)}` : "";
      if (jobPart || faqPart) {
        prompt = `${prompt}${jobPart}${faqPart}`.trim();
      }
    }
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

    const lastInboundText = (lastInbound?.transcriptText || lastInbound?.text || "").trim();
    const lastInboundLower = stripAccents(lastInboundText).toLowerCase();
    const parsedInbound = lastInboundText ? parseDayTime(lastInboundText) : { day: null, time: null };
    const hasExplicitYesNo =
      /\bconfirm(o|ar)?\b/.test(lastInboundLower) ||
      /^(si|sí|ok|dale|listo|perfecto)\b/.test(lastInboundLower) ||
      /\b(no puedo|me sirve|de acuerdo)\b/.test(lastInboundLower) ||
      /^no\s*[,!.?¿¡]*\s*$/.test(lastInboundLower) ||
      /^no\b(?!\s+tengo\b)/.test(lastInboundLower);
    const hasInterviewSignal = Boolean(parsedInbound.day || parsedInbound.time) || hasExplicitYesNo;

    const allowInterviewActions = mode === "INTERVIEW" && hasInterviewSignal;
    if (allowInterviewActions && actions.length > 0) {
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
            interviewStatus: true,
          },
        });
        if (convo?.interviewStatus === "CONFIRMED") {
          suggestionText = buildInterviewConfirmedReply({
            day: convo?.interviewDay || null,
            time: convo?.interviewTime || null,
            location: convo?.interviewLocation || config.defaultInterviewLocation || null,
            config,
          });
        }
      }
    }

    let sendResultRaw: SendResult = {
      success: false,
      error: "waId is missing",
    };
    if (waId) {
      sendResultRaw = await sendWhatsAppText(waId, suggestionText, { phoneNumberId });
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
      include: { contact: true, messages: { orderBy: { timestamp: "desc" }, take: 60 } },
    });
    if (
      convoForNotif &&
      !convoForNotif.isAdmin &&
      convoForNotif.aiMode === "RECRUIT" &&
      suggestionText.toLowerCase().includes("equipo revisará")
    ) {
      const inboundMessages = (convoForNotif.messages || []).filter((m) => m.direction === "INBOUND");
      const assessment = assessRecruitmentReadiness(convoForNotif.contact, inboundMessages);
      const summary = assessment.summary || "Datos mínimos recibidos.";
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

function looksLikeCvText(text: string): boolean {
  const cleaned = normalizeExtractedText(text || "");
  const lower = stripAccents(cleaned).toLowerCase();
  if (!lower) return false;
  if (/\b(curriculum|curriculum vitae|curr[ií]culum|cv|vitae|hoja de vida)\b/.test(lower)) return true;
  const score = [
    Boolean(extractChileRut(cleaned)),
    Boolean(extractEmail(cleaned)),
    Boolean(extractLocation(cleaned)),
    Boolean(extractExperienceSnippet(cleaned)),
    Boolean(extractAvailabilitySnippet(cleaned)),
  ].filter(Boolean).length;
  return score >= 2;
}

function looksLikeNutritionLabelText(text: string): boolean {
  const cleaned = normalizeExtractedText(text || "");
  const lower = stripAccents(cleaned).toLowerCase();
  if (!lower) return false;
  return (
    /\b(informacion nutricional|informacion nutricional|ingredientes|calorias|kcal|proteinas|grasas|carbohidratos|porcion|porción|azucares|azúcares|sodio)\b/.test(
      lower,
    ) && lower.length < 2000
  );
}

function looksLikeAddressText(text: string): boolean {
  const cleaned = normalizeExtractedText(text || "");
  const lower = stripAccents(cleaned).toLowerCase();
  if (!lower) return false;
  if (/\b(calle|av|avenida|piso|oficina|dept|departamento|nro|numero|número|esquina|sector)\b/.test(lower)) return true;
  if (/\b\d{1,4}\b/.test(lower) && /\b([a-z]{3,})\b/.test(lower)) return true;
  return false;
}

function formatInterviewSummary(conversation: any): string | null {
  const day = conversation?.interviewDay || null;
  const time = conversation?.interviewTime || null;
  const location = conversation?.interviewLocation || null;
  if (!day && !time && !location) return null;
  const parts = [
    day && time ? `${day} ${time}` : day ? day : time ? time : null,
    location ? location : null,
  ].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(", ") : null;
}

function sanitizeInterviewLocationLabel(value?: string | null): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const lower = stripAccents(raw).toLowerCase();
  if (lower.includes("direccion exacta") || lower.includes("dirección exacta")) return null;
  if (lower.includes("te enviaremos") && lower.includes("direccion")) return null;
  return raw;
}

function buildInterviewConfirmedReply(params: {
  day: string | null;
  time: string | null;
  location: string | null;
  config: SystemConfig;
}): string {
  const dayText = params.day || "día por definir";
  const timeText = params.time || "hora por definir";
  const label = sanitizeInterviewLocationLabel(params.location) || "el lugar indicado";
  const exact = formatInterviewExactAddress(params.config, label);

  const base = `✅ Confirmado. Quedamos para ${dayText} a las ${timeText} en ${label}.`;
  if (exact) return `${base}\n${exact}`;
  return `${base}\nTe enviaremos la dirección exacta por este medio.`;
}

async function maybeHandleContextualAttachmentReply(params: {
  app: FastifyInstance;
  conversation: any;
  conversationId: string;
  waId: string | null | undefined;
  mode: string;
  extractedText: string;
}): Promise<boolean> {
  const { app, conversation, conversationId, waId, mode, extractedText } = params;
  const cleaned = normalizeExtractedText(extractedText || "");
  if (!cleaned) return false;
  const phoneLine = conversation?.phoneLineId
    ? await prisma.phoneLine
        .findUnique({ where: { id: conversation.phoneLineId }, select: { waPhoneNumberId: true } })
        .catch(() => null)
    : null;
  const phoneNumberId = phoneLine?.waPhoneNumberId || null;

  if (mode === "RECRUIT") {
    const inboundMessages = (conversation.messages || []).filter((m: any) => m.direction === "INBOUND");
    const assessment = assessRecruitmentReadiness(conversation.contact, inboundMessages);
    const hasAnyData =
      Boolean(assessment.fields.location) ||
      Boolean(assessment.fields.rut) ||
      Boolean(assessment.fields.experience) ||
      Boolean(assessment.fields.availability) ||
      Boolean(assessment.fields.email);

    const looksLikeCv = looksLikeCvText(cleaned);
    const looksLikeNutrition = looksLikeNutritionLabelText(cleaned);
    const looksLikeAddress = looksLikeAddressText(cleaned);
    const detected: string[] = [];
    if (assessment.fields.name) detected.push(`Nombre: ${assessment.fields.name}`);
    if (assessment.fields.location) detected.push(`Comuna/Ciudad: ${assessment.fields.location}`);
    if (assessment.fields.rut) detected.push(`RUT: ${assessment.fields.rut}`);
    if (assessment.fields.experience) detected.push(`Experiencia: ${assessment.fields.experience}`);
    if (assessment.fields.availability) detected.push(`Disponibilidad: ${assessment.fields.availability}`);
    if (assessment.fields.email) detected.push(`Email: ${assessment.fields.email}`);

    const missing: string[] = [];
    if (!assessment.fields.name) missing.push("nombre y apellido");
    if (!assessment.fields.location) missing.push("comuna/ciudad");
    if (!assessment.fields.rut) missing.push("RUT");
    if (!assessment.fields.experience) missing.push("experiencia en ventas (años/rubros/terreno)");
    if (!assessment.fields.availability) missing.push("disponibilidad");

    let replyText: string;
    if (looksLikeCv || hasAnyData) {
      const detectedText = detected.length > 0 ? detected.join(" | ") : "No logré identificar datos clave.";
      if (missing.length === 0) {
        replyText =
          `Gracias, pude leer tu adjunto. Detecté: ${detectedText}.\n` +
          "Con eso ya tengo los datos mínimos. El equipo revisará tu postulación y te contactará por este medio.";
      } else {
        replyText =
          `Gracias, pude leer tu adjunto. Detecté: ${detectedText}.\n` +
          `Para completar, me falta: ${missing.join(", ")}.\n` +
          "¿Me lo puedes escribir en un solo mensaje, por favor?";
      }
    } else {
      let hint = "un archivo";
      if (looksLikeNutrition) hint = "una etiqueta nutricional / información de producto";
      else if (looksLikeAddress) hint = "una dirección/ubicación";
      replyText =
        `Gracias, recibí tu adjunto. Por lo que veo, parece ${hint}.\n` +
        "Para postular, necesito tu CV (ideal) o que me escribas en un solo mensaje: nombre y apellido, comuna/ciudad, RUT, experiencia en ventas y disponibilidad para empezar.";
    }

    let sendResultRaw: SendResult = { success: false, error: "waId is missing" };
    if (waId) {
      sendResultRaw = await sendWhatsAppText(waId, replyText, { phoneNumberId });
    }
    const normalizedSendResult = {
      success: sendResultRaw.success,
      messageId: "messageId" in sendResultRaw ? (sendResultRaw.messageId ?? null) : null,
      error: "error" in sendResultRaw ? (sendResultRaw.error ?? null) : null,
    };
    await prisma.message.create({
      data: {
        conversationId,
        direction: "OUTBOUND",
        text: replyText,
        rawPayload: serializeJson({ autoReply: true, attachmentContextual: true, mode: "RECRUIT", sendResult: normalizedSendResult }),
        timestamp: new Date(),
        read: true,
      },
    });
    return true;
  }

  if (mode === "INTERVIEW") {
    const parsed = parseDayTime(cleaned);
    const hasScheduleDetails = Boolean(parsed.day || parsed.time);
    const looksLikeCv = looksLikeCvText(cleaned);
    const looksLikeNutrition = looksLikeNutritionLabelText(cleaned);
    const looksLikeAddress = looksLikeAddressText(cleaned);

    const currentSummary = formatInterviewSummary(conversation);
    const currentAsk = currentSummary
      ? `Para coordinar, ¿confirmas ${currentSummary} o necesitas reagendar?`
      : "Para coordinar la entrevista, ¿qué día y hora te acomodan? Si puedes, dame 2 alternativas.";

    let hint = "un archivo";
    if (looksLikeNutrition) hint = "una etiqueta nutricional / información de producto";
    else if (looksLikeAddress) hint = "una dirección/ubicación";
    else if (looksLikeCv) hint = "un CV/documento de postulación";
    else if (hasScheduleDetails) hint = "información de fecha/hora";

    let replyText: string;
    if (hasScheduleDetails) {
      const parts = [
        parsed.day && parsed.time ? `${parsed.day} ${parsed.time}` : parsed.day ? parsed.day : parsed.time ? parsed.time : null,
      ].filter(Boolean) as string[];
      const extractedSchedule = parts.join(" ");
      replyText =
        `Gracias, pude leer tu adjunto. Veo ${hint}${extractedSchedule ? `: ${extractedSchedule}` : ""}.\n` +
        (currentSummary
          ? `Lo que tengo agendado ahora es: ${currentSummary}.\n¿Quieres mantenerlo o cambiarlo? Si quieres cambiarlo, indícame 2 alternativas (día y hora).`
          : "¿Me confirmas si esa fecha/hora es la que quieres para la entrevista? Si no, indícame 2 alternativas (día y hora).");
    } else if (looksLikeAddress) {
      replyText =
        `Gracias, pude leer tu adjunto. Parece ${hint}.\n` +
        `${currentAsk}\nSi quieres cambiar la dirección/lugar, dime el lugar exacto o el nombre del punto de referencia.`;
    } else if (looksLikeCv) {
      replyText =
        `Gracias, pude leer tu adjunto. Parece ${hint}.\n` +
        `${currentAsk}\nSi necesitas cambiar la entrevista, indícame 2 alternativas (día y hora).`;
    } else {
      replyText =
        `Gracias, pude leer tu adjunto, pero parece ${hint} y no veo información directa sobre la entrevista.\n` +
        "¿Querías enviarme tu CV o algo sobre la entrevista?\n" +
        currentAsk;
    }

    let sendResultRaw: SendResult = { success: false, error: "waId is missing" };
    if (waId) {
      sendResultRaw = await sendWhatsAppText(waId, replyText, { phoneNumberId });
    }
    const normalizedSendResult = {
      success: sendResultRaw.success,
      messageId: "messageId" in sendResultRaw ? (sendResultRaw.messageId ?? null) : null,
      error: "error" in sendResultRaw ? (sendResultRaw.error ?? null) : null,
    };
    await prisma.message.create({
      data: {
        conversationId,
        direction: "OUTBOUND",
        text: replyText,
        rawPayload: serializeJson({ autoReply: true, attachmentContextual: true, mode: "INTERVIEW", sendResult: normalizedSendResult }),
        timestamp: new Date(),
        read: true,
      },
    });
    return true;
  }

  if (mode === "SELLER") {
    const snippet = truncateText(cleaned, 1200);
    const replyText =
      `Leí tu adjunto y pude extraer este texto:\n\n${snippet}\n\n` +
      "¿Qué necesitas hacer con esto? (por ejemplo: registrar una visita/venta, preparar una oferta o responder una objeción)";

    let sendResultRaw: SendResult = { success: false, error: "waId is missing" };
    if (waId) {
      sendResultRaw = await sendWhatsAppText(waId, replyText, { phoneNumberId });
    }
    const normalizedSendResult = {
      success: sendResultRaw.success,
      messageId: "messageId" in sendResultRaw ? (sendResultRaw.messageId ?? null) : null,
      error: "error" in sendResultRaw ? (sendResultRaw.error ?? null) : null,
    };
    await prisma.message.create({
      data: {
        conversationId,
        direction: "OUTBOUND",
        text: replyText,
        rawPayload: serializeJson({ autoReply: true, attachmentContextual: true, mode: "SELLER", sendResult: normalizedSendResult }),
        timestamp: new Date(),
        read: true,
      },
    });
    return true;
  }

  return false;
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
  const manualName =
    contact?.candidateNameManual && String(contact.candidateNameManual).trim()
      ? String(contact.candidateNameManual).trim()
      : null;
  const name =
    manualName ||
    (contact?.candidateName && !isSuspiciousCandidateName(contact.candidateName)
      ? String(contact.candidateName)
      : null) ||
    null;

  const texts = inboundMessages
    .map((m) => (m.transcriptText || m.text || "").trim())
    .filter(Boolean);

  const rut = findFirstValue(texts, extractChileRut);
  const email = findFirstValue(texts, extractEmail);
  const location = findFirstValue(texts, extractLocation) || (name ? findFirstValue(texts, extractLocationLoose) : null);
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

function titleCaseLocation(value: string): string {
  const tokens = value
    .replace(/\//g, " / ")
    .replace(/,/g, " , ")
    .replace(/-/g, " - ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      if (token === "/" || token === "," || token === "-") return token;
      return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
    });
  return tokens
    .join(" ")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLocationText(value: string): string | null {
  if (!value) return null;
  let cleaned = value
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-*•]\s*/, "");
  if (!cleaned) return null;

  // Stop at other labeled fields to avoid swallowing the whole message.
  const stop = /\b(rut|run|correo|email|mail|experiencia|disponibilidad|edad|telefono|tel[ée]fono|celular|direcci[oó]n)\b/i;
  const stopMatch = stop.exec(cleaned);
  if (stopMatch?.index != null && stopMatch.index > 0) {
    cleaned = cleaned.slice(0, stopMatch.index).trim();
  }

  cleaned = cleaned
    .replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ\s\/,.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;

  return titleCaseLocation(cleaned);
}

function extractLocation(text: string): string | null {
  if (!text) return null;
  const labelMatch = text.match(
    /\b(?:comuna|ciudad|localidad|sector|zona)\s*[:\-]\s*([^\n|]{2,80})/i,
  );
  if (labelMatch?.[1]) {
    return normalizeLocationText(labelMatch[1]) || labelMatch[1].trim();
  }
  const verbMatch = text.match(
    /\b(?:vivo|resido|soy)\s+(?:en|de)\s+([^\n|]{2,80})/i,
  );
  if (verbMatch?.[1]) {
    return normalizeLocationText(verbMatch[1]) || verbMatch[1].trim();
  }

  const compact = text.replace(/\s+/g, " ").trim();
  if (
    compact.length <= 60 &&
    /^[A-Za-zÁÉÍÓÚáéíóúÑñ\s\/,.-]+$/.test(compact) &&
    (compact.includes("/") || compact.includes(","))
  ) {
    return normalizeLocationText(compact) || compact;
  }

  return null;
}

function extractLocationLoose(text: string): string | null {
  if (!text) return null;
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact || compact.length > 60) return null;
  if (!/^[A-Za-zÁÉÍÓÚáéíóúÑñ\s\/,.-]+$/.test(compact)) return null;

  const strict = extractLocation(compact);
  if (strict) return strict;

  const lower = stripAccents(compact).toLowerCase();
  const locationHints = [
    "santiago",
    "rm",
    "metropolitana",
    "providencia",
    "nunoa",
    "ñuñoa",
    "maipu",
    "maipú",
    "las condes",
    "vitacura",
    "la reina",
    "puente alto",
    "valparaiso",
    "valparaíso",
    "concon",
    "concón",
    "vina",
    "viña",
    "quilpue",
    "quilpué",
  ];
  if (locationHints.some((hint) => lower.includes(stripAccents(hint)))) {
    return normalizeLocationText(compact) || compact;
  }

  const words = lower.split(/\s+/).filter(Boolean);
  const locationStarters = new Set(["la", "las", "los", "san", "santa", "villa", "puente"]);
  if (words.length >= 2 && locationStarters.has(words[0])) {
    return normalizeLocationText(compact) || compact;
  }

  return null;
}

function extractExperienceSnippet(text: string): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (/no tengo experiencia|sin experiencia/.test(lower)) return "sin experiencia";

  const labeled = text.match(/\b(?:experiencia|exp)\s*[:\-]\s*([^\n|]{3,160})/i);
  if (labeled?.[1]) {
    return truncateText(labeled[1].replace(/\s+/g, " ").trim(), 110);
  }

  const yearsMatch = text.match(/\b(\d{1,2})\s*(?:año|años)\b/i);
  const years = yearsMatch?.[1] ? `${yearsMatch[1]} años` : null;
  const hasTerrain = /\b(terreno|en terreno|puerta a puerta|p2p)\b/i.test(text);
  const rubroMatch = text.match(/\bventas\s+(?:de|en)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ]{3,30}(?:\s+[A-Za-zÁÉÍÓÚáéíóúÑñ]{3,30})?)/i);
  const rubros: string[] = [];
  if (hasTerrain) rubros.push("terreno");
  if (rubroMatch?.[1]) rubros.push(rubroMatch[1].replace(/\s+/g, " ").trim());

  if (years) {
    const extra = rubros.length > 0 ? ` (${rubros.join(", ")})` : "";
    return `${years}${extra}`.trim();
  }

  if (rubros.length > 0) {
    return `ventas (${rubros.join(", ")})`;
  }

  if (/experienc/.test(lower)) return "con experiencia";
  if (/trabaj|ventas/.test(lower)) return "menciona trabajo/ventas";
  return null;
}

function extractAvailabilitySnippet(text: string): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  const labeled = text.match(/\b(?:disponibilidad|disponible)\s*[:\-]\s*([^\n|]{3,120})/i);
  if (labeled?.[1]) {
    return truncateText(labeled[1].replace(/\s+/g, " ").trim(), 90);
  }
  if (/inmediata|inmediato/.test(lower)) return "inmediata";
  if (/disponibil/.test(lower)) return "menciona disponibilidad";
  if (/full\s*time|part\s*time/.test(lower)) return "full/part time";
  if (/turno|horario/.test(lower)) return "menciona horario";
  return null;
}

function normalizeStage(raw: string | null | undefined): WorkflowStage {
  const value = String(raw || "").trim().toUpperCase();
  const allowed: WorkflowStage[] = [
    "NEW_INTAKE",
    "WAITING_CANDIDATE",
    "RECRUIT_COMPLETE",
    "DISQUALIFIED",
    "STALE_NO_RESPONSE",
    "ARCHIVED",
  ];
  const hit = allowed.find((s) => s === value);
  return hit || "NEW_INTAKE";
}

async function applyRecruitmentWorkflowRules(
  app: FastifyInstance,
  conversationId: string,
  config: SystemConfig,
): Promise<void> {
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      contact: true,
      messages: { orderBy: { timestamp: "asc" } },
    },
  });
  if (!convo || convo.isAdmin) return;
  if (String(convo.conversationStage || "").toUpperCase() === "ARCHIVED") return;
  if ((convo.aiMode || "RECRUIT") !== "RECRUIT") return;

  const inboundMessages = (convo.messages || []).filter((m) => m.direction === "INBOUND");
  const assessment = assessRecruitmentReadiness(convo.contact, inboundMessages);
  const missing: string[] = [];
  if (!assessment.fields.name) missing.push("name");
  if (!assessment.fields.location) missing.push("location");
  if (!assessment.fields.rut) missing.push("rut");
  if (!assessment.fields.experience) missing.push("experience");
  if (!assessment.fields.availability) missing.push("availability");

  const hasAnyRecruitData =
    Boolean(assessment.fields.location) ||
    Boolean(assessment.fields.rut) ||
    Boolean(assessment.fields.experience) ||
    Boolean(assessment.fields.availability) ||
    Boolean(assessment.fields.email);
  const hasAskedForRecruitData = (convo.messages || []).some((m) => {
    if (m.direction !== "OUTBOUND") return false;
    const lower = stripAccents(String(m.text || "")).toLowerCase();
    if (lower.includes("para postular") && lower.includes("en un solo mensaje")) return true;
    try {
      const payload = m.rawPayload ? JSON.parse(m.rawPayload) : null;
      if (payload?.recruitFlow && String(payload.recruitFlow).includes("APPLY_REQUEST")) return true;
    } catch {
      // ignore
    }
    return false;
  });

  const stage = normalizeStage(convo.conversationStage);
  const rules = loadWorkflowRules(config);
  const contextMissing = assessment.ready ? [] : hasAnyRecruitData || hasAskedForRecruitData ? missing : [];

  for (const rule of rules) {
    const matched = matchRule({
      rule,
      trigger: "onRecruitDataUpdated",
      stage,
      minimumComplete: assessment.ready,
      missingFields: contextMissing,
      inactivityDays: null,
    });
    if (!matched) continue;

    const now = new Date();
    const nextStage = rule.actions.setStage ? normalizeStage(rule.actions.setStage) : stage;
    const nextStatus =
      rule.actions.setStatus && ["NEW", "OPEN", "CLOSED"].includes(rule.actions.setStatus)
        ? rule.actions.setStatus
        : convo.status;

    if (nextStage !== stage || nextStatus !== convo.status) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          conversationStage: nextStage,
          stageReason: `RULE:${rule.id}`,
          status: nextStatus,
          updatedAt: now,
        },
      });
    }

    if (rule.actions.notifyAdmin === "RECRUIT_READY" && assessment.ready) {
      await sendAdminNotification({
        app,
        eventType: "RECRUIT_READY",
        contact: convo.contact,
        summary: assessment.summary,
      });
    }
    break;
  }
}

function buildInboundText(text?: string, media?: InboundMedia | null): string {
  const trimmed = (text || "").trim();
  if (trimmed) return trimmed;
  const mediaLabel = renderMediaLabel(media);
  return mediaLabel || "(mensaje recibido)";
}

function buildPolicyText(
  params: Pick<InboundMessageParams, "text" | "media">,
  message?: {
    mediaType?: string | null;
    text?: string | null;
    transcriptText?: string | null;
  } | null,
): string {
  const rawText = (params.text || "").trim();
  const caption = (params.media?.caption || "").trim();
  const mediaType = message?.mediaType || params.media?.type || null;

  if (mediaType === "audio" || mediaType === "voice") {
    return (message?.transcriptText || message?.text || rawText || caption || "").trim();
  }

  if (mediaType === "image" || mediaType === "document" || mediaType === "sticker") {
    return (rawText || caption || "").trim();
  }

  return (message?.text || rawText || "").trim();
}

function truncateText(text: string, maxLength: number): string {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function buildAiMessageText(m: {
  text?: string | null;
  transcriptText?: string | null;
  mediaType?: string | null;
}): string {
  const base = (m.text || "").trim();
  const transcript = (m.transcriptText || "").trim();
  if (!transcript || transcript === base) return base || "(sin texto)";
  if (m.mediaType === "audio" || m.mediaType === "voice") return transcript || base || "(sin texto)";
  const snippet = truncateText(transcript, 2000);
  if (!base) return `[Adjunto transcrito]\n${snippet}`;
  return `${base}\n[Adjunto transcrito]\n${snippet}`;
}

function isAttachmentSummaryRequest(text: string): boolean {
  const normalized = stripAccents((text || "").trim()).toLowerCase();
  if (!normalized) return false;
  return (
    /(?:que|qué)\s+(?:dice|trae|contiene)/.test(normalized) ||
    /(?:que|qué)\s+informaci[oó]n/.test(normalized) ||
    /\b(resume|resumen|resumir|analiza|analizar|leer|transcrib|ocr)\b/.test(normalized)
  );
}

function guessNameFromDocumentText(text: string): string | null {
  if (!text) return null;
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.slice(0, 12)) {
    const normalized = normalizeName(line);
    if (!normalized) continue;
    if (!isValidName(normalized)) continue;
    if (containsDataLabel(normalized)) continue;
    if (isSuspiciousCandidateName(normalized)) continue;
    return normalized;
  }
  return null;
}

function extractPhoneSnippet(text: string): string | null {
  if (!text) return null;
  const match = text.match(/\+?\d{9,15}/);
  if (!match) return null;
  return match[0];
}

function buildAdminAttachmentSummary(extractedText: string): string {
  const cleaned = normalizeExtractedText(extractedText || "");
  const labeledParts = extractLabeledNameParts(cleaned);
  const nameFromLabels = buildCandidateNameFromLabels({
    existingCandidate: null,
    display: null,
    labeledParts,
  });
  const name = nameFromLabels || extractNameFromText(cleaned) || guessNameFromDocumentText(cleaned);
  const rut = extractChileRut(cleaned);
  const email = extractEmail(cleaned);
  const phone = extractPhoneSnippet(cleaned);
  const location = extractLocation(cleaned);
  const experience = extractExperienceSnippet(cleaned);
  const availability = extractAvailabilitySnippet(cleaned);

  const lines = [
    "📎 Resumen del adjunto (basado en texto extraído):",
    `- Nombre: ${name || "No aparece"}`,
    `- RUT: ${rut || "No aparece"}`,
    `- Email: ${email || "No aparece"}`,
    `- Teléfono: ${phone || "No aparece"}`,
    `- Comuna/Ciudad: ${location || "No aparece"}`,
    `- Experiencia: ${experience || "No aparece"}`,
    `- Disponibilidad: ${availability || "No aparece"}`,
    "",
    "Fragmento:",
    truncateText(cleaned, 450) || "(sin texto)",
  ];
  return lines.join("\n");
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

function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeBase64Payload(value: string): Buffer | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const base64 = trimmed.includes("base64,") ? trimmed.split("base64,").pop() || "" : trimmed;
  if (!base64) return null;
  try {
    return Buffer.from(base64, "base64");
  } catch {
    return null;
  }
}

async function extractTextFromPdfBuffer(buffer: Buffer): Promise<string | null> {
  const mod: any = await import("pdf-parse");

  if (typeof mod?.PDFParse === "function") {
    const parser = new mod.PDFParse(new Uint8Array(buffer));
    const rawResult = await parser.getText();
    const raw =
      typeof rawResult === "string"
        ? rawResult
        : typeof rawResult?.text === "string"
          ? rawResult.text
          : "";
    const normalized = normalizeExtractedText(raw);
    return normalized.length > 0 ? normalized : null;
  }

  const pdfParseCandidate = mod?.default || mod;
  if (typeof pdfParseCandidate === "function") {
    const result = await pdfParseCandidate(buffer);
    const raw = typeof result?.text === "string" ? result.text : typeof result === "string" ? result : "";
    const normalized = normalizeExtractedText(raw);
    return normalized.length > 0 ? normalized : null;
  }

  throw new Error("pdf-parse: export inválido");
}

async function extractTextFromDocxBuffer(buffer: Buffer): Promise<string | null> {
  const mod: any = await import("mammoth");
  const mammoth = mod?.default || mod;
  const result = await mammoth.extractRawText({ buffer });
  const raw = typeof result?.value === "string" ? result.value : "";
  const normalized = normalizeExtractedText(raw);
  return normalized.length > 0 ? normalized : null;
}

async function extractTextFromImageWithAi(
  buffer: Buffer,
  mimeType: string | null | undefined,
  config: SystemConfig,
  app: FastifyInstance,
): Promise<{ text: string | null; error?: string | null }> {
  try {
    const apiKey = getEffectiveOpenAiKey(config);
    if (!apiKey) return { text: null, error: "Sin clave de OpenAI" };
    const client = new OpenAI({ apiKey });
    const url = `data:${mimeType || "image/jpeg"};base64,${buffer.toString("base64")}`;
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Eres un sistema de OCR. Extrae solo el texto visible en la imagen. " +
            "No inventes ni infieras. Si no hay texto legible, devuelve texto vacío.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Devuelve JSON con {\"text\": \"...\"}." },
            { type: "image_url", image_url: { url } },
          ] as any,
        },
      ],
    });
    const raw = completion.choices?.[0]?.message?.content || "";
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const extracted = typeof parsed?.text === "string" ? parsed.text : "";
    const normalized = normalizeExtractedText(extracted);
    return { text: normalized.length > 0 ? normalized : null };
  } catch (err) {
    app.log.warn({ err }, "Image OCR failed");
    const message = err instanceof Error ? err.message : "OCR falló";
    return { text: null, error: message };
  }
}

async function extractTextFromAttachment(params: {
  mediaType: string;
  mimeType: string | null | undefined;
  buffer: Buffer;
  config: SystemConfig;
  app: FastifyInstance;
}): Promise<{ text: string | null; error?: string | null; method?: string | null }> {
  const { mediaType, mimeType, buffer, config, app } = params;
  const lowerMime = (mimeType || "").toLowerCase();

  if (mediaType === "image") {
    const ocr = await extractTextFromImageWithAi(buffer, mimeType, config, app);
    return { text: ocr.text, error: ocr.error || null, method: ocr.text ? "openai_ocr" : null };
  }

  if (mediaType === "document") {
    try {
      if (lowerMime.includes("pdf")) {
        const text = await extractTextFromPdfBuffer(buffer);
        return { text, method: text ? "pdf_parse" : null, error: text ? null : "Sin texto en PDF" };
      }
      if (
        lowerMime.includes("wordprocessingml") ||
        lowerMime.includes("officedocument") ||
        lowerMime.includes("docx")
      ) {
        const text = await extractTextFromDocxBuffer(buffer);
        return { text, method: text ? "mammoth_docx" : null, error: text ? null : "Sin texto en DOCX" };
      }
      if (lowerMime.startsWith("text/")) {
        const raw = buffer.toString("utf8");
        const normalized = normalizeExtractedText(raw);
        return {
          text: normalized.length > 0 ? normalized : null,
          method: normalized.length > 0 ? "text_plain" : null,
          error: normalized.length > 0 ? null : "Sin texto en archivo",
        };
      }
      return { text: null, error: `Tipo de documento no soportado (${mimeType || "desconocido"})`, method: null };
    } catch (err) {
      app.log.warn({ err, mimeType }, "Document text extraction failed");
      const message = err instanceof Error ? err.message : "Extracción fallida";
      return { text: null, error: message, method: null };
    }
  }

  return { text: null, error: `Media no soportada (${mediaType})`, method: null };
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
  if (!media || !options.waId) return;

  try {
    const inlineBuffer = media.dataBase64 ? decodeBase64Payload(media.dataBase64) : null;
    const hasInline = Boolean(inlineBuffer);
    if (!hasInline) {
      if (!media.id) return;
      if (!options.config?.whatsappToken) return;
    }

    let buffer: Buffer;
    let mimeType: string | null | undefined = media.mimeType || null;

    if (hasInline && inlineBuffer) {
      buffer = inlineBuffer;
    } else {
      const baseUrl = (options.config.whatsappBaseUrl || DEFAULT_WHATSAPP_BASE_URL).replace(
        /\/$/,
        "",
      );
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
      mimeType = mimeType || mediaInfo.mime_type || null;
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

      buffer = Buffer.from(await downloadRes.arrayBuffer());
    }

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

    const existing = await prisma.message.findUnique({ where: { id: options.messageId } });
    const rawPayloadObj = (() => {
      try {
        return existing?.rawPayload ? JSON.parse(existing.rawPayload) : {};
      } catch {
        return { rawPayload: existing?.rawPayload || null };
      }
    })();

    if (media.type === "audio" || media.type === "voice") {
      const transcription = await transcribeAudio(absolutePath, options.config, app);
      if (transcription.text) {
        await prisma.message.update({
          where: { id: options.messageId },
          data: {
            transcriptText: transcription.text,
            text: transcription.text,
            rawPayload: serializeJson({
              ...rawPayloadObj,
              attachment: {
                type: media.type,
                mimeType: mimeType || null,
                filename: media.filename || null,
                sha256: media.sha256 || null,
                sizeBytes: buffer.length,
                extracted: { success: true, method: "openai_transcribe", chars: transcription.text.length },
              },
            }),
          },
        });
      } else {
        await prisma.message.update({
          where: { id: options.messageId },
          data: {
            transcriptText: null,
            rawPayload: serializeJson({
              ...rawPayloadObj,
              attachment: {
                type: media.type,
                mimeType: mimeType || null,
                filename: media.filename || null,
                sha256: media.sha256 || null,
                sizeBytes: buffer.length,
                extracted: {
                  success: false,
                  method: "openai_transcribe",
                  error: transcription.error || "Sin texto",
                },
              },
            }),
          },
        });
      }

      await prisma.conversation
        .update({
          where: { id: options.conversationId },
          data: { updatedAt: new Date() },
        })
        .catch(() => {});
      return;
    }

    if (media.type === "image" || media.type === "document") {
      const extracted = await extractTextFromAttachment({
        mediaType: media.type,
        mimeType,
        buffer,
        config: options.config,
        app,
      });

      const normalized = extracted.text ? normalizeExtractedText(extracted.text) : null;
      const maxChars = 12000;
      const finalText = normalized ? truncateText(normalized, maxChars) : null;
      const truncated = Boolean(normalized && normalized.length > maxChars);

      await prisma.message.update({
        where: { id: options.messageId },
        data: {
          transcriptText: finalText,
          rawPayload: serializeJson({
            ...rawPayloadObj,
            attachment: {
              type: media.type,
              mimeType: mimeType || null,
              filename: media.filename || null,
              sha256: media.sha256 || null,
              sizeBytes: buffer.length,
              extracted: {
                success: Boolean(finalText),
                method: extracted.method || null,
                chars: finalText ? finalText.length : 0,
                truncated,
                error: extracted.error || null,
              },
            },
          }),
        },
      });

      await prisma.conversation
        .update({
          where: { id: options.conversationId },
          data: { updatedAt: new Date() },
        })
        .catch(() => {});
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

function isRecruitChoiceOne(text: string): boolean {
  const normalized = stripAccents(text.trim()).toLowerCase();
  if (!normalized) return false;
  return normalized === "1" || normalized.startsWith("1 ") || /\b(postul|postular|postulacion|postulación)\b/.test(normalized);
}

function isRecruitChoiceTwo(text: string): boolean {
  const normalized = stripAccents(text.trim()).toLowerCase();
  if (!normalized) return false;
  return normalized === "2" || normalized.startsWith("2 ") || /\b(info|informacion|información|detalles|mas info|más info|quiero saber)\b/.test(normalized);
}

function isRecruitApplyIntent(text: string): boolean {
  const normalized = stripAccents(text.trim()).toLowerCase();
  if (!normalized) return false;
  if (/\b(postul|postular|postulacion|postulación|quiero trabajar|quiero el trabajo|quiero aplicar|me interesa postular)\b/.test(normalized)) {
    return true;
  }
  if (extractChileRut(text) || extractEmail(text)) return true;
  return false;
}

function isRecruitInfoIntent(text: string): boolean {
  const normalized = stripAccents(text.trim()).toLowerCase();
  if (!normalized) return false;
  if (isRecruitApplyIntent(text)) return false;
  if (/^(hola|buenas|buenos dias|buenas tardes|buenas noches)\b/.test(normalized)) return true;
  return (
    /\b(info|informacion|información|detalles|de que se trata|de qué se trata|de que trata|de qué trata)\b/.test(normalized) ||
    /\b(quiero saber|me puedes contar|me podr[íi]as contar)\b/.test(normalized)
  );
}

function extractRecruitJobBullets(jobSheet: string): string[] {
  const lines = (jobSheet || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const bullets = lines
    .filter((line) => /^[-*•]\s*\S/.test(line))
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);

  const extra: string[] = [];
  for (const line of lines) {
    if (/^cargo\s*:/i.test(line)) continue;
    if (/^[-*•]\s*\S/.test(line)) continue;
    extra.push(line);
  }

  const merged = [...bullets, ...extra]
    .map((line) => truncateText(line.replace(/\s+/g, " ").trim(), 90))
    .filter(Boolean);

  const unique: string[] = [];
  for (const line of merged) {
    if (!unique.find((item) => stripAccents(item).toLowerCase() === stripAccents(line).toLowerCase())) {
      unique.push(line);
    }
    if (unique.length >= 3) break;
  }
  return unique;
}

function extractRecruitJobTitle(jobSheet: string): string | null {
  const lines = (jobSheet || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.slice(0, 12)) {
    const match = line.match(/^cargo\s*:\s*(.+)$/i);
    if (!match?.[1]) continue;
    const title = truncateText(match[1].replace(/\s+/g, " ").trim(), 60);
    if (title) return title;
  }
  return null;
}

function extractRecruitSafeFacts(jobSheet: string): string[] {
  const lines = (jobSheet || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const find = (re: RegExp) => {
    const hit = lines.find((line) => re.test(stripAccents(line).toLowerCase()));
    if (!hit) return null;
    const cleaned = hit.replace(/^[-*•]\s*/, "").trim();
    return truncateText(cleaned.replace(/\s+/g, " "), 90);
  };

  const rubro =
    find(/\brubro\b/) ||
    find(/\b(servicio|industria|vertical|categoria)\b/) ||
    "Rubro: (por definir)";
  const zona = find(/\bzona\b/) || find(/\b(ciudad|comuna|region|región)\b/) || "Zona: (por definir)";
  const proceso =
    find(/\bproceso\b/) ||
    find(/\b(revisamos|revisar|contactamos|contactar|whatsapp)\b/) ||
    "Proceso: el equipo revisa y contacta por WhatsApp.";

  return [rubro, zona, proceso];
}

function buildRecruitInfoMenuReply(jobTitle: string | null, jobSheet: string): string {
  const title =
    (jobTitle || "").trim() ||
    extractRecruitJobTitle(jobSheet) ||
    "el cargo publicado";
  const facts = extractRecruitSafeFacts(jobSheet).map((line) => `• ${line}`);
  return [
    "Hola, soy el asistente virtual de Postulaciones.",
    `¿Es por el cargo de ${title}?`,
    ...facts.slice(0, 3),
    "Responde: 1) Postular  2) Más info",
  ]
    .slice(0, 6)
    .join("\n");
}

function buildRecruitApplyRequestReply(): string {
  return [
    "Perfecto. Para postular, envíame en un solo mensaje:",
    "• Nombre y apellido",
    "• Comuna/ciudad",
    "• RUT",
    "• Experiencia en ventas (años/rubros/terreno)",
    "• Disponibilidad para empezar (email opcional)",
  ].join("\n");
}

function buildRecruitInfoFollowupReply(jobSheet: string, faq: string): string {
  const safeFacts = extractRecruitSafeFacts(jobSheet).map((line) => `• ${line}`);
  const faqLines = (faq || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 1)
    .map((line) => truncateText(line, 120));

  const body = [...safeFacts.slice(0, 2), ...faqLines.map((line) => `• ${line}`)].slice(0, 3);

  return [
    "Claro. Te cuento lo principal:",
    ...body,
    "¿Qué info necesitas? (requisitos / zona / proceso)",
    "Si quieres postular, responde 1.",
  ]
    .filter(Boolean)
    .slice(0, 6)
    .join("\n");
}

function buildRecruitMissingFieldsReply(missing: string[]): string {
  const missingText = missing.join(", ");
  return `Gracias. Para completar tu postulación, me falta: ${missingText}.\n¿Me lo envías en un solo mensaje, por favor?`;
}

function isAdminRecruitmentSummaryRequest(text: string): boolean {
  const normalized = stripAccents(text.trim()).toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("/")) return false;
  if (/\b(ultimo|último)\s+reclut/.test(normalized)) return true;
  const hasSummary = /\b(resumen|resume|resumir|aplica|aplicar|calza|sirve)\b/.test(normalized);
  const hasRecruit = /\b(reclut|postul|postulación|candidato)\b/.test(normalized) || /\b(ultimo|último)\b/.test(normalized);
  return hasSummary && hasRecruit;
}

function normalizeForFuzzy(value: string): string {
  return stripAccents(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistance(a: string, b: string): number {
  const aa = a || "";
  const bb = b || "";
  if (aa === bb) return 0;
  if (!aa) return bb.length;
  if (!bb) return aa.length;

  const prev = new Array(bb.length + 1).fill(0).map((_, i) => i);
  for (let i = 0; i < aa.length; i++) {
    let current = i + 1;
    const prevDiagonalStart = prev[0];
    prev[0] = current;
    let prevDiagonal = prevDiagonalStart;
    for (let j = 0; j < bb.length; j++) {
      const temp = prev[j + 1];
      const cost = aa[i] === bb[j] ? 0 : 1;
      prev[j + 1] = Math.min(prev[j + 1] + 1, current + 1, prevDiagonal + cost);
      current = prev[j + 1];
      prevDiagonal = temp;
    }
  }
  return prev[bb.length];
}

function fuzzyNameScore(query: string, candidate: string): number {
  const q = normalizeForFuzzy(query);
  const c = normalizeForFuzzy(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  const maxLen = Math.max(q.length, c.length);
  const dist = levenshteinDistance(q, c);
  const stringScore = maxLen > 0 ? 1 - dist / maxLen : 0;

  const qTokens = q.split(" ").filter(Boolean);
  const cTokens = new Set(c.split(" ").filter(Boolean));
  const hit = qTokens.filter((t) => cTokens.has(t)).length;
  const tokenScore = qTokens.length > 0 ? hit / qTokens.length : 0;

  return Math.max(0, Math.min(1, stringScore * 0.7 + tokenScore * 0.3));
}

function extractNameQueryFromAdminText(text: string): string | null {
  const cleaned = normalizeForFuzzy(text)
    .replace(/\+?\d{9,15}\b/g, " ")
    .replace(/\b(reclutamiento|reclutar|reclut|postulacion|postulación|postular|postul)\b/g, " ")
    .replace(/\b(resumen|resume|resumir|ultimo|último|listo|lista|de|del|la|el|para|por|candidato|candidata)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 3) return null;
  return cleaned;
}

async function resolveLastRecruitReadyContact(adminConversationId: string): Promise<{ contactId: string; waId: string; label: string } | null> {
  const lastNotif = await prisma.message.findFirst({
    where: {
      conversationId: adminConversationId,
      direction: "OUTBOUND",
      rawPayload: { contains: "\"adminNotification\":true" },
      text: { contains: "RECRUIT_READY" },
    },
    orderBy: { timestamp: "desc" },
  });
  if (!lastNotif) return null;

  let contactId: string | null = null;
  try {
    const raw = lastNotif.rawPayload ? JSON.parse(lastNotif.rawPayload) : null;
    if (raw && typeof raw.contactId === "string") contactId = raw.contactId;
  } catch {
    contactId = null;
  }
  if (contactId) {
    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    const waId = normalizeWhatsAppId(contact?.waId || contact?.phone || "");
    if (waId) {
      return { contactId, waId, label: getContactDisplayName(contact as any) };
    }
  }

  const waIdFromText = extractWaIdFromText(lastNotif.text || "");
  if (!waIdFromText) return null;
  const convo = await fetchConversationByIdentifier(waIdFromText, { includeMessages: false });
  if (!convo) return null;
  return {
    contactId: convo.contactId,
    waId: waIdFromText,
    label: getContactDisplayName(convo.contact as any),
  };
}

async function findCandidateMatchesByName(params: { query: string; limit?: number; config: SystemConfig }) {
  const limit = typeof params.limit === "number" ? Math.max(1, Math.min(params.limit, 3)) : 3;
  const thresholdDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const adminAllowlist = getAdminWaIdAllowlist(params.config);
  const conversations = await prisma.conversation.findMany({
    where: {
      isAdmin: false,
      updatedAt: { gte: thresholdDate },
      ...(adminAllowlist.length > 0 ? { contact: { waId: { notIn: adminAllowlist } } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 250,
    include: { contact: true },
  });

  const scored = conversations
    .map((c) => {
      const waId = normalizeWhatsAppId(c.contact?.waId || c.contact?.phone || "");
      if (!waId) return null;
      const label = getContactDisplayName(c.contact as any);
      const score = fuzzyNameScore(params.query, label);
      return { waId, label, score, updatedAt: c.updatedAt.toISOString() };
    })
    .filter(Boolean) as Array<{ waId: string; label: string; score: number; updatedAt: string }>;

  return scored
    .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

async function buildAdminRecruitmentSummaryReply(params: {
  adminConversationId: string;
  text: string;
  lastCandidateWaId: string | null;
  config: SystemConfig;
}): Promise<{ replyText: string; resolvedWaId: string | null }> {
  const explicitWaId = extractWaIdFromText(params.text);
  const nameQuery = extractNameQueryFromAdminText(params.text);
  const wantsLastRecruitReady = /\b(ultimo|último)\s+reclut/.test(stripAccents(params.text).toLowerCase());

  const lastRecruitReady = wantsLastRecruitReady
    ? await resolveLastRecruitReadyContact(params.adminConversationId)
    : null;

  if (explicitWaId && nameQuery) {
    const convoByNumber = await fetchConversationByIdentifier(explicitWaId, { includeMessages: false });
    const labelByNumber = convoByNumber ? getContactDisplayName(convoByNumber.contact as any) : null;
    const score = labelByNumber ? fuzzyNameScore(nameQuery, labelByNumber) : 0;
    if (!labelByNumber || score < 0.55) {
      const matches = await findCandidateMatchesByName({ query: nameQuery, config: params.config });
      const lines = matches.map((m, idx) => `${idx + 1}) ${m.label} (+${m.waId})`);
      const extra = lines.length > 0 ? `\n\nCoincidencias por nombre:\n${lines.join("\n")}` : "";
      return {
        resolvedWaId: null,
        replyText:
          `Veo un posible conflicto: indicaste +${explicitWaId} pero el nombre no calza con “${nameQuery}”.\n` +
          `Número indicado: +${explicitWaId}${labelByNumber ? ` (${labelByNumber})` : ""}` +
          `${extra}\n\nResponde con el número correcto (+569...).`,
      };
    }
    // Número y nombre consistentes: usar el número indicado.
  }

  // If the admin explicitly asked for "último reclutamiento", prioritize the latest RECRUIT_READY signal.
  // (Name typos are common; we use the name only as context, not as a selector.)
  let resolvedWaId: string | null =
    explicitWaId ||
    (wantsLastRecruitReady
      ? lastRecruitReady?.waId || null
      : params.lastCandidateWaId || null);

  if (!resolvedWaId && nameQuery) {
    const matches = await findCandidateMatchesByName({ query: nameQuery, config: params.config });
    if (matches.length === 0) {
      if (wantsLastRecruitReady && lastRecruitReady?.waId) {
        resolvedWaId = lastRecruitReady.waId;
      } else {
        return {
          resolvedWaId: null,
          replyText:
            `No encontré candidatos que calcen con “${nameQuery}”.\n` +
            "Envíame el número (+569...) o escribe “último reclutamiento” para usar el más reciente.",
        };
      }
    } else if (matches.length === 1 || (matches[0].score >= 0.78 && matches[0].score - (matches[1]?.score || 0) >= 0.18)) {
      resolvedWaId = matches[0].waId;
    } else {
      const lines = matches.map((m, idx) => `${idx + 1}) ${m.label} (+${m.waId})`);
      return {
        resolvedWaId: null,
        replyText:
          `Encontré varios candidatos parecidos a “${nameQuery}”:\n${lines.join("\n")}\n\n` +
          "Responde con el número correcto (+569...).",
      };
    }
  }

  if (!resolvedWaId && wantsLastRecruitReady && lastRecruitReady?.waId) {
    resolvedWaId = lastRecruitReady.waId;
  }

  if (!resolvedWaId) {
    return {
      resolvedWaId: null,
      replyText:
        "No pude inferir el candidato.\nEnvíame el número (+569...) o escribe “último reclutamiento” para usar el más reciente.",
    };
  }

  const convo = await fetchConversationByIdentifier(resolvedWaId, { includeMessages: true, messageLimit: 80 });
  if (!convo) {
    return { resolvedWaId: null, replyText: `No encontré conversación para +${resolvedWaId}.` };
  }

  const inbound = (convo.messages || []).filter((m: any) => m.direction === "INBOUND");
  const assessment = assessRecruitmentReadiness(convo.contact, inbound);
  const missing: string[] = [];
  if (!assessment.fields.name) missing.push("nombre y apellido");
  if (!assessment.fields.location) missing.push("comuna/ciudad");
  if (!assessment.fields.rut) missing.push("RUT");
  if (!assessment.fields.experience) missing.push("experiencia");
  if (!assessment.fields.availability) missing.push("disponibilidad");

  const statusLine = assessment.ready
    ? "Datos mínimos: OK ✅"
    : `Datos mínimos: incompleto ⚠️ (faltan: ${missing.join(", ")})`;

  const lines = [
    `Resumen reclutamiento: ${getContactDisplayName(convo.contact as any)} (+${resolvedWaId})`,
    statusLine,
    assessment.fields.location ? `Comuna/Ciudad: ${assessment.fields.location}` : null,
    assessment.fields.rut ? `RUT: ${assessment.fields.rut}` : null,
    assessment.fields.experience ? `Experiencia: ${assessment.fields.experience}` : null,
    assessment.fields.availability ? `Disponibilidad: ${assessment.fields.availability}` : null,
    assessment.fields.email ? `Email: ${assessment.fields.email}` : null,
    assessment.ready ? "Recomendación: contactar para coordinar entrevista." : "Recomendación: pedir faltantes y luego contactar.",
  ].filter(Boolean) as string[];

  return { resolvedWaId, replyText: lines.join("\n") };
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
  const displayFromProfile = normalizeName(profileName);
  if (displayFromProfile && displayFromProfile !== contact.displayName) {
    updates.displayName = displayFromProfile;
  }
  const display = displayFromProfile || normalizeName(contact.displayName || null);
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
  const directMatch = cleaned.match(
    /(?:mi nombre es|me llamo)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ\s]{2,60})/i,
  );
  if (directMatch?.[1]) {
    const normalized = normalizeName(directMatch[1]);
    if (
      normalized &&
      isValidName(normalized) &&
      !containsDataLabel(normalized) &&
      !isSuspiciousCandidateName(normalized)
    ) {
      return normalized;
    }
  }

  // Standalone name (high confidence): allow short plain names like "Ignacio González" or "Ignacio, Providencia"
  const firstChunk = cleaned.split(/[\n,;-]/)[0]?.trim() || "";
  const candidateChunk = firstChunk && firstChunk.length < cleaned.length ? firstChunk : cleaned;
  const normalizedLower = stripAccents(candidateChunk).toLowerCase();
  const hasDisqualifyingIntent =
    /\b(tengo|adjunt|env[ií]o|enviar|mando|mand[ée]|quiero|quisiera|necesito|busco|postul|cancel|reagen|reprogra|confirm|disponib)\b/.test(
      normalizedLower,
    ) ||
    /\b(soy\s+de|vivo\s+en|resido\s+en|somos\s+de)\b/.test(normalizedLower) ||
    /\b(info|informacion)\b/.test(normalizedLower) ||
    /\b(cv|curric|curr[íi]cul|vitae|pdf|word|docx|documento|archivo|imagen|foto)\b/.test(
      normalizedLower,
    ) ||
    /\b(calle|avenida|av\\.?|direccion|direcci[oó]n|ubicacion|ubicación|mapa|google|waze|piso|oficina|departamento|dept|esquina|sector|nro|numero|número)\b/.test(
      normalizedLower,
    ) ||
    /\b(informacion nutricional|ingredientes|calorias|kcal|proteinas|grasas|carbohidratos|azucares|azúcares|sodio|porcion|porción)\b/.test(
      normalizedLower,
    );
  if (hasDisqualifyingIntent) return null;
  if (/^[A-Za-zÁÉÍÓÚáéíóúÑñ\s]{2,60}$/.test(candidateChunk)) {
    const normalized = normalizeName(candidateChunk);
    const words = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
    if (
      normalized &&
      words.length >= 2 &&
      isValidName(normalized) &&
      !containsDataLabel(normalized) &&
      !isSuspiciousCandidateName(normalized)
    ) {
      return normalized;
    }
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
  if (/^soy\s+de\b/.test(lower) || /^soy\s+del\b/.test(lower) || /^soy\s+de\s+la\b/.test(lower)) return false;
  if (/^(vivo|resido)\s+en\b/.test(lower)) return false;
  if (stripAccents(lower).includes("informacion") || /\binfo\b/.test(stripAccents(lower))) return false;
  const blacklist = [
    "hola",
    "holi",
    "buenas",
    "buenos",
    "wena",
    "wenas",
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
  const lower = stripAccents(text).toLowerCase();
  if (/(me llamo|mi nombre)/.test(lower)) return true;
  if (/\bsoy\s+(?!de\b|del\b|la\b|el\b|una\b|un\b)/.test(lower)) return true;
  if (/nombre\s*[:\-]/.test(lower)) return true;
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
      ...normalizeChatCreateArgsForModel(
        {
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
        },
        model
      ),
      model,
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
  if (/^soy\s+de\b/.test(lower) || /^soy\s+del\b/.test(lower) || /^soy\s+de\s+la\b/.test(lower)) return true;
  if (/^(vivo|resido)\s+en\b/.test(lower)) return true;
  // Never treat intent/commands as names (prevents candidateName degradation).
  if (/\b(cancelar|cancelacion|cancelación|reagend|reagendar|reprogram|reprogramar|cambiar|cambio|modificar|mover)\b/.test(lower)) {
    return true;
  }
  if (/\b(resumen|reporte|generar|genera|registro|registrar|visita|venta|pitch|onboarding)\b/.test(lower)) {
    return true;
  }
  if (/\b(entrevista|hora|horario|reagendar|reagendemos|reagenden)\b/.test(lower) && /\b(cancelar|cambiar|reagend|reprogram|mover)\b/.test(lower)) {
    return true;
  }
  if (/\b(cv|cb|curric|curr[íi]cul|vitae|adjunt|archivo|documento|imagen|foto|pdf|word|docx)\b/.test(lower)) {
    return true;
  }
  if (/\b(tengo|adjunto|envio|envi[ée]|enviar|mando|mand[ée]|subo)\b/.test(lower)) {
    return true;
  }
  const patterns = [
    "hola quiero postular",
    "hola",
    "quiero postular",
    "postular",
    "mas informacion",
    "más informacion",
    "info",
    "informacion",
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

  const normalized = stripAccents(lower);
  const wantsPause = /\b(en\s+pausa|pausa|mas\s+adelante|m[aá]s\s+adelante|por\s+ahora\s+no)\b/.test(normalized);
  const wantsReschedule =
    /\b(reagend|reagendar|reprogram|reprogramar|cambiar|cambio|modificar|mover|cancelar|cancelacion|cancelación)\b/.test(
      normalized,
    ) && /\b(hora|horario|entrevista)\b/.test(normalized);

  if (isYes && !wantsReschedule && !wantsPause) {
    statusUpdate = "CONFIRMED";
  } else if (wantsPause || wantsReschedule || isNo) {
    statusUpdate = "ON_HOLD";
  }

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

async function refreshPendingBeforeSend(
  action: AdminPendingAction,
  text: string,
  app: FastifyInstance,
  logger: any,
) {
  if (action.type !== "send_template") return;
  const config = await getSystemConfig();
  const templates = await loadTemplateConfig(logger);
  const parsed = parseLooseSchedule(text.toLowerCase());
  let convo = await fetchConversationByIdentifier(action.targetWaId, { includeMessages: false });
  if (parsed && action.mode === "INTERVIEW" && (parsed.day || parsed.time || parsed.location)) {
    if (!convo) {
      throw new Error("No encontré la conversación para preparar la entrevista.");
    }
    if (parsed.day && parsed.time) {
      const scheduleAttempt = await attemptScheduleInterview({
        conversationId: convo.id,
        contactId: convo.contactId,
        day: parsed.day,
        time: parsed.time,
        location: parsed.location,
        config,
      });
      if (!scheduleAttempt.ok) {
        const alternativesText =
          scheduleAttempt.alternatives.length > 0
            ? `\n\nOpciones:\n${scheduleAttempt.alternatives
                .map((slot) => `- ${formatSlotHuman(slot)}`)
                .join("\n")}`
            : "";
        throw new Error(`${scheduleAttempt.message}${alternativesText}`);
      }
      await prisma.conversation.update({
        where: { id: convo.id },
        data: {
          aiMode: "INTERVIEW",
          status: "OPEN",
          interviewDay: scheduleAttempt.slot.day,
          interviewTime: scheduleAttempt.slot.time,
          interviewLocation: scheduleAttempt.slot.location,
          interviewStatus: "PENDING",
        },
      });
      if (scheduleAttempt.kind === "SCHEDULED" || scheduleAttempt.kind === "RESCHEDULED") {
        await sendAdminNotification({
          app,
          eventType:
            scheduleAttempt.kind === "RESCHEDULED" ? "INTERVIEW_RESCHEDULED" : "INTERVIEW_SCHEDULED",
          contact: convo.contact,
          reservationId: scheduleAttempt.reservationId,
          interviewDay: scheduleAttempt.slot.day,
          interviewTime: scheduleAttempt.slot.time,
          interviewLocation: scheduleAttempt.slot.location,
        });
      }
      convo = await fetchConversationByIdentifier(action.targetWaId, { includeMessages: false });
    } else {
      await prisma.conversation.update({
        where: { id: convo.id },
        data: {
          aiMode: "INTERVIEW",
          status: "OPEN",
          ...(parsed.day ? { interviewDay: parsed.day } : {}),
          ...(parsed.time ? { interviewTime: parsed.time } : {}),
          ...(parsed.location ? { interviewLocation: parsed.location } : {}),
          interviewStatus: "PENDING",
        },
      });
      convo = await fetchConversationByIdentifier(action.targetWaId, { includeMessages: false });
    }
  }

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
  const adminConversation = await prisma.conversation
    .findUnique({
      where: { id: adminConversationId },
      select: {
        workspaceId: true,
        phoneLine: { select: { waPhoneNumberId: true } },
      },
    })
    .catch(() => null);
  const workspaceId = adminConversation?.workspaceId || "default";
  const adminPhoneNumberId = adminConversation?.phoneLine?.waPhoneNumberId || null;
  if (pendingAction.targetWaId && pendingAction.type !== "reactivate") {
    const candidates = buildWaIdCandidates(pendingAction.targetWaId);
    const contact = await prisma.contact.findFirst({
      where: {
        workspaceId,
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
          const targetPhoneNumberId = targetConvo
            ? (
                await prisma.conversation
                  .findUnique({
                    where: { id: targetConvo },
                    select: { phoneLine: { select: { waPhoneNumberId: true } } },
                  })
                  .catch(() => null)
              )?.phoneLine?.waPhoneNumberId || null
            : null;
          const sendResult = await sendWhatsAppText(pendingAction.targetWaId, simpleDraft, {
            phoneNumberId: targetPhoneNumberId || adminPhoneNumberId,
          });
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
        workspaceId,
      });
      const success = result.sendResult?.success;
      if (success) {
        await prisma.conversation.updateMany({
          where: { isAdmin: true, workspaceId },
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
      const targetPhoneNumberId = pendingAction.relatedConversationId
        ? (
            await prisma.conversation
              .findUnique({
                where: { id: pendingAction.relatedConversationId },
                select: { phoneLine: { select: { waPhoneNumberId: true } } },
              })
              .catch(() => null)
          )?.phoneLine?.waPhoneNumberId || null
        : null;
      const sendResult = await sendWhatsAppText(pendingAction.targetWaId, pendingAction.text, {
        phoneNumberId: targetPhoneNumberId || adminPhoneNumberId,
      });
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
      const config = await getSystemConfig();
      const convo = await fetchConversationByIdentifier(pendingAction.targetWaId, { includeMessages: false });
      if (!convo) {
        await sendAdminReply(app, adminConversationId, adminWaId, `No encontré la conversación de +${pendingAction.targetWaId}.`);
        return true;
      }
      const day = typeof pendingAction.updates?.interviewDay === "string" ? pendingAction.updates.interviewDay : null;
      const time = typeof pendingAction.updates?.interviewTime === "string" ? pendingAction.updates.interviewTime : null;
      const location =
        typeof pendingAction.updates?.interviewLocation === "string"
          ? pendingAction.updates.interviewLocation
          : null;

      if (day && time) {
        const scheduleAttempt = await attemptScheduleInterview({
          conversationId: convo.id,
          contactId: convo.contactId,
          day,
          time,
          location,
          config,
        });
        if (!scheduleAttempt.ok) {
          const alternativesText =
            scheduleAttempt.alternatives.length > 0
              ? `\n\nOpciones:\n${scheduleAttempt.alternatives.map((slot) => `- ${formatSlotHuman(slot)}`).join("\n")}`
              : "";
          await sendAdminReply(
            app,
            adminConversationId,
            adminWaId,
            `${scheduleAttempt.message}${alternativesText}`,
          );
          return true;
        }

        await prisma.conversation.update({
          where: { id: convo.id },
          data: {
            aiMode: "INTERVIEW",
            status: "OPEN",
            interviewDay: scheduleAttempt.slot.day,
            interviewTime: scheduleAttempt.slot.time,
            interviewLocation: scheduleAttempt.slot.location,
            interviewStatus: "PENDING",
          },
        });

        if (scheduleAttempt.kind === "SCHEDULED" || scheduleAttempt.kind === "RESCHEDULED") {
          await sendAdminNotification({
            app,
            eventType:
              scheduleAttempt.kind === "RESCHEDULED" ? "INTERVIEW_RESCHEDULED" : "INTERVIEW_SCHEDULED",
            contact: convo.contact,
            reservationId: scheduleAttempt.reservationId,
            interviewDay: scheduleAttempt.slot.day,
            interviewTime: scheduleAttempt.slot.time,
            interviewLocation: scheduleAttempt.slot.location,
          });
        }
      } else {
        await prisma.conversation.update({
          where: { id: convo.id },
          data: {
            aiMode: "INTERVIEW",
            status: "OPEN",
            ...(day ? { interviewDay: day } : {}),
            ...(time ? { interviewTime: time } : {}),
            ...(location ? { interviewLocation: location } : {}),
            interviewStatus: "PENDING",
          },
        });
      }
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
    for (const convoId of conversationIds) {
      await archiveConversation({
        conversationId: convoId,
        reason: "TEST_RESET",
        tags: ["TEST"],
        summary: "Reset de pruebas (historial preservado).",
      });
    }
    await prisma.contact.updateMany({
      where: { id: { in: contactIds } },
      data: {
        candidateName: null,
        candidateNameManual: null,
        name: null,
        displayName: null,
        noContact: false,
        noContactAt: null,
        noContactReason: null,
        updatedAt: new Date(),
      },
    }).catch(() => {});
    const primary = contacts[0];
    await prisma.conversation.create({
      data: {
        contactId: primary.id,
        status: "NEW",
        channel: "whatsapp",
        aiMode: "RECRUIT",
      },
    }).catch(() => {});
    await saveAdminPendingAction(adminConversationId, null);
    await sendAdminReply(
      app,
      adminConversationId,
      adminWaId,
      `Conversación de +${target} archivada y reiniciada solo para pruebas (sin borrar historial).`,
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
    try {
      await refreshPendingBeforeSend(pending, text, app, app.log);
      await saveAdminPendingAction(adminConversationId, pending);
    } catch (err: any) {
      await sendAdminReply(
        app,
        adminConversationId,
        adminWaId,
        err?.message || "No pude preparar el envío. Intenta de nuevo.",
      );
      return true;
    }
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
    const convo = await fetchConversationByIdentifier(lastCandidateWaId, { includeMessages: false });
    if (!convo) {
      await sendAdminReply(app, adminConversationId, adminWaId, `No encontré la conversación de +${lastCandidateWaId}.`);
      return true;
    }

    const scheduleAttempt = await attemptScheduleInterview({
      conversationId: convo.id,
      contactId: convo.contactId,
      day: parsedInterview.day,
      time: parsedInterview.time,
      location: parsedInterview.location,
      config,
    });

    if (!scheduleAttempt.ok) {
      const alternativesText =
        scheduleAttempt.alternatives.length > 0
          ? `\n\nOpciones:\n${scheduleAttempt.alternatives
              .map((slot) => `- ${formatSlotHuman(slot)}`)
              .join("\n")}\n\nResponde con una opción (ej: "martes 13:30 en Providencia").`
          : "";
      await sendAdminReply(
        app,
        adminConversationId,
        adminWaId,
        `${scheduleAttempt.message}${alternativesText}`,
      );
      return true;
    }

    await prisma.conversation.update({
      where: { id: convo.id },
      data: {
        aiMode: "INTERVIEW",
        status: "OPEN",
        interviewDay: scheduleAttempt.slot.day,
        interviewTime: scheduleAttempt.slot.time,
        interviewLocation: scheduleAttempt.slot.location,
        interviewStatus: "PENDING",
      },
    });

    if (scheduleAttempt.kind === "SCHEDULED" || scheduleAttempt.kind === "RESCHEDULED") {
      await sendAdminNotification({
        app,
        eventType: scheduleAttempt.kind === "RESCHEDULED" ? "INTERVIEW_RESCHEDULED" : "INTERVIEW_SCHEDULED",
        contact: convo.contact,
        reservationId: scheduleAttempt.reservationId,
        interviewDay: scheduleAttempt.slot.day,
        interviewTime: scheduleAttempt.slot.time,
        interviewLocation: scheduleAttempt.slot.location,
      });
    }

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
    const locationText = scheduleAttempt.slot.location || "Te enviaremos la dirección exacta por este medio.";
    await sendAdminReply(
      app,
      adminConversationId,
      adminWaId,
      `Agendé entrevista: ${scheduleAttempt.slot.day || "día por definir"} a ${
        scheduleAttempt.slot.time || "hora por definir"
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
  if (
    !convo.isAdmin &&
    (nextStatus === "CONFIRMED" ||
      nextStatus === "ON_HOLD" ||
      updates.interviewDay ||
      updates.interviewTime)
  ) {
    data.status = "OPEN";
  }
  await prisma.conversation.update({
    where: { id: convo.id },
    data,
  });

  if (opts?.app && convo.contact && !convo.isAdmin) {
    const statusBecameConfirmed =
      nextStatus === "CONFIRMED" && previous.interviewStatus !== "CONFIRMED";
    const statusBecameCancelled =
      nextStatus === "CANCELLED" && previous.interviewStatus !== "CANCELLED";
    const statusBecameOnHold =
      nextStatus === "ON_HOLD" && previous.interviewStatus !== "ON_HOLD";

    if (statusBecameConfirmed) {
      const reservationUpdate = await confirmActiveReservation(convo.id);
      await sendAdminNotification({
        app: opts.app,
        eventType: "INTERVIEW_CONFIRMED",
        contact: convo.contact,
        reservationId: reservationUpdate.reservationId,
        interviewDay: data.interviewDay,
        interviewTime: data.interviewTime,
        interviewLocation: data.interviewLocation,
      });
    } else if (statusBecameCancelled) {
      const reservationUpdate = await releaseActiveReservation({
        conversationId: convo.id,
        status: "CANCELLED",
      });
      await sendAdminNotification({
        app: opts.app,
        eventType: "INTERVIEW_CANCELLED",
        contact: convo.contact,
        reservationId: reservationUpdate.reservationId,
        interviewDay: data.interviewDay,
        interviewTime: data.interviewTime,
        interviewLocation: data.interviewLocation,
      });
    } else if (statusBecameOnHold) {
      const reservationUpdate = await releaseActiveReservation({
        conversationId: convo.id,
        status: "ON_HOLD",
      });
      await sendAdminNotification({
        app: opts.app,
        eventType: "INTERVIEW_ON_HOLD",
        contact: convo.contact,
        reservationId: reservationUpdate.reservationId,
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
    const workspaceId = String(conversation?.workspaceId || contact?.workspaceId || "default");
    const candidates = buildWaIdCandidates(contact.waId || contact.phone);
    const contacts = await prisma.contact.findMany({
      where: {
        workspaceId,
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
      where: { workspaceId, contactId: { in: contactIds } },
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

    const ackText = "✅ Listo, ya podemos escribirte nuevamente por este medio.";
    let sendResult: SendResult = { success: false, error: "Missing waId" };
    try {
      if (contact.waId) {
        const line = conversation?.phoneLineId
          ? await prisma.phoneLine
              .findUnique({ where: { id: conversation.phoneLineId }, select: { waPhoneNumberId: true } })
              .catch(() => null)
          : null;
        sendResult = await sendWhatsAppText(contact.waId, ackText, { phoneNumberId: line?.waPhoneNumberId || null });
      }
    } catch (err: any) {
      sendResult = { success: false, error: err?.message || "Unknown error" };
      app.log.warn({ err }, "Opt-in ack WA failed");
    }
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "OUTBOUND",
        text: ackText,
        rawPayload: serializeJson({ autoReply: true, optInAck: true, sendResult }),
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
    const workspaceId = String(conversation?.workspaceId || contact?.workspaceId || "default");
    const candidates = buildWaIdCandidates(contact.waId || contact.phone);
    const contacts = await prisma.contact.findMany({
      where: {
        workspaceId,
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
      where: { workspaceId, contactId: { in: contactIds } },
      data: { aiPaused: true },
    });
    if (contact.waId) {
      const line = conversation?.phoneLineId
        ? await prisma.phoneLine
            .findUnique({ where: { id: conversation.phoneLineId }, select: { waPhoneNumberId: true } })
            .catch(() => null)
        : null;
      await sendWhatsAppText(contact.waId, "Entendido, detendremos los mensajes.", {
        phoneNumberId: line?.waPhoneNumberId || null,
      });
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

const PERSONA_MENU_PENDING_TAG = "persona_menu_pending";

function normalizeLooseTag(value: string): string {
  return stripAccents(String(value || "")).toLowerCase().replace(/\s+/g, " ").trim();
}

function parseStageTagsValue(raw: unknown): string[] {
  if (!raw) return [];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => normalizeLooseTag(String(v))).filter(Boolean);
      }
    } catch {
      // ignore
    }
    return trimmed
      .split(/[,\n]/g)
      .map((v) => normalizeLooseTag(v))
      .filter(Boolean);
  }
  return [];
}

function serializeStageTags(tags: string[]): string | null {
  const unique: string[] = [];
  for (const tag of tags) {
    const t = normalizeLooseTag(tag);
    if (!t) continue;
    if (!unique.includes(t)) unique.push(t);
  }
  return unique.length > 0 ? JSON.stringify(unique) : null;
}

function buildPersonaMenuText(allowedKinds: string[]): { text: string; orderedKinds: string[] } {
  const normalized = Array.from(
    new Set(
      (Array.isArray(allowedKinds) ? allowedKinds : [])
        .map((k) => String(k || "").trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  const preferredOrder = ["STAFF", "CLIENT", "PARTNER", "ADMIN"];
  const orderedKinds = [
    ...preferredOrder.filter((k) => normalized.includes(k)),
    ...normalized.filter((k) => !preferredOrder.includes(k)),
  ];
  const label = (k: string) => {
    if (k === "STAFF") return "Staff";
    if (k === "CLIENT") return "Cliente";
    if (k === "PARTNER") return "Proveedor";
    if (k === "ADMIN") return "Admin";
    return k;
  };
  const lines = orderedKinds.map((k, idx) => `${idx + 1}) ${label(k)}`).join("\n");
  const text = `¿En qué modo quieres usar este WhatsApp?\nResponde con el número:\n${lines}\n\nTip: también puedes escribir “modo cliente”, “modo staff” o “modo proveedor”.`;
  return { text, orderedKinds };
}

function resolvePersonaChoice(inboundText: string, orderedKinds: string[]): string | null {
  const normalized = stripAccents(String(inboundText || "")).toLowerCase().trim();
  if (!normalized) return null;
  const numeric = normalized.match(/^(\d{1,2})\b/);
  if (numeric?.[1]) {
    const idx = parseInt(numeric[1], 10);
    if (Number.isFinite(idx) && idx >= 1 && idx <= orderedKinds.length) return orderedKinds[idx - 1];
  }
  if (normalized.includes("cliente")) return orderedKinds.includes("CLIENT") ? "CLIENT" : null;
  if (normalized.includes("staff")) return orderedKinds.includes("STAFF") ? "STAFF" : null;
  if (normalized.includes("proveedor") || normalized.includes("partner") || normalized.includes("aliado"))
    return orderedKinds.includes("PARTNER") ? "PARTNER" : null;
  if (normalized.includes("admin")) return orderedKinds.includes("ADMIN") ? "ADMIN" : null;
  return null;
}

async function maybeHandlePersonaAutoPrompt(
  app: FastifyInstance,
  params: {
    workspaceId: string;
    phoneLineId: string;
    conversation: any;
    contact: any;
    inboundText: string | null;
    effectiveKind: string;
    baseKind: string;
    allowedKinds: string[];
    hasActiveOverride: boolean;
    autoReplyEnabled: boolean;
    ttlMinutes: number;
    allowPersonaSwitch: boolean;
  },
): Promise<boolean> {
  if (!params.allowPersonaSwitch) return false;
  if (!params.conversation?.id) return false;
  const kind = String((params.conversation as any)?.conversationKind || "CLIENT").toUpperCase();
  if (kind !== "STAFF") return false;
  if (params.conversation.isAdmin) return false;

  const allowedKinds = Array.from(
    new Set(
      (Array.isArray(params.allowedKinds) ? params.allowedKinds : [])
        .map((k) => String(k || "").trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  if (allowedKinds.length <= 1) return false;
  if (params.hasActiveOverride) return false;

  const inboundRaw = String(params.inboundText || "");
  const inboundNormalized = stripAccents(inboundRaw).toLowerCase().trim();
  if (!inboundNormalized) return false;
  if (
    inboundNormalized === "modo" ||
    inboundNormalized === "roles" ||
    inboundNormalized === "rol" ||
    inboundNormalized === "cambiar modo" ||
    inboundNormalized.startsWith("modo ")
  ) {
    return false;
  }
  if (
    inboundNormalized === "menu" ||
    inboundNormalized === "programas" ||
    inboundNormalized.includes("cambiar programa") ||
    inboundNormalized.includes("cambiar de programa") ||
    inboundNormalized.includes("menu de programas")
  ) {
    return false;
  }

  // Only prompt proactively when the intent is ambiguous (greetings/help). If the staff message is operational
  // (e.g. "clientes nuevos"), let the agent run in STAFF by default to avoid blocking workflows.
  const isAmbiguousGreeting =
    inboundNormalized === "hola" ||
    inboundNormalized.startsWith("hola ") ||
    inboundNormalized === "buenas" ||
    inboundNormalized.startsWith("buenas ") ||
    inboundNormalized.includes("ayuda") ||
    inboundNormalized === "hi" ||
    inboundNormalized === "hello" ||
    inboundNormalized === "hey";
  const tags = parseStageTagsValue((params.conversation as any).stageTags);
  const awaiting = tags.includes(PERSONA_MENU_PENDING_TAG);
  if (!awaiting && !isAmbiguousGreeting) return false;

  const { text: menuText, orderedKinds } = buildPersonaMenuText(allowedKinds);

  const phoneLine = await prisma.phoneLine
    .findUnique({ where: { id: params.conversation.phoneLineId }, select: { waPhoneNumberId: true } })
    .catch(() => null);
  const phoneNumberId = phoneLine?.waPhoneNumberId || null;

  const sendMenu = async (): Promise<void> => {
    let sendResultRaw: SendResult = { success: false, error: "waId is missing" };
    if (params.autoReplyEnabled && params.contact?.waId) {
      sendResultRaw = await sendWhatsAppText(params.contact.waId, menuText, { phoneNumberId });
    } else if (!params.autoReplyEnabled) {
      sendResultRaw = { success: false, error: "BOT_AUTO_REPLY_DISABLED" };
    }
    const normalizedSendResult = {
      success: sendResultRaw.success,
      messageId: "messageId" in sendResultRaw ? (sendResultRaw.messageId ?? null) : null,
      error: "error" in sendResultRaw ? (sendResultRaw.error ?? null) : null,
    };
    const dedupeKey = `persona_prompt:${params.conversation.id}:${stableHash(menuText).slice(0, 10)}`;
    await prisma.outboundMessageLog
      .create({
        data: {
          workspaceId: params.workspaceId,
          conversationId: params.conversation.id,
          relatedConversationId: null,
          agentRunId: null,
          channel: "WHATSAPP",
          type: "SESSION_TEXT",
          templateName: null,
          dedupeKey,
          textHash: stableHash(`TEXT:${menuText}`),
          blockedReason: normalizedSendResult.success ? null : String(normalizedSendResult.error || "SEND_FAILED"),
          waMessageId: normalizedSendResult.messageId || null,
        } as any,
      })
      .catch(() => {});
    await prisma.message
      .create({
        data: {
          conversationId: params.conversation.id,
          direction: "OUTBOUND",
          text: menuText,
          rawPayload: serializeJson({ system: true, personaPrompt: true, sendResult: normalizedSendResult }),
          timestamp: new Date(),
          read: true,
        },
      })
      .catch(() => {});
    if (normalizedSendResult.success && params.conversation.phoneLineId) {
      await prisma.phoneLine.update({ where: { id: params.conversation.phoneLineId }, data: { lastOutboundAt: new Date() } }).catch(() => {});
    }
  };

  if (awaiting) {
    const choice = resolvePersonaChoice(inboundRaw, orderedKinds);
    if (choice && allowedKinds.includes(choice)) {
      const nextTags = tags.filter((t) => t !== PERSONA_MENU_PENDING_TAG);
      await prisma.conversation
        .update({
          where: { id: params.conversation.id },
          data: { stageTags: serializeStageTags(nextTags), updatedAt: new Date() } as any,
        })
        .catch(() => {});
      (params.conversation as any).stageTags = serializeStageTags(nextTags);

      const toInbound =
        choice === "STAFF" ? "modo staff" : choice === "CLIENT" ? "modo cliente" : choice === "PARTNER" ? "modo proveedor" : "modo admin";
      return maybeHandlePersonaSwitchCommand(app, {
        workspaceId: params.workspaceId,
        phoneLineId: params.phoneLineId,
        conversation: params.conversation,
        contact: params.contact,
        inboundText: toInbound,
        effectiveKind: params.effectiveKind,
        baseKind: params.baseKind,
        allowedKinds: params.allowedKinds,
        autoReplyEnabled: params.autoReplyEnabled,
        ttlMinutes: params.ttlMinutes,
        allowPersonaSwitch: params.allowPersonaSwitch,
      });
    }

    await sendMenu();
    return true;
  }

  if (!tags.includes(PERSONA_MENU_PENDING_TAG)) {
    tags.push(PERSONA_MENU_PENDING_TAG);
    await prisma.conversation
      .update({
        where: { id: params.conversation.id },
        data: { stageTags: serializeStageTags(tags), updatedAt: new Date() } as any,
      })
      .catch(() => {});
    (params.conversation as any).stageTags = serializeStageTags(tags);
  }

  await sendMenu();
  return true;
}

async function maybeHandlePersonaSwitchCommand(
  app: FastifyInstance,
  params: {
    workspaceId: string;
    phoneLineId: string;
    conversation: any;
    contact: any;
    inboundText: string | null;
    effectiveKind: string;
    baseKind: string;
    allowedKinds: string[];
    autoReplyEnabled: boolean;
    ttlMinutes: number;
    allowPersonaSwitch: boolean;
  },
): Promise<boolean> {
  if (!params.allowPersonaSwitch) return false;
  const inbound = stripAccents(String(params.inboundText || "")).toLowerCase().trim();
  if (!inbound) return false;

  const isHelp = inbound === "modo" || inbound === "roles" || inbound === "rol" || inbound === "cambiar modo";
  const wantsClear = inbound === "modo auto" || inbound === "modo normal" || inbound === "modo automático" || inbound === "modo automatico";
  const wantsSet = inbound.startsWith("modo ");
  if (!isHelp && !wantsClear && !wantsSet) return false;

  // If we're mid persona-menu prompt, clear it once the user explicitly interacts.
  try {
    const tags = parseStageTagsValue((params.conversation as any).stageTags);
    if (tags.includes(PERSONA_MENU_PENDING_TAG)) {
      const nextTags = tags.filter((t) => t !== PERSONA_MENU_PENDING_TAG);
      await prisma.conversation
        .update({
          where: { id: params.conversation.id },
          data: { stageTags: serializeStageTags(nextTags), updatedAt: new Date() } as any,
        })
        .catch(() => {});
      (params.conversation as any).stageTags = serializeStageTags(nextTags);
    }
  } catch {
    // ignore
  }

  const currentKind = String(params.effectiveKind || "").toUpperCase() || "CLIENT";
  const baseKind = String(params.baseKind || "").toUpperCase() || currentKind;
  const allowedKinds = Array.isArray(params.allowedKinds) ? params.allowedKinds.map((k) => String(k).toUpperCase()) : [];
  const ttlMinutes = Number.isFinite(params.ttlMinutes) ? Math.max(5, Math.floor(params.ttlMinutes)) : 360;

  const normalizeKindLabel = (kind: string): string => {
    const k = String(kind || "").toUpperCase();
    if (k === "CLIENT") return "cliente";
    if (k === "STAFF") return "staff";
    if (k === "PARTNER") return "proveedor";
    if (k === "ADMIN") return "admin";
    return k.toLowerCase();
  };

  const resolveDesiredKind = (): string | null => {
    if (wantsClear) return "AUTO";
    if (!wantsSet) return null;
    if (inbound.includes("cliente")) return "CLIENT";
    if (inbound.includes("staff")) return "STAFF";
    if (inbound.includes("proveedor") || inbound.includes("partner") || inbound.includes("aliado")) return "PARTNER";
    if (inbound.includes("admin")) return "ADMIN";
    return null;
  };

  const desiredKind = resolveDesiredKind();
  if (wantsSet && !desiredKind) {
    // Unknown mode -> show help.
    return maybeHandlePersonaSwitchCommand(app, { ...params, inboundText: "modo" });
  }

  const phoneLine = await prisma.phoneLine
    .findUnique({
      where: { id: params.conversation.phoneLineId },
      select: { waPhoneNumberId: true },
    })
    .catch(() => null);
  const phoneNumberId = phoneLine?.waPhoneNumberId || null;

  const replyText = (() => {
    if (desiredKind === "AUTO") {
      return `Listo. Volví al modo automático.\nModo actual: ${normalizeKindLabel(baseKind)}.\n\nTip: escribe “menu” para cambiar de programa.`;
    }
    if (desiredKind && !allowedKinds.includes(desiredKind)) {
      const allowedLabel = allowedKinds.length > 0 ? allowedKinds.map(normalizeKindLabel).join(", ") : "cliente";
      return `No tienes permiso para usar el modo “${normalizeKindLabel(desiredKind)}”.\nModos permitidos: ${allowedLabel}.\n\nEscribe “modo” para ver opciones.`;
    }
    if (desiredKind && desiredKind !== "AUTO") {
      return `Listo. Modo: ${normalizeKindLabel(desiredKind)} (por ${ttlMinutes} min).\n\nTip: escribe “menu” para cambiar de programa.`;
    }
    const allowedLabel = allowedKinds.length > 0 ? allowedKinds.map(normalizeKindLabel).join(", ") : "cliente";
    return `Modo actual: ${normalizeKindLabel(currentKind)}.\nModo por defecto: ${normalizeKindLabel(baseKind)}.\n\nModos disponibles: ${allowedLabel}.\nPara cambiar: escribe “modo cliente”, “modo staff” o “modo proveedor”.\nPara volver al automático: “modo auto”.`;
  })();

  // Persist override (archive-only, no deletes): keep it in the current conversation and clear others to avoid ambiguity.
  if (desiredKind === "AUTO") {
    await prisma.conversation.updateMany({
      where: {
        workspaceId: params.workspaceId,
        phoneLineId: params.phoneLineId,
        contactId: params.conversation.contactId,
        archivedAt: null,
        activePersonaKind: { not: null },
      } as any,
      data: { activePersonaKind: null, activePersonaUntilAt: null },
    });
  } else if (desiredKind && allowedKinds.includes(desiredKind)) {
    const untilAt = new Date(Date.now() + ttlMinutes * 60_000);
    await prisma.conversation.updateMany({
      where: {
        workspaceId: params.workspaceId,
        phoneLineId: params.phoneLineId,
        contactId: params.conversation.contactId,
        archivedAt: null,
        activePersonaKind: { not: null },
      } as any,
      data: { activePersonaKind: null, activePersonaUntilAt: null },
    });
    await prisma.conversation.update({
      where: { id: params.conversation.id },
      data: { activePersonaKind: desiredKind, activePersonaUntilAt: untilAt, updatedAt: new Date() } as any,
    });
    await prisma.message
      .create({
        data: {
          conversationId: params.conversation.id,
          direction: "OUTBOUND",
          text: `🔁 Cambio de rol: ${normalizeKindLabel(currentKind)} → ${normalizeKindLabel(desiredKind)} (${ttlMinutes} min)`,
          rawPayload: serializeJson({ system: true, personaSwitch: true, from: currentKind, to: desiredKind, ttlMinutes }),
          timestamp: new Date(),
          read: true,
        },
      })
      .catch(() => {});
  }

  let sendResultRaw: SendResult = { success: false, error: "waId is missing" };
  if (!params.autoReplyEnabled) {
    sendResultRaw = { success: false, error: "BOT_AUTO_REPLY_DISABLED" };
  } else if (params.contact?.waId) {
    sendResultRaw = await sendWhatsAppText(params.contact.waId, replyText, { phoneNumberId });
  }
  const normalizedSendResult = {
    success: sendResultRaw.success,
    messageId: "messageId" in sendResultRaw ? (sendResultRaw.messageId ?? null) : null,
    error: "error" in sendResultRaw ? (sendResultRaw.error ?? null) : null,
  };

  const dedupeKey = `persona_mode:${params.conversation.id}:${String(desiredKind || "HELP")}:${stableHash(replyText).slice(0, 10)}`;
  await prisma.outboundMessageLog
    .create({
      data: {
        workspaceId: params.workspaceId,
        conversationId: params.conversation.id,
        relatedConversationId: null,
        agentRunId: null,
        channel: "WHATSAPP",
        type: "SESSION_TEXT",
        templateName: null,
        dedupeKey,
        textHash: stableHash(`TEXT:${replyText}`),
        blockedReason: normalizedSendResult.success ? null : String(normalizedSendResult.error || "SEND_FAILED"),
        waMessageId: normalizedSendResult.messageId || null,
      } as any,
    })
    .catch(() => {});

  await prisma.message
    .create({
      data: {
        conversationId: params.conversation.id,
        direction: "OUTBOUND",
        text: replyText,
        rawPayload: serializeJson({
          autoReply: true,
          personaSwitch: true,
          desiredKind: desiredKind === "AUTO" ? null : desiredKind,
          baseKind,
          currentKind,
          allowedKinds,
          ttlMinutes,
          sendResult: normalizedSendResult,
        }),
        timestamp: new Date(),
        read: true,
      },
    })
    .catch(() => {});

  if (normalizedSendResult.success && params.conversation.phoneLineId) {
    await prisma.phoneLine
      .update({ where: { id: params.conversation.phoneLineId }, data: { lastOutboundAt: new Date() } })
      .catch(() => {});
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
  const whitelist = [...getAdminWaIdAllowlist(config), ...getTestWaIdAllowlist(config)].filter(Boolean) as string[];
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

async function ensureAdminConversation(params: {
  workspaceId: string;
  waId: string;
  normalizedAdmin: string;
  phoneLineId: string;
}) {
  let contact = await prisma.contact.findFirst({
    where: {
      workspaceId: params.workspaceId,
      OR: [
        { waId: params.normalizedAdmin },
        { phone: params.normalizedAdmin },
        { phone: `+${params.normalizedAdmin}` },
      ],
    },
  });
  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        workspaceId: params.workspaceId,
        waId: params.normalizedAdmin,
        phone: `+${params.normalizedAdmin}`,
        name: "Administrador",
      },
    });
  } else if (!contact.waId) {
    contact = await prisma.contact.update({
      where: { id: contact.id },
      data: { waId: params.normalizedAdmin },
    });
  }

  let conversation = await prisma.conversation.findFirst({
    where: { contactId: contact.id, isAdmin: true, workspaceId: params.workspaceId, phoneLineId: params.phoneLineId },
    orderBy: { updatedAt: "desc" },
  });

  if (!conversation) {
    const adminProgram = await prisma.program
      .findFirst({
        where: { workspaceId: params.workspaceId, slug: "admin", archivedAt: null },
        select: { id: true },
      })
      .catch(() => null);
    conversation = await prisma.conversation.create({
      data: {
        workspaceId: params.workspaceId,
        phoneLineId: params.phoneLineId,
        programId: adminProgram?.id || null,
        contactId: contact.id,
        status: "OPEN",
        channel: "admin",
        isAdmin: true,
        aiMode: "OFF",
        conversationKind: "ADMIN",
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
  const convo = await prisma.conversation
    .findUnique({
      where: { id: conversationId },
      select: { phoneLine: { select: { id: true, waPhoneNumberId: true } } },
    })
    .catch(() => null);
  const phoneNumberId = convo?.phoneLine?.waPhoneNumberId || null;
  let sendResultRaw: SendResult = await sendWhatsAppText(waId, text, { phoneNumberId });
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
  if (sendResultRaw.success && convo?.phoneLine?.id) {
    await prisma.phoneLine
      .update({ where: { id: convo.phoneLine.id }, data: { lastOutboundAt: new Date() } })
      .catch(() => {});
  }
}
