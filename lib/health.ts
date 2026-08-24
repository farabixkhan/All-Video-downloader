import { execFile } from "child_process"
import { promisify } from "util"
import { existsSync } from "fs"
import path from "path"
import os from "os"

const execFileAsync = promisify(execFile)

export interface DependencyStatus {
  name: string
  ok: boolean
}

/** Runs a command with a short timeout; resolves true/false, never throws.
 * Never includes stdout/stderr/paths in the result — callers only see a
 * boolean, so no command output or filesystem detail can leak. */
export async function checkCommand(cmd: string, args: string[], timeoutMs = 5000): Promise<boolean> {
  try {
    await execFileAsync(cmd, args, { timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

/** Required runtime dependencies — the app cannot correctly extract/convert
 * video without these. Missing any of these should surface as unhealthy. */
export async function checkRequiredDependencies(): Promise<DependencyStatus[]> {
  const checks: Array<[string, () => Promise<boolean>]> = [
    ["yt-dlp", () => checkCommand("yt-dlp", ["--version"])],
    ["ffmpeg", () => checkCommand("ffmpeg", ["-version"])],
    ["ffprobe", () => checkCommand("ffprobe", ["-version"])],
    ["deno", () => checkCommand("deno", ["--version"])],
  ]
  return Promise.all(checks.map(async ([name, fn]) => ({ name, ok: await fn() })))
}

// Optional YouTube PO-token provider (see lib/extract.ts / Dockerfile).
// Configurable via env vars so this isn't hardcoded to one Docker layout.
const PO_VENV_PYTHON = process.env.PO_PROVIDER_PYTHON || "/opt/ytdlp-venv/bin/python3"
const PO_PACKAGE_NAME = process.env.PO_PROVIDER_PACKAGE || "bgutil-ytdlp-pot-provider"
const PO_SCRIPT_PATH =
  process.env.PO_PROVIDER_SCRIPT_PATH ||
  path.join(os.homedir(), "bgutil-ytdlp-pot-provider", "server", "build", "main.js")

/**
 * Best-effort, network-free verification that the optional PO-token
 * provider is actually installed and built — NOT a live YouTube check
 * (that would hit YouTube's servers on every health poll, which is exactly
 * the kind of automated traffic this whole feature exists to avoid
 * triggering). Two conditions must both hold:
 *  1. the pip plugin package is importable in the yt-dlp venv
 *  2. the compiled provider script exists on disk
 * If either is false, PO is reported unavailable — the app still works
 * fine without it (normal public extraction is unaffected either way).
 */
export async function checkPoProviderAvailable(): Promise<boolean> {
  const pluginInstalled = await checkCommand(PO_VENV_PYTHON, ["-m", "pip", "show", PO_PACKAGE_NAME], 5000)
  const scriptBuilt = existsSync(PO_SCRIPT_PATH)
  return pluginInstalled && scriptBuilt
}
