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
| ② | `auth.methods[].authorize()` | 华为云 OAuth（PKCE + DPoP）；**两个入口**共用同一条流程 —— 主入口先复用凭据，第二入口「添加其他华为云账号」开一次性隔离窗口 |
| ③ | `auth.refresh(auth, provider)` | STS 续期，带并发去重闸 |
| ④ | `auth.loader(getAuth, provider)` | 请求接管（Bearer → Basic）|
| ⑤ | `auth.usage(getAuth, provider)` | 订阅积分分桶 |
| ⑥ | `auth.checkin(getAuth, provider)` | 每日签到（**开关与按钮由宿主提供**；插件只做一次领取，不写定时器）|
| ⑦ | `provider.models(provider, {auth})` | 每账号目录（失败回退静态表）|
| ⑧ | `"chat.headers"(input, output)` | 会话保持 |
| ⑨ | `accountId` / `uid` / `icon` / `maxConcurrency` | 卡片显示名（手机号，IAM 读一次，打码 `138****8000`）/ 身份（华为云 domain id）/ 图标 / 并发 3。取不到手机号才回落到 domain id |

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

### 两个登录入口（`auth.methods`）

`auth.methods` 是两条，但**共用同一条 OAuth 流程** `startOAuthAuthorization`：

| 入口 | `authorize` | 复用凭据？ | 窗口 |
|---|---|---|---|
| `华为云账号`（主入口） | `probeClientLogin` → 已保存凭据 → MaaS 探测；都不行才 `startOAuthAuthorization()` | 是 | 宿主系统浏览器 / 受控控制台窗口 |
| `添加其他华为云账号`（第二入口） | `() => startOAuthAuthorization({ isolated: true })`，**直接**走 OAuth | 否（跳过 `probeClientLogin` / `probeMaasAccess`） | 插件自己开的一次性隔离 Chromium |

第二入口的隔离实现是 `src/isolated-login.mjs` 的 `launchIsolatedLogin`：

- `mkdtemp(join(os.tmpdir(), "officeace-isolated-login-"))` —— 每次点击一份全新 `--user-data-dir`；
- 参数只有 `--user-data-dir=…` + 四个干净启动开关（`--no-first-run` / `--no-default-browser-check` / `--disable-extensions` / `--disable-background-networking`），**不开** `--remote-debugging-port`、**不指定** `--profile-directory`；
- 只等 `spawn`（毫秒级），**不等用户登录** —— 等用户是 `callback`；
- 返回 `{url, opened: true, method: "auto", instructions, callback}`：`opened: true` 告诉 magpie「窗口已经由插件打开」，不要再开系统浏览器；
- `callback` 的 `finally` 里 `await close()`：`SIGTERM` → 有界等待 3s → 补 `SIGKILL`，然后删本次临时目录；`close` 幂等，只杀自己 spawn 的 child，绝不按进程名 / 端口批量清理；
- 启动失败（没浏览器 / spawn 抛错 / ENOENT / 5s 超时 / 取消）一律返回 `ok:false` 的**同形句柄**，`callback` 直接 `{type:"failed"}`，**不回退**日常浏览器；同时 `beginLogin.close()` 取消授权码轮询，不留 10 分钟后台循环；
- `isDailyProfilePath()` 兜底：临时目录如果指向日常 Chrome / Edge / Brave / Vivaldi / 360 / QQ 的 `User Data`、`~/.config/google-chrome`、macOS `Application Support/...`，或 officeace 自己的持久控制台 profile（`~/.cache/magpie/officeace-huawei-<account>/profile`，可用 `MAGPIE_CACHE_DIR` 覆盖），**拒绝启动且绝不删除**那个目录；
- 启动/关闭所 await 的定时器必须 **ref**：Linux 在没有其它活动句柄时，`unref` 会让事件循环提前结束（CI 曾因此 `cancelledByParent`）；settle/close 一定清掉，最终 `_internal.activeTimers()` 归零，不留常驻定时器。

与 `src/console-browser.mjs` 的分工（别混）：console-browser 是登录**之后**打开 MaaS 控制台，用**持久** profile + `--remote-debugging-port` + CDP 抓 Cookie；本模块是登录**之前**打开 OAuth 授权页，用**一次性** profile、不开调试端口。两者唯一共用 `findBrowser`。

测试：`tests/isolated-login.test.mjs`（18 条，假 spawn / 假 fs / 假 browser + 独立 Node 空事件循环回归）、`tests/add-account.test.mjs`
（3 条：第二入口跳过复用、隔离失败并取消轮询、OAuth 结束后关闭窗口）与 `tests/login-cancel.test.mjs`。

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

## 出站 UA：只有一条，两个 provider 共用

