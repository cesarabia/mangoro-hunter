import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { resolveWorkspaceAccess, isWorkspaceAdmin } from '../services/workspaceAuthService';
import {
  buildPostulacionInternalSummary,
  detectPostulacionDocuments,
  getPostulacionRoleLabel,
} from '../services/postulacionReviewService';
import { coerceStageSlug } from '../services/workspaceStageService';
import { serializeJson } from '../utils/json';
import { resolveMediaPathCandidates } from '../utils/statePaths';

function parseJson(value: string | null | undefined): any {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function pickCandidateDisplayName(contact: any): string {
  return (
    String(contact?.candidateNameManual || '').trim() ||
    String(contact?.candidateName || '').trim() ||
    String(contact?.displayName || '').trim() ||
    String(contact?.name || '').trim() ||
    'Sin nombre'
  );
}

function buildDocStatus(roleRaw: unknown, messages: any[]) {
  const docs = detectPostulacionDocuments(messages || []);
  const byKind = (kind: 'CV' | 'CARNET' | 'LICENCIA' | 'VEHICULO') => docs.filter((d) => d.kind === kind);
  const role = String(roleRaw || '').toUpperCase();
  const requiresVehicleDocs = role === 'DRIVER_OWN_VAN' || role === 'CONDUCTOR_FLOTA';

  return {
    cv: { required: role !== 'PEONETA', count: byKind('CV').length },
    carnet: { required: role !== 'PEONETA', count: byKind('CARNET').length },
    licencia: { required: role !== 'PEONETA', count: byKind('LICENCIA').length },
    vehiculo: { required: requiresVehicleDocs, count: byKind('VEHICULO').length },
    docs,
  };
}

function sanitizeFileName(input: string): string {
  const base = path.basename(String(input || 'archivo').trim() || 'archivo');
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '').slice(0, 140);
  return clean || 'archivo';
}

function mapActionToState(action: string): { stage: string; applicationState: string; aiPaused: boolean; note: string } {
  const normalized = String(action || '').trim().toUpperCase();
  if (normalized === 'ACCEPT') {
    return {
      stage: 'INTERVIEW_PENDING',
      applicationState: 'OP_ACCEPTED',
      aiPaused: false,
      note: '✅ Operación aceptó este caso. Continúa coordinación de entrevista.',
    };
  }
  if (normalized === 'REJECT') {
    return {
      stage: 'REJECTED',
      applicationState: 'OP_REJECTED',
      aiPaused: true,
      note: '🛑 Operación rechazó este caso.',
    };
  }
  if (normalized === 'BACK_TO_SCREENING') {
    return {
      stage: 'SCREENING',
      applicationState: 'COLLECT_REQUIREMENTS',
      aiPaused: false,
      note: '↩️ Caso devuelto a Screening para completar información.',
    };
  }
  if (normalized === 'REQUEST_DOC') {
    return {
      stage: 'DOCS_PENDING',
      applicationState: 'REQUEST_OP_DOCS',
      aiPaused: false,
      note: '📎 Operación solicitó documento faltante. IA reactivada para continuar.',
    };
  }
  throw new Error('Acción inválida. Usa ACCEPT | REJECT | BACK_TO_SCREENING | REQUEST_DOC | REGENERATE_SUMMARY');
}

