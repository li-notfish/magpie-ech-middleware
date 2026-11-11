// The sidecar's keeper: where the binary is, how it is started, and how
// it is asked whether it is up.
//
// This file runs in Bun, in magpie's plugin host, where a process can be
// started. The middleware (ech.middleware.js) runs in the gateway, on
// moejs, where none can be: the Encrypted Client Hello needs Go's
// crypto/tls, so the sidecar is a program of its own.
//
// The sidecar's binaries are in the package itself, in
// sidecar/bin/<platform>-<arch>/, so a machine that runs one of the
// platforms they cover needs no Go at all. The Go source is beside them
// for the platforms that have no binary: the package builds it when it
// is missing and this computer has Go.
//
// The upstream the sidecar talks to is the one the user names: the
// plugin's own options, ECH_API, or a local file beside the package.
// None of them names one by default, so the published package carries
// no address of anyone's.
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import http from "node:http"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

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

// DEFAULT_PORT is the port the sidecar listens on when the options do not
// say: the provider that points at the sidecar is written by hand, and a
// port every machine uses is easier to write than one that changes.
const DEFAULT_PORT = 8790

// HEALTH_PATH answers the keeper's own check without touching the
// upstream.
const HEALTH_PATH = "/_ech/health"

// LOCAL_FILE is a file beside the package that names the API to talk to
// when nothing else does. It is not in the package: it is one machine's
// setting, and it keeps the published package free of anyone's address.
const LOCAL_FILE = join(HERE, "ech.local.json")

// NO_API is what the keeper says when nothing names the API to talk to.
const NO_API =
  "no API is named: set the plugin's api option, or ECH_API, or a file beside the plugin (see the README)"

// localAPI is the API the local file names, or nothing when there is no
// file, no readable file, or no address in it.
export function localAPI(file = LOCAL_FILE) {
  if (!file) return ""
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    const api = typeof parsed === "string" ? parsed : parsed?.api
    return typeof api === "string" ? api.trim() : ""
  } catch {
    return ""
  }
}

// resolveAPI is the API the sidecar talks to: the options' when they say
// so, the environment's, the local file's, nothing otherwise.
//
// It is the API's base URL. The path it carries is where the API is at,
// and the sidecar serves that same path, so the requests that go out are
// the requests the API would have answered without ECH.
export function resolveAPI(given = "", local = "") {
  const raw = process.env.ECH_API || given || local
  if (!raw) return { api: "", origin: "", path: "" }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`the API address is not a URL: ${raw}`)
  }
  const path = url.pathname.replace(/\/+$/, "")
  return { api: `${url.origin}${path}`, origin: url.origin, path }
}

// baseURL is the address the provider that points at the sidecar is
// written with: the sidecar's own address, under the API's path.
export function baseURL(port, path = "") {
  return `http://127.0.0.1:${port}${path}`
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

// sidecarArgs are the flags the sidecar is started with: the origin it
// connects to, the address it listens on, and the ECH config the user
// gives when the DNS record carries none.
export function sidecarArgs(origin, listen = "") {
  if (!origin) throw new Error(NO_API)
  const args = ["-upstream", origin]
  if (listen) args.push("-listen", listen)
  const config = process.env.ECH_SIDECAR_CONFIG
  if (config) args.push("-ech-config", config)
  if (process.env.ECH_SIDECAR_ALLOW_PLAIN === "1") args.push("-allow-plain")
  return args
}

// startSidecar runs the sidecar and waits for the port it took. The
// sidecar writes one JSON line to its stdout when it is ready.
export function startSidecar(spawnImpl = spawn, path = "", origin = "", listen = "") {
  if (!origin) return Promise.reject(new Error(NO_API))
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
      proc = spawnImpl(binary, sidecarArgs(origin, listen), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
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

// start brings the sidecar up: it asks the one that may already be there
// first, and starts one when there is none.
export async function start(options = {}) {
  const o = options && typeof options === "object" ? options : {}
  const { api, origin, path } = resolveAPI(typeof o.api === "string" ? o.api : "", localAPI())
  if (!api) {
    console.error(`[ech] ${NO_API}`)
    return false
  }
  const port = Number.isInteger(Number(o.port)) && Number(o.port) > 0 ? Number(o.port) : DEFAULT_PORT
  const listen = `127.0.0.1:${port}`

  const said = await health(port)
  if (said && said.ok && said.upstream === origin) {
    up = true
    return true
  }

  console.log(`[ech] starting the sidecar for ${origin}; the provider's base URL is ${baseURL(port, path)}`)

  const { child } = await startSidecar(spawn, "", origin, listen)
  running.add(child)
  child?.once?.("exit", () => {
    running.delete(child)
    up = false
  })
  up = true
  return true
}