**为什么必须显式给**：链路是 DSH → magpie → 插件 host → 上游。magpie 给插件宿主的 UA
固定是 `magpie/<version>`；插件不覆盖就原样透传，而上游网关按 `<产品名>/<版本>` 形态
识别「第三方客户端」，命中即回

```
403 {"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试"}
```

codearts 的 snap-access 网关（`snap-access.cn-north-4.myhuaweicloud.com`）就是这套
腾讯式错误码；officeace 的 CLAW / 订阅面 / MaaS 三域同属一套边缘网关，同样按这个判。

**取值**：`src/constants.mjs` 的 `UA`（完整 Chrome UA）。证据等级说明：

| 候选 | 有没有证据 | 结论 |
|---|---|---|
| 仓库里抓到的官方客户端 UA | **没有**。docs / 测试夹具 / 常量里都没有 UA 形态 | 用不了 |
| 华为云 SDK 名当 token（`SDK-HMAC-SHA256` 之类） | 那是**签名算法名**，不是客户端 UA | 不适用 |
| 完整 Chrome UA | 官方网页控制台（OfficeAce / CodeArts 控制台）就是网页客户端，规则里「官方是网页就用完整 Chrome UA」 | **采用**（等级 B：形态推理 + 真机 200） |

**签名与 UA 的关系（改这块前必看）**：UA **不参与签名**。
`signHuaweiRequest` / `signRequestHuawei` 只签它们自己那几项
（`host;x-sdk-date;…`），`signV11Request` 只签 `x-subscription-type` /
`x-sdk-date` / `x-security-token` / `host`（+`content-type` / `x-project-id`）。
UA 一律在签名算完之后 `set` 进去 —— 这样 `SignedHeaders` 与线上已跑通的形态逐字节一致，
只是多带一个不参与校验的头。判据：`node --test tests/ua.test.mjs`
（断言 `SignedHeaders` 里没有 `user-agent`）。

**出站点清单（全部引用同一条常量）**：

| 文件 | 位置 | 用途 |
|---|---|---|
| `src/crypto.mjs` | `signHuaweiRequest` 返回值 | CLAW 权限校验 / 组织 / 订阅（maas.mjs、login.mjs 都吃它）|
| `src/crypto.mjs` | `signV11Request` 的 fetch | 额度 / 签到 / 倍率 |
| `src/login.mjs` | `registerState` / `pollCode` / `exchangeToken` / `doRefresh` | OAuth 与 STS 换 token |
| `src/api.mjs` | `fetchCatalog` | MaaS 模型目录 |
| `src/chat.mjs` | `chatFetch` | MaaS 对话（真正跑模型那条）|
| `src/codearts/index.mjs` | `signFor`（唯一签名出口）| snap-access / opengw / queue 轮询 |

`src/console-browser.mjs` 里打 `127.0.0.1` 的 CDP（`/json/list` 与 WebSocket）是本机
浏览器，不出网，不需要 UA。

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

### 聊天参数：/api/v1 的生成前三族校验（2026-11-13 实测）

`/api/v1/chat/completions` 在**开始生成之前**做参数校验，违规一律回同一个泛化错误
（约 0.15–0.65 s，body 可以只有 ~130 B、无 tools、无 system）：

```
400 InferHub.001001005.400  The request param is invalid, Please check it
```

三族参数各自独立触发（同一账号、同一 STS 签名、逐项只叠加一个变量）：

| 参数族 | 放行 | 违规 → 400 |
|---|---|---|
| `max_tokens` / `max_completion_tokens` | ≤ **32000** | 32001、32768、65536、131072 …（deepseek-v4.1-flash / kimi-k3.1-pro / glm-5.3 / openpangu-2.0-pro 四个模型同一条线） |
| `seed` | `0` / `1` | `2`…`2048`、`-1`、`2^31-1`、`"42"`、`42.0`、`true` / `false`（29/29 次 400） |
| `stop` | 单个字符串 | 数组（`["\n"]`、`["x"]`、`["x","y"]`、甚至 `[]`，11/11 次 400） |

两条容易踩的补充：

- **`max_completion_tokens` 只在 `max_tokens` 缺席时才被校验**：两者同时给时上游以
  `max_tokens` 为准（`max_tokens=16` + `max_completion_tokens=65536` → 200；只有
  `max_completion_tokens=65536` → 400）。插件的夹取对两个键都做。
- **`stream: false` 的折叠路径会把 `seed` 丢掉**：同一 `seed=42` 非流式 3/3 次 200，
  流式 3/3 次 400 —— 因此用非流式探针测不出 `seed` 这一族；`stop` 数组在非流式仍然 400。
- **不要用单次 200 当作「参数合法」**：边界值偶发会走上一条慢速回退路径（14–39 s 后
  200，SSE 不收尾）。判边界要用「32000 过 / 32001 拒」这样的成对复测。

