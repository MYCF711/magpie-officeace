// OfficeAce（华为云 AgentArts / MaaS）· magpie 供应商插件
//
// ═══════════════════════════════════════════════════════════════════════
// 九项清单（一项不缺）
// ═══════════════════════════════════════════════════════════════════════
//
//  钩子
//   ① config(cfg)                      声明 provider + 静态模型表
//   ② auth.methods[].authorize()       华为云 OAuth（PKCE + DPoP）
//   ③ auth.refresh(auth, provider)     STS 续期（带去重闸）
//   ④ auth.loader(getAuth, provider)   请求接管（Bearer → Basic）
//   ⑤ auth.usage(getAuth, provider)    订阅积分分桶
//   ⑥ auth.checkin(getAuth, provider)  每日签到
//   ⑦ provider.models(provider,{auth}) 每账号目录（失败回退静态表）
//   ⑧ "chat.headers"(input, output)    会话保持
//
//  数据字段
//   ⑨ accountId / uid                  卡片显示名
//      icon / maxConcurrency           图标与并发
//
// ═══════════════════════════════════════════════════════════════════════
// 这个插件只做一件事
// ═══════════════════════════════════════════════════════════════════════
//
// OfficeAce 的 /v2 端点要 `Authorization: Basic base64(appKey:appSecret)`，
// 而 magpie 底下的 AI SDK 只会发 `Bearer` ——
// 插件把 Bearer 改写成 Basic，把 `officeace/<id>` 还原成厂商 id，
// 别的原样转发。上游本来就是 OpenAI 协议，没有协议转换。
//
// ═══════════════════════════════════════════════════════════════════════
// 与之前那个临时版的区别
// ═══════════════════════════════════════════════════════════════════════
//
// 前版只有六项（登录/续期/目录/转发/额度），缺：
//   - auth.checkin（magpie 的签到钩子 —— 补上）
//   - chat.headers（会话保持 —— 补上）
//   - accountId 回填（卡片显示名 —— 补上）
//
// 凭据形状**保持不变**，所以已有的登录态可以直接复用，不用重新登录。
//
// ═══════════════════════════════════════════════════════════════════════

import { EXPIRY_LEAD_MS } from "./src/constants.mjs"
import { credentialOf, toStored } from "./src/credential.mjs"
import { beginLogin, refreshOnce } from "./src/login.mjs"
import { checkin, fetchCatalog, fetchTokenRates, fetchUsage } from "./src/api.mjs"
import { chatFetch } from "./src/chat.mjs"
import { staticModels, liveModels } from "./src/models.mjs"

const PROVIDER = "officeace"
const PROVIDER_NAME = "OfficeAce"
const NPM = "@ai-sdk/openai-compatible"

/** 内嵌图标（OfficeAce 官方 .ico 转 PNG，13.6 KB）*/
const ICON =
  "data:image/png;base64,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"

