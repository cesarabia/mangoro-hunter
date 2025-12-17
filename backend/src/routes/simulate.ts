import { FastifyInstance } from 'fastify';
import { handleInboundWhatsAppMessage } from '../services/whatsappInboundService';
import { getAdminWaIdAllowlist, getSystemConfig, getTestWaIdAllowlist } from '../services/configService';
import { normalizeWhatsAppId } from '../utils/whatsapp';
import { prisma } from '../db/client';
import { runAutomations } from '../services/automationRunnerService';
import { piiSanitizeText } from '../services/agent/tools';

type ScenarioStep = {
  inboundText: string;
  expect?: {
    contactFields?: Array<
      'candidateName' | 'comuna' | 'ciudad' | 'region' | 'rut' | 'email' | 'availabilityText'
    >;
    stage?: string;
  };
};

type ScenarioDefinition = {
  id: string;
  name: string;
  description: string;
  programSlug?: string;
  steps: ScenarioStep[];
};

const SCENARIOS: ScenarioDefinition[] = [
  {
    id: 'location_loop_rm',
    name: 'Loop comuna/ciudad (RM)',
    description:
      'Reproduce el caso donde el candidato envía comuna/ciudad en formatos mixtos para evitar loops.',
    programSlug: 'recruitment',
    steps: [
      {
        inboundText: '✅ PUENTE ALTO / REGION METROPOLITANA / RUT 12.345.678-9',
        expect: { contactFields: ['comuna', 'ciudad', 'region', 'rut'] },
      },
      {
        inboundText: 'Tengo disponibilidad inmediata',
        expect: { contactFields: ['availabilityText'] },
      },
    ],
  },
  {
    id: 'displayname_garbage',
    name: 'DisplayName basura ≠ candidateName',
    description: 'Valida que frases tipo "Más información" no se usen como candidateName.',
    programSlug: 'recruitment',
    steps: [
      { inboundText: 'Más información', expect: { contactFields: [] } },
      { inboundText: 'Me llamo Pablo Urrutia Rivas', expect: { contactFields: ['candidateName'] } },
    ],
  },
];

function getScenario(id: string): ScenarioDefinition | null {
  const key = String(id || '').trim();
  return SCENARIOS.find((s) => s.id === key) || null;
}

