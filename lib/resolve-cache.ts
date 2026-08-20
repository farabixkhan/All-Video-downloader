import { randomUUID } from "crypto"

/**
 * Short-lived server-side cache for a resolved (probed) video, keyed by a
 * resolveId handed back to the client. Lets /api/download reuse the same
 * resolution /api/info already did instead of the client having to resend
 * the raw URL and platform/cookie logic being re-derived from scratch.
 *
 * Single-instance in-memory cache — fine for Render's one free instance;
 * a multi-instance deployment would need a shared store (e.g. Redis)
 * instead, since this Map doesn't sync across processes.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ResolveEntry {
  url: string
  cookiesPath: string | null
  entry: Record<string, any>
  createdAt: number
  expiresAt: number
}

const cache = new Map<string, ResolveEntry>()
const TTL_MS = 5 * 60 * 1000 // 5 minutes — within the audit's suggested 2-10 min window

export function putResolve(
  url: string,
  cookiesPath: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entry: Record<string, any>
): string {
  const id = randomUUID()
  const now = Date.now()
  cache.set(id, { url, cookiesPath, entry, createdAt: now, expiresAt: now + TTL_MS })
  return id
}

export function getResolve(id: string): ResolveEntry | null {
  const hit = cache.get(id)
  if (!hit) return null
  if (hit.expiresAt < Date.now()) {
    cache.delete(id)
    return null
  }
  return hit
}

setInterval(() => {
  const now = Date.now()
  for (const [id, e] of cache) if (e.expiresAt < now) cache.delete(id)
}, 60_000).unref?.()
