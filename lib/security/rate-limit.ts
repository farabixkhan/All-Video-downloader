import net from "net"

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

// ---------------------------------------------------------------------------
// Trusted-proxy-aware client IP detection
// ---------------------------------------------------------------------------
//
// X-Forwarded-For is trivially spoofable by the CLIENT itself — anyone can
// send `X-Forwarded-For: 1.2.3.4` directly to bypass IP-based rate limits
// unless we know for certain the value in the header actually came from a
// proxy we trust, and — if there is one — which entry in a comma-separated
// list that trusted proxy is the one that actually appended.
//
// Fail-safe default: if TRUST_PROXY is not explicitly enabled, forwarded
// headers are NEVER trusted (all requests share one "unknown" bucket
// rather than letting a forged header create a fresh untracked identity).
// Render's own edge load balancer IS a trusted single proxy hop in this
// app's actual deployment, so the Dockerfile sets TRUST_PROXY=true for
// production; local/dev runs default to the safe "don't trust" behavior.
const TRUST_PROXY = process.env.TRUST_PROXY === "true"
// Number of trusted proxy hops directly in front of this app. With exactly
// one (Render's edge LB), the *last* entry in X-Forwarded-For is the one
// that hop appended — anything to its left may have been forged by the
// client before the request ever reached the trusted proxy.
const TRUSTED_PROXY_HOPS = (() => {
  const n = parseInt(process.env.TRUSTED_PROXY_HOPS || "1", 10)
  return Number.isFinite(n) && n > 0 ? n : 1
})()

/** Validates a single address as syntactically a real IPv4 or IPv6 address
 * (net.isIP returns 0 for anything else, 4 or 6 for a real address). */
function isValidIp(value: string): boolean {
  return net.isIP(value.trim()) !== 0
}

/**
 * Returns a stable per-client key for rate limiting. Never trusts
 * X-Forwarded-For unless TRUST_PROXY is enabled; when enabled, only reads
 * the specific entry a trusted proxy hop would have appended, and requires
 * it to be a syntactically valid IP — any malformed or missing value falls
 * back to the shared "unknown" bucket rather than creating a bypass.
 */
export function clientKey(request: Request): string {
  if (!TRUST_PROXY) return "unknown"

  const fwd = request.headers.get("x-forwarded-for")
  if (!fwd) return "unknown"

  const parts = fwd
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) return "unknown"

  // The trusted proxy appends to the end of the list, so the entry it
  // added is TRUSTED_PROXY_HOPS from the right.
  const index = parts.length - TRUSTED_PROXY_HOPS
  const candidate = parts[index >= 0 ? index : 0]
  if (!isValidIp(candidate)) return "unknown"
  return candidate
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
