// The sidecar's keeper: where the binary is, how it is started, and how
// it is asked whether it is up.
//
// This file runs in Bun, in magpie's plugin host, where a process can be
// started: the Encrypted Client Hello needs Go's crypto/tls, so the
// sidecar is a program of its own.
//
// The sidecar's binaries are in the package itself, in
// sidecar/bin/<platform>-<arch>/, so a machine that runs one of the
// platforms they cover needs no Go at all. The Go source is beside them
// for the platforms that have no binary: the package builds it when it
// is missing and this computer has Go.
//
// The upstreams the sidecar talks to are the ones the user signed in to:
// the plugin writes each into a file of its own, in magpie's folder, and
// the sidecar reads that file (and reads it again when it changes). So
// the published package carries no address of anyone's, and an upstream
// signed in to later is served without the sidecar being started again.
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import http from "node:http"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { portOf } from "./ech.shared.js"

// Where the package sits, and where the sidecar is looked for.
const HERE = dirname(fileURLToPath(import.meta.url))
const SIDECAR_DIR = join(HERE, "sidecar")

// SIDECAR_WAIT is how long the sidecar may take to say which port it
// took. It resolves the upstream's ECH config over DoH first, which is
// what takes the time.
const SIDECAR_WAIT = 30000

// RETRY is how long the keeper waits before it tries to start the
// sidecar again after a failure, so a request every second does not
// spawn one a second.
const RETRY = 30000

// HEALTH_PATH answers the keeper's own check without touching the
// upstream.
const HEALTH_PATH = "/_ech/health"

// NO_UPSTREAMS is what the keeper says when no upstream is signed in to.
const NO_UPSTREAMS = "no upstream is signed in to: there is nothing for the sidecar to talk to"

// FOLDER is the folder of the plugin's own, in magpie's folder, where
// the upstreams are written.
const FOLDER = "magpie-ech-middleware"

// The folder magpie keeps its files in, and the upstreams the sidecar
// is to serve: what the plugin wrote down last.
let configDirectory = ""
let wanted = {}

// upstreamFile is where the upstreams are written: a file of this
// plugin's own, in magpie's folder.
export function upstreamFile(directory = configDirectory) {
  return join(directory, FOLDER, "upstreams.json")
}

// setUpstream writes one upstream down for the sidecar to serve: the
// name an account's address is served under, and the address itself.
//
// What the file says beside it is kept: the other accounts' upstreams,
// and an ECH config given by hand for an upstream that publishes none.
export function setUpstream(directory, id, address) {
  configDirectory = directory
  const file = upstreamFile(directory)
  let was = {}
  try {
    was = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    was = {}
  }
  const had = was && typeof was === "object" ? was[id] : undefined
  const said = had && typeof had === "object" && typeof had.url === "string" ? { ...had, url: address } : address
  const out = { ...(was && typeof was === "object" ? was : {}), [id]: said }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`)
  } catch (error) {
    console.error(`[ech] the upstreams could not be written: ${error?.message ?? error}`)
  }
  wanted = { ...wanted, [id]: said }
  return out
}

// upstreams is what the sidecar is to serve, as it was written down.
export function upstreams() {
  return wanted
}

// sidecarName is the binary's name on a platform. Windows wants the
// extension, the others do not.
export function sidecarName(platform = process.platform) {
  return platform === "win32" ? "ech-sidecar.exe" : "ech-sidecar"
}

// platformDir is the folder the sidecar for a platform is in. The
// prebuilt one that ships with the package is in sidecar/bin/<platform>-
// <arch>, so a machine that runs one of them needs no Go at all.
export function platformDir(platform = process.platform, arch = process.arch) {
  return join(SIDECAR_DIR, "bin", `${platform}-${arch}`)
}

// findSidecar is the binary to run: the one the user set, the prebuilt
// one for this platform, the one built beside the package, or the one on
// the PATH.
export function findSidecar(path = "") {
  const name = sidecarName()
  const candidates = [
    path,
    process.env.ECH_SIDECAR_PATH,
    join(platformDir(), name),
    join(SIDECAR_DIR, "bin", name),
    join(SIDECAR_DIR, name),
  ].filter(Boolean)
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return name
}

// findGo is the Go toolchain: the one in GOROOT, the usual install
// places, or the one on the PATH. The sidecar needs Go 1.26 or newer, the
// first release whose crypto/tls speaks Encrypted Client Hello.
export function findGo() {
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

// buildSidecar builds the sidecar from the Go source that ships with the
// package. It is what makes the package work on a platform that has no
// prebuilt binary, on a computer that has Go.
export function buildSidecar(spawnImpl = spawn, go = findGo()) {
  const out = join(platformDir(), sidecarName())
  return new Promise((resolve, reject) => {
    try {
      mkdirSync(platformDir(), { recursive: true })
    } catch (error) {
      reject(new Error(`the sidecar's folder could not be made: ${error?.message ?? error}`))
      return
    }
    let proc
    try {
      proc = spawnImpl(go, ["build", "-o", out, "."], {
        cwd: SIDECAR_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (error) {
      reject(new Error(`the sidecar could not be built: ${error?.message ?? error}`))
      return
    }
    let err = ""
    proc.stderr?.setEncoding?.("utf8")
    proc.stderr?.on("data", (chunk) => {
      err += chunk
      // The sidecar's own lines are worth seeing: the cover name its
      // ECH config uses, and a request that failed, are the only word on
      // what the connection is like. They go to the host's log.
      process.stderr.write(chunk)
    })
    proc.on("error", (error) => {
      reject(new Error(`the sidecar could not be built: ${error?.message ?? error}`))
    })
    proc.on("exit", (code) => {
      if (code === 0 && existsSync(out)) {
        resolve(out)
        return
      }
      reject(new Error(`the sidecar could not be built (go exited with ${code})${err.trim() ? `: ${err.trim()}` : ""}`))
    })
  })
}

