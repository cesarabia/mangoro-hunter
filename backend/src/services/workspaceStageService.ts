import { prisma } from '../db/client';

export type WorkspaceStageSeed = {
  slug: string;
  labelEs: string;
  order: number;
  isDefault?: boolean;
  isTerminal?: boolean;
};

export function normalizeStageSlug(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw
    .replace(/\s+/g, '_')
    .replace(/-+/g, '_')
    .replace(/__+/g, '_')
    .toUpperCase()
    .slice(0, 64);
}

function getDefaultStageSeeds(workspaceId: string): WorkspaceStageSeed[] {
  const id = String(workspaceId || '').trim().toLowerCase();
  if (id === 'ssclinical') {
    return [
      { slug: 'PROGRAM_SELECTION', labelEs: 'Selección de programa', order: 5 },
      { slug: 'NUEVO', labelEs: 'Nuevo', order: 10, isDefault: true },
      { slug: 'INFO', labelEs: 'Info', order: 20 },
      { slug: 'CALIFICADO', labelEs: 'Calificado', order: 30 },
      { slug: 'INTERESADO', labelEs: 'Interesado', order: 40 },
      { slug: 'EN_COORDINACION', labelEs: 'En coordinación', order: 50 },
      { slug: 'CONFIRMADO', labelEs: 'Confirmado', order: 60 },
      { slug: 'CERRADO', labelEs: 'Cerrado', order: 90, isTerminal: true },
      { slug: 'NO_CONTACTAR', labelEs: 'No contactar', order: 95, isTerminal: true },
      { slug: 'ARCHIVED', labelEs: 'Archivado', order: 99, isTerminal: true },
    ];
  }

  // Default workflow (Recruitment/Agent OS).
  return [
    { slug: 'NEW_INTAKE', labelEs: 'Nuevo (intake)', order: 10, isDefault: true },
    { slug: 'PROGRAM_SELECTION', labelEs: 'Selección de programa', order: 15 },
    { slug: 'WAITING_CANDIDATE', labelEs: 'Esperando candidato', order: 20 },
    { slug: 'RECRUIT_COMPLETE', labelEs: 'Listo para revisar', order: 30 },
    // Pipeline genérico (útil para clientes tipo SSClinical u otros verticales).
    { slug: 'INTERESADO', labelEs: 'Interesado', order: 40 },
    { slug: 'EN_COORDINACION', labelEs: 'En coordinación', order: 50 },
    { slug: 'AGENDADO', labelEs: 'Agendado', order: 60 },
    { slug: 'COMPLETADO', labelEs: 'Completado', order: 70, isTerminal: true },
    { slug: 'DISQUALIFIED', labelEs: 'No califica', order: 80, isTerminal: true },
    { slug: 'STALE_NO_RESPONSE', labelEs: 'Sin respuesta', order: 85, isTerminal: true },
    { slug: 'NO_CONTACTAR', labelEs: 'No contactar', order: 95, isTerminal: true },
    { slug: 'ARCHIVED', labelEs: 'Archivado', order: 99, isTerminal: true },
  ];
}

