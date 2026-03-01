import { FastifyInstance } from 'fastify';
import * as XLSX from 'xlsx';
import { prisma } from '../db/client';
import { isWorkspaceAdmin, resolveWorkspaceAccess } from '../services/workspaceAuthService';
import { deriveCandidateStatusFromConversation, upsertCandidateAndCase } from '../services/candidateService';
import { normalizeChilePhoneE164 } from '../utils/phone';
import { repairMojibake } from '../utils/textEncoding';

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
  channel: string;
  comuna: string;
  ciudad: string;
  email: string;
  initialStatus: string;
  sourceRow: number;
};

function normalizeImportedRow(row: Record<string, any>, sourceRow: number): CandidateRowNormalized {
  return {
    phoneRaw: firstField(row, ['telefono', 'teléfono', 'celular', 'whatsapp', 'fono', 'phone', 'numero', 'número']),
    name: firstField(row, ['nombre', 'name', 'postulante', 'candidato']),
    role: firstField(row, ['rol', 'cargo', 'puesto', 'vacante']),
    channel: firstField(row, ['canal', 'fuente', 'source', 'origen']),
    comuna: firstField(row, ['comuna']),
    ciudad: firstField(row, ['ciudad', 'city']),
    email: firstField(row, ['email', 'correo']),
    initialStatus: firstField(row, ['estado', 'status', 'etapa', 'stage']),
    sourceRow,
  };
}

function mapCandidateResponseItem(contact: any, conversation: any) {
  const derived = deriveCandidateStatusFromConversation(conversation || null);
  return {
    contactId: contact.id,
    conversationId: conversation?.id || null,
    phoneE164: contact.phone || null,
    waId: contact.waId || null,
    name:
      repairMojibake(
        contact.candidateNameManual || contact.candidateName || contact.displayName || contact.name || contact.phone || 'Sin nombre',
      ),
    comuna: contact.comuna || null,
    ciudad: contact.ciudad || null,
    email: contact.email || null,
    candidateStatus: derived.candidateStatus,
    conversationStatus: derived.status,
    stageSlug: derived.stageSlug,
    updatedAt: (conversation?.updatedAt || contact.updatedAt || contact.createdAt || new Date()).toISOString(),
    createdAt: (contact.createdAt || new Date()).toISOString(),
  };
}

export async function registerCandidateRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const query = String((request.query as any)?.q || '').trim().toLowerCase();
    const statusFilter = String((request.query as any)?.status || '').trim().toUpperCase();
    const limitRaw = Number((request.query as any)?.limit || 100);
    const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, Math.floor(limitRaw))) : 100;

    const contacts = await prisma.contact.findMany({
      where: {
        workspaceId: access.workspaceId,
        archivedAt: null,
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
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
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
      orderBy: { updatedAt: 'desc' },
    });

    const latestByContact = new Map<string, any>();
    for (const c of conversations) {
      if (!latestByContact.has(c.contactId)) latestByContact.set(c.contactId, c);
    }

    const rows = contacts
      .map((contact) => mapCandidateResponseItem(contact, latestByContact.get(contact.id) || null))
      .filter((row) => {
        if (!statusFilter) return true;
        return String(row.candidateStatus || '').toUpperCase() === statusFilter;
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
      channel?: string;
      comuna?: string;
      ciudad?: string;
      email?: string;
      initialStatus?: string;
    };

    const phoneRaw = String(body?.phoneE164 || '').trim();
    if (!phoneRaw) return reply.code(400).send({ error: 'phoneE164 es obligatorio' });

    try {
      const res = await upsertCandidateAndCase({
        workspaceId: access.workspaceId,
        phoneRaw,
        name: body?.name || null,
        role: body?.role || null,
        channel: body?.channel || null,
        comuna: body?.comuna || null,
        ciudad: body?.ciudad || null,
        email: body?.email || null,
        initialStatus: body?.initialStatus || 'NUEVO',
        preserveExistingConversationStage: true,
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

    const preserveExistingConversationStage =
      Object.prototype.hasOwnProperty.call(body || {}, 'preserveExistingConversationStage')
        ? Boolean(body?.preserveExistingConversationStage)
        : true;

    const normalizedRows = rowsRaw.map((row, index) => normalizeImportedRow(row, index + 2));
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
    const imported: Array<{ phoneE164: string; conversationId: string; contactId: string }> = [];

    for (const row of dedupeByPhone.values()) {
      try {
        const result = await upsertCandidateAndCase({
          workspaceId: access.workspaceId,
          phoneRaw: row.phoneRaw,
          name: row.name || null,
          role: row.role || null,
          channel: row.channel || null,
          comuna: row.comuna || null,
          ciudad: row.ciudad || null,
          email: row.email || null,
          initialStatus: row.initialStatus || 'NUEVO',
          preserveExistingConversationStage,
        });

        if (result.createdContact) createdContacts += 1;
        else updatedContacts += 1;
        if (result.createdConversation) createdConversations += 1;

        imported.push({
          phoneE164: result.phoneE164,
          conversationId: result.conversationId,
          contactId: result.contactId,
        });
      } catch (err: any) {
        errors.push({ row: row.sourceRow, phone: row.phoneRaw, reason: err?.message || 'Import failed' });
      }
    }

    return {
      ok: true,
      fileName,
      totalRows: rowsRaw.length,
      validRows: dedupeByPhone.size,
      createdContacts,
      updatedContacts,
      createdConversations,
      dedupedRows: Math.max(0, normalizedRows.length - dedupeByPhone.size),
      errors,
      imported,
      note: 'Importación completada sin envíos automáticos de WhatsApp.',
    };
  });
}