⇒ 代码侧对应：`MAX_OUTPUT_TOKENS = 32_000`（夹 `max_tokens` / `max_completion_tokens`），
`prepareChatBody` 里再由 `sanitizeUnsupportedParams` 删掉违规 `seed`、把单元素 `stop`
数组转字符串。模型目录 `GET /v1/model/builtin` 自报的 `max_tokens: 65536` 是 `/api/v2`
的预算，**不能**直接当聊天端的 `max_tokens` 上报给宿主或下游客户端。

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

⚠ **重复领取是幂等的** —— 服务端 2xx 但 `bonus_skus` 为空表示今天已领取，按 scaffold 0.3.13
契约返回 `claimed`（宿主据此盖当天时间戳），**不是 `failed`**，也不重复记账；重复调用 `credit:0`，
表示本次没有新领取。2xx 但响应无法解析仍归 `done`（无法确认今天的入账，不能冒充 `claimed`）。

### 签到开关与按钮由宿主提供

插件**只实现 `auth.checkin`**，其余全部是 magpie 的：

- **「每日自动签到」开关**：magpie 的**设置 → 用量**；插件不声明自己的选项，也不新增重复开关。
- **「立即签到」按钮**：宿主在**每个账号**那一行画（`auth.checkin` 存在即出现）；插件不自己画按钮 / 不加页面入口。
- **调度**：宿主按**北京时间**每账号每天调一次，当天失败后还会再调；记账写宿主的
  `~/.config/magpie/plugin-checkin.json`（插件不写这个文件）。
- **插件不写定时器**：判据是 `grep -n "setInterval\|cron" index.mjs src/*.mjs` 没有调度器
  （`src` 里的 `setTimeout` 全是单次请求超时）。自己写定时器会：重启即失效、和宿主撞车重复签、
  用户关掉开关后仍在跑。
- **插件只做一次领取**：临期先续期（续不动就用旧凭据试一次），再 `POST /v1/subscription/bonus/claim`；
  返回 `claimed` / `done` / `failed` 等，失败也不影响额度与对话。

### CodeArts 自动邀请

协议证据来自官方 `CodeArtsWorkWeb/126.10.10.20261110214624` 打包产物，不是从其它供应商猜的：

1. `GET /v1/ops/delivery?channel=IDE` 里取 `type === "INVITE_USER" / "invite_user"` 的活动；
2. `POST /v1/ops/invite/generate`，body 是 `{campaignId, channel:"WEB"}`，响应读
   `data.inviteUrl`（从 `?invitecode=` 提码）或 `data.inviteCode`；
3. 新账号 OAuth 成功后，`POST /v1/ops/invite/confirm-by-code?inviteCode=<code>`（无 body）确认邀请关系。
   `authorize()` 登录前记下 `knownUids`；身份已在其中的旧账号重登直接跳过第 3 步，只有新账号才确认。
   拿不到身份时仍尝试一次并由服务端判定，失败只记 warning，不让 OAuth 失败。

`auth.options[].invite_mode` 是 provider 级布尔开关，`default:false`、`placement:"top"`，每次经
`_ctx.magpie.option("codearts", "invite_mode")` 现读，不在工厂构造时缓存。`prompts` 与 `ask()` 同时保留；
联网取码只在 `ask()`，`authorize()` 只做纯本地源解析。

- **off**：最新注册账号有码直接用；没码则用该账号凭据生成，失败回退上一个有码账号，再回退预留码。
- **on**：`logins.json` 的 `first:true` → 最小正 `order` → 第一行决定首选，`home` 映射到
  `plugin-auth.json` 的 `uid || accountId`；首选没码/失败只回预留，`home` 映射失效（含账号已删）也直接回预留，绝不顺移换号。
- `firstSeenAt` 只写一次；首次同步多个旧账号时按 `plugin-auth.json` 的加入顺序赋先后，避免同毫秒排序反转。
- 每 uid 24 小时最多 generate 一次（失败也节流）；已删除账号不作源，账号文件读不到时不把全量账号误判删除。
- 状态只写 `~/.cache/magpie/codearts-invite.json`（账号时间、邀请码、预留码、尝试时间），原子替换；
  凭据仅在内存里传给 `snapRequest`，不落盘。`plugin-auth.json` / `logins.json` 只读。

OfficeAce 的订阅面没有这套邀请路由，不能把 CodeArts 的端点或签名搬过去。

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
签到          ✅ claimed +100（重复调用返回 claimed +0 —— 今天已领取，不重复记账）
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
- **不做 OfficeAce 邀请**：OfficeAce 订阅面没有邀请路由，不伪造开关或端点。CodeArts 的
  `INVITE_USER` / generate / confirm-by-code 已实现并有离线协议与接线测试，见上「CodeArts 自动邀请」。
