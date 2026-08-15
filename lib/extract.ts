import path from "path"
import { promises as fs } from "fs"
import { execFileAsync, cookieArgs, MAX_FILESIZE } from "./ytdlp"
import { validateMediaFile } from "./validate"

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export type FailureCategory =
  | "drm"
  | "geo-restricted"
  | "login-required"
  | "deleted"
  | "anti-bot"
  | "unsupported"
  | "too-large"
  | "unavailable"

export interface ExtractionFailure {
  category: FailureCategory
  message: string
  detail: string
}

const CATEGORY_MESSAGES: Record<FailureCategory, string> = {
  drm: "This video is DRM-protected (encrypted). Downloading it is not technically possible.",
  "geo-restricted":
    "This video is geo-restricted and not available from the server's region.",
  "login-required":
    "This video requires a login / age verification. Add cookies for this platform (top-right Cookies button) to unlock it.",
  deleted: "This video appears to be deleted, private, or no longer available.",
  "anti-bot":
    "The site is blocking automated access (anti-bot / CAPTCHA). Adding cookies sometimes helps.",
  unsupported:
    "No downloadable public video stream could be detected on this page after trying all extraction methods.",
  "too-large": `This file is larger than the ${MAX_FILESIZE} limit — try a lower quality.`,
  unavailable: "No playable media could be extracted from this URL.",
}

export function classifyFailure(rawMsg: string): ExtractionFailure {
  const m = rawMsg.toLowerCase()
  let category: FailureCategory = "unavailable"
  if (/drm|widevine|fairplay|playready|this video is protected|encrypted media|license url/.test(m))
    category = "drm"
  else if (/geo.?restrict|not available in your (country|region)|georestricted|geo.?block/.test(m))
    category = "geo-restricted"
  else if (
    /sign in|log ?in required|login required|private video|authentication|confirm your age|age.?(gate|restrict|verification)|cookies-from-browser|empty media response|requested content is not available, rate.?limit/.test(m)
  )
    category = "login-required"
  else if (/removed|deleted|no longer available|video unavailable|does not exist|404|not found/.test(m))
    category = "deleted"
  else if (/max-filesize|file is larger than/.test(m)) category = "too-large"
  else if (/403|forbidden|captcha|cloudflare|access denied|blocked|429|too many requests|challenge|bot/.test(m))
    category = "anti-bot"
  else if (/unsupported url|no video formats|unable to extract/.test(m)) category = "unsupported"
  return { category, message: CATEGORY_MESSAGES[category], detail: rawMsg.slice(0, 500) }
}

// ---------------------------------------------------------------------------
// Impersonation support (curl_cffi) — detected once per process
// ---------------------------------------------------------------------------

let impersonateAvailable: boolean | null = null
async function canImpersonate(): Promise<boolean> {
  if (impersonateAvailable !== null) return impersonateAvailable
  try {
    const { stdout } = await execFileAsync("yt-dlp", ["--list-impersonate-targets"], {
      timeout: 20_000,
    })
    impersonateAvailable = /chrome/i.test(stdout) && !/chrome.*unavailable/i.test(stdout)
  } catch {
    impersonateAvailable = false
  }
  return impersonateAvailable
}

// ---------------------------------------------------------------------------
// Page scanning: direct MP4/WebM, HLS, DASH, <video>/<source>, og:video,
// JSON-LD contentUrl, and embedded iframes (one level deep)
// ---------------------------------------------------------------------------

export interface MediaCandidate {
  url: string
  referer: string
  kind: "direct" | "hls" | "dash" | "embed"
}

// Known player hosts we can hand straight back to yt-dlp's native extractors.
const EMBED_HOST_RE =
  /(?:youtube\.com\/(?:embed|watch|shorts)|youtu\.be\/|player\.vimeo\.com\/video|vimeo\.com\/\d|dailymotion\.com\/(?:embed\/)?video|player\.twitch\.tv|streamable\.com|wistia\.(?:com|net)|brightcove\.net|jwplatform\.com|kaltura\.com|facebook\.com\/plugins\/video|rumble\.com\/embed|bitchute\.com\/embed|odysee\.com\/\$\/embed)/i

