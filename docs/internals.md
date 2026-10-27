# 实现细节（给要改这份代码的人）

> 这是插件 README 的技术附录。**装机用户看 [README](../README.md) 就够了。**
>
> 这里放的是：协议事实、为什么这么上报、怎么验证、哪些地方故意不做。
> 每条都尽量带「实测判据」—— 不是推测。

OfficeAce（华为云 AgentArts / MaaS）做成 magpie 供应商插件：华为云 OAuth（PKCE + DPoP）
登录、实时模型目录与消费倍率、订阅积分分桶、每日签到，以及 Bearer → Basic 的请求接管。

```
github:MYCF711/magpie-officeace (OfficeAce 0.1.7)  on
  officeace (OfficeAce, 7 models)  signed in as <账号>
```

---

## 这个插件只做一件事

OfficeAce 的 `/v2` 端点要 `Authorization: Basic base64(appKey:appSecret)`，
而 magpie 底下的 AI SDK 只会发 `Bearer` ——

插件把 `Bearer` 改写成 `Basic`，把 `officeace/<id>` 还原成厂商 id，别的原样转发。
**上游本来就是 OpenAI 协议，没有协议转换。**

---

## 九项清单（一项不缺）

| # | 钩子 | 干什么 |
|---|---|---|
| ① | `config(cfg)` | 声明 provider + 静态模型表（未登录时也必须有内容，否则 magpie 显示 `0 models`）|
| ② | `auth.methods[].authorize()` | 华为云 OAuth（PKCE + DPoP）|
| ③ | `auth.refresh(auth, provider)` | STS 续期，带并发去重闸 |
| ④ | `auth.loader(getAuth, provider)` | 请求接管（Bearer → Basic）|
| ⑤ | `auth.usage(getAuth, provider)` | 订阅积分分桶 |
| ⑥ | `auth.checkin(getAuth, provider)` | 每日签到 |
| ⑦ | `provider.models(provider, {auth})` | 每账号目录（失败回退静态表）|
| ⑧ | `"chat.headers"(input, output)` | 会话保持 |
| ⑨ | `accountId` / `uid` / `icon` / `maxConcurrency` | 卡片显示名、图标、并发 3 |

---

## 登录

浏览器完成华为云登录，**没有密码输入框** —— 插件只负责轮询结果。

```
1. POST {CLAW}/v1/claw/auth/state                云端登记 state
2. 打开 auth.huaweicloud.com（PKCE + DPoP）      用户在页面里登录
3. 轮询 GET {CLAW}/v1/claw/auth/code?state=…      拿授权码
4. POST sts.cn-north-4/v1/oauth2/tokens           换 STS 凭据
5. GET {CLAW}/v1/claw/client-permission-validate  拿 MaaS 的 appKey/appSecret
```

⚠ `authorize()` **必须立刻返回**，不能在里面等用户完成登录 —— 真正等的是 `callback()`。
死等会让双方互等（magpie 要拿到 url 才会去开浏览器）。

### 凭据存在哪

`~/.config/magpie/plugin-auth.json` 的 `officeace` 键（第二个账号起为 `officeace#xxxxxx`）。

记录里 `access` 字段是一份 **JSON 字符串**，含：

| 字段 | 是什么 |
|---|---|
| `access` / `secret` / `securityToken` | STS 三元组（V11 签名用）|
| `modelAppKey` / `modelAppSecret` | MaaS 的 Basic 凭据 |
| `dpopPrivateJwk` | DPoP 私钥 —— **续期要用同一把钥匙，不能丢** |
| `maasBaseUrl` | 推理域，可能为空（→ 回退官方直连）|
| `refreshToken` | 华为云 STS refresh |

⚠ 这个形状是**前版插件留下的**，保持不变 ⇒ 老用户登录态直接复用，不用重新登录。
**改形状 = 让所有人的登录态失效。**

⚠ `maasBaseUrl` 可能是**不带协议的裸域名**，直接拼路径会 `Failed to parse URL`，
必须补 `https://`；也可能是空串（实测当前凭据就是空的）→ 回退
`https://api.modelarts-maas.com`。

