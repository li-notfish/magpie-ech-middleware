// The gateway middleware that sends the traffic of the models the user
// names through an Encrypted Client Hello.
//
// A gateway middleware runs in magpie's gateway, on moejs, a JavaScript
// engine written in Go. It sees an agent's request, the model the agent
// asked for, and the provider every try goes to; it never sees the
// upstream's address. ctx.provider carries an id, a name, an account's
// kind and a model, and a request that is routed cannot be sent
// elsewhere: the doc says so, and the gateway's own code says so (the
// provider a middleware is told of, gwmw.To, has no URL).
//
// So the Encrypted Client Hello is the sidecar's work, and this
// middleware is what the gateway layer can do about it:
//
//   1. It routes. The model an agent asks for is rewritten to a model of
//      the provider that points at the sidecar, so the request goes out
//      through the sidecar, which makes the TLS connection with an
//      Encrypted Client Hello.
//   2. It stops the fallback. With "strict" on, an account that is not
//      the sidecar's provider is passed over, so a request the sidecar
//      cannot serve does not quietly go out in the clear.
//   3. It fails closed. With "failClosed" on, a request that is not
//      routed to the sidecar is turned away instead of being sent.
//   4. It puts the name back. The reply names the model the agent asked
//      for again, as the agent wrote it (Claude Code reads the name to
//      know its context window).
//   5. It writes a line. Every try is logged, so magpie's log says what
//      went out and where it went.
//
// The options are the plugin's own, in plugins.json:
//
//   magpie plugin options <name> '{"api":"https://api.example.com","provider":"ech"}'
//
//   {
//     "api": "https://api.example.com",  // the upstream the sidecar talks to
//     "port": 8790,                        // the sidecar's port
//     "provider": "ech",                   // the provider that points at the sidecar
//     "models": {"fast": "gpt-4o-mini"},   // the models to route, and what they become
//     "all": false,                        // route every model there
//     "strict": false,                     // pass over the accounts that are not the sidecar's
//     "failClosed": false,                 // turn away a request that is not routed
//     "restoreName": true,                 // put the asked model's name back in the reply
//     "log": true,                         // write a line per try
//     "off": false
//   }
//
// A model name is written as it is, or as /a pattern/ whose value can use
// $1. The name is matched without the provider that serves it, so "gpt-4o"
// and "openai/gpt-4o" are the same model. A name that maps to itself, or
// to nothing, is not routed.
//
// The middleware imports nothing: moejs runs it as it is, and a package
// has to carry its dependencies inside itself.

// DEFAULT_PORT is the port the sidecar listens on when the options do not
// say: the provider that points at the sidecar is written by hand, and a
// port every machine uses is easier to write than one that changes.
const DEFAULT_PORT = 8790

// onRequest routes the request: the model an agent asks for becomes a
// model of the sidecar's provider, so the gateway sends it there.
export function onRequest(body, ctx) {
  const o = optionsOf(ctx)
  if (o.off) return
  if (!body || typeof body !== "object") return
  const asked = typeof body.model === "string" ? body.model : ""
  if (!asked) return
  const to = routedModel(asked, o)
  const provider = providerOf(o)
  if (!to) {
    // A model the sidecar's provider does not serve is not routed, and
    // with "failClosed" on it is turned away rather than sent in the
    // clear. A model that already names the sidecar's provider is on the
    // sidecar's way and is left alone.
    if (o.failClosed && provider && !asked.startsWith(provider + "/")) {
      ctx.reject(403, "the ECH sidecar does not serve " + asked + ", and this middleware fails closed")
    }
    return
  }
  if (to === asked) return
  ctx.state.asked = asked
  body.model = to
  return body
}

// onAccount passes an account over that is not the sidecar's provider:
// with "strict" on, a request the sidecar cannot serve is not to go out
// to a subscription account in the clear.
//
// Only a subscription account is asked: a try on a key asks no hook, so a
// provider of keys is not kept from taking a request.
export function onAccount(account, ctx) {
  const o = optionsOf(ctx)
  if (o.off || !o.strict) return
  const provider = providerOf(o)
  if (!provider) return
  const id = account && typeof account.provider === "string" ? account.provider : ""
  if (id === provider) return
  return { skip: true }
}

