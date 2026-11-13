// The keeper's own tests: where the sidecar is, what it is to serve,
// and how it is asked whether it is up.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  VERSION,
  assetName,
  downloadDir,
  downloadSidecar,
  findGo,
  findSidecar,
  health,
  platformDir,
  releaseURL,
  setUpstream,
  servesUpstreams,
  sidecarArgs,
  sidecarName,
  upstreams,
  upstreamFile,
} from "./sidecar.mjs"

const temps = []

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

// tempDir is a folder of its own, to write in.
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "ech-sidecar-"))
  temps.push(dir)
  return dir
}

describe("upstreamFile", () => {
  test("is in the plugin's own folder, in magpie's folder", () => {
    const file = upstreamFile(tempDir())
    expect(file).toContain(join("magpie-ech-middleware", "upstreams.json"))
  })
})

describe("setUpstream", () => {
  test("writes the address the sign-in named", () => {
    const dir = tempDir()
    const wrote = setUpstream(dir, "nvidia", "https://api.example.com/v1")
    expect(wrote).toEqual({ nvidia: "https://api.example.com/v1" })
    const said = JSON.parse(readFileSync(upstreamFile(dir), "utf8"))
    expect(said).toEqual(wrote)
  })

  test("keeps the upstreams the file already has", () => {
    const dir = tempDir()
    const file = upstreamFile(dir)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ amd: "https://other.example.com/v1" }))
    const wrote = setUpstream(dir, "nvidia", "https://api.example.com/v1")
    expect(wrote).toEqual({ nvidia: "https://api.example.com/v1", amd: "https://other.example.com/v1" })
    const said = JSON.parse(readFileSync(file, "utf8"))
    expect(said).toEqual(wrote)
  })

  test("keeps the ECH config given by hand for an upstream", () => {
    const dir = tempDir()
    const file = upstreamFile(dir)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ nvidia: { url: "https://old.example.com/v1", ech: "Y2VjaA==" } }))
    const wrote = setUpstream(dir, "nvidia", "https://new.example.com/v1")
    expect(wrote.nvidia.url).toBe("https://new.example.com/v1")
    expect(wrote.nvidia.ech).toBe("Y2VjaA==")
  })

  test("answers the upstreams the sidecar is to serve", () => {
    const dir = tempDir()
    setUpstream(dir, "nvidia", "https://api.example.com/v1")
    expect(upstreams()).toMatchObject({ nvidia: "https://api.example.com/v1" })
  })
})

describe("servesUpstreams", () => {
  test("is so when the names and the addresses are the same", () => {
    const said = { upstreams: { nvidia: { url: "https://api.example.com/v1" } } }
    expect(servesUpstreams(said, { nvidia: "https://api.example.com/v1" })).toBe(true)
  })

  test("is so when a wanted upstream carries its ECH config too", () => {
    const said = { upstreams: { nvidia: { url: "https://api.example.com/v1" } } }
    const want = { nvidia: { url: "https://api.example.com/v1", ech: "a config given by hand" } }
    expect(servesUpstreams(said, want)).toBe(true)
  })

  test("is not so when an address is another", () => {
    const said = { upstreams: { nvidia: { url: "https://other.example.com/v1" } } }
    expect(servesUpstreams(said, { nvidia: "https://api.example.com/v1" })).toBe(false)
  })

  test("is not so when an upstream is missing", () => {
    const said = { upstreams: { amd: { url: "https://other.example.com/v1" } } }
    expect(servesUpstreams(said, { nvidia: "https://api.example.com/v1" })).toBe(false)
  })

  test("is not so when nothing is wanted", () => {
    expect(servesUpstreams({ upstreams: {} }, {})).toBe(false)
  })
})

