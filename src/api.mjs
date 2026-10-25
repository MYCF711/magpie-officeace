// 目录 / 额度 / 签到
//
// ═══════════════════════════════════════════════════════════════════
// 三个端点，两个域
// ═══════════════════════════════════════════════════════════════════
//
//   模型目录  GET  {maas}/v2/models                    Basic 认证
//   额度      GET  {SUB}/v1/subscription               V11 签名
//   签到      POST {SUB}/v1/subscription/bonus/claim   V11 签名
//   倍率      GET  {SUB}/v1/model-token-rates          V11 签名
//
// ⚠ 额度与签到在**订阅面**（SUBSCRIPTION_BASE），不是推理域。
//   真机教训：打 CLAW 域回 404 APIGW.0101（签名错才是 401）。
//
// ═══════════════════════════════════════════════════════════════════

import {
  BONUS_CLAIM_PATH,
  MODELS_PATH,
  REQUEST_TIMEOUT_MS,
  SUBSCRIPTION_BASE,
  SUBSCRIPTION_PATH,
  TOKEN_RATES_PATH,
  TOKEN_RATES_TTL_MS,
  maasBase,
} from "./constants.mjs"

import { basicAuthorization, signV11Request } from "./crypto.mjs"

// ── 倍率 ──────────────────────────────────────────────────────────

/** 模块级缓存（20 分钟），与目录同源以保证「显示的倍率 = 实际计费」*/
let ratesCache = { at: 0, map: new Map() }

/**
 * 拉模型消耗倍率：`GET /v1/model-token-rates`。
 *
 * 响应是 snake_case（`model_name` / `cost_coefficient`），兼容 camelCase。
 *
 * ⚠ **失败时返回上一份成功缓存，而不是空表**（真实缺陷，2026-10-26）：
 *   空表在下游会被当成「没有任何模型有倍率」⇒ `liveModels` 的 rates 白名单失效
 *   ⇒ 注册表 26 条（含 1017 / bnt / v4-pro 三个必 404 的占位 id）全部吐给用户。
 *   实测复现：`liveModels(rows, base, new Map())` → 26 条，其中 4 条调不通。
 *
 *   ⇒ 语义约定：返回**非空**表 = 拿到了权威清单；返回**空**表 = 从来没拿到过。
 *     调用方据此决定是「按白名单过滤」还是「退到静态表」。
 *   失败也不清空缓存，且重置计时（20 分钟内不重复打失败的上游）。
 */
export async function fetchTokenRates(cred) {
  if (Date.now() - ratesCache.at < TOKEN_RATES_TTL_MS && ratesCache.map.size > 0) {
    return ratesCache.map
  }

  /** 失败路径：保留旧缓存，重置计时，不返回空表覆盖真相。 */
  const keepStale = () => {
    ratesCache = { at: Date.now(), map: ratesCache.map }
    return ratesCache.map
  }

  let r
  try {
    r = await signV11Request(`${SUBSCRIPTION_BASE}${TOKEN_RATES_PATH}`, cred, "GET")
  } catch {
    return keepStale()
  }
  if (!r.ok) return keepStale()

  let j
  try {
    j = JSON.parse(r.text)
  } catch {
    return keepStale()
  }

  // 实测形状：{"models":[{"model_name":"…","cost_coefficient":0.18}]}
  const rows = Array.isArray(j)
    ? j
    : Array.isArray(j?.models)
      ? j.models
      : Array.isArray(j?.data)
        ? j.data
        : Array.isArray(j?.rates)
          ? j.rates
          : []

  const map = new Map()
  for (const row of rows) {
    const raw = row?.model_name ?? row?.modelName ?? row?.model ?? row?.name
    // ⚠ 实测上游的 model_name 带尾部换行（"kimi-k3\n"），必须 trim
    const name = typeof raw === "string" ? raw.trim() : ""
    const rate = Number(row?.cost_coefficient ?? row?.costCoefficient ?? row?.rate)
    if (name.length > 0 && Number.isFinite(rate)) {
      map.set(name, rate)
    }
  }

  // 解析出来一条都没有 = 上游换了形状（不是「确实没有模型」）⇒ 同样保留旧缓存
  if (map.size === 0) return keepStale()

  ratesCache = { at: Date.now(), map }
  return map
}

// ── 模型目录 ──────────────────────────────────────────────────────

/**
 * 拉模型目录：`GET {maas}/v2/models`。
 *
 * ⚠ 返回的是**平台目录**，不保证该账号已订阅；且**没有能力元数据**（只有 id），
 *   故上下文窗口统一按保守值，工具调用按实测声明。
 */
