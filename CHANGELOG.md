# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。
> 格式与发布流程见 [magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold) 的 [UPDATING.md](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/UPDATING.md)。

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
