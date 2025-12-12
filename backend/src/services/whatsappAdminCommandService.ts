import { Contact, Conversation, Message, Prisma, SystemConfig } from '@prisma/client';
import { prisma } from '../db/client';
import { buildWaIdCandidates, normalizeWhatsAppId } from '../utils/whatsapp';
import { summarizeConversationForAdmin } from './aiService';

interface AdminCommandParams {
  waId: string;
  text?: string;
  config: SystemConfig;
}

const STATUS_MAP: Record<string, 'NEW' | 'OPEN' | 'CLOSED'> = {
  nuevo: 'NEW',
  seguimiento: 'OPEN',
  cerrado: 'CLOSED',
  abiertos: 'OPEN',
  cerrados: 'CLOSED'
};

const STATUS_LABELS: Record<string, string> = {
  NEW: 'Nuevo',
  OPEN: 'En seguimiento',
  CLOSED: 'Cerrado'
};

export function getAdminHelpText(): string {
  return 'Puedo mostrar pendientes, listar candidatos, resumir conversaciones y cambiar estados. Ejemplos: "/pendientes", "/resumen 569...", "/estado 569... seguimiento".';
}

export async function processAdminCommand(params: AdminCommandParams): Promise<string | null> {
  const normalizedAdmin = normalizeWhatsAppId(params.config.adminWaId);
  const sender = normalizeWhatsAppId(params.waId);

  if (!normalizedAdmin || !sender || normalizedAdmin !== sender) {
    return null;
  }

  const commandText = (params.text || '').trim();
  if (!commandText) {
    return getAdminHelpText();
  }

  if (/^\/ayuda\b/i.test(commandText)) {
    return getAdminHelpText();
  }

  if (/^\/pendientes\b/i.test(commandText)) {
    const items = await listPendingConversationItems(10);
    if (items.length === 0) {
      return 'No hay conversaciones con mensajes sin leer.';
    }
    const lines = items.map(
      (item, idx) =>
        `${idx + 1}. ${item.name} · ${item.status} · ${truncateText(item.lastMessage, 60)} (${item.unreadCount} sin leer)`
    );
    return `Pendientes (${items.length}):\n${lines.join('\n')}`;
  }

  if (/^\/resumen\b/i.test(commandText)) {
    const query = commandText.replace(/^\/resumen\s*/i, '').trim();
    if (!query) {
      return 'Uso: /resumen <telefono>';
    }
    const { summary, label } = await summarizeConversationByWaId(query, params.config);
    if (!summary) {
      return 'No encontré conversaciones para ese número.';
    }
    return `${label ? `Resumen de ${label}` : 'Resumen de la conversación'}:\n${summary}`;
  }

  if (/^\/estado\b/i.test(commandText)) {
    const parts = commandText.split(/\s+/);
    if (parts.length < 3) {
      return 'Uso: /estado <telefono> <nuevo|seguimiento|cerrado>';
    }
    const phone = parts[1];
    const statusLabel = parts[2].toLowerCase();
    const nextStatus = STATUS_MAP[statusLabel];
    if (!nextStatus) {
      return 'Estado inválido. Usa nuevo, seguimiento o cerrado.';
    }
    const result = await setConversationStatusByWaId(phone, nextStatus);
    if (!result) {
      return 'No encontré conversaciones para ese número.';
    }
    const label = result.label || phone;
    return `Estado de ${label} actualizado a ${nextStatus}.`;
  }

  return 'Comando admin no reconocido. Usa /ayuda para ver opciones.';
}

export async function listPendingConversationItems(limit = 10) {
  const unreadGroups = await prisma.message.groupBy({
    by: ['conversationId'],
    where: {
      direction: 'INBOUND',
      read: false,
      conversation: { isAdmin: false }
    },
    _count: { _all: true }
  });

  const pendingGroups = unreadGroups.sort((a, b) => b._count._all - a._count._all).slice(0, limit);
  if (pendingGroups.length === 0) {
    return [];
  }

  const conversations = await prisma.conversation.findMany({
    where: { id: { in: pendingGroups.map(group => group.conversationId) } },
    include: {
      contact: true,
      messages: { orderBy: { timestamp: 'desc' }, take: 1 }
    }
  });

  const convoMap = conversations.reduce<Record<string, typeof conversations[number]>>((acc, curr) => {
    acc[curr.id] = curr;
    return acc;
  }, {});

  return pendingGroups.map(group => {
    const convo = convoMap[group.conversationId];
    const label = convo?.contact?.name?.trim() || convo?.contact?.phone || convo?.contact?.waId || 'Sin nombre';
    const lastMessage = convo?.messages?.[0]?.text || 'Sin mensajes';
    return {
      conversationId: group.conversationId,
      waId: convo?.contact?.waId || null,
      name: label,
      status: convo?.status || 'UNKNOWN',
      unreadCount: group._count._all,
      lastMessage
    };
  });
}

export async function adminListConversations(options?: {
  limit?: number;
  filterStatus?: string | null;
  onlyUnread?: boolean;
  activeWithinDays?: number;
  includeAdmin?: boolean;
}): Promise<
  Array<{
    waId: string | null;
    name: string;
    status: string;
    unreadCount: number;
    lastMessage: string;
    updatedAt: string;
    isAdmin: boolean;
  }>
