import { NextRequest, NextResponse } from "next/server"
import { promises as fs } from "fs"
import path from "path"
import { isValidUrl, platformKey, QUALITY_MAP, DOWNLOAD_ROOT } from "@/lib/ytdlp"
import { downloadWithFallbacks, classifyFailure, ExtractionFailure } from "@/lib/extract"
import { cookiesPathForPlatform, SESSION_COOKIE } from "@/lib/session"
import { DownloadResult } from "@/types"

// Large (up to 5GB) downloads need real time on a slow connection —
// give the route generous headroom above the internal extraction deadline.
export const maxDuration = 1800

export async function POST(request: NextRequest) {
  const sessionId = request.cookies.get(SESSION_COOKIE)?.value
  let url = ""
  let quality = "best"
  try {
    const body = await request.json()
    url = String(body?.url ?? "").trim()
    quality = String(body?.quality ?? "best")
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  if (!isValidUrl(url)) {
    return NextResponse.json({ error: "Please enter a valid http(s) URL" }, { status: 400 })
  }
  const q = QUALITY_MAP[quality] ?? QUALITY_MAP.best
  const cookiesPath = sessionId ? cookiesPathForPlatform(sessionId, platformKey(url)) : null

  const fileId = crypto.randomUUID()
  const dir = path.join(DOWNLOAD_ROOT, fileId)
  await fs.mkdir(dir, { recursive: true })

  try {
    // Multi-strategy pipeline: native -> impersonation -> generic -> page scan.
    // Output is deep-validated (signature + ffprobe); fakes are auto-deleted.
    // Files are capped at MAX_FILESIZE (5GB) to protect disk space.
    const out = await downloadWithFallbacks({ url, dir, formatArgs: q.args, cookiesPath })
    const result: DownloadResult = { fileId, filename: out.filename, sizeBytes: out.sizeBytes }
    return NextResponse.json({ ...result, method: out.method, durationSec: out.durationSec })
  } catch (err: unknown) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    const failure: ExtractionFailure =
      err instanceof Error && "failure" in err
        ? (err as Error & { failure: ExtractionFailure }).failure
        : classifyFailure(err instanceof Error ? err.message : "Download failed")
    return NextResponse.json(
      { error: failure.message, category: failure.category, detail: failure.detail },
      { status: 422 }
    )
  }
}