// onProvider writes the line that says where a try went: the provider it
// went to, and whether that was the sidecar.
export function onProvider(body, ctx) {
  const o = optionsOf(ctx)
  if (o.off || o.log === false) return
  const p = (ctx && ctx.provider) || {}
  const asked = (ctx.state && ctx.state.asked) || ""
  const provider = providerOf(o)
  const id = typeof p.id === "string" ? p.id : "?"
  const model = typeof p.model === "string" ? p.model : ""
  const account = typeof p.account === "string" ? p.account : ""
  const via = provider && id === provider ? "ech" : "direct"
  const what = asked || model || "?"
  console.log("[ech] " + what + " -> " + id + (account ? " (" + account + ")" : "") + " [" + via + "]")
}

// onEvent puts the asked model's name back in a streamed reply.
export function onEvent(ev, ctx) {
  const o = optionsOf(ctx)
  if (o.off || o.restoreName === false) return
  const asked = ctx.state && ctx.state.asked
  if (!asked) return
  return restore(ev, asked)
}

// onResponse puts the asked model's name back in a whole reply.
export function onResponse(body, ctx) {
  const o = optionsOf(ctx)
  if (o.off || o.restoreName === false) return
  const asked = ctx.state && ctx.state.asked
  if (!asked) return
  if (ctx.status >= 400) return
  return restore(body, asked)
}

// optionsOf are the plugin's options, as the user set them.
export function optionsOf(ctx) {
  const o = ctx && ctx.options
  return o && typeof o === "object" ? o : {}
}

// providerOf is the id of the provider that points at the sidecar: the
// one the requests are routed to.
export function providerOf(o) {
  const id = o && typeof o.provider === "string" ? o.provider.trim() : ""
  return id
}

// portOf is the port the sidecar listens on.
export function portOf(o) {
  const port = o && Number(o.port)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT
}

// bare is a model's id without the provider that serves it: "ech/gpt-4o"
// and "gpt-4o" are the same model, and only the last part is matched
// against the rules.
export function bare(model) {
  if (typeof model !== "string") return ""
  const i = model.lastIndexOf("/")
  return i < 0 ? model : model.slice(i + 1)
}

// routedModel is the model the request should be sent as, in the
// provider that points at the sidecar: "" when this request is not one to
// route.
export function routedModel(asked, o) {
  const provider = providerOf(o)
  if (!provider) return ""
  const name = bare(asked)
  if (!name) return ""
  const to = map(name, rules(o))
  if (to === name && !o.all) return ""
  return provider + "/" + to
}

// rules are the options' mappings, compiled: exact names, and patterns.
export function rules(o) {
  if (!o || typeof o !== "object") return { exact: {}, patterns: [] }
  const m = o.models && typeof o.models === "object" ? o.models : {}
  const exact = {}
  const patterns = []
  for (const k of Object.keys(m)) {
    const v = m[k]
    if (typeof v !== "string" || !v) continue
    const re = /^\/(.+)\/([a-z]*)$/.exec(k)
    if (re) patterns.push([new RegExp(re[1], re[2].replace("g", "")), v])
    else exact[k] = v
  }
  return { exact, patterns }
}

// map is a model's new name: the name itself when nothing maps it, and
// the name it maps to otherwise. A name that maps on (a -> b -> c) maps
// as far as it goes; a cycle stops where it would repeat.
export function map(name, r) {
  const seen = [name]
  let cur = name
  for (let i = 0; i < 16; i++) {
    let next = Object.prototype.hasOwnProperty.call(r.exact, cur) ? r.exact[cur] : undefined
    if (next === undefined) {
      for (const [re, to] of r.patterns) {
        if (re.test(cur)) {
          next = cur.replace(re, to)
          break
        }
      }
    }
    if (next === undefined || next === cur || seen.includes(next)) return cur
    seen.push(next)
    cur = next
  }
  return cur
}

// restore puts the asked model's name back in a reply, wherever the
// protocol names the model: in the event itself, in the message it
// starts, in the response it carries, or in a Gemini chunk's model
// version. It returns the reply when it changed something, and nothing
// when it did not.
function restore(ev, asked) {
  if (!ev || typeof ev !== "object") return
  let changed = false
  if (typeof ev.model === "string" && ev.model !== asked) {
    ev.model = asked
    changed = true
  }
  if (ev.message && typeof ev.message === "object" && typeof ev.message.model === "string" && ev.message.model !== asked) {
    ev.message.model = asked
    changed = true
  }
  if (ev.response && typeof ev.response === "object" && typeof ev.response.model === "string" && ev.response.model !== asked) {
    ev.response.model = asked
    changed = true
  }
  if (typeof ev.modelVersion === "string" && ev.modelVersion !== asked) {
    ev.modelVersion = asked
    changed = true
  }
  return changed ? ev : undefined
}
