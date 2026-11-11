// The plugin's own tests: the copies it makes of the providers the user
// wrote, and the sign-in and the loader each copy has.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hooksFor, providersOf } from "./ech.providers.js"
import { portOf } from "./ech.shared.js"

const temps = []

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

// tempProviders writes the providers the user wrote and hands the folder
// back.
function tempProviders(providers) {
  const dir = mkdtempSync(join(tmpdir(), "ech-plugin-"))
  temps.push(dir)
  writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers }))
  return dir
}

describe("the plugin's entry", () => {
  test("exports one function per copy, and nothing else", async () => {
    // magpie reads every function the entry exports as a plugin of its
    // own: a helper exported here would be asked to be one.
    const mod = await import("./ech.plugin.js")
    expect(Object.keys(mod).sort()).toEqual(
      Array.from({ length: 16 }, (_, i) => `echCopy${String(i + 1).padStart(2, "0")}`),
    )
  })
})

describe("providersOf", () => {
  test("are the providers the user wrote that have an address", () => {
    const dir = tempProviders([
      { id: "nvidia", name: "NVIDIA", baseAPI: "chat", chat: "https://api.example.com/v1", key: "sk-1", models: ["a", "b"] },
      { id: "workbuddy", models: ["c"] },
    ])
    const got = providersOf(dir)
    expect(got.length).toBe(1)
    expect(got[0].id).toBe("nvidia")
    expect(got[0].name).toBe("NVIDIA")
    expect(got[0].api).toBe("https://api.example.com/v1")
    expect(got[0].key).toBe("sk-1")
    expect(got[0].models).toEqual(["a", "b"])
  })

  test("are none when the file is not there", () => {
    expect(providersOf(join(tmpdir(), "ech-plugin-nothing-here"))).toEqual([])
  })

  test("are none when the file cannot be read", () => {
    const dir = tempProviders([])
    writeFileSync(join(dir, "providers.json"), "{ not json")
    expect(providersOf(dir)).toEqual([])
  })

  test("are spoken on the package of their own kind", () => {
    const dir = tempProviders([
      { id: "a", baseAPI: "chat", chat: "https://a.example.com/v1" },
      { id: "b", baseAPI: "responses", responses: "https://b.example.com/v1" },
      { id: "c", baseAPI: "anthropic", anthropic: "https://c.example.com/v1" },
      { id: "d", baseAPI: "gemini", gemini: "https://d.example.com/v1beta" },
    ])
    const got = providersOf(dir)
    expect(got.map((p) => p.npm)).toEqual([
      "@ai-sdk/openai-compatible",
      "@ai-sdk/openai",
      "@ai-sdk/anthropic",
      "@ai-sdk/google",
    ])
  })

  test("take the address of the kind the user picked", () => {
    const dir = tempProviders([
      { id: "a", baseAPI: "responses", chat: "https://chat.example.com/v1", responses: "https://responses.example.com/v1" },
    ])
    expect(providersOf(dir)[0].api).toBe("https://responses.example.com/v1")
  })

  test("say the Anthropic address without the /v1 magpie adds itself", () => {
    const dir = tempProviders([
      { id: "a", baseAPI: "anthropic", anthropic: "https://c.example.com/v1" },
    ])
    const got = providersOf(dir)
    expect(got[0].api).toBe("https://c.example.com/v1")
    expect(got[0].declared).toBe("https://c.example.com")
  })

  test("say the other addresses as they are", () => {
    const dir = tempProviders([{ id: "a", baseAPI: "chat", chat: "https://a.example.com/v1" }])
    expect(providersOf(dir)[0].declared).toBe("https://a.example.com/v1")
  })
})

describe("hooksFor", () => {
  const provider = {
    id: "nvidia",
    name: "NVIDIA",
    api: "https://api.example.com/v1",
    declared: "https://api.example.com/v1",
    key: "sk-1",
    npm: "@ai-sdk/openai-compatible",
    models: ["gpt-4o"],
  }

  test("declares the copy, named after the provider", async () => {
    const hooks = hooksFor(provider)
    const cfg = {}
    await hooks.config(cfg)
    expect(cfg.provider["ech-nvidia"].name).toBe("NVIDIA (ECH)")
    expect(cfg.provider["ech-nvidia"].api).toBe("https://api.example.com/v1")
    expect(cfg.provider["ech-nvidia"].npm).toBe("@ai-sdk/openai-compatible")
    expect(Object.keys(cfg.provider["ech-nvidia"].models)).toEqual(["gpt-4o"])
  })

  test("leaves a copy the user made alone", async () => {
    const hooks = hooksFor(provider)
    const cfg = { provider: { "ech-nvidia": { name: "mine" } } }
    await hooks.config(cfg)
    expect(cfg.provider["ech-nvidia"].name).toBe("mine")
  })

  test("signs in under the name of the copy", () => {
    expect(hooksFor(provider).auth.provider).toBe("ech-nvidia")
    expect(hooksFor(provider).auth.methods[0].type).toBe("api")
  })

  test("sends the requests to the sidecar, under the provider's own name", async () => {
    const loader = hooksFor(provider, 9000).auth.loader
    const got = await loader(async () => ({ type: "api", key: "sk-1" }))
    expect(got.baseURL).toBe("http://127.0.0.1:9000/nvidia")
    expect(got.apiKey).toBe("sk-1")
  })

  test("says nothing when the sign-in is not a key", async () => {
    const loader = hooksFor(provider).auth.loader
    expect(await loader(async () => ({ type: "oauth" }))).toEqual({})
  })
})

describe("portOf", () => {
  test("is the port the user set", () => {
    expect(portOf({ port: 9000 })).toBe(9000)
  })

  test("is the default when there is none", () => {
    expect(portOf({})).toBe(8790)
    expect(portOf(null)).toBe(8790)
  })

  test("is the default when what is set is no port", () => {
    expect(portOf({ port: 0 })).toBe(8790)
    expect(portOf({ port: 70000 })).toBe(8790)
    expect(portOf({ port: "nine thousand" })).toBe(8790)
  })
})