export async function fetchCatalog(cred) {
  const r = await fetch(`${maasBase(cred)}${MODELS_PATH}`, {
    headers: { Accept: "application/json", Authorization: basicAuthorization(cred) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`OfficeAce 目录读取失败：HTTP ${r.status}`)

  const body = await r.json()
  const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []

  // 倍率表失败不阻断目录
  const rates = await fetchTokenRates(cred).catch(() => new Map())

  const out = []
  for (const row of rows) {
    const id = (typeof row === "string" ? row : typeof row?.id === "string" ? row.id : "").trim()
    if (id.length === 0) continue
    const rawName = typeof row?.name === "string" ? row.name.trim() : ""
    const baseName = rawName.length > 0 ? rawName : id
    const rate = rates.get(id)
    out.push({
      id,
      // ⚠ x1 不标（全默认倍率没有信息量）；只标非 1 的
      name: rate !== undefined && rate !== 1 ? `${baseName} · x${rate}` : baseName,
    })
  }
  return out
}

// ── 额度 ──────────────────────────────────────────────────────────

/**
 * 拉订阅 → magpie 的 usage.windows。
 *
 * 响应含两类桶：
 *   skus[].quotas[]    套餐桶，`sku_attr_code === 'officeace_points'`
 *   bonus_skus[]       活动桶
 *
 * ⚠ `.trial` 后缀的 sku **不带到期时间**（试用不过期语义）—— 不猜。
 * ⚠ 查询失败**不吞**：带原因抛出，由调用方显示。
 */
export async function fetchUsage(cred) {
  const r = await signV11Request(`${SUBSCRIPTION_BASE}${SUBSCRIPTION_PATH}`, cred, "GET")
  if (!r.ok) {
    const detail = r.text.trim().slice(0, 200)
    throw new Error(`订阅查询失败：HTTP ${r.status}${detail === "" ? "" : `：${detail}`}`)
  }

  let j
  try {
    j = JSON.parse(r.text)
  } catch {
    throw new Error("订阅查询失败：响应不是 JSON")
  }

  const windows = []
  const nowMs = Date.now()
  let planName = ""

  // ① 套餐桶
  for (const sku of Array.isArray(j?.skus) ? j.skus : []) {
    for (const q of Array.isArray(sku?.quotas) ? sku.quotas : []) {
      if (q?.sku_attr_code !== "officeace_points") continue
      const total = Number(q.sku_value)
      const used = Number(q.current_value)
      if (!Number.isFinite(total) || total <= 0) continue

      const isTrial = String(sku.sku_code ?? "").endsWith(".trial")
      const expiresAt =
        typeof q.expired_time === "string" && q.expired_time.length > 0 ? q.expired_time : null
      const remaining = Math.max(0, total - used)
      const round = (n) => Math.round(n * 100) / 100

      if (!planName && typeof sku.sku_name === "string") planName = sku.sku_name

      windows.push({
        name: `${sku.sku_name ?? "套餐"} · 剩 ${round(remaining)}`,
        used: Math.min(100, Math.max(0, Math.round((used / total) * 100))),
        // 试用桶不带到期
        ...(isTrial ? {} : expiresAt !== null ? { resetsAt: new Date(expiresAt).toISOString() } : {}),
        display: `${round(remaining)} / ${round(total)}`,
        amount: used,
        limit: total,
        unit: "积分",
        span: 0,
        // 已过期的桶收进折叠区（主环位留给活着的桶）
        ...(expiresAt !== null && !isTrial && new Date(expiresAt).getTime() <= nowMs
          ? { aside: true }
          : {}),
      })
    }
  }

  // ② 活动桶
  for (const bonus of Array.isArray(j?.bonus_skus) ? j.bonus_skus : []) {
    const points = Number(bonus?.points)
    if (!Number.isFinite(points) || points <= 0) continue

    const used = Number(bonus.current_value)
    const remaining = Math.max(0, points - (Number.isFinite(used) ? used : 0))
    const round = (n) => Math.round(n * 100) / 100
    const expiresAt = typeof bonus.expired_time === "string" ? bonus.expired_time : null

    windows.push({
      name: `${bonus.activity_name ?? "活动奖励"} · 剩 ${round(remaining)}`,
      used: Math.min(100, Math.round(((points - remaining) / points) * 100)),
      ...(expiresAt !== null ? { resetsAt: new Date(expiresAt).toISOString() } : {}),
      display: `${round(remaining)} / ${round(points)}`,
      amount: points - remaining,
      limit: points,
      unit: "积分",
      span: 0,
      ...(expiresAt !== null && new Date(expiresAt).getTime() <= nowMs ? { aside: true } : {}),
    })
  }

  return { plan: planName, windows }
}

// ── 签到 ──────────────────────────────────────────────────────────

/**
 * 每日签到：`POST {SUB}/v1/subscription/bonus/claim`。
 *
 * 返回 magpie 的六种 outcome 之一。
 *
 * ⚠ 重复领取是幂等的 —— 服务端 2xx 但 `bonus_skus` 为空时是 `done`（今天已领完），
 *   不是 `failed`。只看状态码会误报。
 */
export async function checkin(cred) {
  if (!cred?.access || !cred?.securityToken) {
    return { outcome: "failed", message: "凭据缺失（access 或 securityToken），未发起签到" }
  }

  const r = await signV11Request(`${SUBSCRIPTION_BASE}${BONUS_CLAIM_PATH}`, cred, "POST")

  if (!r.ok || r.status < 200 || r.status >= 300) {
    const detail = r.text.trim().slice(0, 200)
    return {
      outcome: "failed",
      message: `HTTP ${r.status === 0 ? "（未发出/无响应）" : r.status}${detail === "" ? "" : `：${detail}`}`,
    }
  }

  // 空响应也是成功
  if (r.text.length === 0) return { outcome: "claimed", message: "已领取（响应为空）" }

  let j
  try {
    j = JSON.parse(r.text)
  } catch {
    // 2xx 但解析失败：领取本身可能已成功（重复领取幂等，明天再来）
    return { outcome: "done", message: "已领取（响应无法解析）" }
  }

  const skus = (Array.isArray(j?.bonus_skus) ? j.bonus_skus : []).map((s) => ({
    name: typeof s?.activity_name === "string" ? s.activity_name : "活动奖励",
    points: Number(s?.points) || 0,
  }))
  const credit = skus.reduce((sum, s) => sum + s.points, 0)

  if (skus.length === 0) return { outcome: "done", message: "今日已无新增可领" }

  return {
    outcome: "claimed",
    ...(credit > 0 ? { credit } : {}),
    message: skus.map((s) => `${s.name} +${s.points}`).join("；"),
  }
}