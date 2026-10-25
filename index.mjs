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
import { checkin, fetchCatalog, fetchUsage } from "./src/api.mjs"
import { chatFetch } from "./src/chat.mjs"
import { staticModels, liveModels } from "./src/models.mjs"

const PROVIDER = "officeace"
const PROVIDER_NAME = "OfficeAce"
const NPM = "@ai-sdk/openai-compatible"

export const OfficeAceAuthPlugin = async ({ client } = {}) => {
  const log = (msg, level = "info") => {
    try {
      client?.app?.log?.({ service: "officeace", level, message: msg })
    } catch {
      // 没有日志通道就算了
    }
  }

  /** 保存续期后的凭据（magpie 的 auth.set 是整体替换）*/
  async function save(next, prev) {
    try {
      await client?.auth?.set?.({
        path: { id: PROVIDER },
        body: toStored(next, prev),
      })
    } catch {
      // 存储失败不阻断请求
    }
  }

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
      icon: "https://www.huaweicloud.com/favicon.ico",
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
        if (!auth || auth.type !== "oauth") return {}
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

      async models(provider, { auth } = {}) {
        const fallback = staticModels()
        const cred = credentialOf(auth)
        if (!cred) return fallback

        try {
          const rows = await fetchCatalog(cred)
          if (!rows.length) return fallback
          return liveModels(rows, maasBaseOf(cred))
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