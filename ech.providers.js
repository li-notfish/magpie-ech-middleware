// The helpers of the plugin's: the kinds of API an upstream speaks, the
// name an upstream is served under, and the models it lists.
//
// This is a helper of the plugin's, not the plugin's entry: magpie reads
// every function the entry exports as a plugin of its own, so what is
// here is kept out of it.
import { createHash } from "node:crypto"

// NPMS is the AI SDK package each kind of API is spoken on: magpie reads
// the protocol of a model's requests from it, the way it reads the
// protocol of a provider of its own.
const NPMS = {
  chat: "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
  anthropic: "@ai-sdk/anthropic",
  gemini: "@ai-sdk/google",
}

// LIST_WAIT is how long a listing may take. The first one gives the sidecar
// time to resolve the upstream's ECH config over DoH, fall back to the
// built-in config, and retry with plain TLS when the edge rejects that config.
// Magpie gives a provider's model list 20 seconds, so this fetch gives up
// first and the listing keeps the models it had instead of the host reporting
// a plugin that finished late.
const LIST_WAIT = 15000

// KINDS is the kinds of API an upstream may speak, as the sign-in asks
// them: the first is what most of them speak.
export const KINDS = [
  { value: "chat", label: "Chat Completions" },
  { value: "responses", label: "Responses" },
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "gemini", label: "Gemini" },
]

// kindOf is the kind of API the sign-in named: the one it said, else the
// chat one, which is what most of them speak.
export function kindOf(metadata) {
  const kind = metadata && String(metadata.kind ?? "").trim().toLowerCase()
  return NPMS[kind] ? kind : "chat"
}

// addressOf is the address the sign-in names, as the sidecar is to reach
// it: an http(s) address, or "" when none was given.
export function addressOf(metadata) {
  const said = metadata && typeof metadata.baseURL === "string" ? metadata.baseURL.trim() : ""
  let url
  try {
    url = new URL(said)
  } catch {
    return ""
  }
  return url.protocol === "http:" || url.protocol === "https:" ? said.replace(/\/+$/, "") : ""
}

// validateAddress is what the sign-in's address prompt takes: an address
// the sidecar could reach. It says what is missing when none is there.
export function validateAddress(value) {
  const trouble = "An http(s) address, like https://api.example.com/v1"
  const said = String(value ?? "").trim()
  if (!said) return trouble
  let url
  try {
    url = new URL(said)
  } catch {
    return trouble
  }
  return url.protocol === "http:" || url.protocol === "https:" ? undefined : trouble
}

// slugOf is the name an upstream is served under: its host and path,
// kept short, with a few marks of the address beside them, so that two
// addresses never share a name. It is a path segment, and a name.
export function slugOf(address) {
  let url
  try {
    url = new URL(address)
  } catch {
    return ""
  }
  const raw = `${url.host}${url.pathname.replace(/\/+$/, "")}`
  const said = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  const marks = createHash("sha256").update(address).digest("hex").slice(0, 8)
  return `${said || "upstream"}-${marks}`
}

// EFFORTS are the levels of thought a model of the openai kinds is asked
// at, weakest first, as the variants magpie offers (the reasoningEffort
// that @ai-sdk/openai-compatible asks an effort by). A listing of models
// says nothing of the levels a model takes, so the five OpenCode knows
// are offered beside each, and the user picks among them — the ones they
// untick are kept untick across listings, in magpie's settings.
const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

// variantsOf is the levels of thought offered for a kind of API: the
// openai kinds ask an effort by, and the other two think by a budget of
// their own, which a listing of models does not speak of, so they are
// offered none.
function variantsOf(kind) {
  return kind === "chat" || kind === "responses"
    ? Object.fromEntries(EFFORTS.map((e) => [e, { reasoningEffort: e }]))
    : undefined
}

// listedOf asks an upstream for the models it serves, through the
// sidecar, so that the listing is carried the way the requests are. It
// answers them keyed by the id the upstream gave, the way magpie keys
// its own: magpie keeps a list per account, so the ids of two upstreams
// never meet, and a model is named ech/<the id, and nothing more>. It
// answers null when the upstream said nothing.
export async function listedOf(kind, address, key, port, wait = LIST_WAIT) {
  const slug = slugOf(address)
  if (!slug) return null
  const base = `http://127.0.0.1:${port}/${slug}`
  // An address with no path of its own has the version the kind wants
  // put under the sidecar's base, so that a request can be made under
  // it; the other kind keeps the base the loader gives.
  const under = hasPath(address) ? "" : kind === "gemini" ? "/v1beta" : "/v1"
  const waitMs = Number.isFinite(wait) && wait > 0 ? wait : LIST_WAIT
  const said =
    kind === "gemini"
      ? geminiOf(await getOf(`${base}${under}/models?key=${encodeURIComponent(key)}`, {}, waitMs))
      : openaiOf(
          await getOf(`${base}${under}/models`, kind === "anthropic" ? anthropicHeaders(key) : bearerHeaders(key), waitMs),
        )
  if (!said) return null
  const variants = variantsOf(kind)
  const out = {}
  for (const m of said) {
    const underBase = under ? `${base}${under}` : undefined
    out[m.id] = {
      name: m.name,
      api: { id: m.id, ...(underBase ? { url: underBase } : {}), npm: NPMS[kind] },
      capabilities: { reasoning: true },
      ...(variants ? { variants } : {}),
    }
  }
  return out
}

// hasPath is whether the address the sign-in named carries a path of its
// own (a /v1, a /v1beta), under which its models sit.
function hasPath(address) {
  try {
    return new URL(address).pathname.replace(/\/+$/, "").length > 0
  } catch {
    return false
  }
}

// bearerHeaders are the headers a chat or Responses API wants.
function bearerHeaders(key) {
  return { authorization: `Bearer ${key}` }
}

// anthropicHeaders are the headers Anthropic's own API wants.
function anthropicHeaders(key) {
  return { ...bearerHeaders(key), "x-api-key": key, "anthropic-version": "2023-06-01" }
}

// getOf asks one address and answers its JSON, or null when it said
// nothing of the kind. It waits a while, no longer.
async function getOf(url, headers = {}, wait = LIST_WAIT) {
  let said
  try {
    said = await fetch(url, { headers, signal: AbortSignal.timeout(wait) })
  } catch {
    return null
  }
  if (!said.ok) return null
  try {
    return await said.json()
  } catch {
    return null
  }
}

// openaiOf is the models of an OpenAI-shaped answer: chat completions,
// Responses, and Anthropic's own list, which is shaped the same way.
function openaiOf(said) {
  const list = Array.isArray(said?.data) ? said.data : []
  const out = []
  for (const m of list) {
    const id = typeof m?.id === "string" ? m.id.trim() : ""
    if (!id) continue
    const name = typeof m?.name === "string" && m.name.trim()
      ? m.name.trim()
      : typeof m?.display_name === "string" && m.display_name.trim()
        ? m.display_name.trim()
        : id
    out.push({ id, name })
  }
  return out.length ? out : null
}

// geminiOf is the models of a Gemini answer: the "models/" before each
// name is not part of the id the API wants.
function geminiOf(said) {
  const list = Array.isArray(said?.models) ? said.models : []
  const out = []
  for (const m of list) {
    const id = typeof m?.name === "string" ? m.name.trim().replace(/^models\//, "") : ""
    if (!id) continue
    const name = typeof m?.displayName === "string" && m.displayName.trim() ? m.displayName.trim() : id
    out.push({ id, name })
  }
  return out.length ? out : null
}
