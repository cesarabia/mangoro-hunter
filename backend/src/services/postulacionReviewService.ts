import { FastifyInstance } from 'fastify';
import nodemailer from 'nodemailer';
import { prisma } from '../db/client';
import { createInAppNotification } from './notificationService';
import { serializeJson } from '../utils/json';
import { coerceStageSlug } from './workspaceStageService';
import { normalizeApplicationRole } from './postulacionFlowService';

export type DocKind = 'CV' | 'CARNET' | 'LICENCIA' | 'VEHICULO';

export type DetectedDoc = {
  kind: DocKind;
  messageId: string;
  fileName: string;
  mime: string | null;
  uploadedAt: string;
  link: string;
};

function appBaseUrl(): string {
  return String(process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || 'https://hunter.mangoro.app').replace(/\/+$/, '');
}

function normalizeLoose(value: unknown): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function inferDocKind(message: any): DocKind | null {
  const text = normalizeLoose(`${String(message?.text || '')} ${String(message?.transcriptText || '')}`);
  const payload = (() => {
    try {
      return JSON.parse(String(message?.rawPayload || '{}'));
    } catch {
      return {};
    }
  })();
  const fileName = normalizeLoose(
    String((payload as any)?.attachment?.fileName || (payload as any)?.fileName || (message?.mediaPath || '')),
  );
  const merged = `${text} ${fileName}`;

  if (/\bcv\b|curriculum|curr[ií]culo|hoja de vida/.test(merged)) return 'CV';
  if (/carnet|cedula|c[ée]dula|dni/.test(merged)) return 'CARNET';
  if (/licencia/.test(merged)) return 'LICENCIA';
  if (/padron|padr[oó]n|permiso de circulacion|circulacion|revisi[oó]n tecnica|seguro/.test(merged)) {
    return 'VEHICULO';
  }

  // Fallback by mime/type for unknown docs.
  const mediaType = normalizeLoose(message?.mediaType);
  if (mediaType === 'document') return 'CV';
  return null;
}

function buildMessageDownloadUrl(messageId: string): string {
  return `${appBaseUrl()}/api/messages/${encodeURIComponent(messageId)}/download`;
}

function detectDocuments(messages: any[]): DetectedDoc[] {
  const docs: DetectedDoc[] = [];
  for (const m of messages || []) {
    if (String(m?.direction || '').toUpperCase() !== 'INBOUND') continue;
    if (!m?.mediaPath) continue;
    const kind = inferDocKind(m);
    if (!kind) continue;
    const payload = (() => {
      try {
        return JSON.parse(String(m?.rawPayload || '{}'));
      } catch {
        return {};
      }
    })();
    const fileName =
      String((payload as any)?.attachment?.fileName || (payload as any)?.fileName || m.mediaPath || '').trim() ||
      `${kind.toLowerCase()}.bin`;
    docs.push({
      kind,
      messageId: String(m.id),
      fileName,
      mime: m.mediaMime ? String(m.mediaMime) : null,
      uploadedAt: m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString(),
      link: buildMessageDownloadUrl(String(m.id)),
    });
  }
  return docs;
}

export function getPostulacionRoleLabel(roleRaw: unknown): string {
  const role = normalizeApplicationRole(roleRaw);
  if (role === 'PEONETA') return 'Peoneta';
  if (role === 'DRIVER_COMPANY') return 'Conductor (vehículo empresa)';
  if (role === 'DRIVER_OWN_VAN') return 'Conductor con vehículo propio';
  return 'Sin definir';
}

function pickLatestInboundText(messages: any[]): string {
  const inbound = (messages || [])
    .filter((m) => String(m.direction || '').toUpperCase() === 'INBOUND')
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return String(inbound[0]?.text || inbound[0]?.transcriptText || '').trim();
}

function buildPaymentRules(roleRaw: unknown): string {
  const role = normalizeApplicationRole(roleRaw);
  if (role === 'PEONETA') return 'Peoneta: $15.000/día.';
  if (role === 'DRIVER_OWN_VAN') {
    return 'Conductor vehículo propio: Chilexpress CHEX $800, Vol $2.000.';
  }
  if (role === 'DRIVER_COMPANY') {
    return 'Conductor empresa: CHEX $400, Vol $1.000; Mercado Libre $25.000/día; Falabella por definir.';
  }
  return 'Pago depende del cargo seleccionado y validación de operación.';
}

