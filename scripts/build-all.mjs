// Builds the Go sidecar for every platform the package ships a binary for.
//
// The package carries these binaries so that a machine that runs one of the
// platforms needs no Go at all: an install is a download and nothing more.
// This script is how they are made. Each one goes into
// sidecar/bin/<platform>-<arch>/, the folder the plugin looks in.
//
// Go names a platform its own way (windows, amd64) and Node names it the
// way the plugin asks for (win32, x64); the table in go.mjs is the bridge.
import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { SIDECAR_DIR, TARGETS, binaryName, goTool, outDir } from "./go.mjs"

const go = goTool()
let failed = false

for (const target of TARGETS) {
  const dir = outDir(target.node)
  const out = join(dir, binaryName(target.goos))
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
