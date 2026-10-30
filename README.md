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

## 未接入 MaaS：卡片标记 + 两条登录方式

账号登录成功、但还没在华为云侧接入 MaaS（凭据里没有 `modelAppKey`）时：

- 账号卡片上的 plan 显示 **「未接入 MaaS」**（`usage().plan`，只影响显示，不参与路由/额度判定）
- magpie 会在那张卡上显示 **「Sign-in required」**（`usage().signIn = "expired"`），点开就是下面的登录方式选择

本包给这张卡**两条登录方式**，选哪条由你决定（点按钮时 magpie 会让你选）：

| 方式 | 打开什么 | 会不会重新登录华为云 |
|---|---|---|
| **华为云账号（浏览器）** | 华为云 OAuth 登录页 | 会。这是真正的登录：换账号、加账号、凭据续期失败后重登都走它 |
| **去 AgentArts 控制台开通 MaaS** | `https://console.huaweicloud.com/agentarts/` | **不会**。它直接用插件里已保存的登录态轮询检测，完全不发登录请求 |

「去 AgentArts 控制台开通 MaaS」的完整行为：

1. magpie 打开 AgentArts 控制台（插件只给地址，不自己开页面）
2. 在控制台里完成开通：管理中心 → 授权管理 →「模型」页签 →「批量开通模型」；再「鉴权管理」→ 在 MaaS 服务创建 API Key → 确定
3. 插件用**已保存的那份凭据**每 5 秒读一次 `client-permission-validate`（只读），最多等 3 分钟
4. 检测到 `model_auth_info` 就把它合并进**同一份记录**回写（没有新登录、没有新账号），magpie 重读额度，卡片标记消失
5. 等待超时会如实报「还没有检测到 MaaS 开通」，并让你开好后回卡片再点一次 —— 不会假装成功

已知边界，别指望它做到：

- **多账号时这条按 provider 级判断**：magpie 调 `authorize()` 传的 `account` 恒为 `plugin.NewAccount`（GUI 与 CLI 都是），插件拿不到「是哪张卡」。所以控制台按你浏览器里当前登录的账号开出；要开通的是另一个账号时，先在控制台右上角切账号。
- **控制台同浏览器是否已登录未实测**：控制台与登录页同属华为云 SSO，理论上已登录；如果要求登录，用**同一个华为云账号**登录即可（那是控制台自己的登录）。插件不能从 STS 凭据伪造网页登录态（STS 是 API 凭证，不是浏览器会话）。
- **已经接好 MaaS 的账号**不需要这两条里的任何一条：额度读取会自动看到 `modelAppKey`。
- 插件选项 `maasWatchMs`（默认 180000）与 `maasWatchIntervalMs`（默认 5000）可以调检测时长与间隔。

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
