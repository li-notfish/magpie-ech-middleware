// The providers the user wrote, and the ECH copy each of them gets.
//
// This is a helper of the plugin's, not the plugin's entry: magpie reads
// every function the entry exports as a plugin of its own, so what is
// here is kept out of it.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_PORT, mirrorId } from "./ech.shared.js"

// NPMS is the AI SDK package each kind of API is spoken on: magpie reads
// the protocol of a model's requests from it, the way it reads the
// protocol of a provider of its own.
const NPMS = {
  chat: "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
  anthropic: "@ai-sdk/anthropic",
  gemini: "@ai-sdk/google",
}

// providersOf are the providers the user wrote, as providers.json keeps
// them: an id, a name, the address of each API, a key and the models it
// serves. A provider without an address is one of another plugin's
// (its address is that plugin's own business), so it is left alone.
export function providersOf(directory) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(join(directory, "providers.json"), "utf8"))
  } catch {
    return []
  }
  const list = Array.isArray(parsed?.providers) ? parsed.providers : []
  const out = []
  for (const p of list) {
    if (!p || typeof p.id !== "string" || !p.id.trim()) continue
    const api = apiOf(p)
    if (!api) continue
    out.push({
      id: p.id.trim(),
      name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : p.id.trim(),
      api,
      declared: declaredOf(p, api),
      key: typeof p.key === "string" ? p.key : "",
      npm: npmOf(p),
      models: modelsOf(p),
    })
  }
  return out
}

// apiOf is the address of the API the user's provider is written with:
// the one of the kind they picked, or the first that is there.
function apiOf(p) {
  const pick = (v) => (typeof v === "string" ? v.trim() : "")
  const kind = kindOf(p)
  if (kind === "responses") return pick(p.responses)
  if (kind === "anthropic") return pick(p.anthropic)
  if (kind === "gemini") return pick(p.gemini)
  return pick(p.chat) || pick(p.responses) || pick(p.anthropic) || pick(p.gemini)
}

// kindOf is the kind of API the user's provider is written with: the one
// they picked, else the chat one, which is what most of them speak.
function kindOf(p) {
  const kind = String(p.baseAPI ?? "").trim().toLowerCase()
  return NPMS[kind] ? kind : "chat"
}

// declaredOf is the address the copy declares: the user's own address, as
// magpie reads it.
//
// The Anthropic API is the one kind where the address is not said as it
// is. magpie puts a "/v1" under the base of a model of that kind whose own
// address ends in "/v1", so that the base the loader says (the sidecar's)
// is a base a request can be made under. The sidecar puts the path of a
// request under the address the upstream has, so the "/v1" has to be in
// one of the two, not in both.
function declaredOf(p, api) {
  if (kindOf(p) !== "anthropic") return api
  return api.replace(/\/v1$/, "")
}

// npmOf is the AI SDK package the provider's API is spoken on.
function npmOf(p) {
  return NPMS[kindOf(p)]
}

// modelsOf are the models the provider serves, as providers.json keeps
// them: a list of ids.
function modelsOf(p) {
  const m = p.models
  if (Array.isArray(m)) return m.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())
  if (m && typeof m === "object") return Object.keys(m).filter((x) => x.trim())
  return []
}

// modelsFor is what the config hook declares the copy's models as: magpie
// reads a plugin provider's models from there, and asks no vendor for
// them.
function modelsFor(models) {
  const out = {}
  for (const id of models) out[id] = { name: id }
  return out
}

// hooksFor are the hooks the copy of the provider has: the config that
// declares the copy, so that magpie knows the models it serves, and the
// sign-in that serves it, whose loader sends the requests to the
// sidecar.
export function hooksFor(provider, port = DEFAULT_PORT) {
  const id = mirrorId(provider.id)
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[id] ??= {
        name: `${provider.name} (ECH)`,
        npm: provider.npm,
        api: provider.declared,
        models: modelsFor(provider.models),
      }
    },
    auth: {
      provider: id,
      methods: [{ type: "api", label: `${provider.name} (ECH) API key` }],
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api") return {}
        return {
          baseURL: `http://127.0.0.1:${port}/${encodeURIComponent(provider.id)}`,
          apiKey: auth.key,
        }
      },
    },
  }
}
