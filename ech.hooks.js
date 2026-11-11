// The sidecar's keeper, as magpie's asynchronous request hook.
//
// The middleware (ech.middleware.js) runs in the gateway, on moejs, where
// no process can be started: the Encrypted Client Hello needs Go's
// crypto/tls, so the sidecar is a program of its own. The hooks run in
// Bun, in the plugin host, where one can be started, so this file starts
// the sidecar and keeps it up.
//
// The hook's own budget is a second, so it starts the sidecar once and
// does nothing after that: the first request waits for the sidecar to
// listen, the rest go straight through.
import { ensureSidecar } from "./sidecar.mjs"

export async function onRequest(body, ctx) {
  await ensureSidecar(ctx?.options ?? {})
}
