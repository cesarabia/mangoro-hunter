import { FastifyInstance } from 'fastify';
import * as XLSX from 'xlsx';
import { prisma } from '../db/client';
import { isWorkspaceAdmin, resolveWorkspaceAccess } from '../services/workspaceAuthService';
import {
  buildWorkspaceJobRoleProgramMap,
  CandidateJobRole,
  deriveCandidateStatusFromConversation,
  inferCandidateJobRoleFromProgram,
  normalizeCandidateJobRole,
  upsertCandidateAndCase,
} from '../services/candidateService';
import { normalizeChilePhoneE164 } from '../utils/phone';
import { repairMojibake } from '../utils/textEncoding';
import { listWorkspaceTemplateCatalog } from '../services/whatsappTemplateCatalogService';
import { loadTemplateConfig, resolveTemplateVariables } from '../services/templateService';
import { sendWhatsAppTemplate } from '../services/whatsappMessageService';
import { serializeJson } from '../utils/json';
import { stableHash } from '../services/agent/tools';
import { getSystemConfig } from '../services/configService';

function normalizeHeader(value: unknown): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function firstField(row: Record<string, any>, aliases: string[]): string {
  const entries = Object.entries(row || {});
  if (entries.length === 0) return '';
  const wanted = aliases.map((a) => normalizeHeader(a));
  for (const [key, value] of entries) {
    const normKey = normalizeHeader(key);
    if (!normKey) continue;
    if (wanted.some((w) => normKey === w || normKey.includes(w) || w.includes(normKey))) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
  }
  return '';
}

function parseWorkbookRows(buffer: Buffer): Record<string, any>[] {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false, dense: false });
  const firstSheetName = workbook.SheetNames?.[0];
  if (!firstSheetName) return [];
  const sheet = workbook.Sheets[firstSheetName];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '', raw: false, blankrows: false });
  return Array.isArray(rows) ? rows : [];
}

