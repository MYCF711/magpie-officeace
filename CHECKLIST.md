# CHECKLIST —— 两张表，两个交付门

> 给 `magpie-officeace`。`scripts/check.mjs`（在脚手架仓库里）只查**能自动查的那部分**；
> 下面这些查不到，但漏了照样出事，而且通常**不报错**。
>
> 逐条勾，勾不上就是还没好。表格里的「判据」都能当场验。

---

## A 表 · 代码交付前

```
□ 1. config.models 有内容
      判据：插件装上后模型列表不是空的（未登录时也要有静态表）
      出处：docs/internals.md 九项清单

□ 2. authorize() 立刻返回
      判据：点登录后没有长时间转圈
      出处：internals 登录

□ 3. dpopPrivateJwk 续期时没丢
      判据：续期后账号还是登录态，key 还能用
      出处：internals 登录

□ 4. 凭据形状没改
      判据：老用户升级后不用重新登录（字段名/嵌套都没动）
      出处：internals 登录

□ 5. maasBaseUrl 处理了两种异常
      判据：裸域名补了 https://；空串走回退；不出现 Failed to parse URL
      出处：internals 登录

□ 6. 三个域没混
      判据：额度与签到打的是订阅面，不是 CLAW 域
      出处：internals 三个域，不能混

□ 7. 模型只列真能调的
      判据：注册表 26 → 实测可调 9 → 界面可见 7；没有选中就报错的 id
      出处：internals 模型：26 / 9 / 7

□ 8. model_name 做了 trim
      判据：上游带尾部换行的名字能正确匹配（"kimi-k3\n"）
      出处：internals 模型

□ 9. 额度三桶语义对
      判据：.trial 桶不带到期时间（照实显示）；已过期桶 aside: true
      出处：internals 额度分桶

□ 10. 额度查询失败不吞
      判据：失败时带原因抛出，不静默变 0（变 0 会被当成空号排队首）
      出处：internals 额度分桶

□ 11. 签到幂等判据用对了
      判据：2xx + bonus_skus 为空 = done（今天领完），不是失败
      出处：internals 额度分桶

□ 12. 没有写 magpie 的市场缓存
      判据：src 里搜不到 plugin-market.json
      出处：CHANGELOG 0.1.9

□ 13. node ../magpie-plugin-scaffold/scripts/check.mjs . 退出码 = 0
```

---

## B 表 · 发版前（七步，一步不能少）

> ⚠ **`git push` 只是第 4 步。** 少一步不会报错，只会「GitHub 右侧暂无发布版本、
> npm 上还是旧版」。

```
□ 第 0 步 · 写 CHANGELOG（一条一行，说用户能感知的变化）
□ 第 1 步 · bump version
      命令：npm version patch --no-git-tag-version
      判据：package.json 的 version 变了
□ 第 2 步 · npm pack --dry-run
      判据：清单里有 README.md / CHANGELOG.md / docs / AGENTS.md / CHECKLIST.md
□ 第 3 步 · 提交
□ 第 4 步 · git push origin main（推别的分支不算）
□ 第 5 步 · npm run publish:npm
      判据：返回 + officeace-auth@<版本>，且 package.json 的 name 已还原
□ 第 6 步 · tag + Release
      命令：git tag v<version> && git push origin v<version>
      本仓库**有** .github/workflows/release.yml ⇒ 推 tag 后 workflow 自动建，不用手工 POST
      判据：约 1 分钟后 GET /releases/tags/v<version> 为 200
        { tag_name, target_commitish:"main", name, body:<CHANGELOG 该版本段>, draft:false }
      判据：tag 与 version 一致；Release 不是 draft
□ 第 7 步 · 四条验证
      ① npm view officeace-auth version    → 新版本（登记可能延迟 1-2 分钟）
      ② 下载 dist.tarball 解包看内容        → 要看到新文件，不只看版本号
      ③ magpie plugin list                 → commit / version 变了
      ④ GET /releases/tags/v<version>      → 200 且 draft=false
```
