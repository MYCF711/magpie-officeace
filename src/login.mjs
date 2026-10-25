// 登录（华为云 OAuth PKCE + DPoP）与续期
//
// ═══════════════════════════════════════════════════════════════════
// 登录流程
// ═══════════════════════════════════════════════════════════════════
//
//   1. POST {CLAW}/v1/claw/auth/state          → 云端登记 state
//   2. 打开 auth.huaweicloud.com（PKCE + DPoP）
//   3. 轮询 GET {CLAW}/v1/claw/auth/code?state=…  → 拿授权码
//   4. POST {TOKEN_URL}                        → 换 STS 凭据（AK/SK/securityToken）
//   5. GET  {CLAW}/v1/claw/client-permission-validate → 拿 MaaS 的 appKey/appSecret
//
// ⚠ **authorize() 必须立刻返回**，不能在里面等用户完成登录。
//   真正等登录的是 callback()。死等会让双方互等。
//   所以这里把「等」放进挂起的 result promise。
//
// ═══════════════════════════════════════════════════════════════════
// 续期的两个坑
// ═══════════════════════════════════════════════════════════════════
//
// 1. refresh_token 是**一次性**的。两个并发请求同时看到临期 → 各发一次
//    续期 → 第二次去消费已被消费的 token → 凭据永久失效，只能重新登录。
//    故必须**去重**，且键要用凭据身份（refreshToken）而不是渠道 id ——
//    账号池下同渠道有多个账号，按渠道键控会让 B 共享 A 的结果。
//
// 2. STS 一成功就**立即落盘**，不等 modelInfo。原先等 modelInfo 一起成功
//    才落盘，中途崩掉就把新 refresh_token 丢了。
//
// ═══════════════════════════════════════════════════════════════════

import { createHash, randomBytes } from "node:crypto"

import {
  CLIENT_ID,
  CLAW_BASE,
  CODE_PATH,
  EXPIRY_LEAD_MS,
  LOGIN_TIMEOUT_MS,
  PERMISSION_PATH,
  POLL_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  REDIRECT_URI,
  STATE_PATH,
  TOKEN_URL,
} from "./constants.mjs"

import { generateDpopKeyPair, importDpopKey, signDpop, signHuaweiRequest } from "./crypto.mjs"

// ── ① 云端登记 state ──────────────────────────────────────────────

