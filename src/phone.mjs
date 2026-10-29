// 账号卡片名：从华为云 IAM 读一次手机号
//
// ═══════════════════════════════════════════════════════════════════
// 问题（与 codearts 0.2.5 同源）
// ═══════════════════════════════════════════════════════════════════
//
// 华为云 OAuth 的 refresh_token 是 JWT，`user_profile` claim 里只有 IAM 自己的
// id：`account_id` / `account_name` / `principal_id` / `principal_urn`，**没有手机号**。
// 于是卡片只能显示 `01a1642ad2ae7f93bf6387ad2fc5f09e` 这种 domain id ——
// 在三个账号并排时，用户看到的就是三串「乱码」，分不清谁是谁。
//
// 手机号其实一步之遥：同一套 STS 三元组（SDK-HMAC-SHA256）就能读
//   GET https://iam.cn-north-4.myhuaweicloud.com/v3.0/OS-USER/users/{principal_id}
// 返回 `user.phone`（实测 `0086-18970098051`）。
// ⚠ 同路径的 `/v3.1/` 是 `APIGW.0101`（API 不存在），只有 `/v3.0/` 通。
//
// ═══════════════════════════════════════════════════════════════════
// 三条规矩（与 magpie-plugin-scaffold 的 account-name 一致）
// ═══════════════════════════════════════════════════════════════════
//
// ① **失败不能阻塞登录**：取不到手机号只是显示问题，登录本身已经成功 ——
//    回落到 `accountId`（domain id），不编造、不抛。
// ② **手机号一律打码**：`0086-18970098051` / `+86 189 7009 8051` / 裸号 → `189****8051`，
//    和别的供应商（loomy / accio / trustoken / codearts）卡片一致。
// ③ **identity 与显示名分开**：`accountId` 给人看（手机号），`uid` 放身份
//    （domain id / URN）。身份字段绝不能写进 `accountId`。

import { signHuaweiRequest } from "./crypto.mjs"

const IAM_USER_URL = (userId) =>
  `https://iam.cn-north-4.myhuaweicloud.com/v3.0/OS-USER/users/${encodeURIComponent(userId)}`
const IAM_TIMEOUT_MS = 8_000
// 手机号对同一个 IAM 用户不会变；卡片会被频繁读，一个进程读一次就够
const IAM_PHONE_TTL_MS = 6 * 60 * 60 * 1000

const phoneByIamUser = new Map()

/** 手机号打码成 `189****8051`（去国家码；已打码的值原样保留）。 */
export function maskPhone(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "")
  // 国家码去掉，只在后面还剩够长的号码时才去（`86123456789` 这种真号不能被砍）
  if (digits.startsWith("0086") && digits.length - 4 >= 7) digits = digits.slice(4)
  else if (digits.startsWith("86") && digits.length - 2 >= 7) digits = digits.slice(2)
  if (digits.length < 7) return ""
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

/** 解 JWT 的 payload（不验签：只读自己刚存的 token 的 claim）。 */
function jwtPayload(token) {
  const parts = String(token ?? "").split(".")
  if (parts.length !== 3) return null
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const text = Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").toString("utf8")
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** refresh_token 里的 `user_profile` claim（字符串装 JSON，或直接对象）。 */
export function profileOf(cred) {
  const payload = jwtPayload(cred?.refreshToken)
  const raw = payload?.user_profile
  if (typeof raw === "string") {
    try {
      const b64 = raw.replace(/-/g, "+").replace(/_/g, "/")
      return JSON.parse(Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").toString("utf8"))
    } catch {
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    }
  }
  return raw && typeof raw === "object" ? raw : null
}

/** IAM 用户 id（`principal_id`），没有就空串 —— 没有它就别去问 IAM。 */
export function iamUserIdOf(cred) {
  return String(profileOf(cred)?.principal_id ?? "").trim()
}

/**
 * 读这个账号自己的手机号（打码后）。全程 best effort：没有 claim、被拒、
 * 返回里没号码，一律返回空串，由调用方回落到 `accountId`。
 */
export async function fetchAccountPhone(cred, fetcher = globalThis.fetch) {
  const userId = iamUserIdOf(cred)
  if (!userId || !cred?.access || !cred?.secret || !cred?.securityToken) return ""
  const hit = phoneByIamUser.get(userId)
  if (hit && Date.now() - hit.at < IAM_PHONE_TTL_MS) return hit.phone
  try {
    const url = IAM_USER_URL(userId)
    const signed = signHuaweiRequest(
      "GET", url,
      { "x-security-token": cred.securityToken },
      "",
      cred.access, cred.secret,
    )
    const res = await fetcher(url, {
      method: "GET",
      headers: { ...signed, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(IAM_TIMEOUT_MS),
    })
    if (!res.ok) return ""
    const body = await res.json().catch(() => null)
    const phone = maskPhone(body?.user?.phone)
    if (phone) phoneByIamUser.set(userId, { at: Date.now(), phone })
    return phone
  } catch {
    return ""
  }
}

/** `{ user_phone }`，取不到就是 `{}`（永远不抛）。 */
export async function phoneField(cred, fetcher) {
  try {
    const phone = await fetchAccountPhone(cred, fetcher)
    return phone ? { user_phone: phone } : {}
  } catch {
    return {}
  }
}

/** 交给 magpie 的 `{ accountId, uid }`：手机号当名字，domain id 当身份。 */
export function accountIdentityOf(cred) {
  const accountId = String(cred?.user_phone ?? "").trim()
  const uid = String(cred?.accountId ?? "").trim()
  return {
    ...(accountId || uid ? { accountId: accountId || uid } : {}),
    ...(uid ? { uid } : {}),
  }
}