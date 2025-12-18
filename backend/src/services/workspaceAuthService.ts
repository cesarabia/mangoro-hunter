import { prisma } from '../db/client';

export type WorkspaceAccess = {
  workspaceId: string;
  role: string | null;
  assignedOnly: boolean;
};

export function getWorkspaceIdFromHeaders(headers: Record<string, any>): string {
  const raw = headers['x-workspace-id'] || headers['X-Workspace-Id'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return 'default';
}

export async function resolveWorkspaceAccess(request: any): Promise<WorkspaceAccess> {
  const workspaceId = getWorkspaceIdFromHeaders(request.headers || {});
  const userId = request.user?.userId as string | undefined;
  if (!userId) return { workspaceId: 'default', role: null, assignedOnly: false };

  const membership = await prisma.membership.findFirst({
    where: { userId, workspaceId, archivedAt: null },
    select: { role: true, assignedOnly: true as any },
  });
  if (membership?.role) {
    return { workspaceId, role: membership.role, assignedOnly: Boolean((membership as any).assignedOnly) };
  }

  // Fallback: if requested workspace is not accessible, use default.
  if (workspaceId !== 'default') {
    const fallback = await prisma.membership.findFirst({
      where: { userId, workspaceId: 'default', archivedAt: null },
      select: { role: true, assignedOnly: true as any },
    });
    return {
      workspaceId: 'default',
      role: fallback?.role || null,
      assignedOnly: Boolean((fallback as any)?.assignedOnly),
    };
  }

  return { workspaceId: 'default', role: null, assignedOnly: false };
}

export function isWorkspaceAdmin(request: any, access: WorkspaceAccess): boolean {
  const global = request.user?.role === 'ADMIN';
  const role = (access.role || '').toUpperCase();
  return global || role === 'OWNER' || role === 'ADMIN';
}

export function isWorkspaceOwner(request: any, access: WorkspaceAccess): boolean {
  const global = request.user?.role === 'ADMIN';
  const role = (access.role || '').toUpperCase();
  return global || role === 'OWNER';
}

export function normalizeWorkspaceRole(role: string | null | undefined): 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' | null {
  const upper = String(role || '').toUpperCase();
  if (upper === 'OWNER' || upper === 'ADMIN' || upper === 'MEMBER' || upper === 'VIEWER') return upper;
  return null;
}

export function canEditWorkspaceConfig(request: any, access: WorkspaceAccess): boolean {
  return isWorkspaceOwner(request, access);
}
