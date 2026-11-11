// The keeper's own tests: where the sidecar is, how it is started, and
// how it is asked whether it is up.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  baseURL,
  findGo,
  findSidecar,
  health,
  localAPI,
  platformDir,
  resolveAPI,
  sidecarArgs,
  sidecarName,
} from "./sidecar.mjs"

const temps = []

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

// tempFile writes a file in a folder of its own and hands its path back.
function tempFile(name, body) {
  const dir = mkdtempSync(join(tmpdir(), "ech-sidecar-"))
  temps.push(dir)
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

describe("localAPI", () => {
  test("is the API the file names", () => {
    const file = tempFile("ech.local.json", JSON.stringify({ api: "https://api.example.com" }))
    expect(localAPI(file)).toBe("https://api.example.com")
  })

  test("is nothing when the file names none", () => {
    const file = tempFile("ech.local.json", JSON.stringify({}))
    expect(localAPI(file)).toBe("")
  })

  test("is nothing when the file cannot be read", () => {
    expect(localAPI(join(tmpdir(), "ech-sidecar-nothing-here.json"))).toBe("")
  })
})

describe("resolveAPI", () => {
  test("is the API that is given, with its path", () => {
    const got = resolveAPI("https://api.example.com/v1/")
    expect(got.api).toBe("https://api.example.com/v1")
    expect(got.origin).toBe("https://api.example.com")
    expect(got.path).toBe("/v1")
  })

  test("is the local file's when nothing else says", () => {
    const got = resolveAPI("", "https://api.example.com/v1")
    expect(got.api).toBe("https://api.example.com/v1")
  })

  test("is the environment's when it says so", () => {
    const before = process.env.ECH_API
    process.env.ECH_API = "https://env.example.com"
    try {
      expect(resolveAPI("https://api.example.com").origin).toBe("https://env.example.com")
    } finally {
      if (before === undefined) delete process.env.ECH_API
      else process.env.ECH_API = before
    }
  })

  test("is nothing when nothing names one", () => {
    const before = process.env.ECH_API
    delete process.env.ECH_API
    try {
      expect(resolveAPI("", "")).toEqual({ api: "", origin: "", path: "" })
    } finally {
      if (before !== undefined) process.env.ECH_API = before
    }
  })

  test("says so when the address is not a URL", () => {
    expect(() => resolveAPI("not a url")).toThrow(/not a URL/)
  })
})

describe("baseURL", () => {
  test("is the sidecar's own address, under the API's path", () => {
    expect(baseURL(8790)).toBe("http://127.0.0.1:8790")
    expect(baseURL(8790, "/v1")).toBe("http://127.0.0.1:8790/v1")
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
  })

  test("is found in the package", () => {
    const found = findSidecar()
    expect(found).toContain("sidecar")
    expect(existsSync(found)).toBe(true)
  })

  test("is built with Go, which the machine may have", () => {
    expect(findGo()).toBeTruthy()
  })
})

describe("sidecarArgs", () => {
  test("are the upstream and the address to listen on", () => {
    expect(sidecarArgs("https://api.example.com", "127.0.0.1:8790")).toEqual([
      "-upstream",
      "https://api.example.com",
      "-listen",
      "127.0.0.1:8790",
    ])
  })

  test("say so when there is no upstream", () => {
    expect(() => sidecarArgs("")).toThrow(/no API is named/)
  })
})

describe("health", () => {
  test("is what the sidecar answers", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, upstream: "https://api.example.com", ech: true }))
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = server.address().port
    try {
      const said = await health(port)
      expect(said.ok).toBe(true)
      expect(said.upstream).toBe("https://api.example.com")
    } finally {
      server.close()
    }
  })

  test("is nothing when nothing listens", async () => {
    expect(await health(1, 300)).toBeNull()
  })
})
