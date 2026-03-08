import { prisma } from '../db/client';

export type QuickReplyRole = 'INTAKE' | 'PEONETA' | 'DRIVER_COMPANY' | 'DRIVER_OWN_VAN';
export type QuickReplyStage =
  | 'START'
  | 'MIN_INFO'
  | 'CONDITIONS'
  | 'REQUEST_CV'
  | 'REQUEST_DOCS'
  | 'DOCS_MISSING'
  | 'OP_REVIEW'
  | 'ACCEPTED'
  | 'REJECTED';

export type QuickReplyInput = {
  id?: string;
  title: string;
  jobRole: QuickReplyRole;
  stageKey: QuickReplyStage;
  text: string;
  sortOrder: number;
  isActive: boolean;
};

const VALID_ROLES = new Set<QuickReplyRole>(['INTAKE', 'PEONETA', 'DRIVER_COMPANY', 'DRIVER_OWN_VAN']);
const VALID_STAGES = new Set<QuickReplyStage>([
  'START',
  'MIN_INFO',
  'CONDITIONS',
  'REQUEST_CV',
  'REQUEST_DOCS',
  'DOCS_MISSING',
  'OP_REVIEW',
  'ACCEPTED',
  'REJECTED',
]);

const DEFAULT_QUICK_REPLIES: Array<Omit<QuickReplyInput, 'id'>> = [
  {
    title: 'Inicio intake',
    jobRole: 'INTAKE',
    stageKey: 'START',
    text:
      'Hola, gracias por escribir a Envío Rápido. Para continuar tu postulación, indícame el cargo: 1) Peoneta, 2) Conductor (vehículo empresa), 3) Conductor con vehículo propio.',
    sortOrder: 10,
    isActive: true,
  },
  {
    title: 'Pedir info mínima',
    jobRole: 'INTAKE',
    stageKey: 'MIN_INFO',
    text: 'Perfecto. Para avanzar necesito: comuna, disponibilidad y experiencia breve en el cargo.',
    sortOrder: 20,
    isActive: true,
  },
  {
    title: 'Condiciones peoneta',
    jobRole: 'PEONETA',
    stageKey: 'CONDITIONS',
    text: 'Para peoneta, la renta es $15.000 por día trabajado. Si te interesa, te pido comuna, disponibilidad y experiencia breve.',
    sortOrder: 30,
    isActive: true,
  },
  {
    title: 'Condiciones conductor empresa',
    jobRole: 'DRIVER_COMPANY',
    stageKey: 'CONDITIONS',
    text:
      'Para conductor empresa: Chilexpress CHEX $400 por bulto, volumétrica $1.000 por bulto, Mercado Libre $25.000 por día y Falabella por definir. Requisitos: licencia clase B y estacionamiento para guardar vehículo.',
    sortOrder: 40,
    isActive: true,
  },
  {
    title: 'Pedir CV conductor empresa',
    jobRole: 'DRIVER_COMPANY',
    stageKey: 'REQUEST_CV',
    text: 'Gracias. Para avanzar con conductor empresa, envíame tu CV por este medio, por favor.',
    sortOrder: 50,
    isActive: true,
  },
  {
    title: 'Condiciones conductor vehículo',
    jobRole: 'DRIVER_OWN_VAN',
    stageKey: 'CONDITIONS',
    text:
      'Para conductor con vehículo propio: CHEX $800 por bulto y volumétrica $2.000 por bulto. Requisitos: furgón cerrado, documentos del vehículo al día y licencia clase B.',
    sortOrder: 60,
    isActive: true,
  },
  {
    title: 'Pedir CV conductor vehículo',
    jobRole: 'DRIVER_OWN_VAN',
    stageKey: 'REQUEST_CV',
    text: 'Perfecto. Para continuar con conductor con vehículo, necesito tu CV actualizado por este chat.',
    sortOrder: 70,
    isActive: true,
  },
  {
    title: 'Pedir documentos operación',
    jobRole: 'DRIVER_COMPANY',
    stageKey: 'REQUEST_DOCS',
    text: 'Para revisión de operación, envía foto del carnet por ambos lados y foto de tu licencia clase B vigente.',
    sortOrder: 80,
    isActive: true,
  },
  {
    title: 'Pedir documentos operación flota',
    jobRole: 'DRIVER_OWN_VAN',
    stageKey: 'REQUEST_DOCS',
    text:
      'Para revisión de operación, envía foto del carnet por ambos lados, licencia clase B y documentos del vehículo al día.',
    sortOrder: 90,
    isActive: true,
  },
  {
    title: 'Faltan documentos',
    jobRole: 'INTAKE',
    stageKey: 'DOCS_MISSING',
    text: 'Gracias. Para avanzar, aún falta documentación. Envíala por este mismo chat y seguimos de inmediato.',
    sortOrder: 100,
    isActive: true,
  },
  {
    title: 'En revisión operación',
    jobRole: 'INTAKE',
    stageKey: 'OP_REVIEW',
    text: 'Tu postulación quedó en revisión de operación. Apenas tengamos actualización te contactamos por este medio.',
    sortOrder: 110,
    isActive: true,
  },
  {
    title: 'Resultado aceptado',
    jobRole: 'INTAKE',
    stageKey: 'ACCEPTED',
    text: '¡Gracias! Tu postulación fue aprobada para siguiente paso. El equipo de coordinación te contactará con el detalle.',
    sortOrder: 120,
    isActive: true,
  },
  {
    title: 'Resultado rechazado',
    jobRole: 'INTAKE',
    stageKey: 'REJECTED',
    text: 'Gracias por tu interés. Por ahora no continuaremos con tu postulación, pero dejaremos tu contacto para futuras vacantes.',
    sortOrder: 130,
    isActive: true,
  },
];

