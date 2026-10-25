// 密码学：DPoP 密钥对 + 华为云两种请求签名
//
// ═══════════════════════════════════════════════════════════════════
// DPoP（Demonstrating Proof-of-Possession）
// ═══════════════════════════════════════════════════════════════════
//
// 华为云 STS 要求每个 token 请求带一个 `DPoP` 头，内容是 ES256 (P-256)
// 签名的 JWT，头部里嵌公钥 JWK。
//
// ⚠ **私钥必须持久化** —— 续期时用同一把钥匙签名，
//   换钥匙会被服务端拒绝。所以 `dpopPrivateJwk` 要存进凭据里。
//
// ═══════════════════════════════════════════════════════════════════
// 两种华为云签名，别搞混
// ═══════════════════════════════════════════════════════════════════
//
//   signHuaweiRequest  SDK-HMAC-SHA256
//                      用于 CLAW 域（登录后的权限校验）
//                      ⚠ 密钥是**裸 Secret**，不做派生
//
//   signV11Request     V11-HMAC-SHA256
//                      用于订阅面（额度 + 签到）
//                      ⚠ 密钥要**派生**：HMAC(access, secret) → 再 HMAC(scope+0x01)
//                      ⚠ 额外带 X-Security-Token 和 x-subscription-type
//
// ═══════════════════════════════════════════════════════════════════

import { createHash, createHmac, randomBytes, webcrypto } from "node:crypto"

import { REGION, REQUEST_TIMEOUT_MS, SERVICE } from "./constants.mjs"

// ── 工具 ──────────────────────────────────────────────────────────

/** base64url 编码 */
const b64 = (buf) => Buffer.from(buf).toString("base64url")

/** UTC 时间戳，格式 20261025T083000Z */
function xsdDate(now = new Date()) {
  const p = (n) => (n >= 10 ? String(n) : `0${n}`)
  return (
    String(now.getUTCFullYear()) +
    p(now.getUTCMonth() + 1) +
    p(now.getUTCDate()) +
    "T" +
    p(now.getUTCHours()) +
    p(now.getUTCMinutes()) +
    p(now.getUTCSeconds()) +
    "Z"
  )
}

/** 严格 URL 编码（RFC 3986）*/
const urlEncode = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

// ── DPoP ──────────────────────────────────────────────────────────

/** 生成 P-256 密钥对，返回私有 JWK */
export async function generateDpopKeyPair() {
  const kp = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )
  return {
    privateJwk: await webcrypto.subtle.exportKey("jwk", kp.privateKey),
    publicJwk: await webcrypto.subtle.exportKey("jwk", kp.publicKey),
  }
}

/** 从私有 JWK 导入密钥 */
export async function importDpopKey(privateJwk) {
  return webcrypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  )
}

/**
 * 生成 DPoP proof JWT。
 *
 * @param {CryptoKey} privateKey
 * @param {object} publicJwk  公钥 JWK（只取 kty/x/y/crv）
 * @param {string} htm         HTTP 方法
 * @param {string} htu         HTTP URL
 */
export async function signDpop(privateKey, publicJwk, htm, htu, nowMs = Date.now()) {
  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: { kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y, crv: publicJwk.crv },
  }
  const payload = { htm, htu, iat: Math.floor(nowMs / 1000), jti: randomBytes(16).toString("hex") }
  const input = `${b64(Buffer.from(JSON.stringify(header)))}.${b64(Buffer.from(JSON.stringify(payload)))}`
  const sig = await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    Buffer.from(input),
  )
  return `${input}.${b64(new Uint8Array(sig))}`
}

// ── SDK-HMAC-SHA256（CLAW 域）─────────────────────────────────────

/**
 * 华为云 APIG 签名。
 *
 * ⚠ 三处坑（逐字复刻上游反编译实现）：
 *   1. canonical URI **末尾强制补 /**
 *   2. 签名密钥是**裸 Secret**，不做 AWS 式 scope 密钥派生
 *   3. 头名**全小写排序**，头值 trim
 */
