# magpie-ech-middleware

给 [magpie](https://usemagpie.ai) 用的 Encrypted Client Hello（ECH），形态是
网关中间件 + sidecar。

按 TLS SNI 拦域名的网络读不到 Encrypted Client Hello 里的名字，所以带 ECH 的
连接能过去。这个包让 magpie 发往你指定的那个 API 的流量都带 ECH。

包里三块：

- **中间件**（`ech.middleware.js`）跑在 magpie 的网关里：把你要指定的模型改道到
  指向 sidecar 的那个供应商，跳过不属于它的账号，把 agent 问的模型名还回回复，
  并给每次尝试写一行日志。
- **sidecar**（`sidecar/`）是一个小的 Go 程序：通过 DoH 解析上游的 ECH 配置，
  用 Encrypted Client Hello 建连，再把上游服务在 127.0.0.1 上。
- **hooks**（`ech.hooks.js`）跑在 Bun 里（magpie 的插件宿主），那里可以起进程：
  由它把 sidecar 拉起来并维持。

## 为什么是中间件，中间件又能做什么

网关中间件看得见 agent 的请求、它问的模型、每次尝试落到哪个供应商，**看不见上游
地址**：中间件拿到的供应商只有 id、名字、账号种类和模型，而且请求一旦路由完就不
能改去别处。magpie 自己的代码就是这么写的——中间件拿到的那个结构（`gwmw.To`）
里根本没有 URL，`onProvider` 也是在路由之后才跑的。

所以中间件没法自己把某个供应商指到 sidecar 上。供应商的 base URL 在 magpie 自己的
设置里，手写一次。中间件能做的是决定**哪些流量走指向 sidecar 的那个供应商**：

- agent 问的模型被改写成那个供应商的模型，请求于是发到 sidecar，由 sidecar 用
  Encrypted Client Hello 建连；
- 不属于那个供应商的账号被跳过，sidecar 接不住的请求不会明文直连出去；
- 打开 `failClosed` 时，完全没被改道的请求直接被拒，而不是照发。

## 安装步骤

### 1. 装插件

```sh
magpie plugin add github:li-notfish/magpie-ech-middleware
```

### 2. 告诉它 sidecar 连哪个 API

```sh
magpie plugin options magpie-ech-middleware '{"api":"https://api.example.com","provider":"ech"}'
```

- `api` 是 sidecar 要连的上游 base URL。仓库里不带任何人的地址：这个地址是你
  的，只留在你自己的设置里。
- `provider` 是 magpie 里「指向 sidecar 的那个供应商」的 id，也就是下一步你给
  它起的名字。

端口默认 8790，`port` 可以改。选项也能在界面里改：插件 → 已安装 → 这一行的
选项。

### 3. 在 magpie 里加这个供应商

设置 → 供应商 → 添加 → OpenAI 兼容：

| 字段 | 填什么 |
| --- | --- |
| 名称 | `ech`（就是第二步 `provider` 指的那个 id） |
| Base URL | `http://127.0.0.1:8790/v1` |
| API key | 第二步那个 API 的 key |
| 模型 | 把上游的模型 id 填进去 |

Base URL 是 sidecar 自己的地址，路径是上游的路径。`api` 写
`https://api.example.com/v1` 时，Base URL 就是 `http://127.0.0.1:8790/v1`。

模型列表可以手填，也可以等 sidecar 起来之后拉：

```sh
curl http://127.0.0.1:8790/v1/models
```

### 4. 用起来

agent 直接问 `ech/<model>`，请求就走过 sidecar。或者让中间件把 agent 问的模型
改道过去，agent 那边不用改：

```sh
magpie plugin options magpie-ech-middleware '{"api":"https://api.example.com","provider":"ech","all":true}'
```

## 选项

选项就是这个插件自己的，在 `plugins.json` 里：
`magpie plugin options <名字> '<json>'`。

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| `api` | `""` | sidecar 连的上游 |
| `port` | `8790` | sidecar 监听的端口 |
| `provider` | `""` | 指向 sidecar 的那个供应商的 id |
| `models` | `{}` | 要改道的模型，以及改道后叫什么 |
| `all` | `false` | 所有模型都改道到那个供应商 |
| `strict` | `false` | 跳过不属于那个供应商的账号 |
| `failClosed` | `false` | 没被改道的请求直接拒掉 |
| `restoreName` | `true` | 回复里把 agent 问的模型名还回去 |
| `log` | `true` | 每次尝试往 magpie 日志写一行 |
| `off` | `false` | 中间件什么都不做 |

`models` 是「agent 问的模型 → sidecar 那个供应商里的模型」的映射：

```json
{"models": {"fast": "gpt-4o-mini", "/^gpt-4o(-.*)?$/": "gpt-4o"}}
```

名字可以照写，也可以写成 `/正则/`，替换值里能用 `$1`。匹配时不含供应商前缀，
所以 `gpt-4o` 和 `openai/gpt-4o` 是同一个模型。映射到自己、或者没有映射的，
不改道。

`strict` 和 `failClosed` 才是保证成立的地方：

- `strict` 跳过不是那个供应商的账号。注意只有订阅账号会被问：用 API key 的
  尝试不问任何钩子，所以按 key 计费的供应商拦不住。
- `failClosed` 把没有任何映射的请求拒掉。已经写了那个供应商 id 的模型不动。

## 一个请求经过了什么

1. hooks 把 sidecar 拉起来（只一次），等它开始监听。
2. `onRequest` 改写模型：`gpt-4o` 变成 `ech/gpt-4o`，网关于是把请求路由到指向
   sidecar 的那个供应商。
3. `onAccount` 跳过不属于那个供应商的账号。
4. 网关把请求发到 `http://127.0.0.1:8790`，sidecar 用 Encrypted Client Hello
   跟 API 建连：网络看到的是一个掩护名，不是 API 的名字。
5. `onProvider` 写一行：模型、去了哪个供应商、是走了 sidecar（`[ech]`）还是没走
   （`[direct]`）。
6. `onEvent` / `onResponse` 把 agent 问的模型名还回回复，agent 读它（Claude Code
   靠它算上下文长度）时看到的还是自己问的名字。

## 单独跑 sidecar

sidecar 本身就是个程序，可以手写启动，第一次拉模型列表就是这么做的：

```sh
sidecar/bin/win32-x64/ech-sidecar.exe -upstream https://api.example.com -listen 127.0.0.1:8790
```

它开始监听时往 stdout 写一行 JSON：

```json
{"port":8790,"upstream":"https://api.example.com","ech":false,"cover":""}
```

这行说的是「sidecar 已经在监听」。ECH 配置是之后在后台查的，所以这行里的
`ech` 是 false、`cover` 是空的：它是就绪信号，不是握手结果的说明。当前状态由
`/_ech/health` 给出，它不碰上游：

```json
{"ok":true,"upstream":"https://api.example.com","ech":true,"cover":"example.com"}
```

`ech` 表示当前用的是不是配置列表，`cover` 是外层 hello 里带的那个名字——网络看到
的就是它。sidecar 把上游服务在 127.0.0.1 上。

包里带了各平台的二进制，在 `sidecar/bin/<platform>-<arch>/`，所以装上就能用，
不用装 Go：

| 平台 | 目录 |
| --- | --- |
| Windows x64 / arm64 | `sidecar/bin/win32-x64`、`sidecar/bin/win32-arm64` |
| Linux x64 / arm64 | `sidecar/bin/linux-x64`、`sidecar/bin/linux-arm64` |
| macOS x64 / arm64 | `sidecar/bin/darwin-x64`、`sidecar/bin/darwin-arm64` |

Go 源码就在旁边，给没有二进制的平台用：缺二进制而机器上有 Go 1.26 以上（第一个
`crypto/tls` 支持 Encrypted Client Hello 的版本）时，包会自己编：

```sh
npm run build
```

## 排错

- **日志里是 `[direct]`** —— 这次没走 sidecar。要么模型不在 `models` 里（`all`
  也没开），要么接住它的供应商不是 `provider` 指的那个。
- **模型列表拉不到** —— sidecar 还没起来。它是第一次 agent 请求时才起来的；在那
  之前可以手写启动（见上），或者把模型 id 手填进去。
- **sidecar 说没有 ECH 配置** —— 上游的 DNS 记录里没有 `ech` 参数。中转站的名字
  一般就没有，这时用 `ECH_SIDECAR_ALLOW_PLAIN=1` 启动，它会不带 ECH 继续跑。
- **要自己给 sidecar 配置** —— `ECH_SIDECAR_CONFIG` 收一个 base64 的
  `ECHConfigList`。

## 测试

```sh
bun test
```

覆盖中间件的各个钩子（对请求、账号、尝试、回复做了什么），以及 sidecar 的守护
逻辑（二进制在哪、怎么起、怎么问它还在不在）。

## 许可

MIT。