function normalizeText(value: unknown, fallback = ''): string {
  return String(value || fallback).trim();
}

function sanitizeInput(raw: any, index: number): QuickReplyInput {
  const title = normalizeText(raw?.title);
  const text = normalizeText(raw?.text);
  const jobRole = normalizeText(raw?.jobRole).toUpperCase() as QuickReplyRole;
  const stageKey = normalizeText(raw?.stageKey).toUpperCase() as QuickReplyStage;
  const sortRaw = Number(raw?.sortOrder);
  const sortOrder = Number.isFinite(sortRaw) ? Math.floor(sortRaw) : (index + 1) * 10;
  const isActive = Boolean(raw?.isActive ?? true);
  if (!title) throw new Error('Cada mensaje listo requiere título.');
  if (!text) throw new Error(`El mensaje "${title}" no tiene texto.`);
  if (!VALID_ROLES.has(jobRole)) throw new Error(`jobRole inválido en "${title}".`);
  if (!VALID_STAGES.has(stageKey)) throw new Error(`stageKey inválido en "${title}".`);
  return {
    id: raw?.id ? String(raw.id) : undefined,
    title,
    jobRole,
    stageKey,
    text,
    sortOrder,
    isActive,
  };
}

export async function ensureWorkspaceQuickRepliesSeed(workspaceId: string): Promise<void> {
  const count = await prisma.quickReply
    .count({ where: { workspaceId, archivedAt: null } as any })
    .catch(() => 0);
  if (count > 0) return;
  const now = new Date();
  await prisma.quickReply
    .createMany({
      data: DEFAULT_QUICK_REPLIES.map((row) => ({
        workspaceId,
        title: row.title,
        jobRole: row.jobRole,
        stageKey: row.stageKey,
        text: row.text,
        sortOrder: row.sortOrder,
        isActive: row.isActive,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      })) as any,
    })
    .catch(() => {});
}

export async function listWorkspaceQuickReplies(workspaceId: string, includeInactive = true) {
  await ensureWorkspaceQuickRepliesSeed(workspaceId);
  const where: any = { workspaceId, archivedAt: null };
  if (!includeInactive) where.isActive = true;
  return prisma.quickReply.findMany({
    where,
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function saveWorkspaceQuickReplies(workspaceId: string, items: any[]) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Debes enviar al menos un mensaje listo.');
  }
  const normalized = items.map((row, idx) => sanitizeInput(row, idx));
  const now = new Date();
  const existing = await prisma.quickReply.findMany({
    where: { workspaceId, archivedAt: null },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((r) => r.id));
  const keepIds = new Set<string>();

  for (const row of normalized) {
    if (row.id && existingIds.has(row.id)) {
      await prisma.quickReply.update({
        where: { id: row.id },
        data: {
          title: row.title,
          jobRole: row.jobRole,
          stageKey: row.stageKey,
          text: row.text,
          sortOrder: row.sortOrder,
          isActive: row.isActive,
          archivedAt: null,
          updatedAt: now,
        } as any,
      });
      keepIds.add(row.id);
    } else {
      const created = await prisma.quickReply.create({
        data: {
          workspaceId,
          title: row.title,
          jobRole: row.jobRole,
          stageKey: row.stageKey,
          text: row.text,
          sortOrder: row.sortOrder,
          isActive: row.isActive,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        } as any,
        select: { id: true },
      });
      keepIds.add(created.id);
    }
  }

  const toArchive = existing.filter((r) => !keepIds.has(r.id)).map((r) => r.id);
  if (toArchive.length > 0) {
    await prisma.quickReply.updateMany({
      where: { id: { in: toArchive } },
      data: { archivedAt: now, isActive: false, updatedAt: now } as any,
    });
  }

  return listWorkspaceQuickReplies(workspaceId, true);
}
