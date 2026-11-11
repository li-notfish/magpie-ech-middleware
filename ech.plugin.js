// The provider side of this package: an ECH copy of every provider the
// user wrote, so that their traffic goes out with an Encrypted Client
// Hello.
//
// The plugin runs in Bun, in magpie's plugin host. It reads the
// providers the user wrote (providers.json) and, for each one that has
// an address, declares an ECH copy of it:
//
//   ech-nvidia        the ECH copy of the provider "nvidia"
//
// The copy's api is the address the user's own provider has, so magpie
// keeps treating the vendor as that vendor (the thinking parts of
// Mistral, the reasoning replay of DeepSeek, and the rest). Its loader
// sends the requests to the sidecar, which makes the connection with an
// Encrypted Client Hello and forwards it to that address.
//
// The copy is signed in with the key the user's own provider has, so
// nothing is asked of the user: the key is read from providers.json,
// and magpie sends it as it sends any other provider's.
//
// magpie gives a plugin one sign-in per function it exports, and the
// number of providers the user wrote is only known when the plugin is
// loaded. So this file exports one function per provider it can copy.
//
// It exports nothing else: magpie reads every function a plugin's entry
// exports as a plugin of its own, and a helper of ours would be asked
// to be one.
import { ensureSidecar, setUpstreams } from "./sidecar.mjs"
import { hooksFor, providersOf } from "./ech.providers.js"
import { mirrorId, portOf } from "./ech.shared.js"

// SLOTS is how many ECH copies this plugin can declare. More than a
// dozen providers with an address of their own is rare; the ones past
// this are left alone, and the plugin says so.
const SLOTS = 16

// slot is the plugin function of one ECH copy: the copy of the
// provider the user wrote in that place. A slot with no provider of its
// own says nothing, and magpie keeps the others.
function slot(index) {
  return async (input, options) => {
    const directory = typeof input?.directory === "string" ? input.directory : ""
    const providers = providersOf(directory)
    const provider = providers[index - 1]
    if (!provider) return {}
    if (providers.length > SLOTS) {
      console.error(`[ech] only the first ${SLOTS} providers with an address are copied; the rest are left alone`)
    }

    const port = portOf(options)
    const id = mirrorId(provider.id)

    // The sidecar serves every provider the user wrote, not only this
    // one: it is told of them all before it is started.
    setUpstreams(directory, providers)
    ensureSidecar({ directory, port }).catch(() => {})

    // The copy is signed in with the key the user's own provider has,
    // so the user is asked for nothing.
    try {
      await input?.client?.auth?.set({
        path: { id },
        body: { type: "api", key: provider.key },
      })
    } catch (error) {
      console.error(`[ech] ${id} could not be signed in: ${error?.message ?? error}`)
    }

    return hooksFor(provider, port)
  }
}

// One export per provider this plugin can copy. magpie reads a plugin's
// sign-ins from the functions it exports, one each.
export const echCopy01 = slot(1)
export const echCopy02 = slot(2)
export const echCopy03 = slot(3)
export const echCopy04 = slot(4)
export const echCopy05 = slot(5)
export const echCopy06 = slot(6)
export const echCopy07 = slot(7)
export const echCopy08 = slot(8)
export const echCopy09 = slot(9)
export const echCopy10 = slot(10)
export const echCopy11 = slot(11)
export const echCopy12 = slot(12)
export const echCopy13 = slot(13)
export const echCopy14 = slot(14)
export const echCopy15 = slot(15)
export const echCopy16 = slot(16)
