# magpie-ech-middleware

给 [magpie](https://usemagpie.ai) 用的 Encrypted Client Hello（ECH），形态是
供应商插件 + sidecar。

按 TLS SNI 拦域名的网络读不到 Encrypted Client Hello 里的名字，所以带 ECH 的
连接能过去。这个包给你自己写的每一个供应商都做一份 ECH 副本，它们的流量于是
都带 ECH 出去。

## 包里四块

- **插件**（`ech.plugin.js`）读你自己写的供应商（`providers.json`），给其中每一个
  有自己地址的供应商声明一份 ECH 副本：`nvidia` 的副本叫 `ech-nvidia`。副本的 api
  就是你自己那个供应商的地址，所以 magpie 仍然把这一家当这一家看待。副本的
  loader 把请求发到 sidecar，由 sidecar 用 Encrypted Client Hello 建连再转发给
  厂商。副本用你自己那个供应商的 key 登录，所以什么都不用问你。
- **sidecar**（`sidecar/`）是一个小的 Go 程序：通过 DoH 解析每个上游的 ECH 配置，
  用 Encrypted Client Hello 建连，再把请求转发过去。
- **中间件**（`ech.middleware.js`）跑在 magpie 的网关里，盯住流量该去哪儿：
  `failClosed` 打开时把没点名副本的请求拒掉，并且给每次尝试写一行日志。
- **hooks**（`ech.hooks.js`）跑在 Bun 里（magpie 的插件宿主），那里可以起进程：
  由它把 sidecar 拉起来并维持。

## 安装步骤

### 1. 装插件

```sh
magpie plugin add github:li-notfish/magpie-ech-middleware
```

### 2. 把要走的供应商写好

就是你已经写好的那些，在 magpie 自己的设置里（设置 → 供应商）。别的插件带来的
供应商不动：它的地址是那个插件自己的事。

### 3. 用起来

每一个自己有地址的供应商，现在都有一份以它命名的副本：

| 你的供应商 | 它的 ECH 副本 |
| --- | --- |
| `nvidia` | `ech-nvidia` |
| `amd` | `ech-amd` |

agent 问 `ech-nvidia/<模型>`，请求于是从 sidecar 出去。模型还是你自己那个供应商
 服务的那一个：副本用同样的模型、同样的名字。

不用你做任何事：副本用你自己那个供应商已有的 key 登录。

## 选项

都是插件自己的选项，在 `plugins.json` 里：
`magpie plugin options <名字> '<json>'`。

| 选项 | 默认 | 做什么 |
| --- | --- | --- |
| `port` | `8790` | sidecar 监听哪个端口 |
| `failClosed` | `false` | 把没点名副本的请求拒掉 |
| `log` | `true` | 每次尝试往 magpie 的日志里写一行 |

`failClosed` 才是保证本身：把模型没点名副本的请求拒掉，已经点名了副本的不动。

不打开它的时候，只写了模型名的请求会落到 magpie 的 Providers 顺序里第一个能
服务它的供应商——也就是你自己那个供应商，明文出去。副本是 key 型的，中间件里
没有别的东西能挡这个：跳过账号的钩子只对订阅账号触发，走 key 的尝试不问钩子。

也别给副本配 fallback：配了之后，副本接不住时请求会被送到别的供应商去。

选项也能在界面里改：插件 → 已安装 → 这一行的选项。

## 一个请求会经过什么

1. 插件被加载：它把 sidecar 要服务的上游写下来，并把 sidecar 拉起来。
2. agent 问 `ech-nvidia/<模型>`。magpie 把它路由给副本 `ech-nvidia`，副本的
   loader 说 base 是 `http://127.0.0.1:8790/nvidia`。
3. sidecar 用 Encrypted Client Hello 跟你自己那个供应商的地址建连：网络上看到
   的是掩护名，不是厂商的名字。
4. 中间件写一行日志：模型、落到哪个供应商、走了 sidecar（`[ech]`）还是没走
   （`[direct]`）。

sidecar 自己的日志（ECH 配置用的掩护名、失败的请求）也会进宿主的日志。

## sidecar 服务哪些上游

插件把它们写进自己那个文件夹，在 magpie 的目录下：

```
<magpie 的目录>/magpie-ech-middleware/upstreams.json
```

```json
{
  "nvidia": "https://api.example.com/v1"
}
```

sidecar 会盯着这个文件，变了就重读：后来加的供应商不用重启 sidecar 就能服务。

不发布 ECH 配置的供应商，可以在这个文件里手写一份：

```json
{
  "nvidia": { "url": "https://api.example.com/v1", "ech": "<base64 的 ECHConfigList>" }
}
```

## 单独跑 sidecar

sidecar 本身是个程序，可以手动跑：

```sh
sidecar/bin/win32-x64/ech-sidecar.exe -upstreams-file upstreams.json -listen 127.0.0.1:8790
```

它监听起来之后往 stdout 写一行 JSON：

```json
{"ok":true,"port":8790,"upstreams":{"nvidia":{"url":"https://api.example.com/v1","ech":false,"cover":""}}}
```

这行说的是它监听起来没有。ECH 配置是之后在后台查的，所以这行里 `ech` 是
false、`cover` 是空的：它是就绪信号，不是握手的结论。`/_ech/health` 回答的是
此刻的状态，不碰厂商：

```json
{"ok":true,"upstreams":{"nvidia":{"url":"https://api.example.com/v1","ech":true,"cover":"example.com"}}}
```

`ech` 说有没有在用配置列表，`cover` 是外面那个 hello 带的掩护名，也就是网络上
看到的那个名字。

请求由路径里点名的上游来服务：`/nvidia/chat/completions` 走到上游 `nvidia`，
挂在那个上游自己的地址底下。

包覆盖的平台的二进制在 `sidecar/bin/<平台>-<架构>/`，所以装上就能用，不需要
Go：

| 平台 | 目录 |
| --- | --- |
| Windows x64 / arm64 | `sidecar/bin/win32-x64`、`sidecar/bin/win32-arm64` |
| Linux x64 / arm64 | `sidecar/bin/linux-x64`、`sidecar/bin/linux-arm64` |
| macOS x64 / arm64 | `sidecar/bin/darwin-x64`、`sidecar/bin/darwin-arm64` |

没有二进制的平台有 Go 源码在旁边：机器上有 Go 1.26 或更新版本（第一个
`crypto/tls` 会说 Encrypted Client Hello 的版本）时，包会自己把它编出来：

```sh
npm run build
```

## 出问题时

- **某个供应商没有副本** —— 它没有自己的地址（是别的插件的供应商），或者有地址
  的供应商超过十六个。
- **日志里写着 `[direct]`** —— 这个请求没走 sidecar：它问的模型不是副本的。
- **sidecar 说没有 ECH 配置** —— 厂商的 DNS 记录里没有 `ech` 参数。中转站的
  主机名就没有，这时用 `ECH_SIDECAR_ALLOW_PLAIN=1` 启动 sidecar，它会不加密也
  继续。
- **某个供应商要自己的一份配置** —— 在上面的上游文件里给它写一份。

## 测试

```sh
bun test
```

覆盖的是插件（它做的副本、每个副本的登录与 loader）、中间件的钩子（它对请求、
账号、尝试做了什么）和 keeper（sidecar 在哪、要服务什么、怎么问它是否在）。

## 许可

MIT。
