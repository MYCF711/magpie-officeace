// 未接入 MaaS 的账号：用已保存的登录态检测开通进度
//
// ═══════════════════════════════════════════════════════════════════
// 为什么需要这个模块
// ═══════════════════════════════════════════════════════════════════
//
// 「登录成功但没接入 MaaS」的账号：STS 三元组是好的（额度、签到都能跑），
// 但 `client-permission-validate` 还没下发 `model_auth_info`，所以拿不到
// MaaS 的 appKey/appSecret，对话用不了。
//
// 用户要做的只有一件事：去 AgentArts 控制台把这个账号的 MaaS 开通。
// 以前卡片上那个「重新登录」按钮走的是**华为云 OAuth 登录** —— 和开通
// MaaS 没有关系，用户点了会以为插件会替他开通，实际不会。
//
// 这里提供两件事：
//   checkMaasAccess()  用**已有凭据**读一次权限接口，看 MaaS 开通了没有（只读）
//   watchMaasAccess()  轮询上面那个接口，直到开通、或超时
//
// ⚠ 只用已保存的 STS 三元组，不发起任何登录；不开通任何东西。

import { CLAW_BASE, PERMISSION_PATH, REQUEST_TIMEOUT_MS, EXPIRY_LEAD_MS } from "./constants.mjs"
import { signHuaweiRequest } from "./crypto.mjs"

/**
 * 读一次权限接口，判断这个账号的 MaaS 开通了没有。
 *
 * @returns {Promise<{ok: true, granted: false} |
 *                   {ok: true, granted: true, modelAppKey, modelAppSecret, maasBaseUrl} |
 *                   {ok: false, status: number, detail: string}>}
 *   `ok: false` 是**这次读失败**（网络/签名/HTTP），不代表没开通。
 */
export async function checkMaasAccess(cred, fetcher = fetch, opts = {}) {
  if (!cred?.access || !cred?.securityToken) return { ok: false, status: 0, detail: "凭据缺 access / securityToken" }
  const timeoutMs = Number.isFinite(opts?.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : REQUEST_TIMEOUT_MS

  const url = `${CLAW_BASE}${PERMISSION_PATH}`
  const headers = {
    "content-type": "application/json",
    "x-security-token": cred.securityToken,
  }
  if (cred.projectId) headers["x-project-id"] = cred.projectId

  // ⚠ 不用 AbortSignal.timeout()：它的计时器**是 unref 的** —— 事件循环一空，
  //   进程先于计时器退出，那次「卡住的请求」就永远不 settle（CI 上就是这样把
  //   测试挂住、被 node --test 判成 cancelledByParent）。自己拿一个普通
  //   setTimeout（ref 住），并在结束前一定 clearTimeout。
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`请求超过 ${timeoutMs}ms 未响应`)), timeoutMs)
  let r
  try {
    const signed = signHuaweiRequest("GET", url, headers, "", cred.access, cred.secret)
    r = await fetcher(url, { method: "GET", headers: signed, signal: ac.signal })
  } catch (e) {
    return { ok: false, status: 0, detail: String(e?.message ?? e).slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }

  const text = await r.text().catch(() => "")
  if (!r.ok) return { ok: false, status: r.status, detail: text.trim().slice(0, 200) }

  let j
  try {
    j = JSON.parse(text)
  } catch {
    return { ok: false, status: r.status, detail: "响应不是 JSON" }
  }

  const info = j?.subscription?.model_info
  const auth = info?.model_auth_info
  const base = info?.model_api_url_base
  const accountId = typeof j?.account_id === "string" ? j.account_id : ""
  if (typeof auth?.model_app_key !== "string" || typeof auth.model_app_secret !== "string") {
    return { ok: true, granted: false, accountId }
  }
  return {
    ok: true,
    granted: true,
    accountId,
    modelAppKey: auth.model_app_key,
    modelAppSecret: auth.model_app_secret,
    maasBaseUrl: typeof base === "string" && base.length > 0 ? base : "",
  }
}

/**
 * 「接入模型」的自动完成：调 CLAW 的 client-subscription，让云端给这个账号
 * 创建/补发 model_info（model_app_key + model_app_secret）。
 *
 * 这就是 OfficeAce 客户端「模型 → 接入模型 → 接入华为云 MaaS 模型」背后真正
 * 让它生效的那一步（客户端源码 `channel-plugins/auth/officeace-huawei-oauth`
 * 里的 `subscriptionClaw()`，同一个端点、同一个 V11 签名）。
 *
 * 2026-10-31 真机实测：181****6710 / 180****2361 / 187****5670 三个原本
 * 「未接入 MaaS」的账号调用后都拿到了 model_info，网关 /v2/models 回 200（25 个模型）。
 *
 * ⚠ 这是**写操作**（订阅/开通），只在账号确实缺 model_info 时调用一次；
 *   调用前必须已有有效 STS 凭据。
 *
 * @returns {Promise<{ok:true, granted:true, modelAppKey, modelAppSecret, maasBaseUrl, accountId?} |
 *                   {ok:true, granted:false} |
 *                   {ok:false, status:number, detail:string}>}
 */
