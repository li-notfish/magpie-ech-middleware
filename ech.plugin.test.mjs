// The plugin's own tests: the provider it declares, the sign-in it asks
// for, and the loader and models each account has.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ech } from "./ech.plugin.js"
import { addressOf, kindOf, listedOf, slugOf, validateAddress } from "./ech.providers.js"
import { dohOf, echFallbackOf, portOf } from "./ech.shared.js"
import { upstreamFile } from "./sidecar.mjs"

const temps = []

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

// tempDir is a folder of its own, to write the upstreams into.
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "ech-plugin-"))
  temps.push(dir)
  return dir
}

async function pluginOf(options = {}) {
  return ech({ directory: tempDir() }, options)
}

describe("the plugin's entry", () => {
  test("exports one function, and nothing else", async () => {
    // magpie reads every function the entry exports as a plugin of its
    // own: a helper exported here would be asked to be one.
    const mod = await import("./ech.plugin.js")
    expect(Object.keys(mod).sort()).toEqual(["ech"])
  })
})

describe("the provider the plugin declares", () => {
  test("is the one the sign-in serves, with no models of its own", async () => {
    const plugin = await pluginOf()
    const cfg = {}
    await plugin.config(cfg)
    expect(cfg.provider.ech.name).toBe("ECH")
    expect(cfg.provider.ech.npm).toBe("@ai-sdk/openai-compatible")
    expect(cfg.provider.ech.models).toEqual({})
  })

  test("leaves a provider the user made alone", async () => {
    const plugin = await pluginOf()
    const cfg = { provider: { ech: { name: "mine" } } }
    await plugin.config(cfg)
    expect(cfg.provider.ech.name).toBe("mine")
  })
})

describe("the sign-in the plugin asks for", () => {
  test("serves the provider, with the address, the kind and the key asked", async () => {
    const plugin = await pluginOf()
    expect(plugin.auth.provider).toBe("ech")
    const method = plugin.auth.methods[0]
    expect(method.type).toBe("api")
    expect(method.prompts.map((p) => p.key)).toEqual(["baseURL", "kind", "key"])
    expect(typeof method.authorize).toBe("function")
  })
})

describe("the authorize of the sign-in", () => {
  const methodOf = async () => (await pluginOf()).auth.methods[0]

  test("signs in with the key, and keeps the address among the metadata", async () => {
    const method = await methodOf()
    const got = await method.authorize({ baseURL: "https://api.example.com/v1", kind: "anthropic", key: " sk-1 " })
    expect(got.type).toBe("success")
    expect(got.key).toBe("sk-1")
    expect(got.metadata).toEqual({ baseURL: "https://api.example.com/v1", kind: "anthropic" })
  })

  test("names the chat kind when none was chosen", async () => {
    const method = await methodOf()
    const got = await method.authorize({ baseURL: "https://api.example.com/v1", key: "sk-1" })
    expect(got.metadata.kind).toBe("chat")
  })

  test("fails when the address given is no address", async () => {
    const method = await methodOf()
    const got = await method.authorize({ baseURL: "api.example.com", key: "sk-1" })
    expect(got.type).toBe("failed")
    expect(typeof got.error).toBe("string")
  })

  test("fails when no key was given", async () => {
    const method = await methodOf()
    const got = await method.authorize({ baseURL: "https://api.example.com/v1", key: "  " })
    expect(got.type).toBe("failed")
    expect(typeof got.error).toBe("string")
  })
})

describe("the loader of an account", () => {
  const metadata = { baseURL: "https://api.example.com/v1", kind: "chat" }

  test("sends the requests to the sidecar, under the upstream's own name", async () => {
    const plugin = await pluginOf({ port: 9000 })
    const got = await plugin.auth.loader(async () => ({ type: "api", key: "sk-1", metadata }))
    expect(got.baseURL).toBe(`http://127.0.0.1:9000/${slugOf("https://api.example.com/v1")}`)
    expect(got.apiKey).toBe("sk-1")
  })

  test("says nothing when the sign-in is not a key", async () => {
    const plugin = await pluginOf()
    expect(await plugin.auth.loader(async () => ({ type: "oauth" }))).toEqual({})
  })

  test("says nothing when the sign-in names no address", async () => {
    const plugin = await pluginOf()
    expect(await plugin.auth.loader(async () => ({ type: "api", key: "sk-1" }))).toEqual({})
  })
})

