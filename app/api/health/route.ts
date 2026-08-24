import { NextResponse } from "next/server"
import { extractGuard, downloadGuard } from "@/lib/security/rate-limit"

export const dynamic = "force-dynamic"

/** Lightweight health/monitoring endpoint (Phase 4). Reports process
 * uptime and current concurrency load — no secrets, no cookie data, no
 * user content. Safe to hit from an uptime monitor. */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    uptimeSec: Math.round(process.uptime()),
    load: {
      activeExtracts: extractGuard.current,
      activeDownloads: downloadGuard.current,
    },
    timestamp: new Date().toISOString(),
  })
}