export async function registerSimulationRoutes(app: FastifyInstance) {
  // Agent OS Simulator (sandbox workspace; never sends WhatsApp).
  app.get('/scenarios', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (request.user?.role !== 'ADMIN') return reply.code(403).send({ error: 'Forbidden' });
    return SCENARIOS.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      stepsCount: s.steps.length,
    }));
  });

  app.post('/scenario/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (request.user?.role !== 'ADMIN') return reply.code(403).send({ error: 'Forbidden' });
    const { id } = request.params as { id: string };
    const scenario = getScenario(id);
    if (!scenario) return reply.code(404).send({ error: 'Scenario no encontrado.' });

    const body = request.body as { sanitizePii?: boolean };
    const sanitize = body?.sanitizePii !== false;

    const program = scenario.programSlug
      ? await prisma.program.findFirst({
          where: { workspaceId: 'sandbox', slug: scenario.programSlug, archivedAt: null },
          select: { id: true },
        })
      : null;

    const contact = await prisma.contact.create({
      data: {
        workspaceId: 'sandbox',
        displayName: sanitize ? `Sandbox Scenario (${scenario.id})` : `Sandbox Scenario (${scenario.id})`,
        candidateName: null,
        candidateNameManual: null,
      } as any,
    });
    const conversation = await prisma.conversation.create({
      data: {
        workspaceId: 'sandbox',
        phoneLineId: 'sandbox-default',
        programId: program?.id || null,
        contactId: contact.id,
        status: 'NEW',
        conversationStage: 'SANDBOX_SCENARIO',
        channel: 'sandbox',
        sandboxSourceConversationId: null,
      } as any,
    });

    const startedAt = new Date();
    const stepResults: any[] = [];
    let ok = true;

    for (const [idx, step] of scenario.steps.entries()) {
      const inboundText = String(step.inboundText || '').trim();
      const message = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction: 'INBOUND',
          text: inboundText,
          rawPayload: JSON.stringify({ simulated: true, sandbox: true, scenario: scenario.id, step: idx }),
          timestamp: new Date(),
          read: false,
        },
      });

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });

      await runAutomations({
        app,
        workspaceId: 'sandbox',
        eventType: 'INBOUND_MESSAGE',
        conversationId: conversation.id,
        inboundMessageId: message.id,
        inboundText,
        transportMode: 'NULL',
      });

      const snap = await prisma.conversation.findUnique({
        where: { id: conversation.id },
        include: { contact: true },
      });

      const assertions: Array<{ ok: boolean; message: string }> = [];
      const expectedFields = step.expect?.contactFields || [];
      for (const field of expectedFields) {
        const val = (snap?.contact as any)?.[field];
        const pass = val !== null && typeof val !== 'undefined' && String(val).trim() !== '';
        assertions.push({ ok: pass, message: pass ? `field ${field} OK` : `field ${field} missing` });
      }
      if (step.expect?.stage) {
        const pass = String(snap?.conversationStage || '') === String(step.expect.stage);
        assertions.push({ ok: pass, message: pass ? `stage OK (${step.expect.stage})` : `stage mismatch` });
      }

      const stepOk = assertions.every((a) => a.ok);
      ok = ok && stepOk;
      stepResults.push({
        step: idx + 1,
        inboundMessageId: message.id,
        inboundText,
        assertions,
        snapshot: snap
          ? {
              status: snap.status,
              stage: snap.conversationStage,
              contact: {
                candidateName: snap.contact.candidateName,
                comuna: (snap.contact as any).comuna,
                ciudad: (snap.contact as any).ciudad,
                region: (snap.contact as any).region,
                rut: (snap.contact as any).rut,
                email: (snap.contact as any).email,
              },
            }
          : null,
      });
    }

    const transcript = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { timestamp: 'asc' },
      select: { id: true, direction: true, text: true, transcriptText: true, timestamp: true },
    });

    const finishedAt = new Date();
    await prisma.scenarioRunLog
      .create({
        data: {
          workspaceId: 'sandbox',
          scenarioId: scenario.id,
          ok,
          sessionConversationId: conversation.id,
          triggeredByUserId: request.user?.userId || null,
          startedAt,
          finishedAt,
        } as any,
      })
      .catch(() => {});

    return {
      ok,
      scenario: { id: scenario.id, name: scenario.name },
      sessionId: conversation.id,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      steps: stepResults,
      transcript: transcript.map((m) => ({
        id: m.id,
        direction: m.direction,
        text: m.transcriptText || m.text,
        timestamp: m.timestamp.toISOString(),
      })),
    };
  });

  app.get('/sessions', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (request.user?.role !== 'ADMIN') return reply.code(403).send({ error: 'Forbidden' });
    const sessions = await prisma.conversation.findMany({
      where: { workspaceId: 'sandbox', channel: 'sandbox', archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, sandboxSourceConversationId: true, createdAt: true },
    });
    return sessions.map((s) => ({
      id: s.id,
      sourceConversationId: s.sandboxSourceConversationId,
      createdAt: s.createdAt.toISOString(),
    }));
  });

  app.get('/sessions/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (request.user?.role !== 'ADMIN') return reply.code(403).send({ error: 'Forbidden' });
    const { id } = request.params as { id: string };
    const session = await prisma.conversation.findFirst({
      where: { id, workspaceId: 'sandbox', channel: 'sandbox' },
      include: { contact: true, messages: { orderBy: { timestamp: 'asc' } } },
    });
    if (!session) return reply.code(404).send({ error: 'Sesión no encontrada.' });
    return {
      id: session.id,
      sourceConversationId: session.sandboxSourceConversationId,
      status: session.status,
      stage: session.conversationStage,
      contact: {
        id: session.contactId,
        displayName: session.contact.displayName,
        candidateName: session.contact.candidateName,
        candidateNameManual: (session.contact as any).candidateNameManual,
        comuna: (session.contact as any).comuna,
        ciudad: (session.contact as any).ciudad,
        rut: (session.contact as any).rut,
        email: (session.contact as any).email,
        noContact: session.contact.noContact,
      },
      messages: session.messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        text: m.transcriptText || m.text,
        timestamp: m.timestamp.toISOString(),
      })),
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    };
  });

  app.post('/sessions', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (request.user?.role !== 'ADMIN') return reply.code(403).send({ error: 'Forbidden' });
    const body = request.body as { sourceConversationId?: string | null };
    const contact = await prisma.contact.create({
      data: {
        workspaceId: 'sandbox',
        displayName: 'Sandbox',
        candidateName: null,
        candidateNameManual: null,
      } as any,
    });
    const conversation = await prisma.conversation.create({
      data: {
        workspaceId: 'sandbox',
        phoneLineId: 'sandbox-default',
        contactId: contact.id,
        status: 'NEW',
        conversationStage: 'SANDBOX',
        channel: 'sandbox',
        sandboxSourceConversationId: body?.sourceConversationId ? String(body.sourceConversationId) : null,
      } as any,
    });
    return { id: conversation.id, sourceConversationId: conversation.sandboxSourceConversationId, createdAt: conversation.createdAt.toISOString() };
  });

  app.post('/run', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (request.user?.role !== 'ADMIN') return reply.code(403).send({ error: 'Forbidden' });
    const body = request.body as { sessionId?: string; inboundText?: string };
    const sessionId = String(body.sessionId || '').trim();
    const inboundText = String(body.inboundText || '').trim();
    if (!sessionId || !inboundText) {
      return reply.code(400).send({ error: '"sessionId" y "inboundText" son obligatorios.' });
    }
    const session = await prisma.conversation.findFirst({
      where: { id: sessionId, workspaceId: 'sandbox', channel: 'sandbox' },
      include: { contact: true },
    });
    if (!session) return reply.code(404).send({ error: 'Sesión no encontrada.' });

    const message = await prisma.message.create({
      data: {
        conversationId: session.id,
        direction: 'INBOUND',
        text: inboundText,
        rawPayload: JSON.stringify({ simulated: true, sandbox: true }),
        timestamp: new Date(),
        read: false,
      },
    });

    await prisma.conversation.update({
      where: { id: session.id },
      data: { updatedAt: new Date() },
    });

    await runAutomations({
      app,
      workspaceId: 'sandbox',
      eventType: 'INBOUND_MESSAGE',
      conversationId: session.id,
      inboundMessageId: message.id,
      inboundText,
      transportMode: 'NULL',
    });

    const updated = await prisma.conversation.findUnique({
      where: { id: session.id },
      include: {
        contact: true,
        messages: { orderBy: { timestamp: 'asc' } },
      },
    });

    return {
      sessionId: session.id,
      conversation: updated && {
        id: updated.id,
        status: updated.status,
        stage: updated.conversationStage,
        contact: {
          id: updated.contactId,
          displayName: updated.contact.displayName,
          candidateName: updated.contact.candidateName,
          candidateNameManual: (updated.contact as any).candidateNameManual,
          comuna: (updated.contact as any).comuna,
          ciudad: (updated.contact as any).ciudad,
          rut: (updated.contact as any).rut,
          email: (updated.contact as any).email,
          noContact: updated.contact.noContact,
        },
        messages: updated.messages.map((m) => ({
          id: m.id,
          direction: m.direction,
          text: m.transcriptText || m.text,
          timestamp: m.timestamp.toISOString(),
        })),
      },
    };
  });

  app.post('/replay/:conversationId', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (request.user?.role !== 'ADMIN') return reply.code(403).send({ error: 'Forbidden' });
    const { conversationId } = request.params as { conversationId: string };
    const body = request.body as { sanitizePii?: boolean };
    const sanitize = body?.sanitizePii !== false;

    const source = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: true, messages: { orderBy: { timestamp: 'asc' } } },
    });
    if (!source) return reply.code(404).send({ error: 'Conversación no encontrada.' });

    const contact = await prisma.contact.create({
      data: {
        workspaceId: 'sandbox',
        displayName: sanitize ? 'Sandbox (sanitizado)' : source.contact.displayName || 'Sandbox',
        candidateName: sanitize ? null : source.contact.candidateName,
        candidateNameManual: sanitize ? null : (source.contact as any).candidateNameManual,
        email: sanitize ? null : (source.contact as any).email,
        rut: sanitize ? null : (source.contact as any).rut,
        comuna: sanitize ? null : (source.contact as any).comuna,
        ciudad: sanitize ? null : (source.contact as any).ciudad,
        region: sanitize ? null : (source.contact as any).region,
        experienceYears: sanitize ? null : (source.contact as any).experienceYears,
        terrainExperience: sanitize ? null : (source.contact as any).terrainExperience,
        availabilityText: sanitize ? null : (source.contact as any).availabilityText,
      } as any,
    });

    const conversation = await prisma.conversation.create({
      data: {
        workspaceId: 'sandbox',
        phoneLineId: 'sandbox-default',
        contactId: contact.id,
        status: source.status,
        conversationStage: 'SANDBOX_REPLAY',
        channel: 'sandbox',
        aiMode: source.aiMode,
        sandboxSourceConversationId: source.id,
      } as any,
    });

    for (const msg of source.messages) {
      const text = msg.transcriptText || msg.text;
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction: msg.direction,
          text: sanitize ? piiSanitizeText(text) : text,
          rawPayload: JSON.stringify({ replay: true, sourceMessageId: msg.id, sanitize }),
          timestamp: msg.timestamp,
          read: true,
        },
      });
    }

    return {
      id: conversation.id,
      sourceConversationId: source.id,
      createdAt: conversation.createdAt.toISOString(),
    };
  });

  app.post('/whatsapp', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (request.user?.role !== 'ADMIN') return reply.code(403).send({ error: 'Forbidden' });
    const { from, text, media, waMessageId } = request.body as {
      from?: string;
      text?: string;
      waMessageId?: string;
      media?: {
        type?: string;
        id?: string;
        mimeType?: string;
        filename?: string;
        caption?: string;
        dataBase64?: string;
      } | null;
    };

    const trimmedText = (text || '').trim();
    const hasMedia = Boolean(media && media.type);
    if (!from || (!trimmedText && !hasMedia)) {
      return reply
        .code(400)
        .send({ error: '"from" es obligatorio y debes enviar "text" o "media".' });
    }

    const config = await getSystemConfig();
    const normalizedFrom = normalizeWhatsAppId(from);
    const allowed = new Set([...getTestWaIdAllowlist(config), ...getAdminWaIdAllowlist(config)]);
    if (!normalizedFrom) {
      return reply.code(400).send({ error: '"from" inválido (usa E.164).' });
    }
    // Guardrail: simulation is TEST-ONLY and must never introduce synthetic candidate numbers in PROD.
    if (!allowed.has(normalizedFrom)) {
      return reply.code(400).send({
        error:
          'Simulación bloqueada: /api/simulate/whatsapp solo permite números admin/de prueba configurados.'
      });
    }

    const result = await handleInboundWhatsAppMessage(app, {
      from: normalizedFrom,
      waMessageId: typeof waMessageId === 'string' && waMessageId.trim() ? waMessageId.trim() : undefined,
      text: trimmedText,
      media: hasMedia
        ? {
          type: String(media?.type || ''),
          id: String(media?.id || `sim-${Date.now()}`),
            mimeType: media?.mimeType,
            filename: media?.filename,
            caption: media?.caption,
            dataBase64: media?.dataBase64
          }
        : null,
      rawPayload: {
        simulated: true,
        text: trimmedText || null,
        media: hasMedia
          ? {
              type: media?.type || null,
              mimeType: media?.mimeType || null,
              filename: media?.filename || null,
              caption: media?.caption || null
            }
          : null
      }
    });

    return reply.send({ status: 'ok', conversationId: result.conversationId });
  });
}
