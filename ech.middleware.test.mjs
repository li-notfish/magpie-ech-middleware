// The middleware's own tests: what it does to a request, to an account,
// to a try and to a reply.
//
// The middleware runs in magpie's gateway on moejs, so it is written the
// way that engine runs it: no import, no Node API, no timer. The tests
// call its hooks with the ctx the gateway gives them.
import { describe, expect, test } from "bun:test"
import {
  bare,
  map,
  onAccount,
  onEvent,
  onProvider,
  onRequest,
  onResponse,
  optionsOf,
  portOf,
  providerOf,
  routedModel,
  rules,
} from "./ech.middleware.js"

// ctx is the context the gateway gives a middleware: its options, its
// state, and the way to turn a request away.
function ctx(options = {}, extra = {}) {
  return {
    options,
    state: {},
    protocol: "anthropic",
    model: "",
    stream: true,
    path: "/v1/messages",
    agent: "claude-code",
    rejected: null,
    reject(status, message) {
      this.rejected = { status, message }
    },
    ...extra,
  }
}

const ECH = { provider: "ech", models: { fast: "gpt-4o-mini" } }

describe("onRequest", () => {
  test("routes the model the rules name", () => {
    const c = ctx(ECH)
    const body = { model: "fast", messages: [] }
    expect(onRequest(body, c)).toBe(body)
    expect(body.model).toBe("ech/gpt-4o-mini")
    expect(c.state.asked).toBe("fast")
  })

  test("leaves a model nothing maps alone", () => {
    const c = ctx(ECH)
    const body = { model: "gpt-4o" }
    expect(onRequest(body, c)).toBeUndefined()
    expect(body.model).toBe("gpt-4o")
  })

  test("routes every model when all is on", () => {
    const c = ctx({ ...ECH, all: true })
    const body = { model: "gpt-4o" }
    expect(onRequest(body, c)).toBe(body)
    expect(body.model).toBe("ech/gpt-4o")
  })

  test("routes a model that already names the provider to itself", () => {
    const c = ctx({ ...ECH, all: true })
    const body = { model: "ech/gpt-4o" }
    expect(onRequest(body, c)).toBeUndefined()
    expect(body.model).toBe("ech/gpt-4o")
  })

  test("routes a model that names another provider", () => {
    const c = ctx({ ...ECH, all: true })
    const body = { model: "openai/gpt-4o" }
    expect(onRequest(body, c)).toBe(body)
    expect(body.model).toBe("ech/gpt-4o")
    expect(c.state.asked).toBe("openai/gpt-4o")
  })

  test("maps a family of models with a pattern", () => {
    const c = ctx({ provider: "ech", models: { "/^gpt-4o(-.*)?$/": "gpt-4o" } })
    const body = { model: "gpt-4o-mini" }
    expect(onRequest(body, c)).toBe(body)
    expect(body.model).toBe("ech/gpt-4o")
  })

  test("does nothing when the middleware is off", () => {
    const c = ctx({ ...ECH, off: true })
    const body = { model: "fast" }
    expect(onRequest(body, c)).toBeUndefined()
    expect(body.model).toBe("fast")
  })

  test("does nothing without a provider to route to", () => {
    const c = ctx({ models: { fast: "gpt-4o-mini" } })
    const body = { model: "fast" }
    expect(onRequest(body, c)).toBeUndefined()
    expect(body.model).toBe("fast")
  })

  test("turns a request away when it fails closed", () => {
    const c = ctx({ ...ECH, failClosed: true })
    const body = { model: "gpt-4o" }
    expect(onRequest(body, c)).toBeUndefined()
    expect(c.rejected?.status).toBe(403)
    expect(c.rejected?.message).toContain("gpt-4o")
    expect(body.model).toBe("gpt-4o")
  })

  test("leaves a model that already names the provider alone when it fails closed", () => {
    const c = ctx({ ...ECH, failClosed: true })
    const body = { model: "ech/gpt-4o" }
    expect(onRequest(body, c)).toBeUndefined()
    expect(c.rejected).toBeNull()
  })

  test("does not turn a request away when it fails open", () => {
    const c = ctx(ECH)
    const body = { model: "gpt-4o" }
    onRequest(body, c)
    expect(c.rejected).toBeNull()
  })
})

describe("onAccount", () => {
  test("passes an account that is not the sidecar's over when strict", () => {
    const c = ctx({ ...ECH, strict: true })
    expect(onAccount({ provider: "claude", kind: "claude" }, c)).toEqual({ skip: true })
  })

  test("keeps the sidecar's own account", () => {
    const c = ctx({ ...ECH, strict: true })
    expect(onAccount({ provider: "ech", kind: "ech" }, c)).toBeUndefined()
  })

  test("keeps every account when strict is off", () => {
    const c = ctx(ECH)
    expect(onAccount({ provider: "claude", kind: "claude" }, c)).toBeUndefined()
  })

  test("keeps every account without a provider to compare with", () => {
    const c = ctx({ strict: true })
    expect(onAccount({ provider: "claude", kind: "claude" }, c)).toBeUndefined()
  })
})

