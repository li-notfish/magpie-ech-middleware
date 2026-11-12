// The sidecar's keeper, as magpie's asynchronous request hook.
//
// The hooks run in Bun, in the plugin host, where a process can be
// started: the Encrypted Client Hello needs Go's crypto/tls, so the
// sidecar is a program of its own. This hook starts it and keeps it up.
//
// The loader of an account writes the upstreams down for the sidecar to
// read, and the first request brings the sidecar up; if it died, this
// hook brings it back. It starts it once: after that it does nothing but
// answer, so the rest go straight through.
//
// The hook's own budget is a second, so the check it makes of the
// sidecar that may already be there is given less than that.
import { ensureSidecar } from "./sidecar.mjs"

export async function onRequest(body, ctx) {
  await ensureSidecar({ ...(ctx?.options ?? {}), healthTimeout: 400 })
}
