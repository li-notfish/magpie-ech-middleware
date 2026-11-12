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
  从 sidecar 那边问来的，每个模型带低/中/高三档思考等级可选。
- **sidecar**（`sidecar/`）是一个小的 Go 程序：通过 DoH 解析每个上游的 ECH
  配置，用 Encrypted Client Hello 建连，再把请求转发过去。
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

选项是插件加载的时候读的，plugins.json 变了 magpie 会重新加载插件。

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

## 单独跑 sidecar

sidecar 本身是个程序，可以手动跑：

```sh
sidecar/bin/win32-x64/ech-sidecar.exe -upstreams-file upstreams.json -listen 127.0.0.1:8790
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

- **模型列不出来** —— 地址不对、sidecar 没起来，或者上游没有模型列表的
  端点：模型就保持原样，magpie 的日志里会说一声。旧版本登录的账号没有
  存下地址：重新登录一次。
- **某个上游没有 ECH 配置** —— 它不发布 HTTPS 记录，或者记录里没有 `ech`：
  可以在 upstreams.json 里手写一份（见上）。
- **急着用、不在乎这一条明文** —— 设 `ECH_SIDECAR_ALLOW_PLAIN=1` 再重启
  magpie：查不到 ECH 配置的上游会明文连出去。
- **sidecar 起不来** —— 没有二进制的平台先 `npm run build`；端口被占了就在
  选项里换一个。
