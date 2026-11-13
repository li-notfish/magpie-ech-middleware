// The Go toolchain and the names the sidecar's binaries are filed under,
// shared by the build scripts.
import { existsSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const HERE = dirname(fileURLToPath(import.meta.url))
export const SIDECAR_DIR = join(HERE, "..", "sidecar")

// TARGETS are the platforms the package ships a binary for. The names are
// Node's (the platform and the architecture the plugin asks for); the Go
// ones are what the Go toolchain is told.
export const TARGETS = [
  { node: "win32-x64", goos: "windows", goarch: "amd64" },
  { node: "win32-arm64", goos: "windows", goarch: "arm64" },
  { node: "linux-x64", goos: "linux", goarch: "amd64" },
  { node: "linux-arm64", goos: "linux", goarch: "arm64" },
  { node: "darwin-x64", goos: "darwin", goarch: "amd64" },
  { node: "darwin-arm64", goos: "darwin", goarch: "arm64" },
]

// goTool is the Go toolchain: GOROOT, the usual install places, or PATH.
export function goTool() {
  const name = process.platform === "win32" ? "go.exe" : "go"
  const dirs = (process.env.PATH ?? "").split(delimiter)
  const candidates = [
    process.env.GOROOT ? join(process.env.GOROOT, "bin", name) : null,
    process.platform === "win32" ? join("C:\\Program Files", "Go", "bin", name) : null,
    process.platform === "darwin" ? "/usr/local/go/bin/go" : "/usr/lib/go/bin/go",
    ...dirs.map((dir) => (dir ? join(dir, name) : null)),
  ].filter(Boolean)
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return name
}

// binaryName is the sidecar's name on a platform: Windows wants the
// extension, the others do not.
export function binaryName(goos = process.platform === "win32" ? "windows" : process.platform) {
  return goos === "windows" ? "ech-sidecar.exe" : "ech-sidecar"
}

// assetName is the sidecar's name as an asset of the release, for a
// platform named the Node way (win32-x64): the runtime asks for the asset
// by this name.
export function assetName(nodeName) {
  return `ech-sidecar-${nodeName}${nodeName.startsWith("win32") ? ".exe" : ""}`
}

// outDir is the folder the binary for a platform is in. It is the folder
// the plugin looks in, so a binary built here is the one that is run.
export function outDir(nodeName) {
  return join(SIDECAR_DIR, "bin", nodeName)
}