export async function buildPostulacionInternalSummary(params: {
  workspaceId: string;
  conversationId: string;
}): Promise<{
  summary: string;
  docs: DetectedDoc[];
  subject: string;
  toEmail: string | null;
  fromEmail: string | null;
}> {
  const convo = await prisma.conversation.findFirst({
    where: { id: params.conversationId, workspaceId: params.workspaceId },
    include: {
      workspace: { select: { name: true, reviewEmailTo: true as any, reviewEmailFrom: true as any } },
      contact: true,
      messages: {
        orderBy: { timestamp: 'desc' },
        take: 120,
        select: {
          id: true,
          direction: true,
          text: true,
          transcriptText: true,
          mediaType: true,
          mediaMime: true,
          mediaPath: true,
          rawPayload: true,
          timestamp: true,
        },
      },
    },
  });
  if (!convo) throw new Error('Conversation no encontrada para resumen interno.');

  const docs = detectDocuments(convo.messages || []);
  const docsByKind = (kind: DocKind) => docs.filter((d) => d.kind === kind);

  const appData = (() => {
    try {
      return JSON.parse(String((convo as any).applicationDataJson || '{}')) || {};
    } catch {
      return {};
    }
  })();

  const displayName =
    String((convo.contact as any)?.candidateNameManual || (convo.contact as any)?.candidateName || (convo.contact as any)?.displayName || '').trim() ||
    'Sin nombre';
  const role = getPostulacionRoleLabel((convo as any).applicationRole || (convo.contact as any)?.jobRole || appData.roleIntent);
  const comuna = String((convo.contact as any)?.comuna || appData.comuna || '').trim() || '(pendiente)';
  const availability =
    String((convo as any).availabilityRaw || (convo.contact as any)?.availabilityText || appData.availability || '').trim() ||
    '(pendiente)';
  const experience =
    String(appData.experience || '').trim() ||
    (Number.isFinite((convo.contact as any)?.experienceYears) ? `${(convo.contact as any).experienceYears} años` : '(pendiente)');
  const latestInbound = pickLatestInboundText(convo.messages || []);

  const summary = [
    'POSTULANTE',
    `- Nombre: ${displayName}`,
    `- Teléfono: ${String((convo.contact as any)?.phone || (convo.contact as any)?.waId || '').trim() || '(pendiente)'}`,
    `- Cargo: ${role}`,
    `- Comuna: ${comuna}`,
    `- Disponibilidad: ${availability}`,
    `- Experiencia: ${experience}`,
    '',
    'DOCUMENTOS',
    `- CV: ${docsByKind('CV').length > 0 ? docsByKind('CV').map((d) => d.link).join(' | ') : '(pendiente)'}`,
    `- Carnet (frente/reverso): ${docsByKind('CARNET').length > 0 ? docsByKind('CARNET').map((d) => d.link).join(' | ') : '(pendiente)'}`,
    `- Licencia clase B: ${docsByKind('LICENCIA').length > 0 ? docsByKind('LICENCIA').map((d) => d.link).join(' | ') : '(pendiente)'}`,
    `- Docs vehículo: ${docsByKind('VEHICULO').length > 0 ? docsByKind('VEHICULO').map((d) => d.link).join(' | ') : '(no aplica / pendiente)'}`,
    '',
    'OPERACIÓN/PAGO',
    `- ${buildPaymentRules((convo as any).applicationRole || appData.roleIntent)}`,
    '',
    'EVALUACIÓN RÁPIDA',
    `- Requisitos mínimos Etapa 1: ${role !== 'Peoneta' && docsByKind('CV').length === 0 ? 'INCOMPLETO (falta CV)' : 'OK/Pendiente validación staff'}`,
    '',
    'ESTADO DEL PROCESO',
    `- applicationState: ${String((convo as any).applicationState || '(vacío)')}`,
    `- stage: ${String((convo as any).conversationStage || '(vacío)')}`,
    '',
    'SIGUIENTE ACCIÓN',
    '- Revisar y marcar resultado de operación: OP_ACCEPTED o OP_REJECTED.',
    latestInbound ? `- Último mensaje candidato: ${latestInbound.slice(0, 280)}` : '- Último mensaje candidato: (sin texto)',
  ].join('\n');

  const toEmail =
    String((convo.workspace as any)?.reviewEmailTo || process.env.WORKSPACE_REVIEW_EMAIL_TO || '').trim().toLowerCase() ||
    null;
  const fromEmail =
    String((convo.workspace as any)?.reviewEmailFrom || process.env.WORKSPACE_REVIEW_EMAIL_FROM || '').trim() || null;

  const subject = `[POSTULACIÓN] Listo para revisión — ${displayName} — ${role} — ${comuna}`;

  return { summary, docs, subject, toEmail, fromEmail };
}

export function detectPostulacionDocuments(messages: any[]): DetectedDoc[] {
  return detectDocuments(messages || []);
}

async function sendSummaryEmail(params: {
  to: string;
  from: string;
  subject: string;
  body: string;
}): Promise<{ ok: boolean; error?: string }> {
  const host = String(process.env.SMTP_HOST || '').trim();
  const port = Number(process.env.SMTP_PORT || 0);
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();
  const secure = String(process.env.SMTP_SECURE || '').trim().toLowerCase() === 'true' || port === 465;

  if (!host || !port || !user || !pass) {
    return { ok: false, error: 'email_not_configured' };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  try {
    await transporter.sendMail({
      from: params.from,
      to: params.to,
      subject: params.subject,
      text: params.body,
    });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err instanceof Error ? err.message : 'smtp_send_failed' };
  }
}

