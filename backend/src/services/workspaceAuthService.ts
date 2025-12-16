import { prisma } from '../db/client';

export type WorkspaceAccess = {
  workspaceId: string;
  role: string | null;
};

export function getWorkspaceIdFromHeaders(headers: Record<string, any>): string {
  const raw = headers['x-workspace-id'] || headers['X-Workspace-Id'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return 'default';
}

export async function resolveWorkspaceAccess(request: any): Promise<WorkspaceAccess> {
  const workspaceId = getWorkspaceIdFromHeaders(request.headers || {});
  const userId = request.user?.userId as string | undefined;
  if (!userId) return { workspaceId: 'default', role: null };

  const membership = await prisma.membership.findFirst({
    where: { userId, workspaceId, archivedAt: null },
    select: { role: true },
  });
  if (membership?.role) {
    return { workspaceId, role: membership.role };
  }

  // Fallback: if requested workspace is not accessible, use default.
  if (workspaceId !== 'default') {
    const fallback = await prisma.membership.findFirst({
      where: { userId, workspaceId: 'default', archivedAt: null },
      select: { role: true },
    });
    return { workspaceId: 'default', role: fallback?.role || null };
  }

  return { workspaceId: 'default', role: null };
}

export function isWorkspaceAdmin(request: any, access: WorkspaceAccess): boolean {
  const global = request.user?.role === 'ADMIN';
  const role = (access.role || '').toUpperCase();
  return global || role === 'OWNER' || role === 'ADMIN';
}

