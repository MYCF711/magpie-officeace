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
import { accountIdentityOf, phoneField } from "./src/phone.mjs"
import { beginLogin, refreshOnce } from "./src/login.mjs"
import { checkin, fetchCatalog, fetchTokenRates, fetchUsage } from "./src/api.mjs"
import { chatFetch } from "./src/chat.mjs"
import { staticModels, liveModels } from "./src/models.mjs"
import { checkMaasAccess, watchMaasAccess, probeMaasAccess } from "./src/maas.mjs"
import { readOfficeAceAccounts, pickOfficeAceCredential, officeAceAuthFile } from "./src/accounts.mjs"
import { openConsoleWindow, waitForLoginAndSave, loadSavedCookies, primeSession, closeWindow, CONSOLE_URL } from "./src/console-browser.mjs"

const PROVIDER = "officeace"
const PROVIDER_NAME = "OfficeAce"
const NPM = "@ai-sdk/openai-compatible"

// 未接入 MaaS 的账号在卡片上的标记。`plan` 只被 magpie 当文字显示（不参与
// 路由/额度判定）；`signIn: "expired"` 会让 magpie 在这张卡上给出「Sign in
// again」按钮 —— 点它走的是登录流程，我们只能在登录说明里附上接入 MaaS 的
// 官方入口（见 README「未接入 MaaS」一节）。不要用 `error`：它会把额度条顶掉、
// 让账号从额度表消失，而且路由会把「未知」当成「没用过」反而优先选它。
const MAAS_MISSING_PLAN = "未接入 MaaS"
// MaaS 控制台（ModelArts）—— 开通预置服务、创建 API Key 都在这里。
// ⚠ 不是 AgentArts 的授权管理页：那条路（批量开通）实测只覆盖 AgentArts 自己的
//   授权，MaaS 的预置服务/API Key 在 ModelArts 控制台。
const MAAS_CONSOLE_URL = "https://console.huaweicloud.com/modelarts/?region=cn-southwest-2#/model-studio/homepage"
const MAAS_API_KEY_URL = "https://console.huaweicloud.com/modelarts/?region=cn-southwest-2#/model-studio/authmanage"
const MAAS_STEPS =
  "①「模型推理 → 在线推理 → 预置服务」里给要用的模型点「开通服务」（没开通时调用会 401/404）；" +
  "②「管理与统计 → API Key 管理」里创建 API Key（明文只显示一次，创建后 3~5 分钟生效）；" +
  "③ 把 Key 填进 OfficeAce 客户端的「模型 → 接入模型 → 接入华为云 MaaS 模型」，或在 OfficeAce 里重新接入一次。"

/**
 * 落进控制台那条路时给用户看的话。
 *
 * ⚠ 如实写：插件**不能**把 OAuth 凭据变成控制台的会话（控制台是 cookie 会话，
 *   华为云没有「拿 access_token 换控制台 session」的公开接口，只有账号级配置的
 *   SAML/OIDC 联邦认证）。所以只说「要登录就用同一个华为云账号登一下」。
 */
const MAAS_OPEN_INSTRUCTIONS =
  "已保存的登录态能调通华为云，但这个账号还没开通 MaaS —— 打开的是 MaaS 控制台（" +
  MAAS_CONSOLE_URL +
  "），请按这三步开通：" +
  MAAS_STEPS +
  "。开通后回到本窗口，插件会自己检测到并完成。" +
  "**控制台要求登录的话，用同一个华为云账号登一下** —— 控制台是浏览器 cookie 会话，插件手里的 STS 凭据没法替你登进去。" +
  "为什么不能全自动：华为云没有公开的「开通预置服务」API（那是控制台的计费授权动作），API Key 虽然有 OpenAPI，但把 Key 绑定给 OfficeAce 也没有公开接口。"

/** 受控浏览器窗口那条路：说明「这个窗口会记住登录」。 */
const MAAS_WINDOW_INSTRUCTIONS =
  "已为你打开一个受控浏览器窗口（它会一直记住这个账号的华为云登录态）。" +
  "如果窗口里显示华为云登录页，**在这个窗口里登录一次** —— 之后打开 MaaS 控制台就不会再要求登录。" +
  "登录后按这三步开通：" +
  MAAS_STEPS +
  "。开通后回到本窗口，插件会自己检测到并完成。"

/** 已经开通时（点了登录但账号其实是好的）：不需要用户做任何事。 */
const MAAS_ALREADY_INSTRUCTIONS =
  "这个账号的 MaaS 已经开通，额度读取正常；本窗口会直接完成，不需要再做任何事。" +
  "（打开的控制台只是顺带，可以直接关掉。）"

