# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 接手前先读这一页。

---

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `magpie-officeace` |
| 包内 name | `OfficeAce`（npm：`officeace-auth`） |
| 当前版本 | `0.1.14` |
| provider id | `officeace` |
| 注册表条目 | `registry-entry.json`（`package: officeace-auth`，`providers: ["officeace"]`） |

## 二、当前状态（2026-10-30）

```
分支 main，工作区干净（本次只读检查，未改代码）
```

**⚠ 有一件已确认但未修的不合规：`accountId` 里写的是手机号。**

实测 `~/.config/magpie/plugin-auth.json`：

```
officeace → accountId = "189****8051"        ← 手机号
codearts  → accountId = "iam::01a18be…:user:hw059194106570983"   ← URN（合规）
```

按 `magpie-community/plugins#483` 的裁定（yetone 原文）：

> **`accountId` is the account's identity in magpie, not only its name, so it must stay what 0.x stored.**

`accountId` 是 magpie 里这个账号的**身份键**：用户给它起的自定义名、proxy、gateway key 绑定全挂在上面。实测换名后的后果：

```
before: AccountNameOf(01a0cbf7-…)="Work account"   gateway-key id 842c5f53982b63b7
after:  AccountNameOf(138****8000)=""               gateway-key id 82ba203e26eff0ed
```

⇒ officeace 现在显示手机号好看，代价是用户自定义名/proxy/gateway key 会在续期时被清掉。

## 三、待决（2026-10-30 主人裁定）

**等 `yetone/magpie#4416` 的回复再决定。**

该 issue 提议：供应商设置页的账号列表改渲染 `usage().user`（卡片已经在渲染它），`accountId` 继续当身份键。若 magpie 那边愿意改，officeace 就不必二选一。

回复出来后的两个方向：
- magpie 接受改显示 → officeace 改回 `accountId` = URN，手机号只走 `usage().user`
- magpie 不改 → 主人再定：合规优先（显示变 URN）还是显示优先（继续牺牲自定义名）

## 三·五、跨仓库待同步（#522）

- **#522 合并后，同一段 MaaS 指导文案要同步到 `packages/codearts/index.mjs`**（`MaaSNotLinked` 的 400 文案，两处文本必须一致）。#522 还在 review，合并前不动那个包，避免扩大 review 面。

## 四、与其他华为插件的关系

`officeace`（OfficeAce / AgentArts）与社区的 `codearts`（码道）**共用同一份华为云 IAM 账号凭证**，实测同一台机器上：

```
plugin:codearts  → 181****0632 / 181****6710 / 189****8051 / iam::01a18be1…:user:hw…
plugin:officeace → 181****0632 / 181****6710 / 189****8051
```

前三个是同一批账号。已在 `magpie-community/plugins#517` 向社区提问：① 合成单包双供应商 ② 或让插件读取对方已登录凭证。**等回复。**

注：本机实测「在 officeace 里点添加账号，能直接抓到 codearts 刚登录的号并正确显示手机号」——说明共享登录态在「本机登录」这条路径上天然成立，不需要合并包也能共用。

## 五、硬约束

- 禁止直推 main（功能分支 → PR → `rules` 全绿 → 合并 → 从与 `origin/main` 一致的提交发版）
- 任何按账号落盘的文件名必须带账号；不要用模块级变量存 per-account 状态
- `src/phone.mjs` 的 `looksLikeIdentifier` 是本仓库对「内部 ID 不许当名字」的实现，改账号名逻辑先读它
- 不碰 aipy / trustoken 相关配置

## 六、交付自检

```bash
node "D:/主工作区/projects/magpie-plugin-scaffold/scripts/check.mjs" .
npm pack --dry-run
# 测试：见 package.json 的 scripts 与 tests/
```