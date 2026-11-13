// Builds the Go sidecar for every platform the release publishes a binary
// for.
//
// The repository carries no binaries: they are the assets of the sidecar
// release, so a machine that runs one of the platforms needs no Go at all —
// an install is a download of the package and of one asset. This script is
// how the assets are made. Each one goes into dist/<platform>-<arch>/,
// named as the plugin asks for it at runtime.
//
// Go names a platform its own way (windows, amd64) and Node names it the
// way the plugin asks for (win32, x64); the table in go.mjs is the bridge.
import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { HERE, SIDECAR_DIR, TARGETS, assetName, goTool } from "./go.mjs"

const go = goTool()
let failed = false

for (const target of TARGETS) {
  const dir = join(HERE, "..", "dist", target.node)
  const out = join(dir, assetName(target.node))
  mkdirSync(dir, { recursive: true })
  process.stdout.write(`${target.node}: building... `)
  const result = spawnSync(go, ["build", "-trimpath", "-buildvcs=false", "-ldflags", "-s -w", "-o", out, "."], {
    cwd: SIDECAR_DIR,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: "0" },
  })
  if (result.error?.code === "ENOENT") {
    console.error("Go was not found")
    console.error(`The sidecar needs Go 1.26 or newer: https://go.dev/dl/`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`go build exited with ${result.status}`)
    failed = true
    continue
  }
  console.log(out)
}

if (failed) process.exit(1)