function detectEmbeds(html: string, baseUrl: string): MediaCandidate[] {
  const out: MediaCandidate[] = []
  const push = (raw: string) => {
    try {
      const abs = new URL(raw, baseUrl).toString()
      if (EMBED_HOST_RE.test(abs)) out.push({ url: abs, referer: baseUrl, kind: "embed" })
    } catch {
      /* ignore */
    }
  }
  for (const m of html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) push(m[1])
  for (const m of html.matchAll(/["'](?:embedUrl|embed_url|player_url)["']\s*:\s*["']([^"']+)["']/gi))
    push(m[1])
  // Bare youtube.com/embed/ID or youtu.be/ID references anywhere in scripts
  for (const m of html.matchAll(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/embed\/[\w-]{6,}|youtu\.be\/[\w-]{6,}|player\.vimeo\.com\/video\/\d+|dailymotion\.com\/embed\/video\/\w+)/gi
  ))
    push(m[0])
  // Dedupe
  const seen = new Set<string>()
  return out.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true))).slice(0, 4)
}

const MEDIA_URL_RE =
  /https?:\/\/[^"'\s\\<>]+?\.(?:mp4|webm|mov|m4v|mkv|m3u8|mpd)(?:\?[^"'\s\\<>]*)?/gi
const JUNK_RE =
  /thumb|sprite|preview|poster|logo|banner|advert|\/ads?[\/._-]|pixel|tracker|analytics|\.svg|blank|placeholder|trailer_sm|_fb\.mp4/i

function kindOf(u: string): MediaCandidate["kind"] {
  if (/\.m3u8(\?|$)|\/hls[\/?]/i.test(u)) return "hls"
  if (/\.mpd(\?|$)|\/dash[\/?]/i.test(u)) return "dash"
  return "direct"
}

function unescapeHtml(s: string): string {
  return s
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&#0?38;/g, "&")
}

async function fetchPage(url: string, referer?: string): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        ...(referer ? { Referer: referer } : {}),
      },
    })
    const ct = res.headers.get("content-type") ?? ""
    if (!res.ok || /image|video|audio|octet-stream/.test(ct)) return ""
    return unescapeHtml(await res.text())
  } catch {
    return ""
  } finally {
    clearTimeout(t)
  }
}

async function fetchText(url: string, referer?: string): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "*/*",
        ...(referer ? { Referer: referer } : {}),
      },
    })
    if (!res.ok) return ""
    const ct = res.headers.get("content-type") ?? ""
    // Only parse textual bodies (JSON/text); never pull a media stream here.
    if (/image|video|audio|octet-stream|mpegurl|dash/.test(ct)) return ""
    const txt = await res.text()
    return txt.length > 3_000_000 ? txt.slice(0, 3_000_000) : txt
  } catch {
    return ""
  } finally {
    clearTimeout(t)
  }
}

