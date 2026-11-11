# magpie-ech-middleware

Encrypted Client Hello (ECH) for [magpie](https://usemagpie.ai), as a
provider plugin and a sidecar.

A network that blocks a domain by its TLS SNI cannot read the name inside
an Encrypted Client Hello, so a connection that carries one goes through.
This package gives every provider you wrote an ECH copy, so their traffic
goes out with an encrypted client hello.

## What it does

- **The plugin** (`ech.plugin.js`) reads the providers you wrote
  (`providers.json`) and declares an ECH copy of each one that has an
  address of its own: the copy of `nvidia` is `ech-nvidia`. The copy's
  api is the address your own provider has, so magpie keeps treating the
  vendor as that vendor. Its loader sends the requests to the sidecar,
  which makes the connection with an Encrypted Client Hello and forwards
  it to the vendor. The copy is signed in with the key your own provider
  has, so nothing is asked of you.
- **The sidecar** (`sidecar/`) is a small Go program. It resolves each
  upstream's ECH config over DoH, connects with an Encrypted Client
  Hello, and forwards the requests to it.
- **The middleware** (`ech.middleware.js`) runs in magpie's gateway and
  keeps the traffic where it should be: it turns a request away that
  names no copy when it fails closed, and it writes a line per try.
- **The hooks** (`ech.hooks.js`) run in Bun, in magpie's plugin host,
  where a process can be started. They start the sidecar and keep it up.

## Setup

### 1. Install the plugin

```sh
magpie plugin add github:li-notfish/magpie-ech-middleware
```

### 2. Add the providers you want to reach with ECH

They are the ones you already wrote, in magpie's own settings
(设置 → 供应商). A provider of another plugin is left alone: its address
is that plugin's own business.

### 3. Use it

Every provider with an address of its own now has a copy named after it:

| your provider | its ECH copy |
| --- | --- |
| `nvidia` | `ech-nvidia` |
| `amd` | `ech-amd` |

The agent asks for `ech-nvidia/<model>`, and the request goes out through
the sidecar. The model is the one your own provider serves: the copy
serves the same models, under the same names.

Nothing is asked of you: the copy is signed in with the key your own
provider already has.

## The options

They are the plugin's own, in `plugins.json`:
`magpie plugin options <name> '<json>'`.

| option | default | what it does |
| --- | --- | --- |
| `port` | `8790` | the port the sidecar listens on |
| `failClosed` | `false` | turn away a request that names no copy |
| `log` | `true` | write a line per try into magpie's log |

`failClosed` is what makes the guarantee real: it turns a request away
whose model names no copy. A model that already names one is left alone.

Without it, a request that names a bare model goes to the first provider
in magpie's Providers order that serves it - your own provider, in the
 clear. The copies are made of keys, so nothing else in the middleware
could have stopped that: a hook that passes an account over is only
asked of a subscription account, and a try on a key asks no hook.

Give a copy no fallback either: a provider that falls back to another
one sends the request there when the copy cannot serve it.

The options can also be edited in the GUI: 插件 → 已安装 → 这一行的选项.

## What happens to a request

1. The plugin is loaded: it writes the upstreams the sidecar is to serve
   and starts the sidecar.
2. The agent asks for `ech-nvidia/<model>`. magpie routes it to the copy
   `ech-nvidia`, whose loader says the base is
   `http://127.0.0.1:8790/nvidia`.
3. The sidecar makes the TLS connection to the address of your own
   provider with an Encrypted Client Hello: the network sees a cover
   name, not the vendor's.
4. The middleware writes one line: the model, the provider it went to,
   and whether it went through the sidecar (`[ech]`) or not (`[direct]`).

The sidecar's own lines (the cover name its ECH config uses, a request
that failed) go to the host's log as well.

## The upstreams the sidecar serves

The plugin writes them into a file of its own, in magpie's folder:

```
<magpie's folder>/magpie-ech-middleware/upstreams.json
```

```json
{
  "nvidia": "https://api.example.com/v1"
}
```

The sidecar reads the file again when it changes, so a provider added
later is served without the sidecar being started again.

A provider that publishes no ECH config can be given one by hand, in the
same file:

```json
{
  "nvidia": { "url": "https://api.example.com/v1", "ech": "<base64 ECHConfigList>" }
}
```

## The sidecar on its own

The sidecar is a program of its own and can be run by hand:

```sh
sidecar/bin/win32-x64/ech-sidecar.exe -upstreams-file upstreams.json -listen 127.0.0.1:8790
```

It writes one JSON line to its stdout when it is listening:

```json
{"ok":true,"port":8790,"upstreams":{"nvidia":{"url":"https://api.example.com/v1","ech":false,"cover":""}}}
```

That line says the sidecar is listening. The ECH config is looked up
afterwards, in the background, so `ech` is false and `cover` is empty in
it: the line is a readiness signal, not a statement about the handshake.
`/_ech/health` answers with the state as it is now, without touching the
vendor:

```json
{"ok":true,"upstreams":{"nvidia":{"url":"https://api.example.com/v1","ech":true,"cover":"example.com"}}}
```

`ech` says whether a config list is in use, and `cover` is the name the
outer hello carries - the one a network sees.

A request is served by the upstream its path names:
`/nvidia/chat/completions` goes to the upstream `nvidia`, under the
address that upstream has.

The binaries for the platforms the package covers are in
`sidecar/bin/<platform>-<arch>/`, so an install needs no Go at all:

| platform | folder |
| --- | --- |
| Windows x64 / arm64 | `sidecar/bin/win32-x64`, `sidecar/bin/win32-arm64` |
| Linux x64 / arm64 | `sidecar/bin/linux-x64`, `sidecar/bin/linux-arm64` |
| macOS x64 / arm64 | `sidecar/bin/darwin-x64`, `sidecar/bin/darwin-arm64` |

The Go source is beside them for the platforms that have no binary: the
package builds it when it is missing and the machine has Go 1.26 or
newer (the first release whose `crypto/tls` speaks Encrypted Client
Hello):

```sh
npm run build
```

## Troubleshooting

- **No copy of a provider appears** - the provider has no address of its
  own (it is another plugin's provider), or there are more than sixteen
  providers with an address.
- **The log says `[direct]`** - the request did not go through the
  sidecar: the model it named is not a copy's.
- **The sidecar says it has no ECH config** - the vendor's DNS record
  carries no `ech` parameter. A relay's hostname does not, so the
  sidecar goes on without one when it is started with
  `ECH_SIDECAR_ALLOW_PLAIN=1`.
- **A provider needs a config of its own** - give it one in the upstreams
  file, as above.

## The tests

```sh
bun test
```

They cover the plugin (the copies it makes, the sign-in and the loader
each of them has), the middleware's hooks (what it does to a request, to
an account and to a try) and the keeper (where the sidecar is, what it is
to serve, how it is asked whether it is up).

## License

MIT.
