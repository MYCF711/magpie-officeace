# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。
> 格式与发布流程见 [magpie-plugin-template](https://github.com/MYCF711/magpie-plugin-template) 的 [UPDATING.md](https://github.com/MYCF711/magpie-plugin-template/blob/main/UPDATING.md)。

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
