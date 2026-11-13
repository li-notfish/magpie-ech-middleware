# magpie-ech-middleware

给 [magpie](https://usemagpie.ai) 用的 Encrypted Client Hello（ECH），形态是
一个供应商 + sidecar。

按 TLS SNI 拦域名的网络读不到 Encrypted Client Hello 里的名字，所以带 ECH 的
连接能过去。装上这个包，magpie 里多一个叫 **ECH** 的供应商：像自定义供应商
一样登录——填上游的地址和 Key——它的流量就从 sidecar 出去，sidecar 用
Encrypted Client Hello 建连再转发给厂商。

## 包里三块

- **供应商插件**（`ech.plugin.js`）声明这个 ECH 供应商。登录时问三样：上游的
  地址（Base URL）、上游说的是哪种 API（Chat Completions、Responses、
  Anthropic Messages、Gemini）、上游的 Key。它列出的模型就是上游自己的模型，
  从 sidecar 那边问来的，每个模型带低/中/高/特高/最高五档思考等级可选。
- **sidecar**（`sidecar/`）是一个小的 Go 程序：通过 DoH 解析每个上游的 ECH
  配置，用 Encrypted Client Hello 建连，再把请求转发过去。解析不到配置时，
  对 Cloudflare 后面的上游用内置的 Cloudflare 配置兜底。
- **hooks**（`ech.hooks.js`）跑在 Bun 里（magpie 的插件宿主），那里可以起
  进程：由它把 sidecar 拉起来并维持。

## 安装步骤

### 1. 装插件

```sh
magpie plugin add github:li-notfish/magpie-ech-middleware
```

### 2. 登录

设置 → 供应商 → ECH → 登录：

| 问的 | 填的 |
| --- | --- |
| Base URL | 上游的地址，连它的版本路径一起填，比如 `https://api.example.com/v1` |
| API | 上游说的是哪种 API |
| API key | 上游的 Key |

### 3. 用起来

agent 问 `ech/<模型>`，模型就是上游列出的那些。请求从 sidecar 出去，网络上
看到的是掩护名，不是厂商的名字。

## 多个上游

一个供应商可以登录多次：再登录一次，填另一个地址和 Key，就是另一个上游。
同一个厂商的两个 Key 也没问题。每个账号只承接它自己列出的模型。

## 选项

都是插件自己的选项，在 `plugins.json` 里：
`magpie plugin options <名字> '<json>'`。

| 选项 | 默认 | 做什么 |
| --- | --- | --- |
| `port` | `8790` | sidecar 监听哪个端口 |
| `doh` | `""` | 查上游 HTTPS 记录用的 DoH 端点，逗号分隔；留空用内置列表 |
| `echFallback` | `""` | DoH 查不到 ECH 配置时 sidecar 用的配置：`cloudflare`、`always`、`off`，或一段 base64 的 `ECHConfigList` |

选项是插件加载的时候读的，plugins.json 变了 magpie 会重新加载插件。

## DoH 解析器

sidecar 先从上游域名的 HTTPS 记录里读 `ech` 配置。默认会同时问这些 DoH 端点：

```text
https://dns.alidns.com/resolve
https://223.5.5.5/resolve
https://doh.pub/dns-query
https://dns.google/resolve
https://cloudflare-dns.com/dns-query
```

要换成自己的解析器，用 `doh` 选项，多个地址用逗号分隔：

```sh
magpie plugin options magpie-ech-middleware '{"doh":"https://doh.pub/dns-query,https://dns.alidns.com/dns-query"}'
```

设置后会**替换**内置列表，不是追加。JSON 形式的 DoH（如
`https://dns.alidns.com/resolve`）和 RFC 8484 wire 形式（如
`https://doh.pub/dns-query`）都支持。地址要填到实际的查询端点。

`doh` 只决定“去哪里查 ECH 配置”，它本身不提供 ECH 配置。阿里云、DNSPod
作为 DNS 托管商不会给域名一份通用 ECH；ECH 配置由实际承载流量的 CDN/边缘
按域名发布，sidecar 查到什么就用什么。

DoH 端点在 sidecar 启动时读取；改完选项后重启 Magpie。

## 一个请求会经过什么

1. 插件被加载：登录过的每个上游被写进 sidecar 要服务的名单；拉模型或第一个
   请求都会把 sidecar 拉起来。
2. agent 问 `ech/<模型>`。magpie 把它路由给 ECH 供应商，这个账号的 loader 说
   base 是 `http://127.0.0.1:8790/<上游的名字>`。
3. sidecar 用 Encrypted Client Hello 跟上游的地址建连：网络上看到的是掩护名，
   不是厂商的名字。
4. 请求到了厂商，回答原路回来。

## sidecar 服务哪些上游

插件把它们写进自己那个文件夹，在 magpie 的目录下：

```
<magpie 的目录>/magpie-ech-middleware/upstreams.json
```

```json
{
  "api-example-com-v1-9f86d081": "https://api.example.com/v1"
}
```

每个名字就是登录时填的一个地址。sidecar 会盯着这个文件，变了就重读：后来
登录的上游不用重启 sidecar 就能服务。

不发布 ECH 配置的供应商，可以在这个文件里手写一份：

```json
{
  "api-example-com-v1-9f86d081": { "url": "https://api.example.com/v1", "ech": "<base64 的 ECHConfigList>" }
}
```

## ECH 兜底

有些网络会挡 DoH，或者把 HTTPS 记录里的 `ech` 参数剥掉。所有解析器都答不出
ECH 配置时，sidecar 会用内置的 Cloudflare 边缘 ECH 配置（掩护名
`cloudflare-ech.com`）兜底。内置配置只给地址落在 Cloudflare 自己网段里的上游
用：别的服务器会按掩护名应答，握手会失败。

这次查询是有界的：所有解析器同时问，各自只给 5 秒，所以挡掉其中几个的网络不会
在兜底之前就把模型列表的 20 秒预算用完。用内置配置发起的握手也有上限；边缘拒绝
它、或者边缘给出的重试配置没有完成握手时，这条连接会改走普通 TLS。

这份内置配置只是猜测，因为不是每个接入 Cloudflare 的站点都启用了 ECH。边缘
拒绝它、又没有给出另一份配置时，sidecar 会对这条连接改用普通 TLS 重试，所以
没启用 ECH 的上游仍然能用。只有这份内置猜测可能这样改走普通 TLS：DoH 查到、或者
`upstreams.json` 里给出的配置不会被悄悄降级。如果宁可用不了也不接受明文
连接，就关掉兜底。

- `ECH_SIDECAR_ECH_FALLBACK=off`（或 `-ech-fallback ""`）关掉兜底。
- `ECH_SIDECAR_ECH_FALLBACK=<base64 ECHConfigList>`（或
  `-ech-fallback <base64>`）换成自己的配置，对所有上游生效。
- `ECH_SIDECAR_ECH_FALLBACK=cloudflare`（默认）保留内置配置。
- `ECH_SIDECAR_ECH_FALLBACK=always` 对所有上游都用内置配置，即使看不出它的
  地址是 Cloudflare 的。
- `upstreams.json` 里手写的 `ech` 仍然优先于以上所有。

`cloudflare` 是唯一有名字的内置配置。DoH 解析器和 ECH 兜底是两件事：`doh`
只决定去哪里查配置，`echFallback` 决定查不到时用哪份配置。阿里云、DNSPod
的 DoH 端点可以通过 `doh` 填写，但它们不是内置 ECH 配置。别的边缘自己的
配置，可以写进 `upstreams.json` 给那个上游用；如果一份配置适合所有上游，
也可以 base64 传给 `echFallback`。

命令行 flag 优先于环境变量，两者都优先于内置默认值。插件选项里的
`echFallback` 就是这个 flag：设了它，它会被当作 `-ech-fallback` 传给 sidecar，
同样优先于环境变量；留空时仍看环境变量和内置默认值。sidecar 是在启动时读它的，
改完要重启 magpie 才会生效。

## 单独跑 sidecar

sidecar 本身是个程序，可以手动跑：

```sh
ech-sidecar.exe -upstreams-file upstreams.json -listen 127.0.0.1:8790 \
  [-doh "https://doh.pub/dns-query,https://dns.alidns.com/dns-query"] \
  [-ech-fallback cloudflare]
# 插件下载的那个、sidecar/bin/ 里的，或 PATH 上的
```

它监听起来之后往 stdout 写一行 JSON：

```json
{"ok":true,"port":8790,"upstreams":{"api-example-com-v1-9f86d081":{"url":"https://api.example.com/v1","ech":false,"cover":""}}}
```

这行说的是它监听起来没有。ECH 配置是之后在后台查的，所以这行里 `ech` 是
false、`cover` 是空的：它是就绪信号，不是握手的结论。`/_ech/health` 回答的是
此刻的状态，不碰厂商：

```json
{"ok":true,"upstreams":{"api-example-com-v1-9f86d081":{"url":"https://api.example.com/v1","ech":true,"cover":"example.com"}}}
```

`ech` 说有没有在用配置列表，`cover` 是外面那个 hello 带的掩护名，也就是网络上
看到的那个名字。

请求由路径里点名的上游来服务：`/<上游的名字>/chat/completions` 走到那个上游，
挂在它自己的地址底下。

仓库里不带二进制。它们是 [sidecar 发布](https://github.com/li-notfish/magpie-ech-middleware/releases/tag/sidecar)
的附件，每个平台和架构一份，所以装上包就能用，不需要 Go：第一次需要
sidecar 时，它的二进制会下载到 magpie 目录下本插件自己的文件夹里、按包的
版本分目录保留。升级包后会下载新版本自己的二进制，不会继续运行上一版留下的：

| 平台 | 附件名 |
| --- | --- |
| Windows x64 / arm64 | `ech-sidecar-win32-x64.exe`、`ech-sidecar-win32-arm64.exe` |
| Linux x64 / arm64 | `ech-sidecar-linux-x64`、`ech-sidecar-linux-arm64` |
| macOS x64 / arm64 | `ech-sidecar-darwin-x64`、`ech-sidecar-darwin-arm64` |

改 `sidecar/` 下的代码必须同时提升包的 `version`：下载的二进制按包的版本分目录
保留，同一版本已经下载过的机器会继续用之前那份。

手动放进 `sidecar/bin/<平台>-<架构>/` 的二进制，或者 `ECH_SIDECAR_PATH` 指定的，
优先于下载。发布里没有附件的平台有 Go 源码在旁边：机器上有 Go 1.26 或
更新版本（第一个 `crypto/tls` 会说 Encrypted Client Hello 的版本）时，包会
自己把它编出来：

```sh
npm run build
```

## 出问题时

- **模型列不出来** —— 地址不对、sidecar 没起来，或者上游没有模型列表的
  端点：模型就保持原样，magpie 的日志里会说一声。旧版本登录的账号没有
  存下地址：重新登录一次。插件给第一次列表 18 秒，留在 magpie 的 20 秒
  预算内；sidecar 还在下载或查配置时，模型保持原样，下一次列表会用已经
  起来的 sidecar。
- **某个上游没有 ECH 配置** —— 它不发布 HTTPS 记录，或者记录里没有 `ech`：
  Cloudflare 后面的上游会用内置配置兜底；不是 Cloudflare 的可以在
  upstreams.json 里手写一份（见上），或者在所有上游都能用同一份配置时用
  `echFallback` 选项。
- **DoH 查不到** —— 当前网络可能挡了内置解析器，或者记录确实没有 `ech`：
  在 `doh` 选项里填一个当前网络可用的 DoH 端点，再重启 Magpie。DNSPod 的
  `https://doh.pub/dns-query` 和阿里云的 `https://dns.alidns.com/dns-query`
  都可以直接填。
- **急着用、不在乎这一条明文** —— 设 `ECH_SIDECAR_ALLOW_PLAIN=1` 再重启
  magpie：查不到 ECH 配置的上游会明文连出去。
- **sidecar 起不来** —— 二进制下载不到（这个平台没有发布附件，或者没网）时，
  先在有 Go 的机器上 `npm run build`，或手动放一个到 `sidecar/bin/`；端口被占了
  就在选项里换一个。
