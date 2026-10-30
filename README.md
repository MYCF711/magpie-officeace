# OfficeAce for magpie

**新用户福利 4,000 积分 + 每天签到 100 积分，7 个可计费模型，倍率最低 x0.08**

OfficeAce（华为云 AgentArts / MaaS）的编码套餐接进 magpie。非官方插件，
与华为云、OfficeAce 无任何关联。

```
套餐     个人体验版 500 + 新用户专属福利 4,000 积分
签到     每日签到有礼 100 积分
模型     7 个可计费（平台目录 26 个）
倍率     x0.08 ~ x2.38
```

> **改代码 / 发版本之前**：先看 [AGENTS.md](./AGENTS.md) —— 按「你在哪一步」给阅读顺序，
> 外加本仓库 14 条**会静默出错**的坑（症状 → 判据 → 出处）。交付与发版逐条走
> [CHECKLIST.md](./CHECKLIST.md) 的两张表。
> 发布是**七步**，`git push` 只是第 4 步。

---

## 功能

- **7 个模型** —— GLM-5.3 / GLM-5.2 / GLM-5.1 / DeepSeek-V4.1 / DeepSeek-V4-Flash / Kimi-K3 / GLM-5.3-Flash，全部 1M 上下文
- **倍率标在模型名上** —— 界面显示 `glm-5.3 · x0.79`，与计费同源，标的就是实际扣的
- **只列调得通的模型** —— 平台目录 26 个里有测试版和没开通计费的，不拿选不了的 id 充数
- **积分算得准** —— 余额是 0 就显示 0，不会被当成满额排在队首
- **每日签到** —— magpie 每天自动领一次，不用点
- **不装客户端** —— 华为云登录全程在浏览器里完成
- **登录态自动续期** —— 到期前 10 分钟续，不用重登
- **换插件不用重登** —— 与前一版插件凭据同形状，登录态直接复用

---

## 模型

| 模型 | 上下文 | 倍率 |
|---|---|---|
| `glm-5.3-flash` | 1M | x0.08 |
| `deepseek-v4.1-flash` | 1M | x0.18 |
| `deepseek-v4-flash-0731` | 1M | x0.27 |
| `glm-5.1` | 1M | x0.67 |
| `glm-5.2` | 1M | x0.70 |
| `glm-5.3` | 1M | x0.79 |
| `kimi-k3` | 1M | x2.38 |

输出上限 128K。全部支持工具调用与推理链，**全部不支持图片输入**。

倍率是消费倍率，最低与最高差约 **30 倍** —— 日常活派给 `glm-5.3-flash`，
重活才用 `kimi-k3`。

模型名单来自登录后的实时目录，**按计费清单过滤**：平台目录 26 个里，只有
计费清单上有的才会列出来。计费清单拉取失败时退回**上一份成功的清单**，
不会把选不了的 id 一股脑洒出来。

---

## 签到

magpie 每天调一次 `POST /v1/subscription/bonus/claim`，领当日签到积分。

**幂等** —— 今天领过了再调，显示「今日已无新增可领」，不是失败，不会弹报错。
签到失败也不影响额度显示和对话。

---

## 未接入 MaaS：卡片标记 + 一个入口自动分流

账号登录成功、但还没在华为云侧接入 MaaS（凭据里没有 `modelAppKey`）时：

- 账号卡片上的 plan 显示 **「未接入 MaaS」**（`usage().plan`，只影响显示，不参与路由/额度判定）
- magpie 在那张卡上显示 **「Sign-in required」**；点「重新登录」走的是**同一个入口**，进去之后插件自己判断该做什么

**凭据从哪来**：内存里那份（刚读过额度、最新）优先；**没有就从磁盘读** magpie 已保存的账号
（`~/.config/magpie/plugin-auth.json`，键 `officeace` / `officeace#…`，遵循 `XDG_CONFIG_HOME`；
只读、不写、不加锁，便携版可用 `MAGPIE_OFFICEACE_AUTH_FILE` 指路）。**magpie 重启后内存是空的，
凭据仍在磁盘上** —— 这时照样复用，不要求重新登录。凭据已过期/临期且带 `refresh_token` 时，
先续一次再探测（续不动才走登录）。

**单入口的分流**（`authorize()` 里先做一次**很短**的探测，默认 1.2 秒）：

```
拿插件里已保存的登录态打一次 MaaS 侧接口（只读 GET /v1/claw/client-permission-validate）
├─ 已经开通        → 打开控制台给你用，本窗口直接完成（不轮询）
├─ 没开通          → 打开 MaaS 控制台（ModelArts），用同一份凭据每 5 秒检测一次，最长 3 分钟
│                     检测到 model_auth_info 就合并进同一份记录回写 → magpie 重读额度，标记消失
├─ 读不通（网络）  → 按「没开通」处理（控制台可能仍是好的）
└─ 凭据被拒(401/403) / 还没有登录态 → 走华为云 OAuth 登录；登录成功后标记仍在，再点一次就会带你到控制台
```

**开通本身只能你在控制台点，插件不能替你做**（已查证，见下）：控制台是**浏览器 cookie 会话**（`J_SESSION_ID`），插件的 OAuth 凭据是 API 凭证 —— 华为云**没有**「拿 access_token 换控制台 session」的公开接口（控制台免登只有账号级配置的 SAML/OIDC 联邦认证这一条路，要管理员在账号里配 IdP）。所以打开控制台后如果要求登录，用**同一个华为云账号**登录一下即可；插件不会假装能替你登进去。

