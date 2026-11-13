// The provider side of this package: one provider of the user's own,
// signed in to with the address of an upstream and its key, whose
// traffic goes out with an Encrypted Client Hello.
//
// The plugin runs in Bun, in magpie's plugin host. It declares one
// provider, "ech". Signing in to it asks for the address of the
// upstream and its API key, the way the user's own providers are
// written. Every sign-in is one upstream, and one upstream may be
// signed in to more than once (two keys of the same vendor, say): the
// provider can be signed in to as many times as the user likes.
//
// The provider's loader sends the requests to the sidecar, which makes
// the connection with an Encrypted Client Hello and forwards them to the
// address the sign-in named. Its models are the ones the upstream lists,
// asked through the sidecar as well.
//
// It exports nothing else: magpie reads every function a plugin's entry
// exports as a plugin of its own, and a helper of ours would be asked to
// be one.
import { ensureSidecar, setUpstream } from "./sidecar.mjs"
import { KINDS, addressOf, kindOf, listedOf, slugOf, validateAddress } from "./ech.providers.js"
import { dohOf, echFallbackOf, portOf } from "./ech.shared.js"

// PROVIDER is the provider this package serves. Its models come from the
// upstream each account is signed in to, so none are declared here.
const PROVIDER = "ech"

// MODELS_WAIT is what magpie gives a provider's model list. The plugin
// answers within it even when the sidecar's binary is still being downloaded
// or the first ECH lookup is slow: the listing keeps the models it had
// instead of the host reporting that the plugin finished late.
const MODELS_WAIT = 18000

// START_WAIT is how much of that budget bringing the sidecar up may take. A
// download that takes longer goes on in the background; the next listing
// finds it done.
const START_WAIT = 6000

// within answers the value when the promise has not settled in time. The
// promise goes on, so a sidecar that is still starting is kept.
function within(promise, ms, value) {
  let timer
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(value), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

export const ech = async (input, options) => {
  const directory = typeof input?.directory === "string" ? input.directory : ""
  const port = portOf(options)
  const fallback = echFallbackOf(options)
  const doh = dohOf(options)

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "ECH",
        npm: "@ai-sdk/openai-compatible",
        api: `http://127.0.0.1:${port}`,
        models: {},
      }
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "API key",
          prompts: [
            {
              type: "text",
              key: "baseURL",
              message: "Base URL",
              placeholder: "https://api.example.com/v1",
              validate: validateAddress,
            },
            { type: "select", key: "kind", message: "API", options: KINDS },
            { type: "password", key: "key", message: "API key", placeholder: "sk-…" },
          ],
          // magpie keeps the answers of the select prompts only, and an
          // api method with an authorize of its own is asked no key: the
          // authorize signs in with what was answered, and the metadata
          // it gives back is the one kept — the address among it.
          async authorize(inputs) {
            const address = addressOf(inputs)
            if (!address) return { type: "failed", error: "an http(s) address of the upstream, like https://api.example.com/v1" }
            const key = typeof inputs.key === "string" ? inputs.key.trim() : ""
            if (!key) return { type: "failed", error: "an API key of the upstream" }
            return { type: "success", key, metadata: { baseURL: address, kind: kindOf(inputs) } }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api") return {}
        const address = addressOf(auth.metadata)
        if (!address) {
          console.error("[ech] the sign-in names no address; sign in again with one")
          return {}
        }

        // The sidecar serves every upstream any account is signed in to:
        // this one is written down for it to read.
        const slug = slugOf(address)
        setUpstream(directory, slug, address)
        return { baseURL: `http://127.0.0.1:${port}/${slug}`, apiKey: auth.key }
      },
    },

    provider: {
      id: PROVIDER,
      async models(given, { auth }) {
        // magpie hands the provider as it has it now, the models it
        // already knows among its fields: what comes back is the models
        // themselves, so a fallback hands those back, not the provider,
        // or its own fields would be read in as models of theirs.
        const known = given?.models ?? {}
        if (auth?.type !== "api") return known
        const address = addressOf(auth.metadata)
        if (!address) return known

        // The listing is what brings the sidecar up, and a loader runs
        // for a request, not for a listing: the upstream is written down
        // here, the way the loader writes it for its requests.
        const began = Date.now()
        setUpstream(directory, slugOf(address), address)
        const up = await within(ensureSidecar({ directory, port, echFallback: fallback, doh }), START_WAIT, false)
        if (!up) {
          console.error("[ech] the sidecar is not up yet, so the models stay as they were")
          return known
        }
        const left = MODELS_WAIT - (Date.now() - began)
        if (left < 1000) {
          console.error("[ech] the sidecar took too long to come up, so the models stay as they were")
          return known
        }
        const said = await listedOf(
          kindOf(auth.metadata),
          address,
          typeof auth.key === "string" ? auth.key : "",
          port,
          left,
        )
        if (!said) {
          console.error(`[ech] the models of ${address} could not be listed; the ones known stay`)
          return known
        }
        return said
      },
    },
  }
}
