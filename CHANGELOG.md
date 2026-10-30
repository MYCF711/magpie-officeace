# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。
> 格式与发布流程见 [magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold) 的 [UPDATING.md](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/UPDATING.md)。

## 未发布

- **改进：未接入 MaaS 的账号在卡片上标「未接入 MaaS」并给出「Sign in again」按钮** —— `usage()` 在没有 `modelAppKey` 时返回 `plan: "未接入 MaaS"` + `signIn: "expired"`（不用 `error`：它会顶掉额度条、让账号从额度表消失，路由还会把「未知」当成「没用过」优先选它）；按钮本身走登录流程，登录说明里附 AgentArts 控制台「授权管理 → 批量开通模型 / 鉴权管理」的官方步骤。多账号时按钮只能按 provider 级判断、对不准具体卡片；「同浏览器 SSO 免登」未实测（README 已写明）

## 0.1.15 — 2026-10-30

- **改进：未接入 MaaS 的 400 文案给出两条可执行路径** —— 从只说「去 OfficeAce 客户端完成接入」改为逐步骤的两条路（① OfficeAce 客户端「模型 → 接入模型 → 接入华为云 MaaS 模型」；② AgentArts 控制台「授权管理 → 批量开通模型 / 鉴权管理」）并附官方步骤链接；`MaaSNotLinked` 的 `code` / `type` / `status` 一字未动

## 0.1.14 — 2026-10-29

- **修复：卡片上的账号名是一串 domain id（`01a1642ad2ae7f93bf6387ad2fc5f09e`），不是手机号** —— 华为云 OAuth 的 `refresh_token` 里 `user_profile` 只有 IAM 自己的 id，**从来没有手机号**；`toStored()` 又把 `cred.accountId`（domain id）当卡片名。三个账号并排时是三串看不懂的 ID，用户以为是乱码
- **登录后读一次手机号**（`src/phone.mjs`）：`GET https://iam.cn-north-4.myhuaweicloud.com/v3.0/OS-USER/users/{principal_id}`，用同一套 STS 三元组走 SDK-HMAC-SHA256，返回 `user.phone`（实测 `0086-18970098051`；同路径 `/v3.1/` 是 `APIGW.0101`，只有 `/v3.0/` 通）。打码成 `189****8051` 存进凭据 `user_phone`，每个 IAM 用户每进程读一次
- **`accountId` = 手机号，`uid` = domain id** —— 名字给人看、身份给宿主去重；取不到手机号就回落到 domain id，**绝不编造、也不影响登录**
- 续期路径同样补取（老的已登录账号在下一次续期时改名），凭据形状只多一个可选字段 `user_phone`
- 新增 `tests/phone.test.mjs`（5 组 18 条断言，`npm test` 18 通过）：打码边界、JWT claim、IAM 读取与缓存、失败回落、名字/身份分离
- **修复：只有 STS、没接入 MaaS 的账号，模型测试报「400 · Failed to get the authorization header」**（issue #2）—— 凭据里没有 `modelAppKey` 时，请求会落到 magpie 的空 apiKey 上，上游回 `ModelArts.81002`，用户看不出「账号还没接入 MaaS」。现在 `loader()` 直接回一个写明原因的 400（`MaaSNotLinked`），提示去 OfficeAce 客户端完成「接入华为云 MaaS 模型」；不再把空 Basic 头发给上游。新增 2 条测试（STS-only 回 400、完全未登录仍不接管）

## 0.1.13 — 2026-10-29

- **修复：只有 STS、还没接入 MaaS 的账号被误判成「未登录」** —— `credentialOf()` 以前只认带 `modelAppKey` 的凭据。但额度（`/v1/subscription`）与签到（`/v1/subscription/bonus/claim`）走 V11-HMAC-SHA256，只用 STS 三元组；`modelAppKey` 只用于 MaaS 的 Basic 认证（模型目录 / 对话）。于是「登录成功、STS 有效、`client-permission-validate` 还没下发 `model_auth_info`」的账号：卡片显示未登录、额度看不到、每日签到固定失败，重新登录也修不好。现在只要 `access` + `securityToken` 齐全就认作已登录
- **对话与目录仍然要 `modelAppKey`** —— 没有就不接管请求、模型目录回退静态表；不会拿空 appKey 去打上游（那样只会得到一个 401）
- 凭据存储形状**一行未改**（`toStored` 不动），老用户不掉登录
- 新增 `tests/credential.test.mjs`（13 条，`npm test`）：完整凭据 / STS-only / 缺字段 / 存储形状 / `loader` 与 `models` 的守卫