async function registerState() {
  const r = await fetch(`${CLAW_BASE}${STATE_PATH}`, {
    method: "POST",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!r.ok) {
    throw new Error(`OfficeAce state 登记失败：HTTP ${r.status}`)
  }
  const j = await r.json().catch(() => null)
  const state = j?.state ?? j?.data?.state
  if (typeof state !== "string" || state.length === 0) {
    throw new Error("OfficeAce state 登记响应缺少 state")
  }
  return state
}

// ── ③ 轮询授权码 ──────────────────────────────────────────────────

async function pollCode(state) {
  const r = await fetch(`${CLAW_BASE}${CODE_PATH}?state=${encodeURIComponent(state)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!r.ok) return null
  const j = await r.json().catch(() => null)
  const code = j?.code ?? j?.data?.code
  return typeof code === "string" && code.length > 0 ? code : null
}

// ── ④ 换 STS 凭据 ─────────────────────────────────────────────────

async function exchangeToken(code, codeVerifier, dpopPrivateJwk) {
  const privateKey = await importDpopKey(dpopPrivateJwk)
  const publicJwk = {
    kty: "EC",
    crv: "P-256",
    x: dpopPrivateJwk.x,
    y: dpopPrivateJwk.y,
  }
  const dpopJwt = await signDpop(privateKey, publicJwk, "POST", TOKEN_URL)

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  })

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", DPoP: dpopJwt },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await r.text()
  if (!r.ok) {
    throw new Error(`华为云 token 交换失败：HTTP ${r.status} ${text.slice(0, 200)}`)
  }
  const token = JSON.parse(text)
  const c = token.credentials
  if (!c?.access_key_id || !c?.secret_access_key || !c?.security_token) {
    throw new Error("华为云 token 响应缺少凭据")
  }

  return {
    access: c.access_key_id,
    secret: c.secret_access_key,
    securityToken: c.security_token,
    projectId: c.project_id ?? "",
    expiresAt: c.expiration ?? "",
    refreshToken: token.refresh_token ?? "",
    dpopPrivateJwk,
  }
}

// ── ⑤ 权限校验 → MaaS 凭据 ────────────────────────────────────────

async function fetchModelInfo(cred) {
  const url = `${CLAW_BASE}${PERMISSION_PATH}`
  const headers = {
    "content-type": "application/json",
    "x-security-token": cred.securityToken,
  }
  if (cred.projectId) headers["x-project-id"] = cred.projectId

  const signed = signHuaweiRequest("GET", url, headers, "", cred.access, cred.secret)
  const r = await fetch(url, {
    method: "GET",
    headers: signed,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await r.text()
  if (!r.ok) {
    throw new Error(`华为云权限校验失败：HTTP ${r.status} ${text.slice(0, 200)}`)
  }

  const j = JSON.parse(text)
  const auth = j.subscription?.model_info?.model_auth_info
  const base = j.subscription?.model_info?.model_api_url_base

  if (typeof auth?.model_app_key !== "string" || typeof auth?.model_app_secret !== "string") {
    // ⚠ 必须给出路：只说「未订阅」用户无从下手
    throw new Error(
      "账号未开通 ModelArts MaaS：请在华为云控制台或 OfficeAce 客户端完成开通后重试。",
    )
  }

  return {
    modelAppKey: auth.model_app_key,
    modelAppSecret: auth.model_app_secret,
    // ⚠ 实测当前可能为空串 → maasBase() 会回退官方直连地址
    maasBaseUrl: typeof base === "string" && base.length > 0 ? base : "",
  }
}

// ── 启动登录 ──────────────────────────────────────────────────────

/**
 * 启动登录。
 *
 * @returns {Promise<{url: string, result: Promise<object>}>}
 *   url 立刻可用（magpie 会打开它）；result 兑现完整凭据。
 */
export async function beginLogin() {
  const state = await registerState()

  const codeVerifier = randomBytes(32).toString("base64url")
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
  const { privateJwk } = await generateDpopKeyPair()

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: "SHA-256",
    state,
    scope: "openid",
    redirect_uri: REDIRECT_URI,
    response_type: "code",
  })

  const authorizeUrl = `https://auth.huaweicloud.com/authui/login.html?service=${encodeURIComponent(
    `https://auth.huaweicloud.com/authui/v1/oauth2/authorize?${params.toString()}`,
  )}`

  // ⚠ 后台推进：先返回 url，让调用方立刻拿到（否则与 magpie 死锁）
  const result = (async () => {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      const code = await pollCode(state)
      if (!code) continue

      const exchanged = await exchangeToken(code, codeVerifier, privateJwk)
      let info
      try {
        info = await fetchModelInfo(exchanged)
      } catch (e) {
        // MaaS 权限读不到不阻断登录本身 —— 用户可能还没开通，但 STS 凭据有效
        info = {}
        console.warn(`[officeace] 权限校验失败：${e?.message ?? e}`)
      }
      return { ...exchanged, ...info, codeVerifier }
    }
    throw new Error("OfficeAce 登录超时（10 分钟）")
  })()

  return { url: authorizeUrl, result }
}

// ── 续期 ──────────────────────────────────────────────────────────

/**
 * 续期的纯协议部分。
 *
 * ⚠ 落盘职责留给调用方（避免同一份凭据被写两处、重复消费一次性 refresh_token）。
 *
 * @param {object} current 当前凭据
 * @param {(next: object) => void} [persist] STS 成功后的立即落盘回调
 */
async function doRefresh(current, persist) {
  if (!current.refreshToken) throw new Error("凭据不支持续期，请重新登录")

  const privateKey = await importDpopKey(current.dpopPrivateJwk)
  const publicJwk = {
    kty: "EC",
    crv: "P-256",
    x: current.dpopPrivateJwk.x,
    y: current.dpopPrivateJwk.y,
  }
  const dpopJwt = await signDpop(privateKey, publicJwk, "POST", TOKEN_URL)

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", DPoP: dpopJwt },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!r.ok) {
    const detail = await r.text().catch(() => "")
    console.warn(
      `[officeace] STS 续期失败 HTTP ${r.status}：${detail.slice(0, 200)}` +
        "（refresh_token 是一次性的：若报 STS5.1806 已被消费，必须重新登录）",
    )
    throw Object.assign(new Error("OfficeAce 续期失败，请重新登录"), {
      signIn: "expired",
    })
  }

  const token = await r.json()
  const c = token.credentials
  if (!c?.access_key_id) throw new Error("续期响应缺少凭据")

  const next = {
    ...current,
    access: c.access_key_id,
    secret: c.secret_access_key,
    securityToken: c.security_token,
    projectId: c.project_id ?? current.projectId,
    expiresAt: c.expiration,
    refreshToken: token.refresh_token ?? current.refreshToken,
  }

  // ⚠ STS 一成功立即落盘，不等 modelInfo（此刻旧 refresh_token 已作废）
  persist?.(next)

  try {
    Object.assign(next, await fetchModelInfo(next))
  } catch {
    // modelInfo 失败不回滚 STS：推理凭据可能仍有效
  }

  return next
}

/** 并发去重闸 */
const refreshInFlight = new Map()

/**
 * 带并发去重的续期。
 *
 * ⚠ 键必须是**凭据身份**（refreshToken），不是渠道 id ——
 *   账号池下同渠道有多个账号并发续期，按渠道键控会让账号 B
 *   共享账号 A 的续期结果（拿到别人的凭据，且 B 的 token 根本没被消费）。
 */
export function refreshOnce(current, persist) {
  const key = `officeace\n${current?.refreshToken ?? ""}`
  const pending = refreshInFlight.get(key)
  if (pending !== undefined) return pending

  const task = doRefresh(current, persist).finally(() => refreshInFlight.delete(key))
  refreshInFlight.set(key, task)
  return task
}

export { EXPIRY_LEAD_MS }