> {
  const limit = options?.limit ? Math.min(Math.max(Math.floor(options.limit), 1), 50) : 10;
  const where: Prisma.ConversationWhereInput = {};
  if (options?.filterStatus) {
    where.status = options.filterStatus.toUpperCase();
  }
  if (!options?.includeAdmin) {
    where.isAdmin = false;
  }
  if (options?.activeWithinDays && options.activeWithinDays > 0) {
    const threshold = new Date(Date.now() - options.activeWithinDays * 24 * 60 * 60 * 1000);
    where.updatedAt = { gte: threshold };
  }

  const conversations = await prisma.conversation.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: limit,
    include: {
      contact: true,
      messages: { orderBy: { timestamp: 'desc' }, take: 1 }
    }
  });

  const ids = conversations.map(c => c.id);
  const unreadMap = await getUnreadMap(ids);

  let filtered = conversations.map(convo => {
    const name = convo.contact?.name?.trim() || convo.contact?.phone || convo.contact?.waId || 'Sin nombre';
    return { convo, name };
  });

  if (options?.onlyUnread) {
    filtered = filtered.filter(item => (unreadMap[item.convo.id] || 0) > 0);
  }

  return filtered.map(({ convo, name }) => ({
    waId: convo.contact?.waId || null,
    name,
    status: convo.status,
    unreadCount: unreadMap[convo.id] || 0,
    lastMessage: convo.messages?.[0]?.text || 'Sin mensajes',
    updatedAt: convo.updatedAt.toISOString(),
    isAdmin: convo.isAdmin
  }));
}

export async function adminGetConversationDetails(waId: string) {
  const conversation = await fetchConversationByIdentifier(waId, { includeMessages: true, messageLimit: 50 });
  if (!conversation) {
    return null;
  }
  const sortedMessages = (conversation.messages || []).slice().sort((a, b) => {
    return a.timestamp.getTime() - b.timestamp.getTime();
  });
  return {
    waId: conversation.contact?.waId || null,
    name: conversation.contact?.name || conversation.contact?.phone || conversation.contact?.waId || 'Sin nombre',
    status: conversation.status,
    isAdmin: conversation.isAdmin,
    messages: sortedMessages.map(message => ({
      id: message.id,
      direction: message.direction,
      text: message.text,
      timestamp: message.timestamp
    }))
  };
}

export async function summarizeConversationByWaId(
  waId: string,
  config: SystemConfig
): Promise<{ summary: string | null; label: string | null }> {
  const conversation = await fetchConversationByIdentifier(waId, { includeMessages: true, messageLimit: 60 });
  if (!conversation) {
    return { summary: null, label: null };
  }

  const messages = (conversation.messages || []) as Array<{ direction: string; text: string }>;
  const lines = messages.map(message =>
    `${message.direction === 'INBOUND' ? 'Candidato' : 'Agente'}: ${message.text}`
  );
  const context = lines.slice(-40);
  const summary = await summarizeConversationForAdmin(context, config);
  const label = conversation.contact?.name || conversation.contact?.waId || conversation.contact?.phone || null;
  return { summary, label };
}

export async function setConversationStatusByWaId(
  waId: string,
  nextStatus: 'NEW' | 'OPEN' | 'CLOSED'
): Promise<{ label: string | null } | null> {
  const conversation = await fetchConversationByIdentifier(waId, { includeMessages: false });
  if (!conversation) {
    return null;
  }
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { status: nextStatus }
  });
  return { label: conversation.contact?.name || conversation.contact?.waId || conversation.contact?.phone || null };
}

export async function adminGetStats() {
  const baseWhere = { isAdmin: false };
  const [total, totalNew, totalOpen, totalClosed, active7d, unread] = await Promise.all([
    prisma.conversation.count({ where: baseWhere }),
    prisma.conversation.count({ where: { ...baseWhere, status: 'NEW' } }),
    prisma.conversation.count({ where: { ...baseWhere, status: 'OPEN' } }),
    prisma.conversation.count({ where: { ...baseWhere, status: 'CLOSED' } }),
    prisma.conversation.count({
      where: {
        ...baseWhere,
        updatedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
      }
    }),
    prisma.message.count({
      where: { direction: 'INBOUND', read: false, conversation: baseWhere }
    })
  ]);

  return {
    total,
    totalNew,
    totalOpen,
    totalClosed,
    activeLast7Days: active7d,
    unreadMessages: unread
  };
}

export async function fetchConversationByIdentifier(
  identifier: string,
  options: { includeMessages?: boolean; messageLimit?: number }
): Promise<(Conversation & { contact: Contact; messages?: Message[] }) | null> {
  const candidates = buildWaIdCandidates(identifier);
  if (candidates.length === 0) {
    return null;
  }

  const include: any = {
    contact: true
  };
  if (options?.includeMessages) {
    include.messages = {
      orderBy: { timestamp: 'desc' },
      take: options.messageLimit ?? 40
    };
  }

  return prisma.conversation.findFirst({
    where: {
      contact: {
        OR: [{ waId: { in: candidates } }, { phone: { in: candidates } }]
      }
    },
    orderBy: { updatedAt: 'desc' },
    include
  }) as Promise<(Conversation & { contact: Contact; messages?: Message[] }) | null>;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

async function getUnreadMap(conversationIds: string[]) {
  if (conversationIds.length === 0) return {};
  const unreadCounts = await prisma.message.groupBy({
    by: ['conversationId'],
    where: {
      conversationId: { in: conversationIds },
      direction: 'INBOUND',
      read: false
    },
    _count: { _all: true }
  });
  return unreadCounts.reduce<Record<string, number>>((acc, curr) => {
    acc[curr.conversationId] = curr._count._all;
    return acc;
  }, {});
}
