/**
 * In-memory rate limiting + concurrency guard for a single-instance
 * deployment (Render Free runs one instance, so this is sufficient here —
 * a multi-instance production deployment would need a shared store like
 * Redis instead, since these counters don't sync across processes).
 */

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

/** Simple fixed-window limiter. Returns true if the request is allowed. */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const existing = buckets.get(key)
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (existing.count >= limit) return false
  existing.count += 1
  return true
}

// Periodic sweep so the map doesn't grow forever
setInterval(() => {
  const now = Date.now()
  for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key)
}, 5 * 60 * 1000).unref?.()

export function clientKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")
  return (fwd?.split(",")[0].trim()) || "unknown"
}

/** Global concurrency guard — limits how many heavy jobs run at once
 * regardless of which client started them, to protect a small instance
 * (Render Free: 0.1 CPU / 512MB) from being overwhelmed. */
class ConcurrencyGuard {
  private active = 0
  constructor(private readonly max: number) {}

  tryAcquire(): boolean {
    if (this.active >= this.max) return false
    this.active += 1
    return true
  }
  release() {
    this.active = Math.max(0, this.active - 1)
  }
  get current() {
    return this.active
  }
}

export const extractGuard = new ConcurrencyGuard(4) // /api/info probes
export const downloadGuard = new ConcurrencyGuard(2) // /api/download heavy jobs
