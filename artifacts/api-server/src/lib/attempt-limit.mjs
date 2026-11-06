export function createAttemptWindow({ limit, windowMs }) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Rate limit must be a positive integer");
  if (!Number.isInteger(windowMs) || windowMs < 1) throw new Error("Rate limit window must be a positive integer");
  const buckets = new Map();

  function prune(now) {
    if (buckets.size < 5000) return;
    for (const [key, bucket] of buckets) {
      if (now - bucket.startedAt >= windowMs) buckets.delete(key);
    }
  }

  return {
    hit(key, now = Date.now()) {
      prune(now);
      const current = buckets.get(key);
      if (!current || now - current.startedAt >= windowMs) {
        buckets.set(key, { count: 1, startedAt: now });
        return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
      }
      if (current.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((current.startedAt + windowMs - now) / 1000)),
        };
      }
      current.count += 1;
      return {
        allowed: true,
        remaining: Math.max(0, limit - current.count),
        retryAfterSeconds: 0,
      };
    },
  };
}
