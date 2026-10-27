# AGENTS.md —— 给 AI 执行者的入口

> 人类请看 [README](./README.md)。这份只回答两件事：**你现在该读哪一份**、
> **忘了哪一条会静默出错**。
>
> 结构照搬 [magpie-plugin-scaffold](../magpie-plugin-scaffold/AGENTS.md)；
> 第二节是本仓库自己的坑，来自 `docs/internals.md` 的实测记录。

---

## 零、magpie 升级时：只看稳定版

**判断「要不要跟着 magpie 改这个插件」看稳定渠道，不看每版本渠道。**
magpie 设置里有「更新渠道：每个版本 / 稳定版」，用户默认跑后者，插件要跟的也是后者。

```bash
curl -s "https://usemagpie.ai/api/latest?channel=stable" | grep -o '"version":"[^"]*"'
```

实测（2026-10-28）：两档差 **400 多个版本**（每版本 0.1.1763 / 稳定版 0.1.1327），
但把两边内嵌契约都提取出来逐字段比对后 —— **插件相关的字段一条不差**。
多出来的段是 GUI 历史，不是插件契约。⇒ 追每版本几乎全是白跑。

**稳定版版本号变了**，才需要重提取契约（脚手架的 `extract-contract.py`）→
跑 `contract-diff.mjs` → 看差集里有没有「不写会关掉某个能力」的字段。
完整判据见脚手架的
[HOOKS.md](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/HOOKS.md) 顶部
与 [UPDATING.md](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/UPDATING.md) 第七节。

---

## 一、先定位你在哪一步

| 你在做什么 | 必读（按顺序） | 做完的判据 |
|---|---|---|
| **改登录 / 凭证** | [docs/internals.md](./docs/internals.md) 的「登录」 | 三条登录路径都能登；老用户的旧凭据仍能直接复用 |
| **改接口域名 / 拼接 URL** | internals 的「三个域，不能混」 | 打的是订阅面，不是 CLAW 域；裸域名补了 `https://` |
| **改模型目录** | internals 的「模型：26 / 9 / 7」 | 只列真能调的；`model_name` 做了 trim |
| **改额度 / 签到** | internals 的「额度分桶」 | 三个桶各自语义对；查询失败不吞；跳过 `aside` 桶 |
| **代码写完，准备交付** | [CHECKLIST.md](./CHECKLIST.md) 的 **A 表** | A 表全勾 + check 脚本退出 0 |
| **要发版本** | [UPDATING.md](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/UPDATING.md)（七步） | CHECKLIST B 表全勾 + 四条验证 |

**最容易漏的是最后一行。** `git push` 只是七步里的第 4 步。

---

## 二、本仓库的坑

