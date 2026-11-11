// The gateway middleware that keeps the traffic of the ECH copies where
// it should be.
//
// A gateway middleware runs in magpie's gateway, on moejs, a JavaScript
// engine written in Go. It sees an agent's request, the model the agent
// asked for, and the provider every try goes to; it never sees the
// upstream's address.
//
// The copies themselves are made by the plugin (ech.plugin.js): every
// provider the user wrote has one, named after it ("ech-nvidia" for the
// provider "nvidia"), and the traffic of a copy goes out through the
// sidecar, which makes the connection with an Encrypted Client Hello.
// What is left for the middleware is to keep that traffic there:
//
//   1. It fails closed. With "failClosed" on, a request that does not
//      name a copy is turned away instead of being sent.
//   2. It writes a line. Every try is logged, so magpie's log says where
//      the request went.
//
// The options are the plugin's own, in plugins.json:
//
//   {
//     "port": 8790,          // the sidecar's port
//     "failClosed": false,   // turn away a request that names no copy
//     "log": true            // write a line per try
//   }
//
// A model names the copy it is served by: "ech-nvidia/gpt-4o" is served
// by the copy of "nvidia", and the model itself is the one the user's
// own provider serves.
//
// There is nothing else here on purpose. A hook that passes an account
// over is only asked of a subscription account (a try on a key asks no
// hook), and the copies are made of keys, so it would say nothing about
// them. The reply is not touched either: the model is not rewritten
// here, so there is no name to put back.
import { isMirror, providerOf } from "./ech.shared.js"

// onRequest turns a request away when it fails closed: a request that
// names no copy would go out in the clear, and this middleware is the
// one that says it may not.
export function onRequest(body, ctx) {
  const o = optionsOf(ctx)
  if (!o.failClosed) return
  if (!body || typeof body !== "object") return
  const asked = askedOf(body, ctx)
  if (!asked) return
  const provider = providerOf(asked)
  if (isMirror(provider)) return
  ctx.reject(
    403,
    `this middleware fails closed: ${asked || "the request"} does not name an ECH copy of a provider ` +
      "(the copy of a provider is named after it: nvidia becomes ech-nvidia)",
  )
}

// askedOf is the model the request names: the one in the body, else the
// one the gateway resolved (they are the same one). A request that names
// none is magpie's to answer, not this middleware's.
function askedOf(body, ctx) {
  if (typeof body.model === "string" && body.model) return body.model
  if (ctx && typeof ctx.model === "string" && ctx.model) return ctx.model
  return ""
}

// onProvider writes the line that says where a try went: the provider
// it went to, and whether that was a copy (and so the sidecar).
export function onProvider(body, ctx) {
  const o = optionsOf(ctx)
  if (o.log === false) return
  const p = (ctx && ctx.provider) || {}
  const id = typeof p.id === "string" ? p.id : "?"
  const model = typeof p.model === "string" ? p.model : ""
  const account = typeof p.account === "string" ? p.account : ""
  const via = isMirror(id) ? "ech" : "direct"
  console.log("[ech] " + (model || "?") + " -> " + id + (account ? " (" + account + ")" : "") + " [" + via + "]")
}

// optionsOf are the plugin's options, as the user set them.
export function optionsOf(ctx) {
  const o = ctx && ctx.options
  return o && typeof o === "object" ? o : {}
}