token 到期前 **10 分钟**（`EXPIRY_LEAD_MS`）自动续期。

---

## 三个域，不能混

| 域 | 用途 |
|---|---|
| `agentarts.cn-southwest-2.myhuaweicloud.com` | 登录 / auth / 权限校验 |
| `sts.cn-north-4.myhuaweicloud.com` | STS token 交换 |
| `api.modelarts-maas.com` | 推理域（模型目录 + 对话）|
| `officeace.cn-southwest-2.huaweicloud-agentarts.com` | 订阅面（额度 + 签到 + 倍率）|

⚠ **真机教训**：额度与签到挂在**订阅面**，不是 CLAW 域。打 CLAW 域回
`404 APIGW.0101 API 不存在` —— 签名是对的（签名错是 `401`），纯粹主机不对。

---

## 模型：26 / 9 / 7

三个数字，别混：

| 来源 | 含义 | 实测（2026-10-26） |
|---|---|---|
| `GET {maas}/v2/models` | **注册表** —— 连测试版和没开通的一起列 | 26 条 |
| `GET {SUB}/v1/model-token-rates` | **计费清单** —— 真会扣积分的 | 9 条 |
| magpie 实际显示 | 交集，再剔掉已知必 404 的 | **7 条** |

⚠ 直接拿注册表会给出 26 个，其中 19 个选不了 —— **比少给更糟**：
失败发生在对话时，而不是在选择时。OfficeAce 桌面端自己也只显示计费清单里的。

倍率表里另有 2 个 id（`glm-5`、`deepseek-v3.2`）不在注册表里，故不进 7 条。

### 能力字段是声明，不是探测

上游目录**只有 id 和 name，没有能力元数据**（`src/api.mjs` 的注释）。
所以 `modelEntry()` 里的 `context: 1M` / `output: 128K` / `toolcall: true` /
`reasoning: true` / `image: false` 是按已知信息**声明**的值 ——
其中工具调用与推理链有实测支撑，上下文窗口是保守声明。

改这里要注意：报大了会让用户拿超长上下文去撞上限，报小了白白浪费。

### 实测调不通的注册表占位 id

判据是 `POST /v2/chat/completions` 的**状态码**，不是「名字看着像测试版」：

| id | 注册表 | 计费清单 | chat 实测 |
|---|---|---|---|
| `deepseek-v4.1-flash-1017` | ✅ | ❌ | **404 `ModelArts.81009 Invalid model`** |
| `deepseek-v4.1-flash-bnt` | ✅ | ❌ | **404 同上** |
| `deepseek-v4-pro` | ✅ | ❌ | **404 同上** |
| `deepseek-v4.1-flash-0930` | ✅ | ❌ | 200，但回显 `model="deepseek-v4.1-flash"`（别名）|

名单见 `src/models.mjs` 的 `UNAVAILABLE_IDS`，**任何情况下都不列出**。

⚠ 1017 带 `maas_type: benefit` 头重试**仍然 404** —— 别照抄 CodeArts 那条
「0731 缺 benefit 头」的经验，两家不是一个网关。
⚠ 换官方直连 `api.modelarts-maas.com` 也救不了：那台要 AK/SK 签名，
Basic 凭据回 `400 ModelArts.81002`。

### 倍率缓存的失败语义（真实缺陷，2026-10-26）

`fetchTokenRates` 失败时**返回上一份成功缓存，而不是空表**：

> 空表在下游会被当成「没有任何模型有倍率」⇒ 白名单失效 ⇒ 注册表 26 条
> （含 3 个必 404 的占位 id）全部吐给用户。
> 实测复现：`liveModels(rows, base, new Map())` → 26 条，其中 4 条调不通。

⇒ 语义约定：返回**非空**表 = 拿到了权威清单；返回**空**表 = 从来没拿到过。
失败也不清空缓存，且重置计时（20 分钟内不重复打失败的上游）。

其它实测形状：

