# magpie-ech-middleware

Encrypted Client Hello (ECH) for [magpie](https://usemagpie.ai), as a
gateway middleware and a sidecar.

A network that blocks a domain by its TLS SNI cannot read the name inside
an Encrypted Client Hello, so a connection that carries one goes through.
This package makes the traffic to the API you name go through one.

The package has three parts:

- **The middleware** (`ech.middleware.js`) runs in magpie's gateway. It
  routes the models you name to the provider that points at the sidecar,
  passes over the accounts that are not that provider's, puts the asked
  model's name back in the reply, and writes a line per try.
- **The sidecar** (`sidecar/`) is a small Go program. It resolves the
  upstream's ECH config over DoH, connects with an Encrypted Client
  Hello, and serves the upstream on 127.0.0.1.
- **The hooks** (`ech.hooks.js`) run in Bun, in magpie's plugin host,
  where a process can be started. They start the sidecar and keep it up.

## Why a middleware, and what a middleware can do about it

A gateway middleware sees an agent's request, the model it asks for, and
the provider every try goes to. It does **not** see the upstream's
address: the provider a middleware is told of carries an id, a name, an
account's kind and a model, and a request that is routed cannot be sent
elsewhere. magpie's own code says so — the struct a middleware is given
the provider in (`gwmw.To`) has no URL, and the `onProvider` hook runs
after the routing.

So a middleware cannot point a provider at the sidecar itself. A
provider's base URL lives in magpie's own settings and is written by
hand, once. What the middleware can do is decide **which traffic goes to
the provider that points at the sidecar**:

- the model an agent asks for is rewritten to a model of that provider,
  so the gateway sends the request there, and the sidecar makes the
  connection with an Encrypted Client Hello;
- the accounts that are not that provider's are passed over, so a request
  the sidecar cannot serve does not go out in the clear;
- with `failClosed` on, a request that is not routed at all is turned away
  instead of being sent.

## Setup

### 1. Install the plugin

```sh
magpie plugin add github:li-notfish/magpie-ech-middleware
```

### 2. Say which API the sidecar talks to

```sh
magpie plugin options magpie-ech-middleware '{"api":"https://api.example.com","provider":"ech"}'
```

- `api` is the API's base URL, the one the sidecar connects to. Nothing
  in this repository names one: the address is yours, and it stays in
  your own settings.
- `provider` is the id of the provider in magpie that points at the
  sidecar — the name you give it in the next step.

The port is 8790 unless `port` says otherwise. The options can also be
edited in the GUI: 插件 → 已安装 → the plugin's row → 选项.

### 3. Add the provider in magpie

设置 → 供应商 → 添加 → OpenAI 兼容:

| field | value |
| --- | --- |
| 名称 | `ech` (the id `provider` in step 2 names) |
| Base URL | `http://127.0.0.1:8790/v1` |
| API key | the key of the API in step 2 |
| 模型 | the API's model ids, typed in |

The base URL is the sidecar's own address; the path is the API's path.
If `api` is `https://api.example.com/v1`, the base URL is
`http://127.0.0.1:8790/v1`.

The model list can be typed in, or fetched once the sidecar is up:

```sh
curl http://127.0.0.1:8790/v1/models
```

### 4. Use it

The agent asks for `ech/<model>` and the request goes through the
sidecar. Or the middleware routes what the agent asks for there, so the
agent can keep asking for the model it knows:

```sh
magpie plugin options magpie-ech-middleware '{"api":"https://api.example.com","provider":"ech","all":true}'
```

## The options

They are the plugin's own, in `plugins.json`:
`magpie plugin options <name> '<json>'`.

| option | default | what it does |
| --- | --- | --- |
| `api` | `""` | the API the sidecar talks to |
| `port` | `8790` | the port the sidecar listens on |
| `provider` | `""` | the id of the provider that points at the sidecar |
| `models` | `{}` | the models to route, and what they become |
| `all` | `false` | route every model to the sidecar's provider |
| `strict` | `false` | pass over the accounts that are not that provider's |
| `failClosed` | `false` | turn away a request that is not routed |
| `restoreName` | `true` | put the asked model's name back in the reply |
| `log` | `true` | write a line per try into magpie's log |
| `off` | `false` | the middleware does nothing |

`models` maps the model an agent asks for to the model the sidecar's
provider serves:

```json
{"models": {"fast": "gpt-4o-mini", "/^gpt-4o(-.*)?$/": "gpt-4o"}}
```

A name is written as it is, or as `/a pattern/` whose value can use `$1`.
The name is matched without the provider that serves it, so `gpt-4o` and
`openai/gpt-4o` are the same model. A name that maps to itself, or to
nothing, is not routed.

`strict` and `failClosed` are what make the guarantee real:

- `strict` passes over an account that is not the sidecar's provider's.
  Only a subscription account is asked: a try on an API key asks no
  hook, so a provider of keys is not kept from taking a request.
- `failClosed` turns a request away whose model nothing routes. A model
  that already names the sidecar's provider is left alone.

## What happens to a request

1. The hooks start the sidecar (once) and wait for it to listen.
2. `onRequest` rewrites the model: `gpt-4o` becomes `ech/gpt-4o`, so the
   gateway routes the request to the provider that points at the sidecar.
3. `onAccount` passes over the accounts that are not that provider's.
4. The gateway sends the request to `http://127.0.0.1:8790`, and the
   sidecar makes the TLS connection to the API with an Encrypted Client
   Hello: the network sees a cover name, not the API's.
5. `onProvider` writes one line: the model, the provider it went to, and
   whether it went through the sidecar (`[ech]`) or not (`[direct]`).
6. `onEvent` / `onResponse` put the asked model's name back in the reply,
   so an agent that reads it (Claude Code reads it to know its context
   window) sees what it asked for.

## The sidecar on its own

The sidecar is a program of its own and can be run by hand, which is what
the first run of the model list needs:

```sh
sidecar/bin/win32-x64/ech-sidecar.exe -upstream https://api.example.com -listen 127.0.0.1:8790
```

It writes one JSON line to its stdout when it is listening:

```json
{"port":8790,"upstream":"https://api.example.com","ech":false,"cover":""}
```

That line says the sidecar is listening. The ECH config is looked up
afterwards, in the background, so `ech` is false and `cover` is empty in
it: the line is a readiness signal, not a statement about the handshake.
`/_ech/health` answers with the state as it is now, without touching the
API:

```json
{"ok":true,"upstream":"https://api.example.com","ech":true,"cover":"example.com"}
```

`ech` says whether a config list is in use, and `cover` is the name the
outer hello carries — the one a network sees. The sidecar serves the API
on 127.0.0.1.

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

- **The log says `[direct]`** — the request did not go through the
  sidecar. Either the model is not in `models` (and `all` is off), or the
  provider that took it is not the one `provider` names.
- **The model list cannot be fetched** — the sidecar is not up yet. It
  starts with the first agent request; before that, start it by hand (see
  above) or type the model ids in.
- **The sidecar says it has no ECH config** — the API's DNS record
  carries no `ech` parameter. A relay's hostname does not, so the
  sidecar goes on without one when it is started with
  `ECH_SIDECAR_ALLOW_PLAIN=1`.
- **The sidecar needs a config of its own** — `ECH_SIDECAR_CONFIG` takes
  a base64 `ECHConfigList`.

## The tests

```sh
bun test
```

They cover the middleware's hooks (what it does to a request, to an
account, to a try and to a reply) and the keeper (where the sidecar is,
how it is started, how it is asked whether it is up).

## License

MIT.