function collectFromHtml(html: string, baseUrl: string): string[] {
  const found = new Set<string>()
  const add = (raw: string | undefined | null) => {
    if (!raw) return
    try {
      const abs = new URL(raw, baseUrl).toString()
      if (/^https?:/.test(abs) && !JUNK_RE.test(abs)) found.add(abs)
    } catch {
      /* ignore bad urls */
    }
  }
  for (const m of html.matchAll(MEDIA_URL_RE)) if (!JUNK_RE.test(m[0])) found.add(m[0])
  // <video src> / <source src>
  for (const m of html.matchAll(/<(?:video|source)[^>]+src=["']([^"']+)["']/gi)) add(m[1])
  // OpenGraph / Twitter video meta
  for (const m of html.matchAll(
    /<meta[^>]+(?:property|name)=["'](?:og:video(?::(?:secure_)?url)?|twitter:player:stream)["'][^>]+content=["']([^"']+)["']/gi
  ))
    add(m[1])
  for (const m of html.matchAll(
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:video(?::(?:secure_)?url)?|twitter:player:stream)["']/gi
  ))
    add(m[1])
  // JSON-LD contentUrl / embedUrl
  for (const m of html.matchAll(/["'](?:contentUrl|contentURL)["']\s*:\s*["']([^"']+)["']/gi)) add(m[1])
  return [...found]
}

const PLAYER_CONFIG_RE =
  /["'](?:videoUrl|video_url|videoSrc|hlsUrl|hls_url|streamUrl|stream_url|manifestUrl|fileUrl|file|src)["']\s*:\s*["'](https?:[^"']{12,})["']/gi

export async function scanPageForMedia(url: string): Promise<MediaCandidate[]> {
  const html = await fetchPage(url)
  if (!html) return []
  // Player JSON configs carry the REAL stream endpoints (often extension-less
  // /media/hls/?s=... URLs) - rank these above raw regex hits, which are
  // frequently related-video preview decoys.
  const priority: MediaCandidate[] = []
  for (const m of html.matchAll(PLAYER_CONFIG_RE)) {
    const u = m[1]
    if (!JUNK_RE.test(u) && !/\.(jpe?g|png|gif|webp|css|js|vtt|srt)(\?|$)/i.test(u))
      priority.push({ url: u, referer: url, kind: kindOf(u) })
  }
  const embeds = detectEmbeds(html, url)
  const direct = collectFromHtml(html, url)
  const candidates: MediaCandidate[] = direct
    .filter((u) => MEDIA_URL_RE.test(u) || /\.(m3u8|mpd|mp4|webm|mov|m4v|mkv)(\?|$)/i.test(u))
    .map((u) => ({ url: u, referer: url, kind: kindOf(u) }))

  // One level of iframe embeds (players hosted on CDN subdomains)
  const iframes = [...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)]
    .map((m) => {
      try {
        return new URL(m[1], url).toString()
      } catch {
        return ""
      }
    })
    .filter((u) => /^https?:/.test(u) && !JUNK_RE.test(u) && !/facebook|twitter|recaptcha|ads|consent/i.test(u))
    .slice(0, 3)
  for (const frame of iframes) {
    const fhtml = await fetchPage(frame, url)
    if (!fhtml) continue
    for (const u of collectFromHtml(fhtml, frame)) {
      if (/\.(m3u8|mpd|mp4|webm|mov|m4v|mkv)(\?|$)/i.test(u))
        candidates.push({ url: u, referer: frame, kind: kindOf(u) })
    }
  }

  // Second hop: player-config endpoints frequently return JSON that itself
  // holds the real CDN media URL (e.g. tube sites' /media/mp4/?s=... APIs).
  const resolved: MediaCandidate[] = []
  for (const c of priority.slice(0, 4)) {
    const hasExt = /\.(m3u8|mpd|mp4|webm|mov|m4v|mkv)(\?|$)/i.test(c.url)
    if (hasExt) continue
    const body = unescapeHtml(await fetchText(c.url, c.referer))
    if (!body) continue
    for (const m of body.matchAll(MEDIA_URL_RE)) {
      if (!JUNK_RE.test(m[0])) resolved.push({ url: m[0], referer: c.referer, kind: kindOf(m[0]) })
    }
    for (const m of body.matchAll(
      /["'](?:videoUrl|video_url|file|src|url|hls|manifest)["']\s*:\s*["'](https?:[^"']{12,})["']/gi
    )) {
      const u = m[1]
      if (!JUNK_RE.test(u) && /\.(m3u8|mpd|mp4|webm|mov|m4v|mkv)(\?|$)/i.test(u))
        resolved.push({ url: u, referer: c.referer, kind: kindOf(u) })
    }
  }

  // Dedupe + rank: embeds first (native extractor = best A/V), then resolved
  // CDN URLs, then player-config, then raw direct/HLS/DASH hits.
  const seen = new Set<string>()
  const rank = { embed: -1, direct: 0, hls: 1, dash: 2 }
  const rest = candidates.sort((a, b) => rank[a.kind] - rank[b.kind])
  return [...embeds, ...resolved, ...priority, ...rest]
    .filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)))
    .slice(0, 10)
}

// ---------------------------------------------------------------------------
// Probe (info) with fallbacks: native → impersonate → generic → page scan
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YtdlpEntry = Record<string, any>

async function runProbe(args: string[], timeout: number): Promise<YtdlpEntry> {
  const { stdout } = await execFileAsync("yt-dlp", args, {
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  })
  const raw = JSON.parse(stdout)
  return raw?._type === "playlist" ? raw.entries?.[0] : raw
}

export async function probeWithFallbacks(
  url: string,
  cookiesPath: string | null
): Promise<YtdlpEntry> {
  const base = ["-J", "--no-playlist", "--no-warnings", "--user-agent", BROWSER_UA, ...cookieArgs(cookiesPath)]
  const errors: string[] = []

  try {
    return await runProbe([...base, url], 75_000)
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e))
  }
  if (await canImpersonate()) {
    try {
      return await runProbe([...base, "--impersonate", "chrome", url], 60_000)
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }
  }
  try {
    return await runProbe([...base, "--force-generic-extractor", url], 45_000)
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e))
  }

  // Before giving up: if the page embeds a known player (YouTube/Vimeo/etc),
  // probe that embed with yt-dlp's native extractor for rich metadata.
  const candidates = await scanPageForMedia(url)
  const embed = candidates.find((c) => c.kind === "embed")
  if (embed) {
    try {
      return await runProbe([...base, embed.url], 60_000)
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }
  }
  // Last resort: our own page scan — synthesize a minimal info entry
  if (candidates.length) {
    const html = await fetchPage(url)
    const title = /<title[^>]*>([^<]{1,200})/i.exec(html)?.[1]?.trim()
    const thumb = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1]
    return {
      id: crypto.randomUUID(),
      title: title || url,
      thumbnail: thumb ?? null,
      duration: null,
      webpage_url: url,
      _magica_page_scan: true,
    }
  }
  throw new Error(errors[0] ?? "No extractable media found")
}

// ---------------------------------------------------------------------------
// Download with fallbacks: native → impersonate → generic → page-scan
// candidates. Every attempt's output is deep-validated; fakes are deleted.
// Deadline is generous (25 min) so full-length, large (up to 5GB) videos
// have time to finish on a normal connection instead of being cut off.
// ---------------------------------------------------------------------------

export interface DownloadSuccess {
  filename: string
  sizeBytes: number
  method: string
  durationSec?: number
}

async function pickLargest(dir: string): Promise<{ name: string; size: number } | null> {
  let files: string[] = []
  try {
    files = await fs.readdir(dir)
  } catch {
    return null
  }
  let best: { name: string; size: number } | null = null
  for (const f of files) {
    const st = await fs.stat(path.join(dir, f)).catch(() => null)
    if (st && st.isFile() && (!best || st.size > best.size)) best = { name: f, size: st.size }
  }
  return best
}

async function wipeDirExcept(dir: string, keep: string) {
  const files = await fs.readdir(dir).catch(() => [] as string[])
  await Promise.all(
    files
      .filter((f) => f !== keep)
      .map((f) => fs.rm(path.join(dir, f), { force: true }).catch(() => {}))
  )
}

async function wipeDir(dir: string) {
  const files = await fs.readdir(dir).catch(() => [] as string[])
  await Promise.all(files.map((f) => fs.rm(path.join(dir, f), { force: true }).catch(() => {})))
}

export async function downloadWithFallbacks(opts: {
  url: string
  dir: string
  formatArgs: string[]
  cookiesPath: string | null
}): Promise<DownloadSuccess> {
  const { url, dir, formatArgs, cookiesPath } = opts
  const audioOnly = formatArgs.includes("-x")
  // 25 minutes total — enough headroom for a full 5GB file on a normal
  // connection, across every fallback strategy combined.
  const deadline = Date.now() + 25 * 60 * 1000
  const timeLeft = () => deadline - Date.now()
  const outTpl = path.join(dir, "%(title).80s.%(ext)s")
  const base = [
    "--no-playlist",
    "--no-warnings",
    "--restrict-filenames",
    "--retries",
    "3",
    "--fragment-retries",
    "5",
    "--socket-timeout",
    "30",
    "--max-filesize",
    MAX_FILESIZE,
    "--user-agent",
    BROWSER_UA,
    ...cookieArgs(cookiesPath),
    "-o",
    outTpl,
  ]
  const errors: string[] = []

  const tryAttempt = async (method: string, args: string[], timeout: number): Promise<DownloadSuccess | null> => {
    if (timeLeft() < 25_000) return null
    try {
      await execFileAsync("yt-dlp", args, {
        maxBuffer: 16 * 1024 * 1024,
        timeout: Math.min(timeout, timeLeft() - 5_000),
      })
    } catch (e) {
      errors.push(`${method}: ${e instanceof Error ? e.message : String(e)}`)
      await wipeDir(dir)
      return null
    }
    const best = await pickLargest(dir)
    if (!best) {
      errors.push(`${method}: produced no file`)
      return null
    }
    const check = await validateMediaFile(path.join(dir, best.name))
    if (!check.ok) {
      errors.push(`${method}: rejected fake media (${check.reason})`)
      await wipeDir(dir)
      return null
    }
    return { filename: best.name, sizeBytes: best.size, method, durationSec: check.durationSec }
  }

  // 1. Native extractor — up to 20 minutes for a large single file
  let r = await tryAttempt("native", [...formatArgs, ...base, url], 20 * 60 * 1000)
  if (r) return r
  // 2. Native + browser TLS impersonation (beats many anti-bot walls)
  if (await canImpersonate()) {
    r = await tryAttempt("impersonate", [...formatArgs, ...base, "--impersonate", "chrome", url], 15 * 60 * 1000)
    if (r) return r
  }
  // 3. Generic extractor
  r = await tryAttempt("generic", [...formatArgs, ...base, "--force-generic-extractor", url], 10 * 60 * 1000)
  if (r) return r
  // 4. Page scan → direct/HLS/DASH candidates
  const candidates = await scanPageForMedia(url).catch(() => [] as MediaCandidate[])
  let decoyFallback: DownloadSuccess | null = null
  for (const c of candidates) {
    if (timeLeft() < 30_000) break
    // Embeds go through yt-dlp's native extractor (best A/V); direct single
    // files skip format merging; manifests keep the quality selector.
    const fmt = c.kind === "direct" ? (audioOnly ? formatArgs : []) : formatArgs
    const refArgs = c.kind === "embed" ? [] : ["--referer", c.referer]
    r = await tryAttempt(
      `page-scan:${c.kind}`,
      [...fmt, ...base, ...refArgs, c.url],
      8 * 60 * 1000
    )
    if (r) {
      // Suspiciously short & tiny files are usually preview/teaser decoys -
      // keep the best one aside but try the remaining candidates first.
      const suspicious = (r.durationSec ?? 0) < 20 && r.sizeBytes < 2_000_000
      if (!suspicious) return r
      if (!decoyFallback || r.sizeBytes > decoyFallback.sizeBytes) {
        const kept = path.join(dir, ".keep-" + r.filename)
        await fs.rename(path.join(dir, r.filename), kept).catch(() => {})
        decoyFallback = { ...r, filename: ".keep-" + r.filename }
      }
      await wipeDirExcept(dir, decoyFallback.filename)
    }
  }
  if (decoyFallback) {
    const finalName = decoyFallback.filename.replace(/^\.keep-/, "")
    await fs
      .rename(path.join(dir, decoyFallback.filename), path.join(dir, finalName))
      .catch(() => {})
    return { ...decoyFallback, filename: finalName, method: decoyFallback.method + ":short" }
  }

  // All methods failed — classify using the most specific error we saw
  const joined = errors.join(" || ")
  const failure = classifyFailure(joined)
  const err = new Error(failure.message) as Error & { failure: ExtractionFailure }
  err.failure = { ...failure, detail: joined.slice(0, 900) }
  throw err
}
