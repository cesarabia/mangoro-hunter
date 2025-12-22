import { Prisma } from '@prisma/client';
import { prisma } from '../db/client';
import { serializeJson } from '../utils/json';
import { getContactDisplayName } from '../utils/contactDisplay';

const MAX_DEDUPE_KEY_LEN = 180;
const MAX_TITLE_LEN = 140;
const MAX_BODY_LEN = 800;

function normalizeDedupeKey(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.slice(0, MAX_DEDUPE_KEY_LEN);
}

function normalizeTitle(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return 'Notificación';
  return raw.slice(0, MAX_TITLE_LEN);
}

function normalizeBody(value: unknown): string | null {
  if (value === null || typeof value === 'undefined') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  return raw.slice(0, MAX_BODY_LEN);
}

export async function createInAppNotification(params: {
  workspaceId: string;
  userId: string;
  conversationId?: string | null;
  type: string;
  title: string;
  body?: string | null;
  data?: any;
  dedupeKey: string;
}): Promise<{ id: string; created: boolean }> {
  const workspaceId = String(params.workspaceId || '').trim();
  const userId = String(params.userId || '').trim();
  if (!workspaceId || !userId) {
    throw new Error('workspaceId y userId son requeridos');
  }

  const dedupeKey = normalizeDedupeKey(params.dedupeKey);
  if (!dedupeKey) {
    throw new Error('dedupeKey es requerido');
  }

  const type = String(params.type || '').trim() || 'GENERIC';
  const title = normalizeTitle(params.title);
  const body = normalizeBody(params.body);
  const conversationId =
    typeof params.conversationId === 'string' && params.conversationId.trim()
      ? params.conversationId.trim()
      : null;
  const dataJson = typeof params.data === 'undefined' ? null : serializeJson(params.data);

  try {
    const created = await prisma.inAppNotification.create({
      data: {
        workspaceId,
        userId,
        conversationId,
        type,
        title,
        body,
        dataJson,
        dedupeKey,
        readAt: null,
        archivedAt: null,
      },
      select: { id: true },
    });
    return { id: created.id, created: true };
  } catch (err: any) {
    const isUnique =
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
    if (!isUnique) throw err;

    const updated = await prisma.inAppNotification.update({
      where: {
        workspaceId_userId_dedupeKey: {
          workspaceId,
          userId,
          dedupeKey,
        },
      },
      data: {
        conversationId,
        type,
        title,
        body,
        dataJson,
        archivedAt: null,
      },
      select: { id: true },
    });
    return { id: updated.id, created: false };
  }
}

export async function listNotificationsForUser(params: {
  workspaceId: string;
  userId: string;
  limit?: number;
  includeRead?: boolean;
}): Promise<{ unreadCount: number; notifications: any[] }> {
  const workspaceId = String(params.workspaceId || '').trim();
  const userId = String(params.userId || '').trim();
  const includeRead = Boolean(params.includeRead);
  const limit = Number.isFinite(params.limit) ? Math.max(1, Math.min(100, Number(params.limit))) : 30;

  const [unreadCount, rows] = await Promise.all([
    prisma.inAppNotification.count({
      where: { workspaceId, userId, archivedAt: null, readAt: null },
    }),
    prisma.inAppNotification.findMany({
      where: {
        workspaceId,
        userId,
        archivedAt: null,
        ...(includeRead ? {} : { readAt: null }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        conversation: {
          select: {
            id: true,
            conversationStage: true,
            status: true,
            contact: true,
          },
        },
      },
    }),
  ]);

  const notifications = rows.map((n) => ({
    id: n.id,
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt ? n.readAt.toISOString() : null,
    type: n.type,
    title: n.title,
    body: n.body,
    conversationId: n.conversationId,
    conversation: n.conversation
      ? {
          id: n.conversation.id,
          label: getContactDisplayName(n.conversation.contact),
          stage: n.conversation.conversationStage,
          status: n.conversation.status,
        }
      : null,
  }));

  return { unreadCount, notifications };
}

export async function markNotificationRead(params: {
  workspaceId: string;
  userId: string;
  notificationId: string;
}): Promise<{ ok: boolean }> {
  const workspaceId = String(params.workspaceId || '').trim();
  const userId = String(params.userId || '').trim();
  const id = String(params.notificationId || '').trim();
  if (!workspaceId || !userId || !id) return { ok: false };

  await prisma.inAppNotification
    .updateMany({
      where: { id, workspaceId, userId, archivedAt: null, readAt: null },
      data: { readAt: new Date() },
    })
    .catch(() => {});
  return { ok: true };
}

export async function markAllNotificationsRead(params: {
  workspaceId: string;
  userId: string;
}): Promise<{ ok: boolean; updated: number }> {
  const workspaceId = String(params.workspaceId || '').trim();
  const userId = String(params.userId || '').trim();
  if (!workspaceId || !userId) return { ok: false, updated: 0 };

  const res = await prisma.inAppNotification
    .updateMany({
      where: { workspaceId, userId, archivedAt: null, readAt: null },
      data: { readAt: new Date() },
    })
    .catch(() => null);
  return { ok: true, updated: res?.count || 0 };
}

export async function listRecentNotificationEvents(params: {
  workspaceId: string;
  limit?: number;
}): Promise<any[]> {
  const workspaceId = String(params.workspaceId || '').trim();
  const limit = Number.isFinite(params.limit) ? Math.max(1, Math.min(200, Number(params.limit))) : 50;

  const rows = await prisma.inAppNotification.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      user: { select: { id: true, email: true, name: true } },
      conversation: { select: { id: true, contact: true } },
    },
  });

  return rows.map((n) => ({
    id: n.id,
    createdAt: n.createdAt.toISOString(),
    eventType: 'NOTIFICATION_CREATED',
    user: n.user ? { id: n.user.id, email: n.user.email, name: n.user.name } : null,
    conversationId: n.conversationId || null,
    conversationLabel: n.conversation ? getContactDisplayName(n.conversation.contact) : null,
    type: n.type,
    title: n.title,
    body: n.body,
    readAt: n.readAt ? n.readAt.toISOString() : null,
    archivedAt: n.archivedAt ? n.archivedAt.toISOString() : null,
  }));
}