describe("the sidecar's binary", () => {
  test("is named for the platform", () => {
    expect(sidecarName("win32")).toBe("ech-sidecar.exe")
    expect(sidecarName("linux")).toBe("ech-sidecar")
    expect(sidecarName("darwin")).toBe("ech-sidecar")
  })

  test("is looked for in the folder of this platform", () => {
    expect(platformDir("linux", "x64")).toContain(join("bin", "linux-x64"))
    expect(platformDir("linux", "x64", "/magpie")).toContain(join("magpie", "magpie-ech-middleware", "bin", "linux-x64"))
  })

  test("is downloaded by version, so an upgrade does not run the old one", () => {
    expect(downloadDir("linux", "x64", "/magpie")).toContain(join("magpie", "magpie-ech-middleware", "bin", "linux-x64", `v${VERSION}`))
  })

  test("is named as an asset of the release for its platform", () => {
    expect(assetName("win32", "x64")).toBe("ech-sidecar-win32-x64.exe")
    expect(assetName("linux", "arm64")).toBe("ech-sidecar-linux-arm64")
  })

  test("is downloaded from the release into magpie's directory", async () => {
    const dir = tempDir()
    const bytes = Buffer.from("a binary of its own")
    const asked = []
    const fakeFetch = async (url) => {
      asked.push(url)
      return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }
    }
    const got = await downloadSidecar(dir, "https://example.com/ech-sidecar-linux-x64", fakeFetch)
    expect(got).toBe(join(downloadDir(process.platform, process.arch, dir), sidecarName()))
    expect(readFileSync(got)).toEqual(bytes)
    expect(asked).toEqual(["https://example.com/ech-sidecar-linux-x64"])
    // a second ask finds the one kept, and downloads nothing
    expect(await downloadSidecar(dir, "https://example.com/other", fakeFetch)).toBe(got)
    expect(asked.length).toBe(1)
  })

  test("is downloaded again when only an unversioned copy is kept", async () => {
    const dir = tempDir()
    const old = join(platformDir(process.platform, process.arch, dir), sidecarName())
    mkdirSync(dirname(old), { recursive: true })
    writeFileSync(old, "the sidecar of an earlier version")
    const bytes = Buffer.from("the sidecar of this version")
    const got = await downloadSidecar(dir, "https://example.com/sidecar", async () => ({
      ok: true,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    }))
    expect(got).toBe(join(downloadDir(process.platform, process.arch, dir), sidecarName()))
    expect(readFileSync(got)).toEqual(bytes)
    expect(findSidecar("", dir)).not.toBe(old)
    expect(readFileSync(old, "utf8")).toBe("the sidecar of an earlier version")
  })

  test("is not downloaded when the release says nothing", async () => {
    const dir = tempDir()
    const got = await downloadSidecar(dir, "https://example.com/none", async () => ({ ok: false }))
    expect(got).toBeNull()
  })

  test("is named in the release's address", () => {
    const url = releaseURL("sidecar", "someone/repo")
    expect(url).toBe(`https://github.com/someone/repo/releases/download/sidecar/${assetName()}`)
  })

  test("is found where the user set one", () => {
    const dir = tempDir()
    const own = join(dir, "my-sidecar")
    writeFileSync(own, "x")
    expect(findSidecar(own)).toBe(own)
  })

  test("is built with Go, which the machine may have", () => {
    expect(findGo()).toBeTruthy()
  })
})

describe("sidecarArgs", () => {
  test("are the file of the upstreams and the address to listen on", () => {
    expect(sidecarArgs("C:/magpie/upstreams.json", "127.0.0.1:8790")).toEqual([
      "-upstreams-file",
      "C:/magpie/upstreams.json",
      "-listen",
      "127.0.0.1:8790",
    ])
  })

  test("carry the ECH fallback the options name", () => {
    expect(sidecarArgs("C:/magpie/upstreams.json", "127.0.0.1:8790", "always")).toEqual([
      "-upstreams-file",
      "C:/magpie/upstreams.json",
      "-listen",
      "127.0.0.1:8790",
      "-ech-fallback",
      "always",
    ])
  })

  test("leave the fallback to the sidecar when the options name none", () => {
    expect(sidecarArgs("C:/magpie/upstreams.json", "127.0.0.1:8790", "")).toEqual([
      "-upstreams-file",
      "C:/magpie/upstreams.json",
      "-listen",
      "127.0.0.1:8790",
    ])
  })

  test("say so when there is no file of the upstreams", () => {
    expect(() => sidecarArgs("")).toThrow(/nothing for the sidecar to talk to/)
  })
})

describe("health", () => {
  test("is what the sidecar answers", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, upstreams: { nvidia: { url: "https://api.example.com/v1" } } }))
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = server.address().port
    try {
      const said = await health(port)
      expect(said.ok).toBe(true)
      expect(said.upstreams.nvidia.url).toBe("https://api.example.com/v1")
    } finally {
      server.close()
    }
  })

  test("is nothing when nothing listens", async () => {
    expect(await health(1, 300)).toBeNull()
  })
})