describe("onProvider", () => {
  test("says where a try went", () => {
    const lines = []
    const log = console.log
    console.log = (line) => lines.push(line)
    try {
      const c = ctx(ECH, { provider: { id: "ech", name: "ECH", account: "", model: "gpt-4o-mini" } })
      c.state.asked = "fast"
      onProvider({}, c)
      const d = ctx(ECH, { provider: { id: "claude", name: "Claude", account: "claude", model: "gpt-4o" } })
      onProvider({}, d)
    } finally {
      console.log = log
    }
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("fast -> ech")
    expect(lines[0]).toContain("[ech]")
    expect(lines[1]).toContain("[direct]")
  })

  test("says nothing when the log is off", () => {
    const lines = []
    const log = console.log
    console.log = (line) => lines.push(line)
    try {
      const c = ctx({ ...ECH, log: false }, { provider: { id: "ech", name: "ECH", model: "gpt-4o" } })
      onProvider({}, c)
    } finally {
      console.log = log
    }
    expect(lines).toHaveLength(0)
  })
})

describe("onEvent", () => {
  test("puts the asked model's name back", () => {
    const c = ctx(ECH)
    c.state.asked = "fast"
    const ev = { type: "message_start", message: { model: "gpt-4o-mini" } }
    expect(onEvent(ev, c)).toBe(ev)
    expect(ev.message.model).toBe("fast")
  })

  test("puts the name back where the protocol names it", () => {
    const c = ctx(ECH)
    c.state.asked = "fast"
    const ev = { model: "gpt-4o-mini" }
    expect(onEvent(ev, c)).toBe(ev)
    expect(ev.model).toBe("fast")
  })

  test("puts a Gemini chunk's model version back", () => {
    const c = ctx(ECH)
    c.state.asked = "fast"
    const ev = { modelVersion: "gpt-4o-mini" }
    expect(onEvent(ev, c)).toBe(ev)
    expect(ev.modelVersion).toBe("fast")
  })

  test("leaves an event that names the asked model alone", () => {
    const c = ctx(ECH)
    c.state.asked = "fast"
    expect(onEvent({ model: "fast" }, c)).toBeUndefined()
  })

  test("leaves an event alone when nothing was routed", () => {
    const c = ctx(ECH)
    expect(onEvent({ model: "gpt-4o-mini" }, c)).toBeUndefined()
  })
})

describe("onResponse", () => {
  test("puts the asked model's name back", () => {
    const c = ctx(ECH, { status: 200 })
    c.state.asked = "fast"
    const body = { model: "gpt-4o-mini" }
    expect(onResponse(body, c)).toBe(body)
    expect(body.model).toBe("fast")
  })

  test("leaves a reply that failed alone", () => {
    const c = ctx(ECH, { status: 500 })
    c.state.asked = "fast"
    const body = { model: "gpt-4o-mini" }
    expect(onResponse(body, c)).toBeUndefined()
    expect(body.model).toBe("gpt-4o-mini")
  })

  test("leaves a reply alone when nothing was routed", () => {
    const c = ctx(ECH, { status: 200 })
    const body = { model: "gpt-4o-mini" }
    expect(onResponse(body, c)).toBeUndefined()
    expect(body.model).toBe("gpt-4o-mini")
  })
})

describe("the helpers", () => {
  test("bare is a model's name without its provider", () => {
    expect(bare("ech/gpt-4o")).toBe("gpt-4o")
    expect(bare("gpt-4o")).toBe("gpt-4o")
    expect(bare("openai/gpt-4o")).toBe("gpt-4o")
    expect(bare("")).toBe("")
  })

  test("routedModel is the model to send, in the provider to send it to", () => {
    expect(routedModel("fast", ECH)).toBe("ech/gpt-4o-mini")
    expect(routedModel("gpt-4o", ECH)).toBe("")
    expect(routedModel("gpt-4o", { ...ECH, all: true })).toBe("ech/gpt-4o")
    expect(routedModel("fast", {})).toBe("")
  })

  test("rules are the mappings, compiled", () => {
    const r = rules({ models: { fast: "gpt-4o-mini", "/^gpt-4o$/": "gpt-4o" } })
    expect(Object.keys(r.exact)).toEqual(["fast"])
    expect(r.patterns).toHaveLength(1)
  })

  test("map follows a name as far as it goes", () => {
    const r = rules({ models: { a: "b", b: "c" } })
    expect(map("a", r)).toBe("c")
    expect(map("c", r)).toBe("c")
  })

  test("map stops where a cycle would repeat", () => {
    const r = rules({ models: { a: "b", b: "a" } })
    // a -> b -> a would repeat, so it stops at b.
    expect(map("a", r)).toBe("b")
  })

  test("optionsOf is the plugin's own options", () => {
    expect(optionsOf({ options: { off: true } })).toEqual({ off: true })
    expect(optionsOf({})).toEqual({})
    expect(optionsOf(null)).toEqual({})
  })

  test("providerOf and portOf are the ones the user set", () => {
    expect(providerOf({ provider: " ech " })).toBe("ech")
    expect(providerOf({})).toBe("")
    expect(portOf({ port: 9000 })).toBe(9000)
    expect(portOf({})).toBe(8790)
    expect(portOf({ port: "x" })).toBe(8790)
  })
})
