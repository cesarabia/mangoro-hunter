import { prisma } from '../db/client';
import { serializeJson } from '../utils/json';

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = String(value || '').trim();
    if (!trimmed) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export async function archiveConversation(params: {
  conversationId: string;
  reason: string;
  tags?: string[];
  summary?: string | null;
  archivedAt?: Date;
}): Promise<void> {
  const now = params.archivedAt ?? new Date();
  const tags = Array.isArray(params.tags) ? uniqueStrings(params.tags) : [];
  const stageTags = tags.length > 0 ? JSON.stringify(tags) : null;
  const summary = typeof params.summary === 'string' ? params.summary.trim() : null;

  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: {
      status: 'CLOSED',
      conversationStage: 'ARCHIVED',
      stageReason: params.reason,
      stageTags,
      archivedAt: now,
      archivedSummary: summary,
      updatedAt: now
    }
  });

  const header = `🗄️ Conversación archivada. Motivo: ${params.reason}.`;
  const body = summary ? `\nResumen: ${summary}` : '';
  await prisma.message.create({
    data: {
      conversationId: params.conversationId,
      direction: 'OUTBOUND',
      text: `${header}${body}`.trim(),
      rawPayload: serializeJson({
        system: true,
        type: 'ARCHIVE',
        reason: params.reason,
        tags,
        summary
      }),
      timestamp: now,
      read: true
    }
  });
}

export async function archiveConversations(params: {
  conversationIds: string[];
  reason: string;
  tags?: string[];
  summary?: string | null;
}): Promise<{ archived: number }> {
  const ids = uniqueStrings(params.conversationIds);
  if (ids.length === 0) return { archived: 0 };
  for (const id of ids) {
    await archiveConversation({
      conversationId: id,
      reason: params.reason,
      tags: params.tags,
      summary: params.summary
    });
  }
  return { archived: ids.length };
}

