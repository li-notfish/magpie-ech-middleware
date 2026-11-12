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
  models it lists are the upstream's own, asked for through the sidecar.
- **The sidecar** (`sidecar/`) is a small Go program: it resolves each
  upstream's ECH configuration over DoH, connects with an Encrypted
  Client Hello, and forwards the requests.
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

## Running the sidecar on its own

The sidecar is a program of its own, and can be run by hand:

```sh
sidecar/bin/win32-x64/ech-sidecar.exe -upstreams-file upstreams.json -listen 127.0.0.1:8790
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

The binaries of the platforms the package covers are in
`sidecar/bin/<platform>-<arch>/`, so installing is enough, with no Go:

| Platform | Folders |
| --- | --- |
| Windows x64 / arm64 | `sidecar/bin/win32-x64`, `sidecar/bin/win32-arm64` |
| Linux x64 / arm64 | `sidecar/bin/linux-x64`, `sidecar/bin/linux-arm64` |
| macOS x64 / arm64 | `sidecar/bin/darwin-x64`, `sidecar/bin/darwin-arm64` |

A platform without a binary has the Go source beside it: when the machine
has Go 1.26 or newer (the first `crypto/tls` that speaks Encrypted Client
Hello), the package builds it:

```sh
npm run build
```

## When something is wrong

- **The models do not list** — the address is not right, the sidecar is
  not up, or the upstream has no endpoint that lists models: the models
  stay as they were, and magpie's log says so. A sign-in of an earlier
  version names no address: sign in again.
- **An upstream publishes no ECH configuration** — no HTTPS record, or
  none with `ech` in it: one can be given by hand in upstreams.json
  (see above).
- **In a hurry, and this one connection may go in the clear** — set
  `ECH_SIDECAR_ALLOW_PLAIN=1` and restart magpie: an upstream no ECH
  configuration is found for goes out without one.
- **The sidecar does not start** — on a platform without a binary, run
  `npm run build` first; when the port is taken, give another in the
  options.
