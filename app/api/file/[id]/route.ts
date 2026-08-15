import { NextResponse } from "next/server"
import { promises as fs } from "fs"
import { createReadStream } from "fs"
import path from "path"
import { DOWNLOAD_ROOT } from "@/lib/ytdlp"

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".opus": "audio/ogg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}

/**
 * Wrap a Node read stream in a WebStream with backpressure and safe
 * close/error handling. Avoids the "Controller is already closed"
 * crash that Readable.toWeb() can trigger when the client disconnects,
 * which was cutting downloads off mid-transfer.
 */
function nodeStreamToWeb(filePath: string): ReadableStream<Uint8Array> {
  const nodeStream = createReadStream(filePath, { highWaterMark: 1024 * 1024 })
  let closed = false
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: string | Buffer) => {
        if (closed) return
        try {
          controller.enqueue(
            typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk)
          )
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            nodeStream.pause()
          }
        } catch {
          closed = true
          nodeStream.destroy()
        }
      })
      nodeStream.on("end", () => {
        if (closed) return
        closed = true
        try {
          controller.close()
        } catch {
          // already closed by the client — ignore
        }
      })
      nodeStream.on("error", (err) => {
        if (closed) return
        closed = true
        try {
          controller.error(err)
        } catch {
          // already closed — ignore
        }
      })
    },
    pull() {
      nodeStream.resume()
    },
    cancel() {
      closed = true
      nodeStream.destroy()
    },
  })
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  // Prevent path traversal — id must be a UUID
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid file id" }, { status: 400 })
  }
  const dir = path.join(DOWNLOAD_ROOT, id)
  try {
    const files = await fs.readdir(dir)
    if (!files.length) throw new Error("empty")
    let best = files[0]
    let bestSize = 0
    for (const f of files) {
      const st = await fs.stat(path.join(dir, f))
      if (st.size > bestSize) {
        bestSize = st.size
        best = f
      }
    }
    const filePath = path.join(dir, best)
    const ext = path.extname(best).toLowerCase()

    // ASCII-safe fallback + RFC 5987 encoded full name for maximum browser compatibility
    const asciiName = best.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'")

    return new NextResponse(nodeStreamToWeb(filePath), {
      headers: {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Content-Length": String(bestSize),
        "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(best)}`,
        "Accept-Ranges": "none",
        "Cache-Control": "no-store",
      },
    })
  } catch {
    return NextResponse.json(
      { error: "File not found — it may have expired. Download it again." },
      { status: 404 }
    )
  }
}
