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

## 许可

MIT

## 非官方声明

本插件与华为云、OfficeAce 无任何关联。调用的是 OfficeAce 客户端同款接口，
接口可能随时变动。