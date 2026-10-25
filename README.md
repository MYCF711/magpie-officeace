# magpie-officeace-auth

OfficeAce（华为云 AgentArts / MaaS）的 magpie / OpenCode 供应商插件。

**一个供应商，一个包，不聚合。** provider id 是 `officeace`。

## 签入什么

[OfficeAce](https://www.officeace.com)（华为云 AgentArts 平台）的编码套餐。
Provider id：`officeace`。

## 怎么登录

用浏览器登录华为云账号。**不需要装 OfficeAce 客户端。**

```
magpie plugin login officeace
```

插件会打开华为云的登录页，登录完成后本窗口自动继续。**没有密码输入框** ——
登录完全在华为云的页面里完成，插件只负责轮询结果。

登录走的是华为云 OAuth（PKCE + DPoP）：

```
1. POST {CLAW}/v1/claw/auth/state          云端登记 state
2. 打开 auth.huaweicloud.com（PKCE + DPoP）
3. 轮询 GET {CLAW}/v1/claw/auth/code?state=…  拿授权码
4. POST sts.cn-north-4/v1/oauth2/tokens    换 STS 凭据
5. GET {CLAW}/v1/claw/client-permission-validate  拿 MaaS 的 appKey/appSecret
```

## 登录态存在哪

`~/.config/magpie/plugin-auth.json` 的 `officeace` 键
（第二个账号起为 `officeace#xxxxxx`）。

记录里 `access` 字段是一份 JSON 字符串，含 STS 三元组
（`access` / `secret` / `securityToken`）+ MaaS 的 `modelAppKey` /
`modelAppSecret` + `dpopPrivateJwk`（**续期要用同一把钥匙，不能丢**）。

token 到期前 **10 分钟**自动续期。

## 模型

登录后从 `GET /v2/models` 拉真实目录，实测 **26 个**，包括：

```
deepseek-v4.1-flash   deepseek-v4-flash   deepseek-v3.2
glm-5.3   glm-5.3-flash   glm-5.2   glm-5.1   glm-5
kimi-k3.1-pro   kimi-k3   kimi-k2.6
qwen3-30b-a3b   qwen3-32b
openpangu-2.0-pro   openpangu-2.0-flash
```

模型名后带消费倍率（`GLM-5.2 · x0.7`），倍率来自
`GET /v1/model-token-rates`，与选择器同源 —— 显示的倍率就是实际计费。

未登录时显示内置的 10 个兜底模型。

## 能力

| 能力 | 说明 |
|---|---|
| 华为云 OAuth 登录 | PKCE + DPoP，浏览器轮询 |
| STS 自动续期 | 提前 10 分钟，带并发去重闸 |
| 模型目录 | 26 个，含消费倍率 |
| 积分额度 | 卡片进度条（套餐桶 + 活动桶）|
| 每日签到 | `POST /v1/subscription/bonus/claim` |
| 工具调用 | 透传（上游是 OpenAI 协议）|
| 代理 | 跟随 magpie 的 provider 代理设置 |

## 额度显示

订阅面返回两类桶，都转成 magpie 的 windows：

```
个人体验版 · 剩 500          500 / 500
新用户专属福利 · 剩 2461.69   2461.69 / 4000
每日签到有礼 · 剩 100         100 / 100
```

⚠ `.trial` 后缀的套餐桶**不带到期时间**（试用不过期语义）——
不猜，照实显示。

已过期的桶会标 `aside: true`，magpie 收进折叠区。

## 开发

```bash
# 沙箱里试，不碰你自己的 magpie
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache \
      MAGPIE_ADDR=127.0.0.1:3499 magpie "$@" ; }

m plugin add ./
m plugin --json
m plugin login officeace
m provider test officeace
m quota
```

## 实测记录（2026-10-25）

```
模型目录     ✅ 26 个
额度         ✅ plan 个人体验版，3 个窗口
签到         ✅ claimed +100（重复调用返回 done —— 幂等判定正确）
倍率         ✅ 9 条
凭据往返     ✅ toStored → credentialOf 一致
```

## 图标

内嵌在 `package.json` 的 `magpie.icon` 和 `index.mjs` 的 `auth.icon` 里
（OfficeAce 官方 `.ico` 转 128×128 PNG，13.6 KB 的 data URI）。

**为什么不用 https URL：** magpie 只存不拉（契约原文
"nothing is fetched here"），git 源下的外部图片不会渲染，卡片会显示默认拼图。

## 鸣谢

这个插件的协议实现不是凭空写出来的，参考了下面三个仓库。三个都是 **MIT**，与本项目许可兼容。

### 1. [theseaiying/magpie-officeace-plugin](https://github.com/theseaiying/magpie-officeace-plugin) · MIT

同为 OfficeAce 的 magpie 插件。**参考了 V11 签名**：

| 位置 | 参考了什么 |
|---|---|
| `src/crypto.mjs` `signV11Request` | 派生密钥公式：`HMAC(HMAC(access, secret), scope + 0x01)[:32].hex` |
| `src/constants.mjs` `SERVICE` | `apic` —— V11 credential scope 里的服务名 |

这个公式不能直接拿 `secret` 用，也不在华为云公开文档的显眼位置；没有参考实现，靠试错很难凑对。

其余部分独立实现：登录流程（PKCE + DPoP）、额度分桶、签到、倍率缓存、模型过滤。

### 2. [Gyl1219/magpie-providers-hub](https://github.com/Gyl1219/magpie-providers-hub) · MIT

把多个供应商聚合成一个插件。**参考了域名分工**：

| 位置 | 参考了什么 |
|---|---|
| `src/constants.mjs` | `CLAW_BASE`（登录/权限）和 `SUBSCRIPTION_BASE`（额度/签到）**不是同一个主机** |

这一条很关键：用错主机会返回 `404 APIGW.0101` 而不是 `401`，很容易被误判成签名错误。
它的注释直接指出了这一点。

### 3. [yetone/magpie](https://github.com/yetone/magpie) · MIT

magpie 本体。**参考了插件契约**：

| 位置 | 参考了什么 |
|---|---|
| `index.mjs` 九个钩子 | 契约源码（二进制里嵌的那份，以及 `internal/plugin/` 的 Go 实现）|
| `src/self-register.mjs` | `internal/plugin/market.go` 的 `market()` —— 理解缓存为何会被整体替换 |
| 全部 | `auth.checkin` 等文档未列的钩子 |

### 没有用到的

- 竞品的测试文件（`*.test.mjs`）—— 本插件没有测试
- 竞品的 `index.mjs` 实现（41 KB 单文件）—— 本插件按职责拆成 7 个模块
- `magpie-providers-hub` 的 `src/*.mjs` 渠道实现

## 许可

MIT

## 非官方声明

本插件与华为云、OfficeAce 无任何关联。调用的是 OfficeAce 客户端同款接口，
接口可能随时变动。