export async function subscribeClientModelInfo(cred, fetcher = fetch, opts = {}) {
  if (!cred?.access || !cred?.securityToken) return { ok: false, status: 0, detail: "凭据缺 access / securityToken" }
  const timeoutMs = Number.isFinite(opts?.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : REQUEST_TIMEOUT_MS
  const url = `${CLAW_BASE}/v1/claw/client-subscription`
  const body = "{}"
  const headers = {
    "content-type": "application/json;charset=utf8",
    "x-subscription-type": "v2",
    "x-security-token": cred.securityToken,
  }
  if (cred.projectId) headers["x-project-id"] = cred.projectId
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`请求超过 ${timeoutMs}ms 未响应`)), timeoutMs)
  let r
  try {
    const signed = signHuaweiRequest("POST", url, headers, body, cred.access, cred.secret)
    r = await fetcher(url, { method: "POST", headers: signed, body, signal: ac.signal })
  } catch (e) {
    return { ok: false, status: 0, detail: String(e?.message ?? e).slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
  const text = await r.text().catch(() => "")
  if (!r.ok) return { ok: false, status: r.status, detail: text.trim().slice(0, 200) }
  let j
  try {
    j = JSON.parse(text)
  } catch {
    return { ok: false, status: r.status, detail: "响应不是 JSON" }
  }
  const info = j?.model_info ?? j?.subscription?.model_info
  const auth = info?.model_auth_info
  const base = info?.model_api_url_base
  if (typeof auth?.model_app_key !== "string" || typeof auth.model_app_secret !== "string") {
    return { ok: true, granted: false }
  }
  return {
    ok: true,
    granted: true,
    accountId: typeof j?.account_id === "string" ? j.account_id : undefined,
    modelAppKey: auth.model_app_key,
    modelAppSecret: auth.model_app_secret,
    maasBaseUrl: typeof base === "string" && base.length > 0 ? base : "",
  }
}

/**
 * 轮询到 MaaS 开通为止（只读）。
 *
 * @param {object} cred   已保存的凭据（STS 三元组 + refreshToken）
 * @param {object} [opts]
 * @param {Function} [opts.fetcher]
 * @param {number} [opts.timeoutMs]    等多久（默认 3 分钟）
 * @param {number} [opts.intervalMs]   每次间隔（默认 5 秒）
 * @param {Function} [opts.renew]      临期时续期一次的回调（可选）
 * @returns {Promise<object|null>} 开通后的完整凭据（合并了 MaaS 字段），超时/null
 */
export async function watchMaasAccess(cred, opts = {}) {
  const fetcher = opts.fetcher ?? fetch
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 3 * 60_000
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0 ? opts.intervalMs : 5_000
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const renew = opts.renew ?? null

  let use = cred
  const deadline = now() + timeoutMs

  for (;;) {
    // 凭据临期先续一次（不续的话权限接口会回 401，看起来像「还没开通」）
    if (renew) {
      const at = Date.parse(use?.expiresAt ?? "")
      if (Number.isFinite(at) && at - now() <= EXPIRY_LEAD_MS) {
        try {
          const next = await renew(use)
          if (next) use = next
        } catch {
          /* 续期失败就用手上这份继续试 */
        }
      }
    }

    const r = await checkMaasAccess(use, fetcher)
    if (r.ok && r.granted) {
      return { ...use, modelAppKey: r.modelAppKey, modelAppSecret: r.modelAppSecret, maasBaseUrl: r.maasBaseUrl }
    }

    if (now() >= deadline) return null
    await sleep(Math.max(0, Math.min(intervalMs, deadline - now())))
  }
}

/**
 * `authorize()` 里那一次「先拿已保存的凭据试一下」。
 *
 * 只做一次读，且**必须很快**（`authorize()` 要立刻返回）—— 所以给一个短超时。
 *
 * @returns {Promise<{route: "granted"|"not-granted"|"dead"|"unknown", credential: object|null}>}
 *   granted     已经接入 MaaS：`credential` 是合并了 MaaS 字段的那份（直接回写即可）
 *   not-granted 凭据有效、但 MaaS 没开通（开控制台让用户去开通）
 *   dead        凭据被拒（401/403）或没有凭据（要重新登录）
 *   unknown     读失败但不是明确被拒（网络/超时）—— 当作 not-granted 处理
 */
export async function probeMaasAccess(cred, fetcher = fetch, opts = {}) {
  if (!cred) return { route: "dead", credential: null }
  const r = await checkMaasAccess(cred, fetcher, { timeoutMs: opts?.timeoutMs }).catch(() => ({ ok: false, status: 0 }))
  if (r.ok && r.granted) {
    return {
      route: "granted",
      credential: { ...cred, modelAppKey: r.modelAppKey, modelAppSecret: r.modelAppSecret, maasBaseUrl: r.maasBaseUrl },
    }
  }
  if (r.ok) return { route: "not-granted", credential: cred }
  if (r.status === 401 || r.status === 403) return { route: "dead", credential: null }
  return { route: "unknown", credential: cred }
}