export async function ensureWorkspaceStages(workspaceId: string): Promise<void> {
  const wsId = String(workspaceId || '').trim();
  if (!wsId) return;

  const seeds = getDefaultStageSeeds(wsId);
  if (seeds.length === 0) return;

  const desiredDefaultSlug = (() => {
    const seedDefault = seeds.find((s) => Boolean(s.isDefault));
    return seedDefault ? normalizeStageSlug(seedDefault.slug) : normalizeStageSlug(seeds[0].slug);
  })();

  for (const seed of seeds) {
    const slug = normalizeStageSlug(seed.slug);
    if (!slug) continue;
    const existing = await prisma.workspaceStage
      .findUnique({ where: { workspaceId_slug: { workspaceId: wsId, slug } } })
      .catch(() => null);
    if (existing) continue;
    await prisma.workspaceStage
      .create({
        data: {
          workspaceId: wsId,
          slug,
          labelEs: seed.labelEs,
          order: seed.order,
          isDefault: slug === desiredDefaultSlug,
          isActive: true,
          isTerminal: Boolean(seed.isTerminal),
          archivedAt: null,
        } as any,
      })
      .catch(() => {});
  }

  // Ensure exactly one active default stage per workspace (best-effort fix-up).
  try {
    const stages = await prisma.workspaceStage.findMany({
      where: { workspaceId: wsId, archivedAt: null, isActive: true },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, slug: true, isDefault: true as any },
    });

    const defaults = stages.filter((s: any) => Boolean(s.isDefault));
    if (defaults.length === 1) return;

    const pick = (() => {
      const desired = stages.find((s: any) => String(s.slug) === desiredDefaultSlug);
      if (desired) return desired;
      return stages[0] || null;
    })();
    if (!pick?.id) return;

    await prisma.workspaceStage.updateMany({
      where: { workspaceId: wsId, archivedAt: null },
      data: { isDefault: false } as any,
    });
    await prisma.workspaceStage.update({ where: { id: pick.id }, data: { isDefault: true } as any });
  } catch {
    // ignore
  }
}

export async function listWorkspaceStages(params: {
  workspaceId: string;
  includeArchived?: boolean;
}): Promise<any[]> {
  const wsId = String(params.workspaceId || '').trim();
  const includeArchived = Boolean(params.includeArchived);
  if (!wsId) return [];

  await ensureWorkspaceStages(wsId).catch(() => {});

  const rows = await prisma.workspaceStage
    .findMany({
      where: {
        workspaceId: wsId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    })
    .catch(() => []);

  return rows.map((s) => ({
    id: s.id,
    slug: s.slug,
    labelEs: s.labelEs,
    order: s.order,
    isDefault: Boolean((s as any).isDefault),
    isActive: Boolean(s.isActive),
    isTerminal: Boolean(s.isTerminal),
    archivedAt: s.archivedAt ? s.archivedAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }));
}

export async function getWorkspaceDefaultStageSlug(workspaceId: string): Promise<string> {
  const wsId = String(workspaceId || '').trim();
  if (!wsId) return 'NEW_INTAKE';

  await ensureWorkspaceStages(wsId).catch(() => {});

  const def = await prisma.workspaceStage
    .findFirst({
      where: { workspaceId: wsId, archivedAt: null, isActive: true, isDefault: true as any },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      select: { slug: true },
    })
    .catch(() => null);
  if (def?.slug) return String(def.slug);

  const first = await prisma.workspaceStage
    .findFirst({
      where: { workspaceId: wsId, archivedAt: null, isActive: true },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      select: { slug: true },
    })
    .catch(() => null);
  return String(first?.slug || 'NEW_INTAKE');
}

export async function coerceStageSlug(params: { workspaceId: string; stageSlug?: string | null }): Promise<string> {
  const wsId = String(params.workspaceId || '').trim();
  const input = normalizeStageSlug(params.stageSlug ?? '');
  const fallback = await getWorkspaceDefaultStageSlug(wsId);
  if (!input) return fallback;
  const ok = await prisma.workspaceStage
    .findFirst({
      where: { workspaceId: wsId, slug: input, archivedAt: null, isActive: true },
      select: { id: true },
    })
    .catch(() => null);
  return ok?.id ? input : fallback;
}

export async function isKnownActiveStage(workspaceId: string, slug: string): Promise<boolean> {
  const wsId = String(workspaceId || '').trim();
  const s = normalizeStageSlug(slug);
  if (!wsId || !s) return false;
  const row = await prisma.workspaceStage
    .findFirst({
      where: { workspaceId: wsId, slug: s, archivedAt: null, isActive: true },
      select: { id: true },
    })
    .catch(() => null);
  return Boolean(row?.id);
}
