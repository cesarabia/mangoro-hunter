type Bucket = {
  windowStartMs: number;
  count: number;
};

const buckets = new Map<string, Bucket>();

function cleanup(nowMs: number) {
  if (buckets.size < 5000) return;
  for (const [key, bucket] of buckets) {
    if (nowMs - bucket.windowStartMs > 10 * 60 * 1000) {
      buckets.delete(key);
    }
  }
}

export function checkRateLimit(input: {
  key: string;
  limit: number;
  windowMs: number;
}): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const now = Date.now();
  cleanup(now);

  const key = String(input.key || '');
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.floor(input.limit)) : 1;
  const windowMs = Number.isFinite(input.windowMs) ? Math.max(1000, Math.floor(input.windowMs)) : 1000;

  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStartMs >= windowMs) {
    buckets.set(key, { windowStartMs: now, count: 1 });
    return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterMs: 0 };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    const retryAfterMs = Math.max(0, windowMs - (now - bucket.windowStartMs));
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  return { allowed: true, remaining: Math.max(0, limit - bucket.count), retryAfterMs: 0 };
}