function decodeBase64Payload(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.includes('base64,') ? trimmed.split('base64,').pop() || '' : trimmed;
  if (!cleaned) return null;
  try {
    const buffer = Buffer.from(cleaned, 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

type CandidateRowNormalized = {
  phoneRaw: string;
  name: string;
  role: string;
  jobRole: CandidateJobRole;
  channel: string;
  comuna: string;
  ciudad: string;
  email: string;
  initialStatus: string;
  sourceRow: number;
};

function normalizeImportedRow(row: Record<string, any>, sourceRow: number): CandidateRowNormalized {
  const roleText = repairMojibake(
    firstField(row, ['rol', 'cargo', 'puesto', 'vacante', 'job', 'job role', 'jobrole', 'position']),
  );
  const explicitJobRole = repairMojibake(firstField(row, ['jobrole', 'job_role', 'puesto objetivo', 'tipo cargo']));
  const inferredJobRole = normalizeCandidateJobRole(explicitJobRole || roleText || '', 'CONDUCTOR');

  return {
    phoneRaw: firstField(row, ['telefono', 'teléfono', 'celular', 'whatsapp', 'fono', 'phone', 'numero', 'número']),
    name: repairMojibake(firstField(row, ['nombre', 'name', 'postulante', 'candidato'])),
    role: roleText,
    jobRole: inferredJobRole,
    channel: repairMojibake(firstField(row, ['canal', 'fuente', 'source', 'origen'])),
    comuna: repairMojibake(firstField(row, ['comuna'])),
    ciudad: repairMojibake(firstField(row, ['ciudad', 'city'])),
    email: repairMojibake(firstField(row, ['email', 'correo'])),
    initialStatus: repairMojibake(firstField(row, ['estado', 'status', 'etapa', 'stage'])),
    sourceRow,
  };
}

function parseTemplateOverrides(input: unknown): Partial<Record<CandidateJobRole, string>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const raw = input as Record<string, unknown>;
  const out: Partial<Record<CandidateJobRole, string>> = {};
  const conductor = String(raw.CONDUCTOR || raw.conductor || '').trim();
  const peoneta = String(raw.PEONETA || raw.peoneta || '').trim();
  if (conductor) out.CONDUCTOR = conductor;
  if (peoneta) out.PEONETA = peoneta;
  return out;
}

function normalizeRoleKey(value: unknown): CandidateJobRole {
  return normalizeCandidateJobRole(value, 'CONDUCTOR');
}

function mapCandidateResponseItem(contact: any, conversation: any) {
  const derived = deriveCandidateStatusFromConversation(conversation || null);
  const jobRole: CandidateJobRole = normalizeRoleKey(
    contact?.jobRole || inferCandidateJobRoleFromProgram(conversation?.program || null),
  );

  return {
    contactId: contact.id,
    conversationId: conversation?.id || null,
    phoneE164: contact.phone || null,
    waId: contact.waId || null,
    name: repairMojibake(
      contact.candidateNameManual || contact.candidateName || contact.displayName || contact.name || contact.phone || 'Sin nombre',
    ),
    comuna: contact.comuna || null,
    ciudad: contact.ciudad || null,
    email: contact.email || null,
    candidateStatus: derived.candidateStatus,
    conversationStatus: derived.status,
    stageSlug: derived.stageSlug,
    jobRole,
    programId: conversation?.programId || null,
    programName: conversation?.program?.name || null,
    programSlug: conversation?.program?.slug || null,
    importBatchId: contact.importBatchId || null,
    importedAt: contact.importedAt ? new Date(contact.importedAt).toISOString() : null,
    importedByUserId: contact.importedByUserId || null,
    importSourceFileName: contact.importSourceFileName || null,
    importSourceChannel: contact.importSourceChannel || null,
    hasMessages: Array.isArray(conversation?.messages) ? conversation.messages.length > 0 : false,
    updatedAt: (conversation?.updatedAt || contact.updatedAt || contact.createdAt || new Date()).toISOString(),
    createdAt: (contact.createdAt || new Date()).toISOString(),
  };
}

function parseWhatsappPricing(value: unknown):
  | { sessionTextUsd: number; templateUsd: number; templateByNameUsd?: Record<string, number> }
  | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as any;
  const sessionTextUsd = Number(raw.sessionTextUsd);
  const templateUsd = Number(raw.templateUsd);
  if (!Number.isFinite(sessionTextUsd) || !Number.isFinite(templateUsd) || sessionTextUsd < 0 || templateUsd < 0) {
    return null;
  }
  let templateByNameUsd: Record<string, number> | undefined;
  if (raw.templateByNameUsd && typeof raw.templateByNameUsd === 'object' && !Array.isArray(raw.templateByNameUsd)) {
    templateByNameUsd = {};
    for (const [k, v] of Object.entries(raw.templateByNameUsd)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) templateByNameUsd[String(k)] = n;
    }
  }
  return { sessionTextUsd, templateUsd, ...(templateByNameUsd ? { templateByNameUsd } : {}) };
}

function estimateTemplateCostUsd(
  pricing: { sessionTextUsd: number; templateUsd: number; templateByNameUsd?: Record<string, number> } | null,
  templateName: string,
): number | null {
  if (!pricing) return null;
  const byName = pricing.templateByNameUsd || {};
  if (templateName in byName) return byName[templateName];
  return pricing.templateUsd;
}

function computeDefaultTemplateByRole(workspace: any): Record<CandidateJobRole, string> {
  const conductor =
    String(workspace?.templateRecruitmentStartName || '').trim() ||
    'enviorapido_postulacion_inicio_v1';
  const peoneta =
    String((workspace as any)?.templatePeonetaStartName || '').trim() ||
    'enviorapido_postulacion_general_v1';
  return {
    CONDUCTOR: conductor,
    PEONETA: peoneta,
  };
}

function shouldSkipByStageForInitialTemplate(stageSlug: string): boolean {
  const stage = String(stageSlug || '').toUpperCase();
  return !['NEW_INTAKE', 'SCREENING', 'INFO', 'NUEVO'].includes(stage);
}