// sidecarArgs are the flags the sidecar is started with: the file it
// reads its upstreams from, the address it listens on, and what the
// user says about going on without an ECH config.
export function sidecarArgs(file, listen = "") {
  if (!file) throw new Error(NO_UPSTREAMS)
  const args = ["-upstreams-file", file]
  if (listen) args.push("-listen", listen)
  if (process.env.ECH_SIDECAR_ALLOW_PLAIN === "1") args.push("-allow-plain")
  return args
}

// startSidecar runs the sidecar and waits for the port it took. The
// sidecar writes one JSON line to its stdout when it is ready.
export function startSidecar(spawnImpl = spawn, path = "", file = "", listen = "") {
  if (!file) return Promise.reject(new Error(NO_UPSTREAMS))
  const binary = findSidecar(path)
  return new Promise((resolve, reject) => {
    let settled = false
    let out = ""
    let err = ""
    const finish = (done, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(value)
    }
    let proc
    try {
      proc = spawnImpl(binary, sidecarArgs(file, listen), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    } catch (error) {
      reject(new Error(`the sidecar could not be started: ${error?.message ?? error}`))
      return
    }
    const timer = setTimeout(() => {
      proc.kill?.()
      finish(reject, new Error(`the sidecar said nothing in ${SIDECAR_WAIT / 1000} seconds`))
    }, SIDECAR_WAIT)
    proc.stdout?.setEncoding?.("utf8")
    proc.stdout?.on("data", (chunk) => {
      out += chunk
      const line = out.split("\n")[0]
      if (!line) return
      let status
      try {
        status = JSON.parse(line)
      } catch {
        return
      }
      finish(resolve, { child: proc, port: status?.port, status })
    })
    proc.stderr?.setEncoding?.("utf8")
    proc.stderr?.on("data", (chunk) => {
      err += chunk
    })
    proc.on("error", (error) => {
      finish(reject, new Error(`the sidecar could not be started: ${error?.message ?? error}`))
    })
    proc.on("exit", (code) => {
      finish(reject, new Error(`the sidecar stopped (code ${code}): ${err.trim() || "it said nothing"}`))
    })
  })
}

// health asks the sidecar whether it is up and what it connects with. It
// goes over the loopback interface on node:http, for the reason Bun's own
// fetch is not used: that one would hand it to the proxy the user set for
// the internet.
export function health(port, timeout = 1500) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      call.destroy()
      finish(null)
    }, timeout)
    const call = http.request(
      { hostname: "127.0.0.1", port, path: HEALTH_PATH, method: "GET" },
      (response) => {
        let body = ""
        response.setEncoding?.("utf8")
        response.on("data", (chunk) => {
          body += chunk
        })
        response.on("end", () => {
          try {
            finish(JSON.parse(body))
          } catch {
            finish(null)
          }
        })
      },
    )
    call.on("error", () => finish(null))
    call.end()
  })
}

// The sidecars this package runs, so that they die with the host that
// started them and are not left behind.
const running = new Set()
process.once("exit", () => {
  for (const child of running) {
    try {
      child?.kill?.()
    } catch {}
  }
})

// The sidecar that is up, and the one being started.
let up = false
let pending = null
let lastTry = 0

// ensureSidecar makes sure the sidecar is up: it starts it when it is
// not, and says whether it is there afterwards. It starts it once, and
// does nothing after that, so the hook's own second is spent only on the
// first request.
export async function ensureSidecar(options = {}) {
  if (up) return true
  if (pending) return pending
  if (Date.now() - lastTry < RETRY) return false
  lastTry = Date.now()
  pending = start(options)
    .then((ok) => {
      up = ok
      return ok
    })
    .catch((error) => {
      console.error(`[ech] ${error?.message ?? error}`)
      return false
    })
    .finally(() => {
      pending = null
    })
  return pending
}

// servesUpstreams is whether the sidecar that is up serves the upstreams
// that are wanted: the same names at the same addresses.
export function servesUpstreams(said, want = wanted) {
  const have = said && typeof said === "object" ? said.upstreams : null
  if (!have || typeof have !== "object") return false
  const names = Object.keys(want)
  if (!names.length) return false
  return names.every((name) => {
    const u = have[name]
    if (!u) return false
    const url = typeof u === "string" ? u : u.url
    const trim = (v) => String(v ?? "").replace(/\/+$/, "")
    return trim(url) === trim(want[name])
  })
}

// start brings the sidecar up: it asks the one that may already be there
// first, and starts one when there is none.
export async function start(options = {}) {
  const o = options && typeof options === "object" ? options : {}
  if (typeof o.directory === "string" && o.directory) configDirectory = o.directory
  const names = Object.keys(wanted)
  if (!names.length) {
    console.error(`[ech] ${NO_UPSTREAMS}`)
    return false
  }
  const file = upstreamFile(configDirectory)
  const port = portOf(o)
  const listen = `127.0.0.1:${port}`

  // The check is given the time the caller has: the gateway hook that
  // starts the sidecar has a second of its own, and the check must not
  // take it.
  const timeout = Number.isInteger(Number(o.healthTimeout)) ? Number(o.healthTimeout) : 1500
  const said = await health(port, timeout)
  if (said && said.ok && servesUpstreams(said)) {
    up = true
    return true
  }

  console.log(`[ech] starting the sidecar on 127.0.0.1:${port} for ${names.join(", ")}`)

  const { child } = await startSidecar(spawn, "", file, listen)
  running.add(child)
  child?.once?.("exit", () => {
    running.delete(child)
    up = false
  })
  up = true
  return true
}
