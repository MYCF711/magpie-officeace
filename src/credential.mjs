// 凭据的读写与兼容
//
// ═══════════════════════════════════════════════════════════════════
// 存在 magpie 里的形状
// ═══════════════════════════════════════════════════════════════════
//
// magpie 的 plugin-auth.json 里，一个 officeace 账号长这样：
//
//   {
//     "type": "oauth",
//     "access": "<JSON 字符串，见下>",
//     "refresh": "<华为云 STS refresh_token，JWT>",
//     "expires": 1792841892266,
//     "accountId": "01a1642ad2ae7f93bf6387ad2fc5f09e"
//   }
//
// `access` 里那份 JSON 的结构：
//
//   {
//     "modelAppKey":     "39161fdacb0c...",   // MaaS 的 appKey
//     "modelAppSecret":  "11644a70ea4d...",   // MaaS 的 appSecret
//     "maasBaseUrl":     "https://...",       // 推理域（可能空 → 回退官方）
//     "access":          "HSTAOZ3JN3WWYF3L...",// STS AK
//     "secret":          "9hefA4eK2KTT...",   // STS SK
//     "securityToken":   "hQpjbi1ub3J0...",   // STS 临时令牌
//     "projectId":       "",
//     "expiresAt":       "2026-10-24T11:38:12.266Z",
//     "refreshToken":    "<同一个 JWT>",
//     "codeVerifier":    "...",               // PKCE
//     "dpopPrivateJwk":  { ... },             // ⚠ 续期要用同一把钥匙
//     "accountId":       "01a1642ad2ae7f93bf6387ad2fc5f09e"
//   }
//
// ═══════════════════════════════════════════════════════════════════
// 为什么要保持这个形状
// ═══════════════════════════════════════════════════════════════════
//
// 本机之前那个临时插件（v0.1）就是这么存的。保持同形状
// ⇒ **用户已有的登录态可以直接复用，不用重新登录**。
//
// ═══════════════════════════════════════════════════════════════════

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

/** 凭据到期时间（毫秒）。解析不出来时保守给 1 小时后。 */
export function expiryMs(cred) {
  const at = Date.parse(cred?.expiresAt ?? "")
  return Number.isFinite(at) ? at : Date.now() + 60 * 60 * 1000
}

/** 是否临期（提前 EXPIRY_LEAD_MS 就续）*/
export function nearExpiry(cred, leadMs) {
  return expiryMs(cred) - Date.now() <= leadMs
}

/**
 * 基本认证的指纹（key + secret + 宿主）。
 *
 * 用途：续期后判断「凭据真的换了吗」。
 * 指纹没变 ⇒ 重发注定得到同一个拒绝，不如直接告诉用户。
 */
export function basicAuthFingerprint(cred) {
  return `${cred?.modelAppKey ?? ""}:${cred?.modelAppSecret ?? ""}:${cred?.maasBaseUrl ?? ""}`
}

/** 判断一次拒绝是不是「这对 Basic 凭据不被接受」*/
export function isBasicCredentialRejection(status, text) {
  if (status === 401 || status === 403) return true
  if (status < 400 || status >= 500) return false
  return /APIG\.1009|invalid.*(app|key|secret)|appkey|app_key/i.test(text ?? "")
}