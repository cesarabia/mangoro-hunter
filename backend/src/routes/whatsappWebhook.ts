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
    await processIncomingPayload(app, payload);
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
        from: msg.from,
        text: msg.text ?? "",
        timestamp: msg.timestamp,
        rawPayload: msg.rawPayload,
        config,
      });
    }
  } catch (err) {
    app.log.error({ err }, "Error processing WhatsApp payload");
  }
}

function extractMessages(payload: any): Array<{
  from: string;
  text: string | undefined;
  timestamp?: number;
  rawPayload: any;
  profileName?: string;
}> {
  const collected: Array<{
    from: string;
    text: string | undefined;
    timestamp?: number;
    rawPayload: any;
    profileName?: string;
  }> = [];

  if (payload?.messages && Array.isArray(payload.messages)) {
    for (const msg of payload.messages) {
      collected.push({
        from: msg.from,
        text: msg.text?.body,
        timestamp: msg.timestamp,
        rawPayload: msg,
        profileName: msg.profile?.name,
      });
    }
  }

  if (Array.isArray(payload?.entry)) {
    for (const entry of payload.entry) {
      const changes = entry?.changes || [];
      for (const change of changes) {
        const value = change?.value;
        if (Array.isArray(value?.messages)) {
          for (const message of value.messages) {
            collected.push({
              from: message.from,
              text: message.text?.body,
              timestamp: message.timestamp
                ? Number(message.timestamp)
                : undefined,
              rawPayload: message,
              profileName:
                value?.contacts?.[0]?.profile?.name || message.profile?.name,
            });
          }
        }
      }
    }
  }

  return collected;
}