function pickTemplateContactName(contact: any): string | null {
  const candidates = [contact?.candidateNameManual, contact?.candidateName, contact?.displayName, contact?.name]
    .map((v: any) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
  for (const value of candidates) {
    const lower = value.toLowerCase();
    if (
      lower.includes('ejecutivo') ||
      lower.includes('ventas') ||
      lower.includes('terreno') ||
      lower.includes('postul') ||
      lower.includes('informaci')
    ) {
      continue;
    }
    return value;
  }
  return null;
}

function buildBatchDedupeKey(conversationId: string, templateName: string, importBatchId: string): string {
  return `bulk_import_template:${importBatchId}:${conversationId}:${templateName}`;
}

async function applyTemplateStatusTransition(params: {
  conversationId: string;
  workspaceId: string;
  templateName: string;
}): Promise<{ stageSlug: string; candidateStatus: string }> {
  const template = String(params.templateName || '').trim().toLowerCase();
  const now = new Date();
  const conversation = await prisma.conversation.findFirst({
    where: { id: params.conversationId, workspaceId: params.workspaceId },
    select: { id: true, status: true, conversationStage: true },
  });
  if (!conversation?.id) return { stageSlug: '', candidateStatus: 'NUEVO' };

  const patch: any = { updatedAt: now };
  if (template === 'enviorapido_postulacion_inicio_v1' || template === 'enviorapido_postulacion_general_v1') {
    patch.status = 'OPEN';
    if (String(conversation.conversationStage || '').toUpperCase() === 'NEW_INTAKE') {
      patch.conversationStage = 'SCREENING';
      patch.stageChangedAt = now;
      patch.stageReason = 'bulk_template_initial_contact';
    }
  } else if (template === 'enviorapido_confirma_entrevista_v1') {
    patch.status = 'OPEN';
    patch.conversationStage = 'INTERVIEW_SCHEDULED';
    patch.stageChangedAt = now;
    patch.stageReason = 'bulk_template_interview_confirm';
  }

  const updated = await prisma.conversation.update({ where: { id: conversation.id }, data: patch as any });
  const derived = deriveCandidateStatusFromConversation(updated);
  return { stageSlug: String(updated.conversationStage || ''), candidateStatus: derived.candidateStatus };
}

async function listBatchCandidates(params: {
  workspaceId: string;
  importBatchId: string;
  q?: string;
}): Promise<
  Array<{
    contact: any;
    conversation: any | null;
    candidateStatus: string;
    stageSlug: string;
    jobRole: CandidateJobRole;
    waId: string | null;
  }>
> {
  const q = String(params.q || '').trim().toLowerCase();
  const contacts = await prisma.contact.findMany({
    where: {
      workspaceId: params.workspaceId,
      archivedAt: null,
      importBatchId: params.importBatchId,
      ...(q
        ? {
            OR: [
              { phone: { contains: q } },
              { waId: { contains: q } },
              { candidateName: { contains: q } },
              { candidateNameManual: { contains: q } },
              { displayName: { contains: q } },
              { name: { contains: q } },
            ],
          }
        : {}),
    },
    orderBy: { importedAt: 'asc' },
  });

  if (contacts.length === 0) return [];
  const contactIds = contacts.map((c) => c.id);
  const conversations = await prisma.conversation.findMany({
    where: {
      workspaceId: params.workspaceId,
      contactId: { in: contactIds },
      archivedAt: null,
      isAdmin: false,
      conversationKind: 'CLIENT',
    } as any,
    include: {
      contact: true,
      phoneLine: { select: { id: true, waPhoneNumberId: true } },
      program: { select: { id: true, slug: true, name: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });
  const latestByContact = new Map<string, any>();
  for (const c of conversations) {
    if (!latestByContact.has(c.contactId)) latestByContact.set(c.contactId, c);
  }

  return contacts.map((contact) => {
    const conversation = latestByContact.get(contact.id) || null;
    const derived = deriveCandidateStatusFromConversation(conversation || null);
    const jobRole = normalizeRoleKey(contact.jobRole || inferCandidateJobRoleFromProgram(conversation?.program || null));
    const waId = String(contact.waId || '').trim() || (String(contact.phone || '').trim().replace(/^\+/, '') || null);
    return {
      contact,
      conversation,
      candidateStatus: derived.candidateStatus,
      stageSlug: derived.stageSlug,
      jobRole,
      waId,
    };
  });
}

export async function registerCandidateRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const query = String((request.query as any)?.q || '').trim().toLowerCase();
    const statusFilter = String((request.query as any)?.status || '').trim().toUpperCase();
    const jobRoleFilter = String((request.query as any)?.jobRole || '').trim().toUpperCase();
    const programIdFilter = String((request.query as any)?.programId || '').trim();
    const importBatchIdFilter = String((request.query as any)?.importBatchId || '').trim();
    const limitRaw = Number((request.query as any)?.limit || 100);
    const limit = Number.isFinite(limitRaw) ? Math.min(1000, Math.max(1, Math.floor(limitRaw))) : 100;

    const contacts = await prisma.contact.findMany({
      where: {
        workspaceId: access.workspaceId,
        archivedAt: null,
        ...(importBatchIdFilter ? { importBatchId: importBatchIdFilter } : {}),
        ...(jobRoleFilter ? { jobRole: jobRoleFilter } : {}),
        ...(query
          ? {
              OR: [
                { phone: { contains: query } },
                { waId: { contains: query } },
                { candidateName: { contains: query } },
                { candidateNameManual: { contains: query } },
                { displayName: { contains: query } },
                { name: { contains: query } },
                { comuna: { contains: query } },
                { ciudad: { contains: query } },
                { importBatchId: { contains: query } },
              ],
            }
          : {}),
      },
      orderBy: [{ importedAt: 'desc' }, { updatedAt: 'desc' }],
      take: limit,
    });

    if (contacts.length === 0) return { rows: [], total: 0 };

    const contactIds = contacts.map((c) => c.id);
    const conversations = await prisma.conversation.findMany({
      where: {
        workspaceId: access.workspaceId,
        contactId: { in: contactIds },
        archivedAt: null,
        isAdmin: false,
      } as any,
      include: {
        program: { select: { id: true, name: true, slug: true } },
        messages: {
          orderBy: { timestamp: 'desc' },
          take: 1,
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const latestByContact = new Map<string, any>();
    for (const c of conversations) {
      if (!latestByContact.has(c.contactId)) latestByContact.set(c.contactId, c);
    }

    const rows = contacts
      .map((contact) => mapCandidateResponseItem(contact, latestByContact.get(contact.id) || null))
      .filter((row) => {
        if (statusFilter && String(row.candidateStatus || '').toUpperCase() !== statusFilter) return false;
        if (programIdFilter && String(row.programId || '') !== programIdFilter) return false;
        return true;
      });

    return { rows, total: rows.length };
  });

  app.post('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const body = request.body as {
      phoneE164?: string;
      name?: string;
      role?: string;
      jobRole?: string;
      channel?: string;
      comuna?: string;
      ciudad?: string;
      email?: string;
      initialStatus?: string;
    };

    const phoneRaw = String(body?.phoneE164 || '').trim();
    if (!phoneRaw) return reply.code(400).send({ error: 'phoneE164 es obligatorio' });

    try {
      const roleProgramMap = await buildWorkspaceJobRoleProgramMap(access.workspaceId);
      const res = await upsertCandidateAndCase({
        workspaceId: access.workspaceId,
        phoneRaw,
        name: body?.name || null,
        role: body?.role || null,
        jobRole: body?.jobRole || body?.role || null,
        channel: body?.channel || null,
        comuna: body?.comuna || null,
        ciudad: body?.ciudad || null,
        email: body?.email || null,
        initialStatus: body?.initialStatus || 'NUEVO',
        preserveExistingConversationStage: true,
        roleProgramMap,
      });
      return { ok: true, ...res };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message || 'No se pudo crear candidato' });
    }
  });

  app.post('/import', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const body = request.body as {
      fileName?: string;
      mimeType?: string;
      fileBase64?: string;
      preserveExistingConversationStage?: boolean;
      overrideJobRole?: string | null;
    };

    const fileName = String(body?.fileName || '').trim() || 'import';
    const fileBase64 = String(body?.fileBase64 || '').trim();
    if (!fileBase64) return reply.code(400).send({ error: 'fileBase64 es obligatorio' });

    const payload = decodeBase64Payload(fileBase64);
    if (!payload) return reply.code(400).send({ error: 'Archivo inválido/base64 corrupto' });

    let rowsRaw: Record<string, any>[] = [];
    try {
      rowsRaw = parseWorkbookRows(payload);
    } catch (err: any) {
      return reply.code(400).send({ error: `No se pudo leer ${fileName}: ${err?.message || 'formato inválido'}` });
    }

    if (rowsRaw.length === 0) {
      return reply.code(400).send({ error: 'El archivo no trae filas útiles (cabecera + datos).' });
    }

    const userId = request.user?.userId ? String(request.user.userId) : null;
    const preserveExistingConversationStage =
      Object.prototype.hasOwnProperty.call(body || {}, 'preserveExistingConversationStage')
        ? Boolean(body?.preserveExistingConversationStage)
        : true;

    const overrideJobRole = body?.overrideJobRole
      ? normalizeCandidateJobRole(body.overrideJobRole, 'CONDUCTOR')
      : null;

    const roleProgramMap = await buildWorkspaceJobRoleProgramMap(access.workspaceId);

    const importBatchId = `imp_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${stableHash(
      `${access.workspaceId}:${fileName}:${rowsRaw.length}:${Date.now()}`,
    ).slice(0, 8)}`;

    const normalizedRows = rowsRaw.map((row, index) => {
      const parsed = normalizeImportedRow(row, index + 2);
      if (overrideJobRole) parsed.jobRole = overrideJobRole;
      return parsed;
    });
    const dedupeByPhone = new Map<string, CandidateRowNormalized>();

    const errors: Array<{ row: number; phone?: string; reason: string }> = [];
    for (const row of normalizedRows) {
      if (!row.phoneRaw) {
        errors.push({ row: row.sourceRow, reason: 'Sin teléfono' });
        continue;
      }
      let phoneE164: string;
      try {
        phoneE164 = normalizeChilePhoneE164(row.phoneRaw) || '';
      } catch (err: any) {
        errors.push({ row: row.sourceRow, phone: row.phoneRaw, reason: err?.message || 'Teléfono inválido' });
        continue;
      }
      if (!phoneE164) {
        errors.push({ row: row.sourceRow, phone: row.phoneRaw, reason: 'Teléfono inválido' });
        continue;
      }
      if (!dedupeByPhone.has(phoneE164)) {
        dedupeByPhone.set(phoneE164, { ...row, phoneRaw: phoneE164 });
      }
    }

    let createdContacts = 0;
    let updatedContacts = 0;
    let createdConversations = 0;
    const imported: Array<{
      phoneE164: string;
      conversationId: string;
      contactId: string;
      jobRole: CandidateJobRole;
      programId: string | null;
    }> = [];

    for (const row of dedupeByPhone.values()) {
      try {
        const result = await upsertCandidateAndCase({
          workspaceId: access.workspaceId,
          phoneRaw: row.phoneRaw,
          name: row.name || null,
          role: row.role || null,
          jobRole: row.jobRole,
          channel: row.channel || null,
          comuna: row.comuna || null,
          ciudad: row.ciudad || null,
          email: row.email || null,
          initialStatus: row.initialStatus || 'NUEVO',
          preserveExistingConversationStage,
          importBatchId,
          importedByUserId: userId,
          sourceFileName: fileName,
          sourceChannel: row.channel || null,
          roleProgramMap,
        });

        if (result.createdContact) createdContacts += 1;
        else updatedContacts += 1;
        if (result.createdConversation) createdConversations += 1;

        imported.push({
          phoneE164: result.phoneE164,
          conversationId: result.conversationId,
          contactId: result.contactId,
          jobRole: result.jobRole,
          programId: result.programId,
        });
      } catch (err: any) {
        errors.push({ row: row.sourceRow, phone: row.phoneRaw, reason: err?.message || 'Import failed' });
      }
    }

    const dedupedRows = Math.max(0, normalizedRows.length - dedupeByPhone.size);

    return {
      ok: true,
      fileName,
      importBatchId,
      importedAt: new Date().toISOString(),
      importedByUserId: userId,
      totalRows: rowsRaw.length,
      validRows: dedupeByPhone.size,
      createdContacts,
      updatedContacts,
      createdConversations,
      dedupedRows,
      errors,
      imported,
      // Backward compatibility with existing UI keys.
      created: createdContacts,
      updated: updatedContacts,
      skipped: dedupedRows + errors.length,
      note: 'Importación completada sin envíos automáticos de WhatsApp.',
    };
  });

  app.post('/import/bulk-template/preview', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const body = request.body as {
      importBatchId?: string;
      templateByRole?: Record<string, string>;
    };

    const importBatchId = String(body?.importBatchId || '').trim();
    if (!importBatchId) return reply.code(400).send({ error: 'importBatchId es obligatorio' });

    const workspace = await prisma.workspace.findUnique({
      where: { id: access.workspaceId },
      select: {
        id: true,
        templateRecruitmentStartName: true as any,
        templatePeonetaStartName: true as any,
      } as any,
    });
    if (!workspace?.id) return reply.code(404).send({ error: 'Workspace no encontrado' });

    const catalog = await listWorkspaceTemplateCatalog(access.workspaceId).catch(() => null);
    const namesLower = new Set(
      Array.isArray(catalog?.templates)
        ? catalog.templates.map((t: any) => String(t?.name || '').trim().toLowerCase()).filter(Boolean)
        : [],
    );

    const overrides = parseTemplateOverrides(body?.templateByRole);
    const defaults = computeDefaultTemplateByRole(workspace);

    const rows = await listBatchCandidates({ workspaceId: access.workspaceId, importBatchId });
    if (rows.length === 0) {
      return {
        ok: true,
        importBatchId,
        totals: { total: 0, eligible: 0, skipped: 0 },
        templatesByRole: { ...defaults, ...overrides },
        skipReasons: {},
        rows: [],
        dryRunHash: stableHash(`${access.workspaceId}:${importBatchId}:empty`),
      };
    }

    const config = await getSystemConfig();
    let pricing: any = null;
    try {
      pricing = parseWhatsappPricing((config as any)?.whatsappPricing ? JSON.parse(String((config as any).whatsappPricing)) : null);
    } catch {
      pricing = null;
    }

    const skipReasons: Record<string, number> = {};
    const rowsOut: any[] = [];
    let estimatedCostUsd = 0;
    let hasAnyCost = false;

    for (const item of rows) {
      const role = item.jobRole;
      const templateName = String(overrides[role] || defaults[role] || '').trim();
      const stage = String(item.stageSlug || '').toUpperCase();
      const status = String(item.candidateStatus || '').toUpperCase();

      let eligible = true;
      let reason: string | null = null;
      if (!item.waId) {
        eligible = false;
        reason = 'INVALID_PHONE';
      } else if (!item.conversation?.id) {
        eligible = false;
        reason = 'NO_CASE';
      } else if (status !== 'NUEVO') {
        eligible = false;
        reason = 'ALREADY_CONTACTED';
      } else if (shouldSkipByStageForInitialTemplate(stage)) {
        eligible = false;
        reason = 'STAGE_NOT_ELIGIBLE';
      } else if (!templateName) {
        eligible = false;
        reason = 'NO_TEMPLATE';
      } else if (namesLower.size > 0 && !namesLower.has(templateName.toLowerCase())) {
        eligible = false;
        reason = 'TEMPLATE_NOT_IN_CATALOG';
      }

      if (!eligible && reason) skipReasons[reason] = (skipReasons[reason] || 0) + 1;

      const costUsd = templateName ? estimateTemplateCostUsd(pricing, templateName) : null;
      if (eligible && costUsd !== null) {
        estimatedCostUsd += costUsd;
        hasAnyCost = true;
      }

      rowsOut.push({
        contactId: item.contact.id,
        conversationId: item.conversation?.id || null,
        phoneE164: item.contact.phone || null,
        name: repairMojibake(item.contact.candidateNameManual || item.contact.candidateName || item.contact.displayName || item.contact.name || ''),
        jobRole: role,
        stageSlug: item.stageSlug,
        candidateStatus: item.candidateStatus,
        templateName: templateName || null,
        eligible,
        reason,
        estimatedCostUsd: eligible ? costUsd : null,
      });
    }

    const eligibleRows = rowsOut.filter((r) => r.eligible);
    const dryRunHash = stableHash(
      JSON.stringify({
        workspaceId: access.workspaceId,
        importBatchId,
        templates: { ...defaults, ...overrides },
        ids: eligibleRows.map((r) => `${r.contactId}:${r.conversationId}:${r.templateName}`),
      }),
    );

    return {
      ok: true,
      importBatchId,
      templatesByRole: { ...defaults, ...overrides },
      totals: {
        total: rowsOut.length,
        eligible: eligibleRows.length,
        skipped: rowsOut.length - eligibleRows.length,
      },
      skipReasons,
      estimatedCostUsd: hasAnyCost ? Number(estimatedCostUsd.toFixed(6)) : null,
      dryRunHash,
      rows: rowsOut,
      sync: catalog?.sync || null,
    };
  });

  app.post('/import/bulk-template/send', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const body = request.body as {
      importBatchId?: string;
      templateByRole?: Record<string, string>;
      confirmText?: string;
      dryRunHash?: string;
      transportMode?: 'NULL' | 'REAL';
    };

    const importBatchId = String(body?.importBatchId || '').trim();
    if (!importBatchId) return reply.code(400).send({ error: 'importBatchId es obligatorio' });
    if (String(body?.confirmText || '').trim().toUpperCase() !== 'CONFIRMAR') {
      return reply.code(400).send({ error: 'Confirmación requerida. Escribe CONFIRMAR para ejecutar el envío masivo.' });
    }

    const preview = await app.inject({
      method: 'POST',
      url: '/api/candidates/import/bulk-template/preview',
      headers: {
        authorization: String((request.headers as any)?.authorization || ''),
        'x-workspace-id': access.workspaceId,
      },
      payload: {
        importBatchId,
        templateByRole: body?.templateByRole || {},
      },
    });

    if (preview.statusCode !== 200) {
      const text = String(preview.body || '').trim() || 'No se pudo evaluar el dry-run';
      return reply.code(400).send({ error: text });
    }

    let previewJson: any = null;
    try {
      previewJson = JSON.parse(String(preview.body || '{}'));
    } catch {
      previewJson = null;
    }
    if (!previewJson?.ok) return reply.code(400).send({ error: 'No se pudo calcular preview para envío masivo.' });

    const expectedHash = String(previewJson?.dryRunHash || '');
    const providedHash = String(body?.dryRunHash || '').trim();
    if (providedHash && expectedHash && providedHash !== expectedHash) {
      return reply.code(409).send({ error: 'El preview cambió. Actualiza el dry-run antes de confirmar.' });
    }

    const templatesCfg = await loadTemplateConfig(app.log, access.workspaceId).catch(async () =>
      loadTemplateConfig(app.log).catch(() => ({
        templateInterviewInvite: null,
        templateGeneralFollowup: null,
        templateLanguageCode: 'es_CL',
        defaultJobTitle: null,
        defaultInterviewDay: null,
        defaultInterviewTime: null,
        defaultInterviewLocation: null,
        testPhoneNumber: null,
      })),
    );
    const rows = Array.isArray(previewJson?.rows) ? previewJson.rows : [];
    const eligibleRows = rows.filter((r: any) => Boolean(r?.eligible));

    const userId = request.user?.userId ? String(request.user.userId) : null;
    const now = new Date();

    const results: Array<{
      contactId: string;
      conversationId: string;
      templateName: string;
      ok: boolean;
      blockedReason: string | null;
      messageId: string | null;
      error: string | null;
    }> = [];

    for (const row of eligibleRows) {
      const conversation = await prisma.conversation.findFirst({
        where: {
          id: String(row.conversationId || ''),
          workspaceId: access.workspaceId,
          archivedAt: null,
        },
        include: {
          contact: true,
          phoneLine: { select: { waPhoneNumberId: true } },
        },
      });

      if (!conversation?.id || !conversation.contact?.waId) {
        results.push({
          contactId: String(row.contactId || ''),
          conversationId: String(row.conversationId || ''),
          templateName: String(row.templateName || ''),
          ok: false,
          blockedReason: 'NO_CASE',
          messageId: null,
          error: 'Caso no encontrado para este candidato.',
        });
        continue;
      }

      const templateName = String(row.templateName || '').trim();
      const variables = resolveTemplateVariables(templateName, undefined, templatesCfg, {
        candidateName: pickTemplateContactName(conversation.contact),
        interviewDay: conversation.interviewDay,
        interviewTime: conversation.interviewTime,
        interviewLocation: conversation.interviewLocation,
      });

      const dedupeKey = buildBatchDedupeKey(conversation.id, templateName, importBatchId);

      const sendResult =
        String(body?.transportMode || '').toUpperCase() === 'NULL'
          ? ({ success: true, messageId: `sim_tpl_${stableHash(`${conversation.id}:${templateName}:${now.toISOString()}`).slice(0, 12)}` } as any)
          : await sendWhatsAppTemplate(conversation.contact.waId, templateName, variables, {
              phoneNumberId: conversation.phoneLine?.waPhoneNumberId || null,
              enforceSafeMode: false,
            });

      const blockedReason = sendResult.success ? null : String(sendResult.error || 'SEND_FAILED');

      await prisma.outboundMessageLog
        .create({
          data: {
            workspaceId: access.workspaceId,
            conversationId: conversation.id,
            channel: 'WHATSAPP',
            type: 'TEMPLATE',
            templateName,
            dedupeKey,
            textHash: stableHash(`TEMPLATE:${templateName}:${serializeJson(variables || [])}`),
            blockedReason,
            waMessageId: sendResult.success ? sendResult.messageId || null : null,
          } as any,
        })
        .catch(() => {});

      if (sendResult.success) {
        await prisma.message
          .create({
            data: {
              conversationId: conversation.id,
              direction: 'OUTBOUND',
              text: `[TEMPLATE] ${templateName}`,
              rawPayload: serializeJson({
                template: templateName,
                variables,
                sendResult,
                source: 'bulk_import_template_send',
                importBatchId,
              }),
              timestamp: new Date(),
              read: true,
            },
          })
          .catch(() => {});

        await applyTemplateStatusTransition({
          conversationId: conversation.id,
          workspaceId: access.workspaceId,
          templateName,
        }).catch(() => {});
      }

      results.push({
        contactId: conversation.contactId,
        conversationId: conversation.id,
        templateName,
        ok: Boolean(sendResult.success),
        blockedReason,
        messageId: sendResult.success ? sendResult.messageId || null : null,
        error: sendResult.success ? null : blockedReason,
      });
    }

    const sent = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId,
          type: 'CANDIDATE_BULK_TEMPLATE_SEND',
          beforeJson: serializeJson({
            importBatchId,
            dryRunHash: expectedHash,
            totals: previewJson?.totals || null,
          }),
          afterJson: serializeJson({
            importBatchId,
            sent,
            failed,
            results: results.slice(0, 50),
          }),
        },
      })
      .catch(() => {});

    return {
      ok: true,
      importBatchId,
      dryRunHash: expectedHash,
      totals: {
        total: eligibleRows.length,
        sent,
        failed,
      },
      results,
    };
  });
}