**为什么开通不能全自动**（2026-10-31 查证）：

- **开通预置服务**（模型推理 → 在线推理 → 预置服务 → 开通服务）是**控制台的计费授权动作**，华为云没有对应的公开 OpenAPI（MaaS 的 API 概览里只有自定义接入点、调用统计、API Key 管理，没有「开通预置服务」）。
- **创建 API Key 有 OpenAPI**（`POST /v2/{project_id}/maas/api-auth/api-keys`，需 `X-Auth-Token`，权限 `modelarts:apiKey:create`），但那是 **IAM token**，不是我们手里的 STS 临时凭据；而且**把 Key 绑给 OfficeAce 也没有公开接口** —— OfficeAce 客户端是走它自己后端（`/api/maas-subscribe-models`）写进本地配置的。
- 插件手里的 `modelAppKey` 是 CLAW 的 `client-permission-validate` 下发的（`src/login.mjs:130`、`src/maas.mjs:60`），**只读**：开通前后它自己会出现或消失，插件无法反向创建。
- 结论：**插件能做的是「检测 + 把你送到对的地方」**，做不到「用 STS 凭据直接开通」。

已知边界：

- **多账号时按 provider 级判断**：magpie 调 `authorize()` 传的 `account` 恒为 `plugin.NewAccount`（GUI 与 CLI 都是），插件拿不到「是哪张卡」。探测用的是**最近一次见过**的那份未接 MaaS 的凭据；控制台按你浏览器里当前登录的账号开出，要开通的是另一个账号时在控制台右上角切账号。
- **已经接好 MaaS 的账号**：探测会说「已经开通」，本窗口直接完成。
- **续期与放弃**：只有在凭据临期时才会续一次；万一续完你就关掉了窗口，那份新凭据来不及写回 magpie（插件不写账号文件），下次可能要求重新登录一次。
- 插件选项：`maasProbeMs`（默认 1200，`authorize()` 里那次探测的超时）、`maasWatchMs`（默认 180000）、`maasWatchIntervalMs`（默认 5000）、`authFile`（账号文件位置，默认按上面的规则推导）。

---

## 安装

在 magpie 的 **插件 → 发现** 搜 `OfficeAce`，点**安装**。

先卸掉别的 OfficeAce 插件 —— 会抢同一个供应商。

### 命令行

```bash
# 从 npm（推荐）
magpie plugin add officeace-auth

# 从仓库源码（拿最新代码，不走 npm）
magpie plugin add github:MYCF711/magpie-officeace

# 本地 tgz（自己改了代码）
npm pack --pack-destination ./dist
cp dist/officeace-auth-*.tgz ~/.config/magpie/plugins/dist/
# plugins.json          追加 { "spec": "officeace-auth" }
# plugins/package.json  追加 "officeace-auth": "./dist/officeace-auth-*.tgz"
cd ~/.config/magpie/plugins && ~/.cache/magpie/bun/1.4.4/magpie-bun.exe install
```

⚠ **`magpie plugin add <tgz路径>` 用不了** —— 它把 tgz 当 JS 模块 `import()`，报
`exports no OpenCode plugin function`。本地包必须走上头那套 `plugins.json` 登记 +
`bun install`。

装完确认：

```bash
magpie plugin list
# officeace (OfficeAce, 7 models)  signed in as <账号>
```

⚠ 改了代码要 **bump `version` 再打包** —— 同一版本号重打，bun 会命中缓存（输出 `no changes`）。

---

## 常见问题

**为什么只有 7 个模型，平台上有 26 个？**
那 26 个是平台注册表，把测试版和没开通计费的 id 也列着 —— 有些选下去，
对话时才报错。这里只列计费清单上真能跑的，少给总比给了用不了强。

**要装 OfficeAce 客户端吗？** 不用。插件直接走 OfficeAce 客户端同款接口。

**登录要输密码吗？** 没有密码框。登录全程在华为云页面里完成，插件只负责轮询结果。

**会花我的积分吗？** 不会。插件只读额度和领签到，不做别的消费。

**想再登一个账号？** 再跑一次 `magpie plugin login officeace`，
第二个账号会存成 `officeace#xxxxxx`，两个号同时可用。

**签到显示「今日已无新增可领」？** 今天已经领过了，明天再来 —— 这不是错误。

---

## 参考源

本插件的协议实现参考了这几处，按各自许可在此声明
（完整版权声明见 [`NOTICE.md`](NOTICE.md)）：

| 来源 | 用在哪 |
|---|---|
| [theseaiying/magpie-officeace-plugin](https://github.com/theseaiying/magpie-officeace-plugin)（MIT） | V11 签名（`signV11Request`）的派生密钥公式、credential scope 里的服务名 `apic` |
| [Gyl1219/magpie-providers-hub](https://github.com/Gyl1219/magpie-providers-hub)（MIT） | 登录域与订阅面**不是同一个主机**这条结论 |
| [yetone/magpie](https://github.com/yetone/magpie)（MIT） | 插件钩子契约（含文档未列的 `auth.checkin`） |

---

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)

## 许可

MIT。