/** 凭据被拒 / 没有凭据 → 走真正的华为云登录时说的话。 */
const MAAS_OAUTH_INSTRUCTIONS =
  "已保存的登录态不能用了（或还没有登录态），这里走的是**华为云登录**：在打开的页面里完成登录，本窗口会自动继续。" +
  "登录成功后，如果额度仍然显示「未接入 MaaS」，再点一次「重新登录」——那时插件会直接带你到 MaaS 控制台去开通。" +
  "这一步不会替你开通 MaaS。"

const DEFAULT_MAAS_WATCH_MS = 3 * 60_000
const DEFAULT_MAAS_WATCH_INTERVAL_MS = 5_000
const DEFAULT_MAAS_PROBE_MS = 1_200

/**
 * 见过「有凭据、但没有 MaaS appKey」的账号：身份 → 那份凭据。
 *
 * 用途只有一个：用户点「去 AgentArts 控制台开通 MaaS」时，插件用这份
 * **已保存的登录态**轮询开通结果 —— 不发起华为云登录。
 * `authorize()` 拿不到账号（magpie 恒传 `plugin.NewAccount`，见 README），
 * 所以这里按 provider 级记录；多账号时取最先见过的那个。
 */
const maasPending = new Map()

/**
 * 把一份凭据变成 magpie 的登录结果。
 *
 * ⚠ 控制台那两条路**没有新登录**：回写的还是同一份凭据（可能多了刚检测到的
 *   MaaS 字段）。magpie 会因此重读额度，卡片上的「未接入 MaaS」随之消失。
 */
function successOf(cred) {
  const identified = cred
  return {
    type: "success",
    refresh: identified.refreshToken ?? "",
    access: JSON.stringify(identified),
    expires: Date.parse(identified.expiresAt ?? "") || Date.now() + 3600_000,
    ...accountIdentityOf(identified),
  }
}

/** 记住/忘掉用的键：解析得出的身份优先，拿不到就退到 accountId / refreshToken。 */
function maasPendingKey(cred) {
  return accountIdentityOf(cred).id || cred?.accountId || cred?.refreshToken || PROVIDER
}

function noteMaasPending(cred) {
  if (!cred) return
  const key = maasPendingKey(cred)
  // 删了再放：最近见过的排到最后，latestMaasPending() 取的才是新的那份
  maasPending.delete(key)
  maasPending.set(key, cred)
}

/**
 * 旧记录补全：只有 STS、没有 modelAppKey 的账号，云端其实已经给了 `model_info`
 * （`GET /v1/claw/client-permission-validate` 回 `model_auth_info` + `model_api_url_base`）。
 *
 * 以前 loader/usage/models 只看存储里的字段，于是「登录完就能用模型」的账号
 * （比如 181****0632）被误判成「未接入 MaaS」，还要用户去 MaaS 控制台建 key ——
 * 而 OfficeAce 自己的模型网关（`modelgw-*.officeace...`）根本不需要那个 key。
 *
 * 读一次补上，按账号缓存 6 小时（失败不缓存，下次还会试）。
 */
const modelInfoCache = new Map() // identity → { at, cred }

async function hydratedCredential(cred, fetcher = (...args) => fetch(...args)) {
  if (!cred || cred.modelAppKey) return cred
  const id = accountIdentityOf(cred).id || cred.accountId || cred.refreshToken || "default"
  const hit = modelInfoCache.get(id)
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.cred
  const r = await checkMaasAccess(cred, fetcher, { timeoutMs: 3_000 }).catch(() => null)
  if (!r?.ok || !r.granted) return cred
  const merged = { ...cred, modelAppKey: r.modelAppKey, modelAppSecret: r.modelAppSecret, maasBaseUrl: r.maasBaseUrl }
  modelInfoCache.set(id, { at: Date.now(), cred: merged })
  return merged
}

/** 凭据是否到了该续期的时候（与 magpie 的 refreshLead 同一个判据）。 */
function needsRefresh(cred) {
  const at = Date.parse(cred?.expiresAt ?? "")
  return Number.isFinite(at) && at - Date.now() <= EXPIRY_LEAD_MS
}

/** 最近一次见到的、还没接 MaaS 的那份凭据（没有就是 null）。 */
function latestMaasPending() {
  const all = [...maasPending.values()]
  return all.length > 0 ? all[all.length - 1] : null
}