export function signHuaweiRequest(method, url, headers, bodyText, accessKey, secretKey) {
  const u = new URL(url)
  const xdate = xsdDate()

  const canonicalUri0 = u.pathname.split("/").map(urlEncode).join("/")
  const canonicalUri = canonicalUri0.endsWith("/") ? canonicalUri0 : `${canonicalUri0}/`

  const queryPairs = []
  for (const key of [...u.searchParams.keys()].sort()) {
    queryPairs.push(`${urlEncode(key)}=${urlEncode(u.searchParams.get(key) ?? "")}`)
  }
  const canonicalQuery = queryPairs.join("&")

  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim()
  lower.host = u.host
  lower["x-sdk-date"] = xdate

  const signedHeaders = Object.keys(lower).sort()
  let canonicalHeaders = ""
  for (const h of signedHeaders) canonicalHeaders += `${h}:${lower[h]}\n`

  const bodyHash =
    method === "PUT" || method === "PATCH" || method === "POST"
      ? createHash("sha256").update(bodyText).digest("hex")
      : createHash("sha256").update("").digest("hex")

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(";"),
    bodyHash,
  ].join("\n")

  const stringToSign = [
    "SDK-HMAC-SHA256",
    xdate,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n")

  const sig = createHmac("sha256", secretKey).update(stringToSign).digest("hex")

  return {
    ...headers,
    "X-Sdk-Date": xdate,
    Authorization: `SDK-HMAC-SHA256 Access=${accessKey}, SignedHeaders=${signedHeaders.join(";")}, Signature=${sig}`,
  }
}

// ── V11-HMAC-SHA256（订阅面）──────────────────────────────────────

/**
 * 发一个 V11 签名的请求。
 *
 * ⚠ 与 SDK-HMAC 的区别：
 *   1. 密钥**要派生**：HMAC(HMAC(access, secret), scope + 0x01)，取前 32 字节 hex
 *   2. 必须带 `X-Security-Token`（STS 临时凭据的三元组之一）
 *   3. 必须带 `x-subscription-type: v2`
 *   4. canonical URI 会先 decodeURIComponent 再编码（与其他实现不同）
 *
 * @returns {Promise<{ok: boolean, status: number, text: string}>}
 */
export async function signV11Request(url, credential, method = "GET", body) {
  const xdate = xsdDate()
  const u = new URL(url)

  const canonicalUri0 = u.pathname
    .split("/")
    .map((s) => urlEncode(decodeURIComponent(s)))
    .join("/")
  const canonicalUri = canonicalUri0.endsWith("/") ? canonicalUri0 : `${canonicalUri0}/`

  const queryPairs = []
  u.searchParams.forEach((v, n) => queryPairs.push([n, v]))
  queryPairs.sort(([a], [c]) => a.localeCompare(c))
  const canonicalQuery = queryPairs.map(([k, v]) => `${urlEncode(k)}=${urlEncode(v)}`).join("&")

  const original = {
    "x-subscription-type": "v2",
    "X-Sdk-Date": xdate,
    "X-Security-Token": String(credential.securityToken ?? "").trim(),
    Host: u.host,
  }
  if (method === "POST") original["Content-Type"] = "application/json;charset=utf8"
  if (credential.projectId) original["X-Project-ID"] = credential.projectId

  const lower = {}
  for (const [k, v] of Object.entries(original)) {
    lower[k.toLowerCase()] = v.trim().replace(/\s+/g, " ")
  }

  const signedHeaders = Object.keys(lower).sort()
  let canonicalHeaders = ""
  for (const h of signedHeaders) canonicalHeaders += `${h}:${lower[h]}\n`

  const payloadHash = createHash("sha256").update(body ?? "", "utf8").digest("hex")
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n")

  const scope = `${xdate.slice(0, 8)}/${REGION}/${SERVICE}`
  const stringToSign = [
    "V11-HMAC-SHA256",
    xdate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n")

  // ⚠ 密钥派生：不能直接用 secret
  const u1 = createHmac("sha256", credential.access).update(credential.secret).digest()
  const derivedKey = createHmac("sha256", u1)
    .update(Buffer.concat([Buffer.from(scope, "utf8"), Buffer.from([1])]))
    .digest()
    .subarray(0, 32)
    .toString("hex")

  const signature = createHmac("sha256", Buffer.from(derivedKey, "utf8"))
    .update(stringToSign)
    .digest("hex")

  try {
    const r = await fetch(url, {
      method,
      headers: {
        ...original,
        Authorization: `V11-HMAC-SHA256 Credential=${credential.access}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`,
      },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await r.text().catch(() => "")
    return { ok: r.ok, status: r.status, text }
  } catch (error) {
    // ⚠ 失败也要带原因 —— 只给空串会把 401 读成「没有可领的」
    return {
      ok: false,
      status: 0,
      text: error instanceof Error ? error.message : String(error),
    }
  }
}

/** MaaS 用 Basic 认证：`base64(appKey:appSecret)`，不是 Bearer */
export function basicAuthorization(cred) {
  return (
    "Basic " + Buffer.from(`${cred.modelAppKey}:${cred.modelAppSecret}`).toString("base64")
  )
}