export const OfficeAceAuthPlugin = async ({ client } = {}) => {
  const log = (msg, level = "info") => {
    try {
      client?.app?.log?.({ service: "officeace", level, message: msg })
    } catch {
      // 没有日志通道就算了
    }
  }

  // 卡片标题与文案不在这里做 —— 那是 registry 条目的职责（见 registry-entry.json）。
  // 插件不写 magpie 自己的缓存目录：那份文件属于 magpie，插件只读不写。

  return {
    // ═══ ① 声明 provider ═════════════════════════════════════════════
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: NPM,
        api: "https://api.modelarts-maas.com/v2",
        // ⚠ 未登录时也必须有内容，否则 magpie 显示 "0 models"
        models: staticModels(),
      }
    },

    auth: {
      provider: PROVIDER,
      // 内嵌图标（magpie 只存不拉，外部 URL 在 git 源下不渲染）
      icon: ICON,
      maxConcurrency: 3,
      refreshLead: EXPIRY_LEAD_MS,

      // ═══ ② 登录 ═══════════════════════════════════════════════════
      methods: [
        {
          type: "oauth",
          label: "华为云账号（浏览器）",
          /**
           * ⚠ 立刻返回，不能在这里等用户完成登录 —— 真正等的是 callback()。
           *   死等会让双方互等（magpie 要等 url 才开浏览器）。
           */
          async authorize() {
            const started = await beginLogin()
            return {
              url: started.url,
              instructions: "在打开的页面里完成华为云登录，本窗口会自动继续。",
              method: "auto",

              async callback() {
                try {
                  const cred = await started.result
                  return {
                    type: "success",
                    // magpie 的 refreshLead 机制读这个
                    refresh: cred.refreshToken ?? "",
                    // 完整凭据（JSON 字符串，与前版同形状）
                    access: JSON.stringify(cred),
                    expires: Date.parse(cred.expiresAt ?? "") || Date.now() + 3600_000,
                    // 卡片显示名
                    accountId: cred.accountId ?? "",
                    uid: cred.accountId ?? "",
                  }
                } catch (e) {
                  return { type: "failed", error: String(e?.message ?? e).slice(0, 500) }
                }
              },
            }
          },
        },
      ],

      // ═══ ③ 续期 ═══════════════════════════════════════════════════
      /**
       * ⚠ 返回的字段**合并**到旧账号上（与 client.auth.set 的整体替换不同）。
       *
       * magpie 会串行化同一账号的续期（最多等 15 秒），
       * 加上这里的 refreshOnce 去重闸，一次性 refresh_token 不会被用两次。
       */
      async refresh(auth, provider) {
        const cred = credentialOf(auth)
        if (!cred?.refreshToken) return undefined

        try {
          const next = await refreshOnce(cred)
          if (!next) return undefined
          return {
            access: JSON.stringify(next),
            refresh: next.refreshToken ?? cred.refreshToken,
            expires: Date.parse(next.expiresAt ?? "") || Date.now() + 3600_000,
            ...(next.accountId ? { accountId: next.accountId, uid: next.accountId } : {}),
          }
        } catch (e) {
          // 一次性 refresh_token 被消费 → 标记账号，不再重试直到重新登录
          throw Object.assign(new Error("OfficeAce 续期失败，请重新登录"), {
            signIn: "expired",
          })
        }
      },

      // ═══ ④ 请求接管 ═══════════════════════════════════════════════
      async loader(getAuth, provider) {
        const auth = await getAuth()
        // ⚠ 不检查 auth.type —— 旧版插件留下的记录可能没有 type 字段，
        //   而 credentialOf 能认出来就够了。
        const cred = credentialOf(auth)
        if (!cred) return {}

        return {
          // 空 baseURL：由 chatFetch 自己拼目标地址
          baseURL: "",
          // 空 apiKey：我们自己加 Basic 头
          apiKey: "",

          async fetch(input, init) {
            // ⚠ 每次重新读 auth —— 可能已被 refresh 更新
            const fresh = await getAuth()
            const current = credentialOf(fresh) ?? cred

            return chatFetch({
              input,
              init,
              credential: current,
              // 二次保险：万一 magpie 的 refreshLead 没触发
              renew: async () => {
                try {
                  const next = await refreshOnce(current)
                  if (next) await save(next, fresh)
                  return next
                } catch (e) {
                  log(`续期失败：${e?.message ?? e}`, "warn")
                  return undefined
                }
              },
            })
          },
        }
      },

      // ═══ ⑤ 额度 ═══════════════════════════════════════════════════
      /**
       * 决定卡片上的进度条。
       *
       * 订阅面返回两类桶：套餐桶（skus[].quotas）和活动桶（bonus_skus）。
       * 转成 magpie 的 windows 后，卡片显示：
       *   `套餐名 · 剩 1234`  `1234 / 2000`  进度条
       */
      async usage(getAuth, provider) {
        const auth = await getAuth()
        const cred = credentialOf(auth)
        if (!cred) return { error: "未登录", windows: [] }

        try {
          const u = await fetchUsage(cred)
          return {
            plan: u.plan || PROVIDER_NAME,
            ...(cred.accountId ? { user: cred.accountId } : {}),
            windows: u.windows,
          }
        } catch (e) {
          // error 字段会替代 windows 显示
          return { error: String(e?.message ?? e).slice(0, 300), windows: [] }
        }
      },

      // ═══ ⑥ 签到 ═══════════════════════════════════════════════════
      /**
       * magpie 按**北京时间**每个账号每天调一次，当天失败后还会再调。
       *
       * 端点：POST /v1/subscription/bonus/claim
       *
       * ⚠ 重复领取是幂等的 —— 2xx 但 bonus_skus 为空时是 `done`，
       *   不是 `failed`。只看状态码会误报。
       */
      async checkin(getAuth, provider) {
        const auth = await getAuth()
        const cred = credentialOf(auth)
        if (!cred) return { outcome: "failed", message: "未登录" }

        try {
          // 临期就先续（签到也要有效凭据）
          let use = cred
          const at = Date.parse(cred.expiresAt ?? "")
          if (Number.isFinite(at) && at - Date.now() <= EXPIRY_LEAD_MS && cred.refreshToken) {
            try {
              const next = await refreshOnce(cred)
              if (next) {
                use = next
                await save(next, auth)
              }
            } catch {
              // 续期失败就用旧的试一次
            }
          }

          return await checkin(use)
        } catch (e) {
          return { outcome: "failed", message: String(e?.message ?? e).slice(0, 300) }
        }
      },
    },

    // ═══ ⑦ 每账号的模型目录 ═════════════════════════════════════════
    /**
     * ⚠ 失败回退的三种方式（用第一种）：
     *   1. fetch 失败后原样返回兜底表
     *   2. 抛异常
     *   3. 返回自己的列表并设 list[Symbol.for("magpie.fellBack")] = true
     *
     * 局部成功时**不要**标 fellBack —— 那样 magpie 会整份丢弃。
     */
    provider: {
      id: PROVIDER,
      // 卡片标题用这个；不给就退回包名
      name: PROVIDER_NAME,

      async models(provider, { auth } = {}) {
        const fallback = staticModels()
        const cred = credentialOf(auth)
        if (!cred) return fallback

        try {
          const rows = await fetchCatalog(cred)
          if (!rows.length) return fallback
          // 倍率表当白名单：桌面端只显示有倍率的模型。
          // 注册表把 404 的测试版也列出来，选不了比少给更糟。
          let rates = null
          try {
            rates = await fetchTokenRates(cred)
          } catch {
            rates = null
          }

          // ⚠ **拿不到倍率表时退回静态表，不要退回注册表全量**（真实缺陷，2026-10-26）
          //
          // 注册表 `/v2/models` 的 26 条里有 3 个必 404 的占位 id
          // （`deepseek-v4.1-flash-1017` / `-bnt` / `deepseek-v4-pro`，实测判据见
          // `src/models.mjs` 的 `UNAVAILABLE_IDS`）。旧逻辑在这里是
          // `liveModels(rows, base, null)` —— 不过滤、26 条全给，于是用户能选中
          // 一个**只会在对话时才 404** 的模型。少给（10 个静态兜底）比多给这些更好。
          if (!rates || rates.size === 0) {
            log("倍率表不可用（空表）—— 目录降级为静态表，不列出注册表占位 id", "warn")
            return fallback
          }

          const live = liveModels(rows, maasBaseOf(cred), rates)
          // 目录与倍率表零交集 = 上游改了清单形状，同样退回静态表（不再吐全量）
          if (Object.keys(live).length === 0) {
            log("倍率表与模型目录零交集 —— 退回静态表", "warn")
            return fallback
          }
          return live
        } catch (e) {
          log(`目录拉取失败，回退静态表：${e?.message ?? e}`, "warn")
          // 登录被拒 → 标记账号
          if (/401|403|unauthorized|被拒/i.test(String(e?.message))) {
            throw Object.assign(new Error("OfficeAce 登录已失效，请重新登录"), {
              signIn: "expired",
            })
          }
          return fallback
        }
      },
    },

    // ═══ ⑧ 每请求加头 ═══════════════════════════════════════════════
    /**
     * input.sessionID 是 magpie 的会话 id，同一会话多轮不变。
     */
    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== PROVIDER || !input?.sessionID) return
      output.headers["x-officeace-session"] = String(input.sessionID).slice(0, 128)
    },
  }
}

/** 推理域（与 constants.maasBase 同逻辑，这里避免再 import 一层）*/
function maasBaseOf(cred) {
  const raw = cred?.maasBaseUrl
  if (typeof raw !== "string" || raw.length === 0) return "https://api.modelarts-maas.com"
  const trimmed = raw.replace(/\/+$/, "")
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

// 供测试引用（⚠ 入口文件不要导出 helper 函数，否则会被当插件调用）
export const _internal = {
  PROVIDER,
  credentialOf,
  toStored,
  staticModels,
}