| # | 症状（出问题时你看到什么） | 判据 | 出处 |
|---|---|---|---|
| 1 | 点登录后界面转圈很久，或整张卡片卡住 | `authorize()` **必须立刻返回**，真正等的是 `callback()`；网络请求挪进 `loader` | internals 登录 |
| 2 | 续期后账号掉登录，或 key 用不了 | `dpopPrivateJwk` 是 DPoP 私钥，**续期必须用同一把**，不能丢、不能重建 | internals 登录 |
| 3 | 老用户升级后要求重新登录 | 凭据形状是**前版插件留下的**，保持不变老登录态就能复用；改字段名等于把所有老用户踢下线 | internals 登录 |
| 4 | 报 `Failed to parse URL` | `maasBaseUrl` 可能是**不带协议的裸域名**，必须补 `https://`；也可能是空串 → 走回退 | internals 登录 |
| 5 | 额度 / 签到接口回错、或回空 | 有**三个域**：额度与签到挂在**订阅面**，不是 CLAW 域；打错域就是这条症状 | internals 三个域 |
| 6 | 列表里有模型，选中就报错 | 平台注册表给 26 个，其中 19 个**选不了** —— 只列真能调的，界面可见 7 个（**比少给更糟**） | internals 模型 26/9/7 |
| 7 | 某个模型 id 一直 404，换什么头都没用 | `1017` 带 `maas_type: benefit` 重试**仍 404** —— 别照抄 CodeArts 那条路；换官方直连也没用（要 AK/SK 签名） | internals 模型 |
| 8 | 模型名后面多出空白 / 匹配不上 | 上游 `model_name` 带**尾部换行**（`"kimi-k3\n"`），必须 `trim` | internals 模型 |
| 9 | 额度条数字不对、或把试用额度当成永久额度 | 额度分**三桶**；`.trial` 后缀桶不带到期时间（不猜、照实显示）；已过期桶标 `aside: true` 收进折叠区 | internals 额度分桶 |
| 10 | 额度查询一失败，整张卡片空白 | 查询失败**不吞**：带原因抛出，由调用方显示；静默变 0 会被当成空号排到队首 | internals 额度分桶 |
| 11 | 签到明明成功，界面却显示「今天已领」/ 反之 | 重复领取是**幂等**的：服务端 2xx 且 `bonus_skus` 为空 = `done`（今天领完），不是失败 | internals 额度分桶 |
| 12 | `magpie plugin add xxx.tgz` 报 `exports no OpenCode plugin function` | 这个命令把 tgz 当 JS 模块 `import()`，**用不了**；本地包要走 `plugins.json` + `plugins/package.json` 登记 | README 安装段 |
| 13 | 改了代码重装，行为没变 | 同版本号重打包会命中 bun 缓存 —— 必须 bump `version` | 脚手架 UPDATING 第 1 步 |
| 14 | 想让卡片标题 / 许可 / 「源码」按钮对，去改了 magpie 的缓存 | 插件对 magpie 目录**只有读的份**；唯一载体是 `registry-entry.json` | internals 卡片标题 |

---

## 三、命令

```bash
# 合规检查（脚手架里的脚本，指到本仓库）
node ../magpie-plugin-scaffold/scripts/check.mjs .

# 打包面预演
npm pack --dry-run

# 发布（包内 name 与 npm 包名不同时）
npm run publish:npm

# Release：本仓库有 release.yml，推 tag 后 workflow 自动建（不用手工 POST）
git tag v0.1.10 && git push origin v0.1.10
#   （workflow 会自动建 Release；约 1 分钟后查 /releases/tags/v<version>）
```

真实登录态与缓存在 `~/.cache/magpie/officeace*`；探针脚本需要现场凭据时从那里取。

---

## 四、两个交付门

**门 1 · 代码交付**

```
□ node ../magpie-plugin-scaffold/scripts/check.mjs . 退出码 = 0
□ CHECKLIST.md 的 A 表全勾
□ 模型列表按「真能调」过滤过（26 里只有 9 个能调，界面 7 个）
```

**门 2 · 发布**

```
□ CHECKLIST.md 的 B 表全勾（七步）
□ 四条验证：npm view officeace-auth version / tarball 内容 / magpie plugin list / Release 在
```

⚠ 没过门 2 不许说「已发布」。

---

## 五、文档地图

| 文件 | 管什么 | 什么时候读 |
|---|---|---|
| [README](./README.md) | 用户门面：功能、模型、签到、安装、常见问题 | 改用户可见行为时 |
| [docs/internals.md](./docs/internals.md) | 九项清单、登录、三个域、模型口径、额度分桶、卡片文案 | 改代码前按章查 |
| [CHANGELOG.md](./CHANGELOG.md) | 每版一节 | 写新版本时 |
| [CHECKLIST.md](./CHECKLIST.md) | 两张勾选表 | 两个交付门 |
| 脚手架 [AGENTS.md](../magpie-plugin-scaffold/AGENTS.md) | 通用坑与 check 能查什么 | 第一次接触这个插件族时 |

---

## 六、这份文件的维护规矩

1. 任何一次「不报错、要几小时才找到」的坑，收工前在第二节加一行（症状 → 判据 → 出处）。
2. 第二节只放一句话判据，论证留在 `docs/internals.md`。
3. 判据要能当场验证（命令、字段、界面现象）。
