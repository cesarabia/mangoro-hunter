export type OutboundLogLike = {
  dedupeKey: string;
  textHash: string;
  blockedReason: string | null;
  createdAt: Date;
};

export function computeOutboundBlockReason(params: {
  recentLogs: OutboundLogLike[];
  dedupeKey: string;
  textHash: string;
  lastInboundAt?: Date | null;
  stageChangedAt?: Date | null;
}): string | null {
  const active = params.recentLogs.filter((l) => !l.blockedReason);
  if (active.some((l) => l.dedupeKey === params.dedupeKey)) return 'ANTI_LOOP_DEDUPE_KEY';
  const sameText = active.find((l) => l.textHash === params.textHash) || null;
  if (!sameText) return null;
  if (params.lastInboundAt && params.lastInboundAt.getTime() > sameText.createdAt.getTime()) return null;
  if (params.stageChangedAt && params.stageChangedAt.getTime() > sameText.createdAt.getTime()) return null;
  return 'ANTI_LOOP_SAME_TEXT';
}
