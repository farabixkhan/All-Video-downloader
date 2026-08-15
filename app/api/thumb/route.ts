import { NextResponse } from "next/server"
import { isValidUrl } from "@/lib/ytdlp"

export const maxDuration = 60

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const url = searchParams.get("url") ?? ""
  const name = (searchParams.get("name") ?? "thumbnail").replace(/[^\w.-]+/g, "_").slice(0, 80)

  if (!isValidUrl(url)) {
    return NextResponse.json({ error: "Invalid thumbnail URL" }, { status: 400 })
  }
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
    if (!res.ok || !res.body) throw new Error(`Upstream ${res.status}`)
    const contentType = res.headers.get("content-type") ?? "image/jpeg"
    const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg"
    return new NextResponse(res.body, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${name}.${ext}"`,
        "Cache-Control": "no-store",
      },
    })
  } catch {
    return NextResponse.json({ error: "Could not fetch thumbnail" }, { status: 422 })
  }
}
