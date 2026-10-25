// 对话转发
//
// ═══════════════════════════════════════════════════════════════════
// 这个插件只做一件事
// ═══════════════════════════════════════════════════════════════════
//
// OfficeAce 的 /v2 端点要 `Authorization: Basic base64(appKey:appSecret)`，
// 而 magpie 底下的 AI SDK 只会发 `Bearer` ——
// 这个插件把 Bearer 改写成 Basic，把 `officeace/<id>` 还原成厂商 id，
// 别的原样转发。上游本来就是 OpenAI 协议，没有协议转换。
//
// ═══════════════════════════════════════════════════════════════════
// 非 2xx 时「续期一次再重发」有没有意义
// ═══════════════════════════════════════════════════════════════════
//
// 闸门必须是**超集**：
//   - 401 照旧一律尝试续期（形状未知的网关 401 也可能是凭据陈旧）
//   - **另外**把「4xx + 报文点名这对 Basic 凭据」也算进来
//     （APIG.1009 文档 400 / 真机 401，只认 401 会漏掉文档那一侧）
//
// 重发与否**只认指纹**（key+secret+host），不认对象身份 ——
// 指纹没变 ⇒ 重发注定得到同一个拒绝，不如把这句话原样告诉用户。
//
// ═══════════════════════════════════════════════════════════════════

import { CHAT_PATH, REQUEST_TIMEOUT_MS, maasBase } from "./constants.mjs"
import {
  basicAuthFingerprint,
  expiryMs,
  isBasicCredentialRejection,
} from "./credential.mjs"
import { basicAuthorization } from "./crypto.mjs"

/** provider id 前缀 */
const PREFIX = "officeace/"

/**
 * 把 magpie 的 `officeace/<id>` 还原成厂商自己的 id。
 */
export function stripPrefix(body) {
  if (typeof body !== "string" || body.length === 0) return body
  try {
    const parsed = JSON.parse(body)
    if (typeof parsed?.model === "string" && parsed.model.startsWith(PREFIX)) {
      parsed.model = parsed.model.slice(PREFIX.length)
      return JSON.stringify(parsed)
    }
  } catch {
    // 不是 JSON 就原样透传
  }
  return body
}

/**
 * 发一次对话请求。
 *
 * @param {object} opts
 * @param {string|Request|URL} opts.input
 * @param {RequestInit} [opts.init]
 * @param {object} opts.credential 当前凭据
 * @param {() => Promise<object|undefined>} [opts.renew] 硬续期（失败抛）
 * @returns {Promise<Response>}
 */
export async function chatFetch({ input, init, credential, renew }) {
  const req = input instanceof Request ? input : null
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (req?.url ?? "")

  let body = init?.body
  if (body === undefined && req) body = await req.text()
  body = stripPrefix(body)

  const target = `${maasBase(credential)}${CHAT_PATH}`
  const signal = init?.signal ?? req?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)

  const call = (cred) =>
    fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // ⚠ MaaS 用 Basic，不是 Bearer
        authorization: basicAuthorization(cred),
      },
      body,
      signal,
    })

  let response
  try {
    response = await call(credential)
  } catch (e) {
    // 网络层失败：原样抛，magpie 会做故障转移
    throw e
  }

  if (response.ok) return response

  // ── 失败：判断要不要续期后重发 ──
  const text = await response.text().catch(() => "")
  let finalStatus = response.status
  let finalText = text
  let renewal = "not-attempted" // 四态，不是布尔

  const shouldRenew =
    renew && (finalStatus === 401 || isBasicCredentialRejection(finalStatus, finalText))

  if (shouldRenew) {
    const before = basicAuthFingerprint(credential)
    let renewed
    try {
      // 硬续期：失败会抛，才能与「续期成功但没变化」区分开
      renewed = await renew()
    } catch {
      renewed = undefined
    }

    if (!renewed) {
      renewal = "unreadable"
    } else if (basicAuthFingerprint(renewed) !== before) {
      renewal = "changed"
      const retry = await call(renewed)
      if (retry.ok) return retry
      finalStatus = retry.status
      finalText = await retry.text().catch(() => "")
    } else {
      // 续期跑了，但决定鉴权的三个字段逐字节没变 ⇒ 重发没有意义
      renewal = "unchanged"
    }
  }

  return Response.json(
    {
      error: {
        type: "provider_error",
        message:
          `OfficeAce（华为 MaaS）返回 HTTP ${finalStatus}：` +
          `${finalText.slice(0, 200)}（${diagnose(finalStatus, renewal)}）`,
        provider_status: finalStatus,
        credential_rejected: isBasicCredentialRejection(finalStatus, finalText),
        renewal_outcome: renewal,
      },
    },
    { status: finalStatus >= 400 ? finalStatus : 502 },
  )
}

/** 把失败变成用户能读懂的一句话 */
function diagnose(status, renewal) {
  if (status === 401 || status === 403) {
    if (renewal === "changed") return "续期后仍然是 401，请重新登录"
    if (renewal === "unchanged") return "凭据没变，重试无意义，请重新登录"
    if (renewal === "unreadable") return "续期失败，请重新登录"
    return "凭据被拒，请重新登录"
  }
  if (status === 404) return "模型名不对，或该模型不在这个账号的套餐里"
  if (status === 429) return "被限流，稍后重试或换账号"
  if (status >= 500) return "上游服务错误"
  return "请求被拒"
}