export async function triggerReadyForOpReview(params: {
  app: FastifyInstance;
  workspaceId: string;
  conversationId: string;
  reason?: string | null;
  actorUserId?: string | null;
}): Promise<{
  ok: boolean;
  summary: string;
  email: { configured: boolean; sent: boolean; error?: string | null; to?: string | null };
}> {
  const now = new Date();
  const convo = await prisma.conversation
    .findFirst({
      where: { id: params.conversationId, workspaceId: params.workspaceId, archivedAt: null },
      include: { contact: true },
    })
    .catch(() => null);
  if (!convo) throw new Error('Conversation no encontrada');

  const stage = await coerceStageSlug({ workspaceId: params.workspaceId, stageSlug: 'OP_REVIEW' }).catch(() => 'OP_REVIEW');
  await prisma.conversation
    .update({
      where: { id: convo.id },
      data: {
        conversationStage: stage,
        stageReason: params.reason || 'READY_FOR_OP_REVIEW',
        stageChangedAt: now,
        aiPaused: true,
        applicationState: 'WAITING_OP_RESULT',
        opReviewSummarySentAt: now,
        updatedAt: now,
      } as any,
    })
    .catch(() => {});

  const { summary, subject, toEmail, fromEmail } = await buildPostulacionInternalSummary({
    workspaceId: params.workspaceId,
    conversationId: convo.id,
  });

  await prisma.message
    .create({
      data: {
        conversationId: convo.id,
        direction: 'OUTBOUND',
        text: `📋 RESUMEN INTERNO — LISTO PARA REVISIÓN\n\n${summary}`,
        rawPayload: serializeJson({
          system: true,
          internalEvent: true,
          reviewSummary: true,
          eventType: 'READY_FOR_OP_REVIEW',
        }),
        isInternalEvent: true as any,
        timestamp: now,
        read: true,
      },
    })
    .catch(() => {});

  const memberships = await prisma.membership
    .findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        role: { in: ['OWNER', 'ADMIN'] },
      } as any,
      select: { userId: true, role: true },
    })
    .catch(() => []);

  for (const m of memberships) {
    await createInAppNotification({
      workspaceId: params.workspaceId,
      userId: String(m.userId),
      conversationId: convo.id,
      type: 'POSTULACION_READY_FOR_OP_REVIEW',
      title: 'Candidato listo para revisión',
      body: `${String((convo.contact as any)?.displayName || (convo.contact as any)?.candidateName || 'Postulante')} en OP_REVIEW`,
      dedupeKey: `op-review:${convo.id}:${now.toISOString().slice(0, 10)}`,
      data: { conversationId: convo.id, stage: stage },
    }).catch(() => null);
  }

  let emailResult: { configured: boolean; sent: boolean; error?: string | null; to?: string | null } = {
    configured: Boolean(toEmail && fromEmail),
    sent: false,
    error: null,
    to: toEmail,
  };

  if (toEmail && fromEmail) {
    const sent = await sendSummaryEmail({ to: toEmail, from: fromEmail, subject, body: summary });
    emailResult = {
      configured: true,
      sent: sent.ok,
      error: sent.ok ? null : sent.error || null,
      to: toEmail,
    };
    await prisma.conversation
      .update({
        where: { id: convo.id },
        data: {
          opReviewEmailSentAt: sent.ok ? new Date() : null,
          updatedAt: new Date(),
        } as any,
      })
      .catch(() => {});
  } else {
    emailResult = { configured: false, sent: false, error: 'email_not_configured', to: toEmail };
  }

  await prisma.emailOutboundLog
    .create({
      data: {
        workspaceId: params.workspaceId,
        conversationId: convo.id,
        channel: 'EMAIL',
        fromEmail: fromEmail || null,
        toEmail: toEmail || 'not_configured',
        subject,
        bodyPreview: summary.slice(0, 1000),
        status: emailResult.configured ? (emailResult.sent ? 'SENT' : 'ERROR') : 'SKIPPED',
        error: emailResult.error || null,
        metadataJson: serializeJson({
          reason: params.reason || 'READY_FOR_OP_REVIEW',
          configured: emailResult.configured,
          sent: emailResult.sent,
          toEmail,
          fromEmail,
        }),
        sentAt: emailResult.sent ? new Date() : null,
      } as any,
    })
    .catch(() => {});

  if (!emailResult.sent) {
    params.app.log.warn(
      {
        workspaceId: params.workspaceId,
        conversationId: convo.id,
        error: emailResult.error,
        toEmail,
      },
      'OP_REVIEW summary email not sent',
    );
  }

  return { ok: true, summary, email: emailResult };
}
