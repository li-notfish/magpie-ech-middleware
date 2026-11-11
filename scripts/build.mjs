// Builds the Go sidecar the plugin runs, for this computer.
//
// The package ships a prebuilt binary for the platforms it covers, in
// sidecar/bin/<platform>-<arch>/. This script builds the one for this
// computer into that same folder, so a machine whose platform has no
// prebuilt binary ends up with one.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { SIDECAR_DIR, binaryName, goTool, outDir } from "./go.mjs"

const nodeName = `${process.platform}-${process.arch}`
const dir = outDir(nodeName)
const out = join(dir, binaryName())

if (existsSync(out)) {
  console.log(`the sidecar is already built: ${out}`)
  process.exit(0)
}

const go = goTool()
mkdirSync(dir, { recursive: true })
const result = spawnSync(go, ["build", "-trimpath", "-buildvcs=false", "-ldflags", "-s -w", "-o", out, "."], {
  cwd: SIDECAR_DIR,
  stdio: "inherit",
  env: { ...process.env, CGO_ENABLED: "0" },
})
if (result.error?.code === "ENOENT") {
  console.error(`Go was not found (${go}). The sidecar needs Go 1.26 or newer: https://go.dev/dl/`)
  process.exit(1)
}
if (result.status !== 0) {
  console.error(`go build exited with ${result.status}`)
  process.exit(result.status ?? 1)
}
console.log(`built the sidecar: ${out}`)
