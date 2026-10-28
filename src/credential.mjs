//
// credential.mjs — 凭据形状与解析
//
// 目录：
//   parseMaybeJson  安全解析（对象直用，字符串 JSON.parse）
//   credentialOf   magpie 账号记录 → 完整凭据（或 null）
//   toStored       凭据 → magpie 存储形状（⚠ 改形状等于让老用户掉登录态）
//   expiryMs       凭据的过期毫秒
//   isNearExpiry   是否临期（提前 EXPIRY_LEAD_MS 续期）
//   basicAuthFingerprint  Basic 凭据指纹（判断续期后有没有变化）
//   isBasicCredentialRejection  一次拒绝是否是「这对 Basic 凭据不被接受」
//

import { EXPIRY_LEAD_MS } from "./constants.mjs"

// ─── 安全解析 ─────────────────────────────────────────────────────

/** 安全解析：对象直接用，字符串尝试 JSON.parse */
function parseMaybeJson(raw) {
  if (raw && typeof raw === "object") return raw
  if (typeof raw !== "string" || raw.length === 0) return null
  try {
    const j = JSON.parse(raw)
    return j && typeof j === "object" ? j : null
  } catch {
    return null
  }
}

/**
 * 读一个 magpie 账号记录，取出完整的凭据对象。
 *
 * 兼容两种来源：
 *   ① 本插件的形状（access 是 JSON 字符串）
 *   ② 凭据字段直接铺在 auth 上（勉强兼容，比如手写的记录）
 *
 * @returns {object|null} 完整凭据，或 null（未登录 / 形状不对）
 */
export function credentialOf(auth) {
  if (!auth) return null

  // ① 标准形状
  const parsed = parseMaybeJson(auth.access)
  if (parsed && typeof parsed.modelAppKey === "string" && parsed.modelAppKey.length > 0) {
    // refresh 可能与内嵌的 refreshToken 不同（magpie 单独存一份）
    return {
      ...parsed,
      refreshToken: auth.refresh || parsed.refreshToken || "",
    }
  }

  // ② 字段直接铺开的形状
  if (typeof auth.modelAppKey === "string" && auth.modelAppKey.length > 0) {
    return {
      ...auth,
      refreshToken: auth.refresh || auth.refreshToken || "",
    }
  }

  // ③ 只有 STS 三元组（access / securityToken）也算已登录
  //
  //   额度查询（GET {SUB}/v1/subscription）与每日签到（POST .../bonus/claim）
  //   都走 V11-HMAC-SHA256 签名，只用到 STS；modelAppKey 仅用于 MaaS 的
  //   Basic 认证（模型目录 / 对话），缺了它不影响额度与签到。
  //
  //   原实现只认 modelAppKey，于是「登录成功但 model_auth_info 尚未下发
  //   appKey」的账号（例如尚未在 OfficeAce 客户端接入 MaaS）被误判成未登录：
  //   卡片显示「未登录」，每日签到固定失败。实测仅带 STS 的凭据打订阅
  //   接口返回 200，签到/额度均正常。
  const stsReady = (c) =>
    c &&
    typeof c.access === "string" && c.access.length > 0 &&
    typeof c.securityToken === "string" && c.securityToken.length > 0

  if (parsed && stsReady(parsed)) {
    return {
      ...parsed,
      refreshToken: auth.refresh || parsed.refreshToken || "",
    }
  }
  if (stsReady(auth)) {
    return {
      ...auth,
      refreshToken: auth.refresh || auth.refreshToken || "",
    }
  }

  return null
}

/**
 * 把凭据写回 magpie 记录的形状。
 *
 * ⚠ 这个函数的输出会被 magpie 存进 plugin-auth.json。
 *   改形状就等于让老用户的登录态失效 —— 不要改。
 *
 * @param {object} cred   完整凭据
 * @param {object} [prev] 上一份记录（保留 type 等字段）
 */
export function toStored(cred, prev) {
  return {
    ...(prev ?? {}),
    type: "oauth",
    // magpie 的 expires 是毫秒时间戳
    expires: expiryMs(cred),
    // 嵌在 access 里的完整凭据
    access: JSON.stringify(cred),
    // magpie 的 refreshLead 机制读这个字段
    refresh: cred.refreshToken ?? "",
    // 卡片显示名（三级回退：accountId → metadata.email → email）
    accountId: cred.accountId ?? "",
    // 厂商自己的 id（区分同名账号）
    uid: cred.accountId ?? "",
  }
}

/** 凭据的过期毫秒（拿不到就 0） */
export function expiryMs(cred) {
  const at = Date.parse(cred?.expiresAt ?? "")
  return Number.isFinite(at) ? at : 0
}

/** 是否临期（提前 EXPIRY_LEAD_MS 就续）*/
export function isNearExpiry(cred, nowMs = Date.now()) {
  const at = expiryMs(cred)
  return at > 0 && at - nowMs <= EXPIRY_LEAD_MS
}

/** Basic 凭据指纹（判断续期后有没有变化；不含 STS）*/
export function basicAuthFingerprint(cred) {
  return `${cred?.modelAppKey ?? ""}:${cred?.modelAppSecret ?? ""}:${cred?.maasBaseUrl ?? ""}`
}

/**
 * 判断一次拒绝是不是「这对 Basic 凭据不被接受」。
 *
 * 判据（与 login.mjs 的报错文案对齐）：
 *   - 401 / 403 → 是
 *   - 4xx 且报文点名 app/key/secret → 是
 *   - 其余 → 不是
 *
 *   ⚠ 不含「ModelArts.81002 Failed to get the authorization header」——
 *     那是「Authorization 头缺失/为空」（凭据里根本没有 modelAppKey），
 *     属于未接入 MaaS 的正常状态，不该触发 Basic 续期重发。
 */
export function isBasicCredentialRejection(status, text) {
  if (status === 401 || status === 403) return true
  if (status < 400 || status >= 500) return false
  return /APIG\.1009|invalid.*(app|key|secret)|appkey|app_key/i.test(text ?? "")
}