export async function registerOpReviewRoutes(app: FastifyInstance) {
  app.get('/queue', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const q = String((request.query as any)?.q || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, Number((request.query as any)?.limit || 80) || 80));

    const rows = await prisma.conversation.findMany({
      where: {
        workspaceId: access.workspaceId,
        archivedAt: null,
        conversationStage: { in: ['OP_REVIEW', 'EN_REVISION_OPERACION'] as any },
      },
      include: {
        contact: true,
        program: { select: { id: true, name: true, slug: true } },
        messages: {
          orderBy: { timestamp: 'desc' },
          take: 150,
          select: {
            id: true,
            direction: true,
            text: true,
            transcriptText: true,
            mediaPath: true,
            mediaMime: true,
            mediaType: true,
            rawPayload: true,
            timestamp: true,
          },
        },
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: limit,
    });

    const out = rows
      .map((row) => {
        const appData = parseJson((row as any).applicationDataJson);
        const roleRaw = (row as any).applicationRole || row.contact?.jobRole || appData.roleIntent || null;
        const docsStatus = buildDocStatus(roleRaw, row.messages || []);
        const phone = String((row.contact as any)?.phone || (row.contact as any)?.waId || '').trim();
        const item = {
          conversationId: row.id,
          name: pickCandidateDisplayName(row.contact),
          jobRole: String(roleRaw || '').trim() || null,
          roleLabel: getPostulacionRoleLabel(roleRaw),
          comuna: String((row.contact as any)?.comuna || appData.comuna || '').trim() || null,
          availability:
            String((row as any).availabilityRaw || (row.contact as any)?.availabilityText || appData.availability || '').trim() || null,
          experience:
            String(appData.experience || '').trim() ||
            (Number.isFinite((row.contact as any)?.experienceYears)
              ? `${Number((row.contact as any)?.experienceYears)} años`
              : null),
          phone,
          programId: row.programId || null,
          programName: row.program?.name || null,
          stage: row.conversationStage,
          applicationState: (row as any).applicationState || null,
          aiPaused: Boolean((row as any).aiPaused),
          updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
          docs: {
            cv: docsStatus.cv,
            carnet: docsStatus.carnet,
            licencia: docsStatus.licencia,
            vehiculo: docsStatus.vehiculo,
          },
        };
        return item;
      })
      .filter((item) => {
        if (!q) return true;
        const hay = [
          item.conversationId,
          item.name,
          item.phone,
          item.comuna,
          item.programName,
          item.roleLabel,
          item.jobRole,
          item.stage,
        ]
          .map((v) => String(v || '').toLowerCase())
          .join(' ');
        return hay.includes(q);
      });

    return { items: out, total: out.length };
  });

  app.get('/:conversationId', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const { conversationId } = request.params as { conversationId: string };

    const row = await prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId: access.workspaceId, archivedAt: null },
      include: {
        contact: true,
        program: { select: { id: true, name: true, slug: true } },
        messages: {
          orderBy: [{ timestamp: 'desc' }],
          take: 200,
          select: {
            id: true,
            direction: true,
            text: true,
            transcriptText: true,
            mediaPath: true,
            mediaMime: true,
            mediaType: true,
            rawPayload: true,
            timestamp: true,
            isInternalEvent: true,
          },
        },
      },
    });
    if (!row) return reply.code(404).send({ error: 'Caso no encontrado' });

    const appData = parseJson((row as any).applicationDataJson);
    const roleRaw = (row as any).applicationRole || row.contact?.jobRole || appData.roleIntent || null;
    const docsStatus = buildDocStatus(roleRaw, row.messages || []);
    const summaryRow = (row.messages || []).find(
      (m) => Boolean((m as any).isInternalEvent) && /RESUMEN INTERNO/i.test(String(m.text || '')),
    );

    const summaryComputed = await buildPostulacionInternalSummary({
      workspaceId: access.workspaceId,
      conversationId,
    }).catch(() => null);

    return {
      conversationId: row.id,
      stage: row.conversationStage,
      applicationState: (row as any).applicationState || null,
      aiPaused: Boolean((row as any).aiPaused),
      name: pickCandidateDisplayName(row.contact),
      phone: String((row.contact as any)?.phone || (row.contact as any)?.waId || '').trim() || null,
      email: String((row.contact as any)?.email || appData.email || '').trim() || null,
      comuna: String((row.contact as any)?.comuna || appData.comuna || '').trim() || null,
      availability:
        String((row as any).availabilityRaw || (row.contact as any)?.availabilityText || appData.availability || '').trim() || null,
      experience:
        String(appData.experience || '').trim() ||
        (Number.isFinite((row.contact as any)?.experienceYears)
          ? `${Number((row.contact as any)?.experienceYears)} años`
          : null),
      programName: row.program?.name || null,
      roleLabel: getPostulacionRoleLabel(roleRaw),
      docs: {
        cv: docsStatus.cv,
        carnet: docsStatus.carnet,
        licencia: docsStatus.licencia,
        vehiculo: docsStatus.vehiculo,
      },
      documents: docsStatus.docs,
      summary: String(summaryRow?.text || summaryComputed?.summary || '').trim() || null,
      summaryUpdatedAt: summaryRow?.timestamp ? new Date(summaryRow.timestamp).toISOString() : null,
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    };
  });

  app.post('/:conversationId/action', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const { conversationId } = request.params as { conversationId: string };
    const body = (request.body || {}) as { action?: string; note?: string | null };
    const action = String(body.action || '').trim().toUpperCase();

    const convo = await prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId: access.workspaceId, archivedAt: null },
      include: { contact: true },
    });
    if (!convo) return reply.code(404).send({ error: 'Caso no encontrado' });

    if (action === 'REGENERATE_SUMMARY') {
      const result = await buildPostulacionInternalSummary({
        workspaceId: access.workspaceId,
        conversationId,
      });
      const now = new Date();
      await prisma.message
        .create({
          data: {
            conversationId,
            direction: 'OUTBOUND',
            text: `📋 RESUMEN INTERNO (actualizado)\n\n${String(result.summary || '')}`,
            rawPayload: serializeJson({ system: true, internalEvent: true, reviewSummary: true, eventType: 'REGENERATE_SUMMARY' }),
            isInternalEvent: true as any,
            timestamp: now,
            read: true,
          },
        })
        .catch(() => {});
      await prisma.configChangeLog
        .create({
          data: {
            workspaceId: access.workspaceId,
            userId: request.user?.userId ? String(request.user.userId) : null,
            type: 'OP_REVIEW_REGENERATE_SUMMARY',
            afterJson: serializeJson({ conversationId }),
          },
        })
        .catch(() => {});
      return { ok: true, action, summary: result.summary };
    }

    let mapped: { stage: string; applicationState: string; aiPaused: boolean; note: string };
    try {
      mapped = mapActionToState(action);
    } catch (err: any) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Acción inválida' });
    }

    const stageSlug = await coerceStageSlug({ workspaceId: access.workspaceId, stageSlug: mapped.stage }).catch(() => mapped.stage);
    const now = new Date();
    await prisma.conversation
      .update({
        where: { id: conversationId },
        data: {
          conversationStage: stageSlug,
          stageChangedAt: now,
          stageReason: `op_review_action_${action.toLowerCase()}`,
          applicationState: mapped.applicationState as any,
          aiPaused: mapped.aiPaused,
          updatedAt: now,
        } as any,
      })
      .catch(() => {});

    const noteText = String(body.note || '').trim() || mapped.note;
    await prisma.message
      .create({
        data: {
          conversationId,
          direction: 'OUTBOUND',
          text: noteText,
          rawPayload: serializeJson({ system: true, internalEvent: true, opReviewAction: action }),
          isInternalEvent: true as any,
          timestamp: now,
          read: true,
        },
      })
      .catch(() => {});

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId: request.user?.userId ? String(request.user.userId) : null,
          type: 'OP_REVIEW_ACTION',
          afterJson: serializeJson({ conversationId, action, stage: stageSlug, applicationState: mapped.applicationState }),
        },
      })
      .catch(() => {});

    return {
      ok: true,
      action,
      conversationId,
      stage: stageSlug,
      applicationState: mapped.applicationState,
      aiPaused: mapped.aiPaused,
    };
  });

  app.get('/:conversationId/package', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const { conversationId } = request.params as { conversationId: string };

    const convo = await prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId: access.workspaceId, archivedAt: null },
      include: {
        contact: true,
        messages: {
          orderBy: [{ timestamp: 'desc' }],
          take: 240,
          select: {
            id: true,
            direction: true,
            text: true,
            transcriptText: true,
            mediaPath: true,
            mediaMime: true,
            mediaType: true,
            rawPayload: true,
            timestamp: true,
          },
        },
      },
    });
    if (!convo) return reply.code(404).send({ error: 'Caso no encontrado' });

    const summary = await buildPostulacionInternalSummary({
      workspaceId: access.workspaceId,
      conversationId,
    });

    const docs = detectPostulacionDocuments(convo.messages || []);
    const messageMap = new Map((convo.messages || []).map((m: any) => [String(m.id), m]));

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileBase = sanitizeFileName(`${pickCandidateDisplayName(convo.contact)}-${conversationId}`);
    const filename = `op-review-${fileBase}-${stamp}.zip`;

    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err: any) => {
      app.log.error({ err, conversationId }, 'op-review package zip error');
    });
    reply.send(archive);

    archive.append(summary.summary, { name: 'resumen.txt' });
    archive.append(
      [
        `conversationId=${conversationId}`,
        `name=${pickCandidateDisplayName(convo.contact)}`,
        `stage=${String(convo.conversationStage || '')}`,
        `applicationState=${String((convo as any).applicationState || '')}`,
        `generatedAt=${new Date().toISOString()}`,
      ].join('\n'),
      { name: 'manifest.txt' },
    );

    for (const doc of docs) {
      const msg = messageMap.get(String(doc.messageId));
      const mediaPath = String(msg?.mediaPath || '').trim();
      if (!mediaPath) continue;
      const absolute = resolveMediaPathCandidates(mediaPath).find((p) => fs.existsSync(p));
      if (!absolute) continue;
      const finalName = sanitizeFileName(doc.fileName || path.basename(absolute));
      archive.file(absolute, { name: `documentos/${doc.kind.toLowerCase()}_${finalName}` });
    }

    await archive.finalize();
  });
}
