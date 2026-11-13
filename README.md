# magpie-ech-middleware

Encrypted Client Hello (ECH) for [magpie](https://usemagpie.ai), as a
provider and a sidecar.

A network that blocks a domain by its TLS SNI cannot read the name inside
an Encrypted Client Hello, so a connection that carries one goes through.
With this package installed, magpie has one more provider, named **ECH**:
it is signed in to the way a provider of your own is, with the address of
the upstream and its key, and its traffic goes out through the sidecar,
which makes the connection with an Encrypted Client Hello and forwards it
to the vendor.

## What it does

- **The provider plugin** (`ech.plugin.js`) declares this ECH provider.
  Signing in asks for three things: the address of the upstream (its
  base URL), the kind of API the upstream speaks (Chat Completions,
  Responses, Anthropic Messages, Gemini), and the upstream's key. The
  models it lists are the upstream's own, asked for through the sidecar,
and each carries the levels of thought (low, medium, high, xhigh, max) an
agent may ask it at.
- **The sidecar** (`sidecar/`) is a small Go program: it resolves each
  upstream's ECH configuration over DoH, connects with an Encrypted
  Client Hello, and forwards the requests. When the resolvers give no
  configuration, it falls back to a built-in Cloudflare one for upstreams
  behind Cloudflare.
- **The hooks** (`ech.hooks.js`) run in Bun, in magpie's plugin host,
  where a process can be started: they bring the sidecar up and keep it
  there.

## Install

### 1. Add the plugin

```sh
magpie plugin add github:li-notfish/magpie-ech-middleware
```

### 2. Sign in

Settings → Providers → ECH → sign in:

| Asked | Given |
| --- | --- |
| Base URL | the address of the upstream, with its version path, like `https://api.example.com/v1` |
| API | the kind of API the upstream speaks |
| API key | the upstream's key |

### 3. Use it

An agent asks for `ech/<model>`, and the models are the ones the upstream
lists. The requests go out through the sidecar: what the network sees is
the cover name, not the vendor's.

## More than one upstream

A provider can be signed in to more than once: sign in again with another
address and key, and that is another upstream. Two keys of the same vendor
are fine. Each account serves the models it lists itself.

## Options

All of them are the plugin's own, in `plugins.json`:
`magpie plugin options <name> '<json>'`.

| Option | Default | What it does |
| --- | --- | --- |
| `port` | `8790` | which port the sidecar listens on |
| `echFallback` | `""` | the ECH config offered when DoH gives none: `cloudflare`, `always`, `off`, or a base64 `ECHConfigList` |

The options are read when the plugin is loaded: when plugins.json changes,
magpie loads the plugin again.

## What a request goes through

1. The plugin is loaded: every upstream that is signed in to is written
   down for the sidecar to serve; listing the models or the first request
   brings it up.
2. An agent asks for `ech/<model>`. magpie routes it to the ECH provider,
   whose loader says the base is
   `http://127.0.0.1:8790/<the upstream's name>`.
3. The sidecar connects to the address the sign-in named with an
   Encrypted Client Hello: what the network sees is the cover name, not
   the vendor's.
4. The request reaches the vendor, and the answer comes back the way it
   went.

## Which upstreams the sidecar serves

The plugin writes them into its own folder, in magpie's directory:

```
<magpie's directory>/magpie-ech-middleware/upstreams.json
```

```json
{
  "api-example-com-v1-9f86d081": "https://api.example.com/v1"
}
```

Each name is one address a sign-in named. The sidecar watches this file
and reads it again when it changes: an upstream signed in to later is
served without the sidecar being started again.

An upstream that publishes no ECH configuration can be given one by hand:

```json
{
  "api-example-com-v1-9f86d081": { "url": "https://api.example.com/v1", "ech": "<base64 ECHConfigList>" }
}
```

## ECH fallback

Some networks block DoH or strip the `ech` parameter from the HTTPS
record. When every resolver answers without an ECH configuration, the
sidecar falls back to a built-in configuration of Cloudflare's edge (cover
name `cloudflare-ech.com`). The built-in one is only used for an upstream
whose address is in Cloudflare's own networks: another server would answer
under the cover name, and the handshake would fail.

The built-in config is a guess, because not every zone behind Cloudflare has
ECH enabled. When the edge rejects it without offering another config, the
sidecar retries that connection with plain TLS, so an upstream that does not
enable ECH stays usable. Only this built-in guess may end in plain TLS: a
config from DoH or supplied in `upstreams.json` is not silently downgraded.
If you would rather fail than connect without ECH, turn the fallback off.

