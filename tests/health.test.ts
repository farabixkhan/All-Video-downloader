import { describe, it, expect, vi, beforeEach } from "vitest"
import { promises as fs } from "fs"
import path from "path"
import os from "os"

// Controls which commands the mocked child_process.execFile "succeeds" for.
// Any command not explicitly set to false is treated as succeeding, so
// tests only need to override the specific binary they want to fail.
let shouldFail: Record<string, boolean> = {}

vi.mock("child_process", () => ({
  execFile: (
    cmd: string,
    _args: string[],
    optsOrCb: unknown,
    maybeCb?: (err: Error | null, stdout: string, stderr: string) => void
  ) => {
    const callback = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as (
      err: Error | null,
      stdout: string,
      stderr: string
    ) => void
    if (shouldFail[cmd]) callback(new Error(`${cmd}: command not found`), "", "")
    else callback(null, "", "")
  },
}))

beforeEach(() => {
  shouldFail = {}
  vi.resetModules()
})

describe("checkRequiredDependencies", () => {
  it("reports every dependency ok when all commands succeed", async () => {
    const { checkRequiredDependencies } = await import("../lib/health")
    const result = await checkRequiredDependencies()
    expect(result.map((d) => d.name).sort()).toEqual(["deno", "ffmpeg", "ffprobe", "yt-dlp"].sort())
    expect(result.every((d) => d.ok)).toBe(true)
  })

  it("flags only the specific dependency that fails", async () => {
    shouldFail.deno = true
    const { checkRequiredDependencies } = await import("../lib/health")
    const result = await checkRequiredDependencies()
    const deno = result.find((d) => d.name === "deno")
    const others = result.filter((d) => d.name !== "deno")
    expect(deno?.ok).toBe(false)
    expect(others.every((d) => d.ok)).toBe(true)
  })

  it("never throws even if a binary is completely missing", async () => {
    shouldFail["yt-dlp"] = true
    shouldFail.ffmpeg = true
    shouldFail.ffprobe = true
    shouldFail.deno = true
    const { checkRequiredDependencies } = await import("../lib/health")
    const result = await checkRequiredDependencies()
    expect(result.every((d) => !d.ok)).toBe(true)
  })
})

describe("checkPoProviderAvailable", () => {
  it("returns false when the compiled script is missing, even if the pip check succeeds", async () => {
    process.env.PO_PROVIDER_SCRIPT_PATH = "/definitely/does/not/exist/main.js"
    const { checkPoProviderAvailable } = await import("../lib/health")
    expect(await checkPoProviderAvailable()).toBe(false)
    delete process.env.PO_PROVIDER_SCRIPT_PATH
  })

  it("returns false when the pip package check fails, even if the script file exists", async () => {
    const tmpFile = path.join(os.tmpdir(), `po-script-${Date.now()}.js`)
    await fs.writeFile(tmpFile, "// stub")
    process.env.PO_PROVIDER_SCRIPT_PATH = tmpFile
    shouldFail["/opt/ytdlp-venv/bin/python3"] = true
    const { checkPoProviderAvailable } = await import("../lib/health")
    expect(await checkPoProviderAvailable()).toBe(false)
    delete process.env.PO_PROVIDER_SCRIPT_PATH
    await fs.rm(tmpFile, { force: true })
  })

  it("returns true only when BOTH the pip package and the compiled script are present", async () => {
    const tmpFile = path.join(os.tmpdir(), `po-script-ok-${Date.now()}.js`)
    await fs.writeFile(tmpFile, "// stub")
    process.env.PO_PROVIDER_SCRIPT_PATH = tmpFile
    // pip check command isn't in shouldFail, so it "succeeds" per the mock default
    const { checkPoProviderAvailable } = await import("../lib/health")
    expect(await checkPoProviderAvailable()).toBe(true)
    delete process.env.PO_PROVIDER_SCRIPT_PATH
    await fs.rm(tmpFile, { force: true })
  })
})
