// The middleware's own tests: what it does to a request, to an account
// and to a try.
//
// The middleware runs in magpie's gateway on moejs, so it is written the
// way that engine runs it: no import, no Node API, no timer. The tests
// call its hooks with the ctx the gateway gives them.
import { describe, expect, test } from "bun:test"
import { onProvider, onRequest, optionsOf } from "./ech.middleware.js"

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

// said is what the middleware writes, gathered while it runs.
function said(run) {
  const lines = []
  const before = console.log
  console.log = (line) => lines.push(line)
  try {
    run()
  } finally {
    console.log = before
  }
  return lines.join("\n")
}

describe("onRequest", () => {
  test("leaves a request that names a copy alone", () => {
    const c = ctx({ failClosed: true })
    const body = { model: "ech-nvidia/minimaxai/minimax-m3.1-flash" }
    expect(onRequest(body, c)).toBeUndefined()
    expect(c.rejected).toBeNull()
  })

  test("turns a request that names no copy away when it fails closed", () => {
    const c = ctx({ failClosed: true })
    const body = { model: "minimaxai/minimax-m3.1-flash" }
    expect(onRequest(body, c)).toBeUndefined()
    expect(c.rejected?.status).toBe(403)
    expect(c.rejected?.message).toContain("minimaxai/minimax-m3.1-flash")
    expect(body.model).toBe("minimaxai/minimax-m3.1-flash")
  })

  test("turns a request that names another provider away when it fails closed", () => {
    const c = ctx({ failClosed: true })
    onRequest({ model: "openai/gpt-4o" }, c)
    expect(c.rejected?.status).toBe(403)
  })

  test("says what a copy is called in the answer it gives", () => {
    const c = ctx({ failClosed: true })
    onRequest({ model: "gpt-4o" }, c)
    expect(c.rejected?.message).toContain("ech-nvidia")
  })

  test("leaves a request alone when it fails open", () => {
    const c = ctx({})
    onRequest({ model: "gpt-4o" }, c)
    expect(c.rejected).toBeNull()
  })

  test("leaves a request that names no model alone", () => {
    const c = ctx({ failClosed: true })
    onRequest({}, c)
    expect(c.rejected).toBeNull()
  })
})

describe("onProvider", () => {
  test("writes where the try went", () => {
    const c = ctx({ log: true }, { provider: { id: "ech-nvidia", model: "gpt-4o", account: "key" } })
    const wrote = said(() => onProvider({}, c))
    expect(wrote).toContain("ech-nvidia")
    expect(wrote).toContain("gpt-4o")
    expect(wrote).toContain("ech")
  })

  test("says that a try went straight out when it did", () => {
    const c = ctx({ log: true }, { provider: { id: "openai", model: "gpt-4o" } })
    expect(said(() => onProvider({}, c))).toContain("direct")
  })

  test("says nothing when the log is off", () => {
    const c = ctx({ log: false }, { provider: { id: "ech-nvidia" } })
    expect(said(() => onProvider({}, c))).toBe("")
  })
})

describe("optionsOf", () => {
  test("are the options of the plugin", () => {
    expect(optionsOf(ctx({ port: 9000 })).port).toBe(9000)
  })

  test("are none when there are none", () => {
    expect(optionsOf({})).toEqual({})
    expect(optionsOf(null)).toEqual({})
  })
})