- `ECH_SIDECAR_ECH_FALLBACK=off` (or `-ech-fallback ""`) turns it off.
- `ECH_SIDECAR_ECH_FALLBACK=<base64 ECHConfigList>` (or
  `-ech-fallback <base64>`) uses a configuration of your own for every
  upstream.
- `ECH_SIDECAR_ECH_FALLBACK=cloudflare` (the default) keeps the built-in
  one.
- `ECH_SIDECAR_ECH_FALLBACK=always` uses the built-in one for every
  upstream, even when its address cannot be seen to be Cloudflare's.
- An `ech` value in `upstreams.json` still wins over all of them.

The flag wins over the environment variable; both win over the built-in
default. The plugin's `echFallback` option is that flag: what it names is
passed to the sidecar as `-ech-fallback`, so it wins over the environment
variable too; leave it empty and the environment variable and the built-in
default decide. The sidecar reads it when it starts: after changing it,
restart magpie.

## Running the sidecar on its own

The sidecar is a program of its own, and can be run by hand:

```sh
ech-sidecar.exe -upstreams-file upstreams.json -listen 127.0.0.1:8790 \
  [-ech-fallback cloudflare]
# the one the plugin downloaded, the one in sidecar/bin/, or one on the PATH
```

Once it is listening, it writes one line of JSON to its stdout:

```json
{"ok":true,"port":8790,"upstreams":{"api-example-com-v1-9f86d081":{"url":"https://api.example.com/v1","ech":false,"cover":""}}}
```

That line says it is listening. The ECH configuration is looked up after,
in the background, so `ech` is false and `cover` is empty in it: it is a
signal that it is ready, not the conclusion of a handshake. `/_ech/health`
answers with the state of this moment, without touching the vendor:

```json
{"ok":true,"upstreams":{"api-example-com-v1-9f86d081":{"url":"https://api.example.com/v1","ech":true,"cover":"example.com"}}}
```

`ech` says whether a configuration list is in use, and `cover` is the name
the outer hello carries — the name the network sees.

A request is served by the upstream its path names:
`/<the upstream's name>/chat/completions` goes to that upstream, under the
address it has.

The repository carries no binaries. They are the assets of the
[sidecar release](https://github.com/li-notfish/magpie-ech-middleware/releases/tag/sidecar),
one per platform and architecture, so installing the package is enough and
needs no Go: the first time the sidecar is needed, its binary is downloaded
into the plugin's own folder in magpie's directory, under a folder named for
this package's version, and kept there. An upgrade downloads the binary of
its own version instead of running the one left by the version before:

| Platform | Asset |
| --- | --- |
| Windows x64 / arm64 | `ech-sidecar-win32-x64.exe`, `ech-sidecar-win32-arm64.exe` |
| Linux x64 / arm64 | `ech-sidecar-linux-x64`, `ech-sidecar-linux-arm64` |
| macOS x64 / arm64 | `ech-sidecar-darwin-x64`, `ech-sidecar-darwin-arm64` |

A binary put by hand in `sidecar/bin/<platform>-<arch>/`, or named by
`ECH_SIDECAR_PATH`, is used before any download. A platform the release
covers no asset of has the Go source beside it: when the machine has Go
1.26 or newer (the first `crypto/tls` that speaks Encrypted Client Hello),
the package builds it:

```sh
npm run build
```

## When something is wrong

- **The models do not list** — the address is not right, the sidecar is
  not up, or the upstream has no endpoint that lists models: the models
  stay as they were, and magpie's log says so. A sign-in of an earlier
  version names no address: sign in again.
- **An upstream publishes no ECH configuration** — no HTTPS record, or
  none with `ech` in it: an upstream behind Cloudflare gets the built-in
  fallback; any other one can be given a configuration by hand in
  upstreams.json (see above), or with the `echFallback` option when one
  configuration fits every upstream.
- **In a hurry, and this one connection may go in the clear** — set
  `ECH_SIDECAR_ALLOW_PLAIN=1` and restart magpie: an upstream no ECH
  configuration is found for goes out without one.
- **The sidecar does not start** — when its binary could not be downloaded
  (no release asset for this platform, or no network), run `npm run build`
  on a machine with Go first, or put one in `sidecar/bin/` by hand; when
  the port is taken, give another in the options.
