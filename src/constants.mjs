// OfficeAce（华为云 AgentArts / MaaS）端点与常量
//
// ═══════════════════════════════════════════════════════════════════
// 三个域，不能混
// ═══════════════════════════════════════════════════════════════════
//
//   CLAW_BASE          登录 / auth / 权限校验
//   TOKEN_URL          华为云 STS token 交换
//   MODELS_BASE        推理域（模型目录 + 对话）
//   SUBSCRIPTION_BASE  订阅面（额度 + 签到）
//
// ⚠ 真机教训：订阅面挂在 **推理域**，不是 CLAW 域。
//   打 CLAW 域会回 `404 APIGW.0101 API 不存在`
//   —— 签名是对的（签名错是 401），纯粹主机不对。
//
// ═══════════════════════════════════════════════════════════════════

/** 登录与权限校验域 */
export const CLAW_BASE = "https://agentarts.cn-southwest-2.myhuaweicloud.com"

/** 华为云 STS token 交换 */
export const TOKEN_URL = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens"

/** PKCE public client，无 secret */
export const CLIENT_ID = "pdp5_for_agentarts"

/** OAuth 回调地址 */
export const REDIRECT_URI = `${CLAW_BASE}/v1/claw/auth/callback`

/** 云端登记的 state */
export const STATE_PATH = "/v1/claw/auth/state"

/** 轮询取授权码 */
export const CODE_PATH = "/v1/claw/auth/code"

/** 权限校验（拿 MaaS 的 appKey/appSecret/推理域名）*/
export const PERMISSION_PATH = "/v1/claw/client-permission-validate"

/** 推理域：模型目录 */
export const MODELS_PATH = "/v2/models"

/** 推理域：对话 */
export const CHAT_PATH = "/v2/chat/completions"

/** 推理域的官方直连地址（凭据里没给 maasBaseUrl 时兜底）*/
export const OFFICIAL_MAAS_BASE = "https://api.modelarts-maas.com"

/** 订阅面：额度 */
export const SUBSCRIPTION_PATH = "/v1/subscription"

/** 订阅面：模型倍率 */
export const TOKEN_RATES_PATH = "/v1/model-token-rates"

/** 订阅面：签到（每日领积分）*/
export const BONUS_CLAIM_PATH = "/v1/subscription/bonus/claim"

/**
 * 订阅面基址。
 *
 * ⚠ 与 CLAW_BASE 不是同一个主机。真机验证过：
 *    CLAW 域返回 404 APIGW.0101，这里返回 200。
 */
export const SUBSCRIPTION_BASE = "https://officeace.cn-southwest-2.huaweicloud-agentarts.com"

/** 华为云区域与服务（V11 签名用）*/
export const REGION = "cn-southwest-2"
export const SERVICE = "apic"

/** 请求超时 */
export const REQUEST_TIMEOUT_MS = 30_000

/** 登录轮询间隔与总超时 */
export const POLL_INTERVAL_MS = 3_000
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/** token 提前续期窗口 */
export const EXPIRY_LEAD_MS = 10 * 60 * 1000

/** 倍率缓存时长 */
export const TOKEN_RATES_TTL_MS = 20 * 60 * 1000

/** 未登录时的兜底模型表（实测 /v2/models 有 11 个，这里列常用的 10 个）*/
export const FALLBACK_MODELS = {
  "glm-5.3": { name: "GLM-5.3", limit: { context: 1_000_000, output: 128_000 } },
  "glm-5.2": { name: "GLM-5.2", limit: { context: 1_000_000, output: 128_000 } },
  "glm-5.1": { name: "GLM-5.1", limit: { context: 1_000_000, output: 128_000 } },
  "deepseek-v4": { name: "DeepSeek-V4", limit: { context: 1_000_000, output: 128_000 } },
  "deepseek-v4.1": { name: "DeepSeek-V4.1", limit: { context: 1_000_000, output: 128_000 } },
  "qwen3-30b": { name: "Qwen3 30B", limit: { context: 1_000_000, output: 128_000 } },
  "qwen3-32b": { name: "Qwen3 32B", limit: { context: 1_000_000, output: 128_000 } },
  "kimi-k2.6": { name: "Kimi-K2.6", limit: { context: 1_000_000, output: 128_000 } },
  "pangu-2.0-pro": { name: "盘古 2.0 Pro", limit: { context: 1_000_000, output: 128_000 } },
  "pangu-2.0-flash": { name: "盘古 2.0 Flash", limit: { context: 1_000_000, output: 128_000 } },
}

/**
 * 推理域基址。
 *
 * ⚠ 上游返回的 `maasBaseUrl` 可能是**不带协议的裸域名**
 *   （`officeace.cn-southwest-2.huaweicloud-agentarts.com`），
 *   直接拼路径会 `Failed to parse URL`。必须补 https://
 *   ⚠ 也可能返回空串 —— 实测当前凭据就是空的，此时回退官方直连地址。
 */
export function maasBase(cred) {
  const raw = cred?.maasBaseUrl
  if (typeof raw !== "string" || raw.length === 0) return OFFICIAL_MAAS_BASE
  const trimmed = raw.replace(/\/+$/, "")
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}