- 上游 `model_name` 带**尾部换行**（`"kimi-k3\n"`），必须 `trim`
- 响应是 snake_case（`model_name` / `cost_coefficient`），兼容 camelCase
- `x1` 不标（全默认倍率没有信息量），只标非 1 的

---

## 额度分桶

订阅面返回两类桶，都转成 magpie 的 `windows`：

| 来源 | 名称 |
|---|---|
| `skus[].quotas[]`，`sku_attr_code === 'officeace_points'` | 套餐桶 |
| `bonus_skus[]` | 活动桶 |

实测三桶：

```
个人体验版 · 剩 500          500 / 500
新用户专属福利 · 剩 2220.41   2220.41 / 4000
每日签到有礼 · 剩 0           0 / 100
```

⚠ `.trial` 后缀的套餐桶**不带到期时间**（试用不过期语义）—— 不猜，照实显示。
⚠ 已过期的桶标 `aside: true`，magpie 收进折叠区，主环位留给活着的桶。
⚠ 查询失败**不吞**：带原因抛出，由调用方显示。

### 签到

`POST {SUB}/v1/subscription/bonus/claim` → magpie 六种 outcome 之一。

⚠ **重复领取是幂等的** —— 服务端 2xx 但 `bonus_skus` 为空时是 `done`（今天已领完），
**不是 `failed`**。只看状态码会误报成「签到失败」。
2xx 但响应无法解析也归 `done`（领取本身可能已成功，明天再来）。

---

## 图标

内嵌在 `package.json` 的 `magpie.icon` 和 `index.mjs` 的 `auth.icon` 里
（OfficeAce 官方 `.ico` 转 128×128 PNG，13.6 KB 的 data URI）。

**为什么不用 https URL：** magpie 只存不拉（契约原文 *"nothing is fetched here"*），
git 源下的外部图片不会渲染，卡片会显示默认拼图。

---

## 卡片标题与市场文案

两条互不依赖的路，各管一半：

| 来源 | 管什么 |
|---|---|
| 包内 `package.json` 的 `name` | **卡片标题** —— magpie 的依赖键就是它 |
| registry 条目（`registry-entry.json` → `registry.json`） | **「源码」按钮 + 中英文案 + `community: true` 标记** |

包不在 registry 里 ⇒ 卡片退回包名、没有源码按钮。所以条目的唯一去处是
`magpie-community/plugins` 的 `registry.json` —— 那是这个信息**受支持**的载体。

**插件不写 magpie 的缓存。** `~/.cache/magpie/plugin-market.json` 属于 magpie：
条目一旦由插件自己 merge 进去，每次加载都会把它那份写死的内容盖回来，
registry 这个「唯一真相」就被架空了。0.1.8 曾用 `src/self-register.mjs` 这么干，
0.1.9 删除（上游 review 里明确要求，见 CHANGELOG）。

⚠ 插件对 magpie 的目录**只有读的份**。想改卡片上看到的东西 → 改 registry 条目。

---

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

只读探针（取注册表 / 计费清单 / 额度，不签到、不写状态）：`src/api.mjs` 的
`fetchCatalog` / `fetchTokenRates` / `fetchUsage` 直接用 `credentialOf()`
读 `~/.config/magpie/plugin-auth.json` 即可。

### 实测记录（2026-10-26）

```
注册表目录    ✅ 26 条
计费清单      ✅ 9 条
实际显示      ✅ 7 个
积分分桶      ✅ plan 个人体验版，3 个窗口
签到          ✅ claimed +100（重复调用返回 done —— 幂等判定正确）
倍率          ✅ 9 条，与界面显示同源
凭据往返      ✅ toStored → credentialOf 一致
```

---

## 故意不做的事

- **不聚合**：一个供应商一个包。provider id 是 `officeace`，不与别的厂商混在一个插件里。
- **不伪造 `used`**：拿不到就是拿不到，不让这个号以「满额」的姿态排在队首。
- **不做协议转换**：上游是 OpenAI 协议，转一层只会多一个出错的地方。
- **不猜试用桶的到期时间**：`.trial` 不带到期字段就不显示到期。
- **不列选不了的模型**：见上「26 / 9 / 7」。
