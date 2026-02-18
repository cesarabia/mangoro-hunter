import { prisma } from '../db/client';

type ConversationKind = 'CLIENT' | 'STAFF' | 'PARTNER' | 'ADMIN';

type ProgramSummary = { id: string; name: string; slug: string; isActive: boolean };

function normalizeText(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function parseIdsJson(raw: unknown): string[] {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const item of parsed) {
      const id = String(item || '').trim();
      if (!id) continue;
      if (!out.includes(id)) out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

function isStaffProgramLike(program: ProgramSummary): boolean {
  const t = normalizeText(`${program.name} ${program.slug}`);
  return /\bstaff\b/.test(t) || /\boperaci/.test(t) || /\benfermer/.test(t) || /\bcoordinad/.test(t);
}

function isPartnerProgramLike(program: ProgramSummary): boolean {
  const t = normalizeText(`${program.name} ${program.slug}`);
  return /\bpartner\b/.test(t) || /\bproveedor/.test(t) || /\baliad/.test(t);
}

function isAdminProgram(program: ProgramSummary): boolean {
  return normalizeText(program.slug) === 'admin' || /\badmin\b/.test(normalizeText(program.name));
}

function pickFirstActiveByIds(programsById: Map<string, ProgramSummary>, ids: string[]): ProgramSummary | null {
  for (const id of ids) {
    const program = programsById.get(String(id || '').trim());
    if (!program || !program.isActive) continue;
    return program;
  }
  return null;
}

export async function resolveWorkspaceProgramForKind(params: {
  workspaceId: string;
  kind: ConversationKind;
  phoneLineId?: string | null;
  preferredProgramId?: string | null;
}): Promise<{ programId: string | null; source: string }> {
  const workspaceId = String(params.workspaceId || '').trim();
  if (!workspaceId) return { programId: null, source: 'missing_workspace' };
  const kind = String(params.kind || 'CLIENT').toUpperCase() as ConversationKind;
  const preferredProgramId = String(params.preferredProgramId || '').trim() || null;
  const phoneLineId = String(params.phoneLineId || '').trim() || null;

  const [workspace, phoneLine, programs] = await Promise.all([
    prisma.workspace
      .findUnique({
        where: { id: workspaceId },
        select: {
          clientDefaultProgramId: true as any,
          staffDefaultProgramId: true as any,
          partnerDefaultProgramId: true as any,
          clientProgramMenuIdsJson: true as any,
          staffProgramMenuIdsJson: true as any,
          partnerProgramMenuIdsJson: true as any,
        } as any,
      })
      .catch(() => null),
    phoneLineId
      ? prisma.phoneLine
          .findFirst({
            where: { id: phoneLineId, workspaceId, archivedAt: null },
            select: { defaultProgramId: true, inboundMode: true as any, programMenuIdsJson: true as any },
          } as any)
          .catch(() => null)
      : Promise.resolve(null),
    prisma.program
      .findMany({
        where: { workspaceId, archivedAt: null, isActive: true },
        select: { id: true, name: true, slug: true, isActive: true },
        orderBy: { createdAt: 'asc' },
      })
      .catch(() => []),
  ]);
  const programsById = new Map<string, ProgramSummary>();
  for (const p of programs) programsById.set(p.id, p);

  const byId = (id: string | null | undefined): ProgramSummary | null => {
    const key = String(id || '').trim();
    if (!key) return null;
    return programsById.get(key) || null;
  };

  if (preferredProgramId) {
    const preferred = byId(preferredProgramId);
    if (preferred) return { programId: preferred.id, source: 'preferred_program' };
  }

  const clientDefault = byId((workspace as any)?.clientDefaultProgramId || null);
  const staffDefault = byId((workspace as any)?.staffDefaultProgramId || null);
  const partnerDefault = byId((workspace as any)?.partnerDefaultProgramId || null);
  const phoneLineDefault = byId((phoneLine as any)?.defaultProgramId || null);

  const workspaceClientMenu = parseIdsJson((workspace as any)?.clientProgramMenuIdsJson);
  const workspaceStaffMenu = parseIdsJson((workspace as any)?.staffProgramMenuIdsJson);
  const workspacePartnerMenu = parseIdsJson((workspace as any)?.partnerProgramMenuIdsJson);
  const phoneLineMenu = parseIdsJson((phoneLine as any)?.programMenuIdsJson);

  if (kind === 'ADMIN') {
    const adminProgram = programs.find((p) => isAdminProgram(p)) || null;
    return { programId: adminProgram?.id || null, source: adminProgram ? 'admin_program' : 'none' };
  }

  if (kind === 'STAFF') {
    if (staffDefault) return { programId: staffDefault.id, source: 'workspace_staff_default' };
    const fromStaffMenu = pickFirstActiveByIds(programsById, workspaceStaffMenu);
    if (fromStaffMenu) return { programId: fromStaffMenu.id, source: 'workspace_staff_menu' };
    const staffLike = programs.find((p) => isStaffProgramLike(p)) || null;
    if (staffLike) return { programId: staffLike.id, source: 'staff_like_fallback' };
    return { programId: null, source: 'none' };
  }

  if (kind === 'PARTNER') {
    if (partnerDefault) return { programId: partnerDefault.id, source: 'workspace_partner_default' };
    const fromPartnerMenu = pickFirstActiveByIds(programsById, workspacePartnerMenu);
    if (fromPartnerMenu) return { programId: fromPartnerMenu.id, source: 'workspace_partner_menu' };
    const partnerLike = programs.find((p) => isPartnerProgramLike(p)) || null;
    if (partnerLike) return { programId: partnerLike.id, source: 'partner_like_fallback' };
    return { programId: null, source: 'none' };
  }

  // CLIENT
  if (phoneLineDefault) return { programId: phoneLineDefault.id, source: 'phoneline_default' };
  if (clientDefault) return { programId: clientDefault.id, source: 'workspace_client_default' };
  if (String((phoneLine as any)?.inboundMode || '').toUpperCase() === 'MENU') {
    const fromLineMenu = pickFirstActiveByIds(programsById, phoneLineMenu);
    if (fromLineMenu) return { programId: fromLineMenu.id, source: 'phoneline_menu' };
  }
  const fromClientMenu = pickFirstActiveByIds(programsById, workspaceClientMenu);
  if (fromClientMenu) return { programId: fromClientMenu.id, source: 'workspace_client_menu' };
  const genericClient = programs.find((p) => !isStaffProgramLike(p) && !isPartnerProgramLike(p) && !isAdminProgram(p)) || null;
  if (genericClient) return { programId: genericClient.id, source: 'client_generic_fallback' };
  return { programId: programs[0]?.id || null, source: programs[0]?.id ? 'first_active_fallback' : 'none' };
}

