// The sidecar's keeper, as magpie's asynchronous request hook.
//
// The middleware (ech.middleware.js) runs in the gateway, on moejs, where
// no process can be started: the Encrypted Client Hello needs Go's
// crypto/tls, so the sidecar is a program of its own. The hooks run in
// Bun, in the plugin host, where one can be started, so this file starts
// the sidecar and keeps it up.
//
// The plugin (ech.plugin.js) starts it too, when it is loaded, so the
// sidecar is usually up before the first request. This hook is what
// brings it back when it died, and it starts it once: after that it
// does nothing but answer, so the rest go straight through.
//
// The hook's own budget is a second, so the check it makes of the
// sidecar that may already be there is given less than that.
import { ensureSidecar } from "./sidecar.mjs"

export async function onRequest(body, ctx) {
  await ensureSidecar({ ...(ctx?.options ?? {}), healthTimeout: 400 })
}
