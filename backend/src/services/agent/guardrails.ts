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
}): string | null {
  const active = params.recentLogs.filter((l) => !l.blockedReason);
  if (active.some((l) => l.dedupeKey === params.dedupeKey)) return 'ANTI_LOOP_DEDUPE_KEY';
  if (active.some((l) => l.textHash === params.textHash)) return 'ANTI_LOOP_SAME_TEXT';
  return null;
}