function forgetMaasPending(cred) {
  if (!cred) return
  maasPending.delete(maasPendingKey(cred))
}

/** 内嵌图标（OfficeAce 官方 .ico 转 PNG，13.6 KB）*/
const ICON =
  "data:image/png;base64,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"

export const OfficeAceAuthPlugin = async ({ client } = {}, options = {}) => {
  const maasWatchMs = Number.isFinite(options?.maasWatchMs) && options.maasWatchMs > 0 ? options.maasWatchMs : DEFAULT_MAAS_WATCH_MS
  const maasWatchIntervalMs =
    Number.isFinite(options?.maasWatchIntervalMs) && options.maasWatchIntervalMs > 0
      ? options.maasWatchIntervalMs
      : DEFAULT_MAAS_WATCH_INTERVAL_MS
  // 只有新代码用得上：允许测试注入 fetch（其余调用点仍用全局 fetch，与旧版一致）
  const maasFetcher = typeof options?.fetch === "function" ? options.fetch : (...args) => fetch(...args)
  const maasProbeMs = Number.isFinite(options?.maasProbeMs) && options.maasProbeMs > 0 ? options.maasProbeMs : DEFAULT_MAAS_PROBE_MS
  // 受控浏览器（持久 profile）：默认真起一个 Chromium；测试可注入。
  const openConsole = typeof options?.openConsole === "function" ? options.openConsole : openConsoleWindow
  const waitConsoleLogin =
    typeof options?.waitConsoleLogin === "function" ? options.waitConsoleLogin : waitForLoginAndSave
  // magpie 保存账号的那个文件（只读；见 src/accounts.mjs）。测试可注入。
  const authFile = officeAceAuthFile({ file: options?.authFile })
  // 测试注入：真实的 beginLogin 会去 CLAW 注册 state 并后台轮询 10 分钟
  const startLogin = typeof options?.beginLogin === "function" ? options.beginLogin : beginLogin

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
      /**
       * ⚠ 只有一个入口，进去之后自己分流（用户不用选）：
       *
       *   ① 手里有已保存的登录态 → 先用它打一次 MaaS 侧接口（**短超时**，默认 1.2s）
       *      ・granted     → 已开通：打开控制台给用户用，本窗口直接完成
       *      ・not-granted → 没开通：打开 AgentArts 控制台，轮询检测开通
       *      ・unknown     → 读不通（网络/超时）：按没开通处理（控制台可能仍是好的）
       *   ② dead（401/403）或根本没有登录态 → 走华为云 OAuth 登录
       *
       * ⚠ authorize() 必须立刻返回：探测用的是短超时，不是常规的 30s。
       *   真正的等待都在 callback() 里。
       */
      methods: [
        {
          type: "oauth",
          label: "华为云账号",
          async authorize() {
            // 已保存的登录态：内存里那份（刚读过额度，最新）优先；没有就从磁盘
            // 读 magpie 存下的账号 —— magpie 一重启内存就是空的，只看内存会把
            // 「明明有凭据」的用户送去登录页。
            let pending = latestMaasPending()
            if (!pending) pending = pickOfficeAceCredential(readOfficeAceAccounts({ file: authFile }))

            // 凭据过期/临期：先用它的 refresh_token 续一次（不续的话探测必然 401，
            // 用户又得重新登录一次）
            if (pending && needsRefresh(pending) && pending.refreshToken) {
              try {
                pending = (await refreshOnce(pending)) ?? pending
              } catch {
                /* 续不动就用旧的去探，探不动自然会走登录 */
              }
            }

            const probed = pending
              ? await probeMaasAccess(pending, maasFetcher, { timeoutMs: maasProbeMs })
              : { route: "dead", credential: null }
            const route = probed.route

            // ①-a 已经开通：不用轮询，直接完成（顺带把控制台开给用户）
            if (route === "granted" && probed.credential) {
              const ready = probed.credential
              return {
                url: MAAS_CONSOLE_URL,
                instructions: MAAS_ALREADY_INSTRUCTIONS,
                method: "auto",
                async callback() {
                  return successOf(ready)
                },
              }
            }

            // ①-b 凭据有效、MaaS 没开通（或这次读不通）：开控制台 + 轮询
            //
            // 优先用**受控 Chromium + 持久 profile**：第一次在这个窗口里登录一次，
            // cookie 被保存下来；以后打开控制台直接进，不再跳华为云登录页。
            // 浏览器起不来 → 回退成「系统浏览器 + 控制台链接」（不设 opened）。
            const use = probed.credential
            if ((route === "not-granted" || route === "unknown") && use) {
              const accountKey = accountIdentityOf(use).id || use.accountId || "default"
              const saved = loadSavedCookies(accountKey)
              let win = null
              try {
                win = await openConsole({ accountKey, url: CONSOLE_URL })
              } catch {
                win = null
              }
              const opened = Boolean(win?.ok)
              if (opened) {
                // 后台：先把上次保存的 cookie 注入这个窗口（有的话）再导航到控制台，
                // 然后等登录完成 → 抓 cookie 落盘。都不阻塞 authorize()。
                const prime = typeof options?.primeConsoleSession === "function" ? options.primeConsoleSession : primeSession
                Promise.resolve()
                  .then(() => prime(win, { accountKey, url: CONSOLE_URL }))
                  .then(() => waitConsoleLogin(win.port, accountKey, { timeoutMs: 5 * 60_000 }))
                  .catch(() => {})
              }
              return {
                url: MAAS_CONSOLE_URL,
                ...(opened ? { opened: true } : {}),
                instructions: opened
                  ? (saved ? "已用上次保存的华为云登录态打开 MaaS 控制台。" : "") + MAAS_WINDOW_INSTRUCTIONS
                  : MAAS_OPEN_INSTRUCTIONS,
                method: "auto",
                async callback() {
                  const granted = await watchMaasAccess(use, {
                    fetcher: maasFetcher,
                    timeoutMs: maasWatchMs,
                    intervalMs: maasWatchIntervalMs,
                    renew: (c) => refreshOnce(c),
                  }).catch(() => null)

                  if (!granted) {
                    return {
                      type: "failed",
                      error:
                        "还没有检测到 MaaS 开通。在控制台完成开通（授权管理 →「批量开通模型」／「鉴权管理」）后，回到这张卡再点一次「重新登录」即可。" +
                        (route === "unknown" ? " 另外这一次没能读通华为云（可能是网络或凭据问题），如果一直读不通，请重新登录一次。" : "") +
                        " 额度与签到不受影响。",
                    }
                  }
                  // 开通成功：把受控窗口收掉（用户不用再管它）
                  if (opened) {
                    try { await closeWindow(win) } catch {}
                  }
                  return successOf(granted)
                },
              }
            }

            // ② 凭据不能用（或没有）：真正的华为云登录
            const started = await startLogin()
            return {
              url: started.url,
              instructions: MAAS_OAUTH_INSTRUCTIONS,
              method: "auto",

              async callback() {
                try {
                  const cred = await started.result
                  // 卡片名用手机号，不用 domain id（见 src/phone.mjs 顶部）
                  const identified = { ...cred, ...(await phoneField(cred)) }
                  if (!identified.modelAppKey) noteMaasPending(identified)
                  return {
                    type: "success",
                    // magpie 的 refreshLead 机制读这个
                    refresh: identified.refreshToken ?? "",
                    // 完整凭据（JSON 字符串，与前版同形状 + 一个可选 user_phone）
                    access: JSON.stringify(identified),
                    expires: Date.parse(identified.expiresAt ?? "") || Date.now() + 3600_000,
                    // 卡片显示名（手机号）/ 身份（domain id）
                    ...accountIdentityOf(identified),
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
          // 续期会重建凭据：保住只存在于旧记录里的 user_phone；老账号在这里懒补一次
          const kept = {
            ...next,
            ...(cred.user_phone && !next.user_phone ? { user_phone: cred.user_phone } : {}),
          }
          const identified = kept.user_phone ? kept : { ...kept, ...(await phoneField(kept)) }
          if (identified.modelAppKey) forgetMaasPending(identified)
          return {
            access: JSON.stringify(identified),
            refresh: identified.refreshToken ?? cred.refreshToken,
            expires: Date.parse(identified.expiresAt ?? "") || Date.now() + 3600_000,
            ...accountIdentityOf(identified),
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
        const base = credentialOf(auth)
        if (!base) return {}
        // 旧记录没有 modelAppKey？先向云端补一次 model_info（见 hydratedCredential）
        const cred = await hydratedCredential(base, maasFetcher)

        // 有凭据但没有 MaaS 的 Basic 凭据（尚未在 OfficeAce 客户端接入 MaaS）。
        // 额度与签到走 STS，是好的；对话走 /v2/chat/completions 要 appKey。
        //
        // 以前这里直接 `return {}`（不接管），请求会落到 magpie 自己的空 apiKey 上，
        // 上游回 `400 ModelArts.81002 Failed to get the authorization header` ——
        // 用户看到的是「模型报错」，看不出是「账号还没接入 MaaS」（issue #2）。
        // 现在接管，但直接回一个说清楚原因的 400，不把空 Basic 头发给上游。
        if (cred.modelAppKey) forgetMaasPending(cred)
        else noteMaasPending(cred)

        if (!cred.modelAppKey) {
          return {
            async fetch() {
              return new Response(
                JSON.stringify({
                  error: {
                    message:
                      "OfficeAce 账号已登录，但还没有接入华为云 MaaS（凭据里没有 modelAppKey）。" +
                      "两条路都行：\n" +
                      "① OfficeAce 客户端：左侧「模型」→ 右上角「接入模型」→「接入华为云 MaaS 模型」→ 接入类型选「华为云 MaaS 按需计费」→ 填 MaaS 控制台创建的 API Key → 连通性测试 → 确认。\n" +
                      "② AgentArts 控制台：管理中心 → 授权管理 →「模型」页签 →「批量开通模型」；再「鉴权管理」→ 在 MaaS 服务创建 API Key → 确定。\n" +
                      "步骤：https://support.huaweicloud.com/usermanual-officeace/officeace_02_0018.html\n" +
                      "额度与签到不受影响，已经可以正常使用。",
                    type: "officeace_maas_not_linked",
                    code: "MaaSNotLinked",
                  },
                }),
                { status: 400, headers: { "content-type": "application/json" } }
              )
            },
          }
        }

        return {
          // 空 baseURL：由 chatFetch 自己拼目标地址
          baseURL: "",
          // 空 apiKey：我们自己加 Basic 头
          apiKey: "",

          async fetch(input, init) {
            // ⚠ 每次重新读 auth —— 可能已被 refresh 更新
            const fresh = await getAuth()
            const latest = credentialOf(fresh) ?? cred
            // 旧记录没有 modelAppKey 时补一次（否则 chatFetch 会报「未接入 MaaS」）
            const current = await hydratedCredential(latest, maasFetcher)

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
        const stored = credentialOf(auth)
        if (!stored) return { error: "未登录", windows: [] }
        // 旧记录先补 model_info —— 有模型网关就不用再标「未接入 MaaS」
        const cred = await hydratedCredential(stored, maasFetcher)

        // 没接入 MaaS：卡片上用 plan 标明（只影响显示），并让 magpie 在这张
        // 卡上给出「Sign in again」按钮（登录说明里带官方接入入口）。有
        // modelAppKey 时两个都不给。
        const maasMissing = !cred.modelAppKey
        if (maasMissing) noteMaasPending(cred)
        else forgetMaasPending(cred)
        try {
          const u = await fetchUsage(cred)
          return {
            plan: maasMissing ? MAAS_MISSING_PLAN : u.plan || PROVIDER_NAME,
            ...(maasMissing ? { signIn: "expired" } : {}),
            ...(cred.user_phone || cred.accountId ? { user: cred.user_phone || cred.accountId } : {}),
            windows: u.windows,
          }
        } catch (e) {
          // error 字段会替代 windows 显示
          return {
            error: String(e?.message ?? e).slice(0, 300),
            windows: [],
            ...(maasMissing ? { plan: MAAS_MISSING_PLAN, signIn: "expired" } : {}),
          }
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
        const stored = credentialOf(auth)
        if (!stored) return fallback
        // 旧记录没有 modelAppKey？先补 model_info；补不到才退回静态表
        const cred = await hydratedCredential(stored, maasFetcher)
        if (!cred.modelAppKey) return fallback

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
  MAAS_MISSING_PLAN,
  MAAS_CONSOLE_URL,
  MAAS_API_KEY_URL,
  MAAS_STEPS,
  MAAS_OAUTH_INSTRUCTIONS,
  MAAS_OPEN_INSTRUCTIONS,
  MAAS_ALREADY_INSTRUCTIONS,
  maasPending,
  maasPendingKey,
  noteMaasPending,
  forgetMaasPending,
  latestMaasPending,
  successOf,
  checkMaasAccess,
  watchMaasAccess,
  probeMaasAccess,
  needsRefresh,
  readOfficeAceAccounts,
  pickOfficeAceCredential,
  officeAceAuthFile,
  openConsoleWindow,
  waitForLoginAndSave,
  loadSavedCookies,
  primeSession,
  hydratedCredential,
  modelInfoCache,
}