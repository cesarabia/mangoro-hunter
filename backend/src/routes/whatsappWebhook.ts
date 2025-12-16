import { FastifyInstance } from "fastify";
import { getSystemConfig } from "../services/configService";
import { handleInboundWhatsAppMessage } from "../services/whatsappInboundService";

export function registerWhatsAppWebhookRoutes(app: FastifyInstance) {
  app.get("/whatsapp/webhook", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const mode = query["hub.mode"];
    const token = query["hub.verify_token"];
    const challenge = query["hub.challenge"];

    const config = await getSystemConfig();
    const expectedToken = config.whatsappVerifyToken;

    if (
      mode === "subscribe" &&
      token &&
      expectedToken &&
      token === expectedToken
    ) {
      reply
        .code(200)
        .header("Content-Type", "text/plain")
        .send(challenge || "");
      return;
    }

    reply.code(403).send("Forbidden");
  });

  const handlePost = async (request: any, reply: any) => {
    const payload = request.body as any;
    processIncomingPayload(app, payload).catch((err) => {
      app.log.error({ err }, "Error procesando payload de WhatsApp");
    });
    reply.code(200).send({ status: "ok" });
  };

  app.post("/whatsapp/webhook", handlePost);
  app.post("/webhook/whatsapp", handlePost);
  app.get("/webhook/whatsapp", async (request, reply) => {
    // Alias for local testing if someone hits the old path with GET
    const query = request.query as Record<string, string | undefined>;
    const mode = query["hub.mode"];
    const token = query["hub.verify_token"];
    const challenge = query["hub.challenge"];

    const config = await getSystemConfig();
    const expectedToken = config.whatsappVerifyToken;

    if (
      mode === "subscribe" &&
      token &&
      expectedToken &&
      token === expectedToken
    ) {
      reply
        .code(200)
        .header("Content-Type", "text/plain")
        .send(challenge || "");
      return;
    }

    reply.code(403).send("Forbidden");
  });
}

async function processIncomingPayload(app: FastifyInstance, payload: any) {
  try {
    const config = await getSystemConfig();
    const messages = extractMessages(payload);
    for (const msg of messages) {
      if (!msg.from) continue;
      await handleInboundWhatsAppMessage(app, {
        waMessageId: msg.id,
        waPhoneNumberId: msg.waPhoneNumberId,
        from: msg.from,
        text: msg.text ?? "",
        media: msg.media,
        timestamp: msg.timestamp,
        rawPayload: msg.rawPayload,
        profileName: msg.profileName,
        config,
      });
    }
  } catch (err) {
    app.log.error({ err }, "Error processing WhatsApp payload");
  }
}

function extractMessages(payload: any): Array<{
  id?: string;
  waPhoneNumberId?: string;
  from: string;
  text: string | undefined;
  timestamp?: number;
  rawPayload: any;
  profileName?: string;
  media?: {
    type: string;
    id: string;
    mimeType?: string;
    sha256?: string;
    filename?: string;
    caption?: string;
  } | null;
}> {
  const collected: Array<{
    id?: string;
    waPhoneNumberId?: string;
    from: string;
    text: string | undefined;
    timestamp?: number;
    rawPayload: any;
    profileName?: string;
    media?:
      | {
          type: string;
          id: string;
          mimeType?: string;
          sha256?: string;
          filename?: string;
          caption?: string;
        }
      | null;
  }> = [];

  if (payload?.messages && Array.isArray(payload.messages)) {
    const waPhoneNumberId =
      payload?.metadata?.phone_number_id || payload?.metadata?.phoneNumberId || null;
    for (const msg of payload.messages) {
      collected.push({
        id: msg.id,
        waPhoneNumberId: msg?.metadata?.phone_number_id || waPhoneNumberId || undefined,
        from: msg.from,
        text: msg.text?.body || msg?.[msg.type]?.caption,
        timestamp: msg.timestamp,
        rawPayload: msg,
        profileName: msg.profile?.name,
        media: mapMediaFromMessage(msg),
      });
    }
  }

  if (Array.isArray(payload?.entry)) {
    for (const entry of payload.entry) {
      const changes = entry?.changes || [];
      for (const change of changes) {
        const value = change?.value;
        const waPhoneNumberId = value?.metadata?.phone_number_id || value?.metadata?.phoneNumberId || null;
        if (Array.isArray(value?.messages)) {
          for (const message of value.messages) {
            collected.push({
              id: message.id,
              waPhoneNumberId: waPhoneNumberId || message?.metadata?.phone_number_id || undefined,
              from: message.from,
              text: message.text?.body || message?.[message.type]?.caption,
              timestamp: message.timestamp
                ? Number(message.timestamp)
                : undefined,
              rawPayload: message,
              profileName:
                value?.contacts?.[0]?.profile?.name || message.profile?.name,
              media: mapMediaFromMessage(message),
            });
          }
        }
      }
    }
  }

  return collected;
}

function mapMediaFromMessage(message: any) {
  const type = message?.type;
  if (!type) return null;

  if (type === "image" && message.image?.id) {
    return {
      type: "image",
      id: message.image.id,
      mimeType: message.image.mime_type,
      sha256: message.image.sha256,
      caption: message.image.caption,
    };
  }

  if (type === "audio" && message.audio?.id) {
    return {
      type: message.audio.voice ? "voice" : "audio",
      id: message.audio.id,
      mimeType: message.audio.mime_type,
      sha256: message.audio.sha256,
    };
  }

  if (type === "document" && message.document?.id) {
    return {
      type: "document",
      id: message.document.id,
      mimeType: message.document.mime_type,
      sha256: message.document.sha256,
      filename: message.document.filename,
      caption: message.document.caption,
    };
  }

  if (type === "sticker" && message.sticker?.id) {
    return {
      type: "sticker",
      id: message.sticker.id,
      mimeType: message.sticker.mime_type,
      sha256: message.sticker.sha256,
    };
  }

  return null;
}