## 0.1.12 — 2026-10-28

- **修正文档里的错误说法**：AGENTS 与 CHECKLIST 都写着「本仓库没有 .github/workflows ⇒ Release 手工建」，实际本仓库**有** `release.yml` —— 推 tag 后 workflow 自动建 Release。上一版发布时 `release.mjs` 打出「交给 release.yml」才暴露出来

## 0.1.11 — 2026-10-28

- **AGENTS 新增「零、magpie 升级时：只看稳定版」** —— magpie 有「更新渠道：每个版本 / 稳定版」，用户默认跑稳定版。两渠道实测差 **400 多个版本**（每版本 0.1.1763 / 稳定版 0.1.1327），但插件相关的契约字段**一条不差** ⇒ 追每版本几乎全是白跑。判断依据只有一条：**稳定版版本号变了**才需要重新同步

## 0.1.10 — 2026-10-28

- **新增 `AGENTS.md`** —— 给 AI 执行者的入口：按「你在哪一步」给阅读顺序，外加本仓库 14 条会静默出错的坑（症状 → 判据 → 出处）。坑全部来自 `docs/internals.md` 的实测：`dpopPrivateJwk` 续期不能重建、三个域不能混、26/9/7 三个模型口径、`model_name` 带尾部换行、额度三桶的 `.trial` 与 `aside` 语义
- **新增 `CHECKLIST.md`** —— A 表 13 项代码交付前，B 表发版前七步带命令与判据
- [README](./README.md) —— 顶部加三行指路：改代码 / 发版前先看这两份；发布是七步，`git push` 只是第 4 步
- [CHANGELOG](./CHANGELOG.md) 与 `publish-npm.mjs` 里的脚手架链接从旧名 `magpie-plugin-template` 更新为 `magpie-plugin-scaffold`（旧名靠 GitHub 的 301 还能打开，但不该依赖它）
- `package.json` 的 `files` 补上这两份，否则 npm 包里没有它们

## 0.1.9 — 2026-10-27

- **插件不再写 magpie 自己的缓存** —— 删掉 `src/self-register.mjs` 与 index 里的调用：`~/.cache/magpie/plugin-market.json` 属于 magpie，插件每次加载都去改它，等于把 registry 条目盖掉
- **卡片标题与文案改由 registry 条目承担** —— 提交到 `magpie-community/plugins` 的 `registry-entry.json` 是唯一受支持的做法
- 其余行为（登录、模型、额度、签到）**一行未动**，凭据形状不变，不用重新登录

## 0.1.8 — 2026-10-26

- **模型数纠错** —— README 与市场文案写「26 个」，实际界面只显示 7 个（26 是平台注册表，7 是计费清单过滤后的结果）
- **README 重写** —— 按 magpie-plugin-template 的九段结构：数字在前、功能一条一行、安装放最后
- **新增 `docs/internals.md`** —— 登录流程、凭据形状、三域分工、26/9/7 的过滤判据都挪到这里
- **市场卡片文案同步修正** —— 原文案写的 Qwen3 / openPangu，一个都不在可计费清单里
- **LICENSE 换成标准 MIT 正文** —— 归属说明移到 `NOTICE.md`，GitHub 才认得出许可
- **删掉「跟随代理」一条** —— 包内没有任何代理代码
- **新增 `CHANGELOG.md`**，并让推 tag 自动生成 GitHub Release
- **仓库里的 `name` 改成 `OfficeAce`** —— 卡片标题就是包名（`plugins/package.json` 的依赖键由包内 `name` 决定），改这里才永久生效：`add` / `update` 不会再把它重置回 `officeace-auth`
- **新增 `publish-npm.mjs`** —— npm 上的包名仍是 `officeace-auth`（registry 不接受含大写的新包名）；发布改用 `npm run publish:npm`，别再裸跑 `npm publish`

## 0.1.7 及更早

未留档 —— 同一天的连续迭代，`git log --oneline` 是唯一的记录。
