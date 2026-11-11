// The names this package and magpie agree on.
//
// The plugin (ech.plugin.js) runs in Bun, in magpie's plugin host; the
// middleware (ech.middleware.js) runs in the gateway, on moejs. They are
// two processes, so what they both use is written here and imported by
// both: the middleware's import is bundled into it when magpie compiles
// it, so this stays a file of constants and nothing else.

// MIRROR_PREFIX is what the ECH copy of a provider is called: the copy
// of the provider "nvidia" is "ech-nvidia".
export const MIRROR_PREFIX = "ech-"

// DEFAULT_PORT is the port the sidecar listens on.
export const DEFAULT_PORT = 8790

// portOf is the port the sidecar listens on, as the user set it: the one
// in the options, else the default. A port that is no port is no port.
export function portOf(options) {
  const port = options && Number(options.port)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT
}

// mirrorId is the id of the ECH copy of the provider id.
export function mirrorId(id) {
  return MIRROR_PREFIX + String(id ?? "").trim()
}

// isMirror is whether the id is one of the ECH copies.
export function isMirror(id) {
  return typeof id === "string" && id.startsWith(MIRROR_PREFIX)
}

// providerOf is the provider a model names: "ech-nvidia/gpt-4o" names
// "ech-nvidia", a bare "gpt-4o" names none. magpie reads a model the
// same way: the provider is what is before the first slash.
export function providerOf(model) {
  if (typeof model !== "string") return ""
  const at = model.indexOf("/")
  return at < 0 ? "" : model.slice(0, at)
}