describe("the models of an account", () => {
  test("are the upstream's own, keyed by the id the upstream gave", async () => {
    // A sidecar of our own: what the listing asks, it answers.
    const address = "https://api.example.com/v1"
    const slug = slugOf(address)
    const server = http.createServer((req, res) => {
      if (req.url === `/${slug}/models`) {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini", name: "GPT-4o mini" }] }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise((done) => server.listen(0, "127.0.0.1", done))
    try {
      const port = server.address().port
      const said = await listedOf("chat", address, "sk-1", port)
      expect(said).toEqual({
        "gpt-4o": {
          name: "gpt-4o",
          api: { id: "gpt-4o", npm: "@ai-sdk/openai-compatible" },
          capabilities: { reasoning: true },
          variants: {
            low: { reasoningEffort: "low" },
            medium: { reasoningEffort: "medium" },
            high: { reasoningEffort: "high" },
            xhigh: { reasoningEffort: "xhigh" },
            max: { reasoningEffort: "max" },
          },
        },
        "gpt-4o-mini": {
          name: "GPT-4o mini",
          api: { id: "gpt-4o-mini", npm: "@ai-sdk/openai-compatible" },
          capabilities: { reasoning: true },
          variants: {
            low: { reasoningEffort: "low" },
            medium: { reasoningEffort: "medium" },
            high: { reasoningEffort: "high" },
            xhigh: { reasoningEffort: "xhigh" },
            max: { reasoningEffort: "max" },
          },
        },
      })
    } finally {
      server.close()
    }
  })

  test("are listed after the upstream was written down for the sidecar", async () => {
    // A sidecar of our own: the health it answers says the upstream is
    // served, and what the listing asks, it answers. The listing is what
    // brings the sidecar up — no loader has run for it — so the upstream
    // has to be written down on the way.
    const address = "https://api.example.com/v1"
    const slug = slugOf(address)
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json")
      if (req.url === "/_ech/health") {
        res.end(JSON.stringify({ ok: true, upstreams: { [slug]: address } }))
        return
      }
      if (req.url === `/${slug}/models`) {
        res.end(JSON.stringify({ data: [{ id: "gpt-4o" }] }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise((done) => server.listen(0, "127.0.0.1", done))
    try {
      const plugin = await pluginOf({ port: server.address().port })
      const got = await plugin.provider.models({}, {
        auth: { type: "api", key: "sk-1", metadata: { baseURL: address, kind: "chat" } },
      })
      expect(got).toEqual({
        "gpt-4o": {
          name: "gpt-4o",
          api: { id: "gpt-4o", npm: "@ai-sdk/openai-compatible" },
          capabilities: { reasoning: true },
          variants: {
            low: { reasoningEffort: "low" },
            medium: { reasoningEffort: "medium" },
            high: { reasoningEffort: "high" },
            xhigh: { reasoningEffort: "xhigh" },
            max: { reasoningEffort: "max" },
          },
        },
      })
      const said = JSON.parse(readFileSync(upstreamFile(temps.at(-1)), "utf8"))
      expect(said[slug]).toBe(address)
    } finally {
      server.close()
    }
  })

  test("are none when nothing answers", async () => {
    expect(await listedOf("chat", "https://api.example.com/v1", "sk-1", 1)).toBe(null)
  })

  test("give up when the listing does not answer in time", async () => {
    const address = "https://api.example.com/v1"
    const server = http.createServer(() => {
      // An upstream that accepts the request and never answers.
    })
    await new Promise((done) => server.listen(0, "127.0.0.1", done))
    try {
      const began = Date.now()
      const said = await listedOf("chat", address, "sk-1", server.address().port, 100)
      expect(said).toBe(null)
      expect(Date.now() - began).toBeLessThan(2000)
    } finally {
      server.closeAllConnections?.()
      server.close()
    }
  })

  test("name no levels for the kinds that think by a budget of their own", async () => {
    const address = "https://api.example.com/v1"
    const slug = slugOf(address)
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json")
      if (req.url === `/${slug}/models`) {
        res.end(JSON.stringify({ data: [{ id: "claude-sonnet-4-5" }] }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise((done) => server.listen(0, "127.0.0.1", done))
    try {
      const said = await listedOf("anthropic", address, "sk-1", server.address().port)
      expect(said).toEqual({
        "claude-sonnet-4-5": {
          name: "claude-sonnet-4-5",
          api: { id: "claude-sonnet-4-5", npm: "@ai-sdk/anthropic" },
          capabilities: { reasoning: true },
        },
      })
    } finally {
      server.close()
    }
  })

  test("keep the ones known when the sign-in is not a key", async () => {
    const plugin = await pluginOf()
    const known = { "gpt-4o": { name: "gpt-4o" } }
    expect(await plugin.provider.models({ models: known }, { auth: { type: "oauth" } })).toBe(known)
  })

  test("keep the ones known when the sign-in names no address", async () => {
    const plugin = await pluginOf()
    const known = { "gpt-4o": { name: "gpt-4o" } }
    expect(await plugin.provider.models({ models: known }, { auth: { type: "api", key: "sk-1" } })).toBe(known)
  })
})

describe("the helpers", () => {
  test("the address is what the sign-in named, without its last slash", () => {
    expect(addressOf({ baseURL: "https://api.example.com/v1/" })).toBe("https://api.example.com/v1")
    expect(addressOf({ baseURL: "not a url" })).toBe("")
    expect(addressOf({})).toBe("")
    expect(addressOf(undefined)).toBe("")
  })

  test("the kind is the one named, or the chat one", () => {
    expect(kindOf({ kind: "anthropic" })).toBe("anthropic")
    expect(kindOf({ kind: " ANTHROPIC " })).toBe("anthropic")
    expect(kindOf({ kind: "no such" })).toBe("chat")
    expect(kindOf(undefined)).toBe("chat")
  })

  test("the address is asked for until one is given", () => {
    expect(validateAddress("https://api.example.com/v1")).toBe(undefined)
    expect(validateAddress("http://api.example.com")).toBe(undefined)
    expect(validateAddress("")).toBeTruthy()
    expect(validateAddress("api.example.com")).toBeTruthy()
    expect(validateAddress("ftp://api.example.com")).toBeTruthy()
  })

  test("the name of an upstream is its host and path, with marks of its own", () => {
    const one = slugOf("https://api.example.com/v1")
    expect(one).toMatch(/^api-example-com-v1-[0-9a-f]{8}$/)
    expect(slugOf("https://api.example.com/v1")).toBe(one)
    expect(slugOf("https://api.example.com/v2")).not.toBe(one)
    expect(slugOf("not a url")).toBe("")
  })

  test("the port is the one the user set", () => {
    expect(portOf({ port: 9000 })).toBe(9000)
    expect(portOf({})).toBe(8790)
    expect(portOf(null)).toBe(8790)
    expect(portOf({ port: 70000 })).toBe(8790)
  })

  test("the ECH fallback is the one the user set", () => {
    expect(echFallbackOf({ echFallback: " always " })).toBe("always")
    expect(echFallbackOf({ echFallback: "AEX+DQBB" })).toBe("AEX+DQBB")
    expect(echFallbackOf({})).toBe("")
    expect(echFallbackOf({ echFallback: "  " })).toBe("")
    expect(echFallbackOf(null)).toBe("")
    expect(echFallbackOf({ echFallback: 8790 })).toBe("")
  })

  test("the DoH endpoints are the ones the user set", () => {
    expect(dohOf({ doh: " https://doh.pub/dns-query,https://dns.alidns.com/dns-query " })).toBe(
      "https://doh.pub/dns-query,https://dns.alidns.com/dns-query",
    )
    expect(dohOf({})).toBe("")
    expect(dohOf({ doh: "  " })).toBe("")
    expect(dohOf(null)).toBe("")
    expect(dohOf({ doh: ["https://doh.pub/dns-query"] })).toBe("")
  })
})
