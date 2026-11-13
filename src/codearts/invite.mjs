// CodeArts 自动邀请（「邀好友送积分」）—— 协议、账号源、存储
//
// ═══════════════════════════════════════════════════════════════════
// 协议从哪来（2026-11-13 只读实测，不是猜的）
// ═══════════════════════════════════════════════════════════════════
//
// 官方网页 https://devcloud.cn-north-4.huaweicloud.com/chat/home 的打包产物
// `CodeArtsWorkWeb/126.10.10.20261110214624/hws/assets/index-CtpvL1LP.js`
// 里，`const ri="/PromptCenterService/v1"`，邀请相关只有两条：
//
//   POST ${ri}/ops/invite/generate            body {campaignId, channel:"WEB"}
//   POST ${ri}/ops/invite/confirm-by-code?inviteCode=<code>   （无 body）
//
// 生成后前端按三级取值（WorkbenchView / getauth 两个 chunk 一致）：
//   data.inviteUrl → data.inviteCode → window.location.href
//
// 活动列表 `GET ${ri}/ops/delivery?channel=WEB`，项里的原始 type 经 `n_()` 归一：
//   INVITE_USER|invite_user → "invite"；USER_LOGIN|user_login → "login"；…
//
// 网页走的是同源 `/chat/PromptCenterService/…`；本包打的是 snap-access 网关，
// 同族路径（delivery / claim / confirm）**真机已验证**在
// `https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/*` 上：
//   GET /v1/ops/delivery?channel=IDE → 401 APIG.0301（存在，要签名）
//   GET /v1/ops/invite/generate      → 404 APIG.0101 "method GET not found"
//   GET /v1/ops/zzz-不存在           → 404 APIG.0101 "…does not exist…"
//   两种 404 文案不同 ⇒ 邀请两条路由在 snap-access 上**已发布**（仅 POST）。
//
// ⚠ 本模块自己**不签名**：签名由 index.mjs 注入的 `request` 完成，形状与它
//   内部的 `snapRequest(method, url, cred, fetcher, payload)` 完全一致：
//     成功 → { ok: true, data }
//     失败 → { ok: false, message }
//   这样这里零网络、零凭据形态假设，测试可以整个替换掉。
//
// ⚠ 边界：OfficeAce（officeace.cn-southwest-2.huaweicloud-agentarts.com）是
//   另一个服务（V11 签名 + 完全不同的端点集），**没有**这套邀请路由，别混用。
//
// ⚠ 凭据：本模块只在**内存**里传 `cred`，绝不写进缓存文件、绝不进日志。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// ---- 协议常量（全部来自上面的实测）-----------------------------------------

/** snap-access 网关：本包所有 CodeArts 管理面调用都打这里。 */
export const SNAP_HOST = "https://snap-access.cn-north-4.myhuaweicloud.com"

/** 活动列表：网页用 channel=WEB，IDE 用 channel=IDE（本包沿用 IDE，与签到一致）。 */
export const OPS_DELIVERY_URL = `${SNAP_HOST}/v1/ops/delivery?channel=IDE`

/** 生成邀请链接。body 必须是官方证实的 `{campaignId, channel:"WEB"}`。 */
export const OPS_INVITE_GENERATE_URL = `${SNAP_HOST}/v1/ops/invite/generate`

/** 按邀请码确认（被邀请方注册后绑定邀请人）。无 body，码走 query。 */
export const OPS_INVITE_CONFIRM_URL = `${SNAP_HOST}/v1/ops/invite/confirm-by-code`

/** 服务端原始 type；前端归一成 "invite"，本模块对接服务端，认原始值。 */
export const INVITE_TYPES = ["INVITE_USER", "invite_user"]

/**
 * 生成接口的 channel。
 *
 * ⚠ 官方网页只出现过 `"WEB"`，所以这里固定用 WEB；不要随签到的 OPS_CHANNEL 改成 IDE。
 */
export const GENERATE_CHANNEL = "WEB"

/** 每个 uid 的 generate 尝试节流：24 小时（失败也记，避免打爆上游）。 */
export const THROTTLE_MS = 24 * 60 * 60 * 1000

/** 缓存文件名（只落在 ~/.cache/magpie，绝不落 ~/.config）。 */
export const STATE_FILE = "codearts-invite.json"

/** 邀请码的形状上限：非空、无空白、无控制字符、长度 1..128。 */
export const CODE_MAX_LEN = 128

// ---- 小工具 ----------------------------------------------------------------

/**
 * 洗成「去空白的串」。
 *
 * ⚠ 必须接受**数字**：上游的 `campaignId` 实测就是数字（官方网页里也是
 *   `String(R.campaignId ?? "")` 之后才用）。只认 `typeof === "string"` 会把
 *   数字 campaignId 洗成空串，然后误报「邀请活动缺少 campaignId」。
 */
const str = (v) => (v === null || v === undefined ? "" : String(v)).trim()

/** 同一个东西的可读别名：凡是「上游字段」都建议用 `text` 以减少误读。 */
const text = str

/** 把可能是裸值/带空白的邀请码洗成可用串；不合法 → ""。 */
export function cleanCode(raw) {
  const s = str(raw).trim()
  if (!s || s.length > CODE_MAX_LEN) return ""
  // 空白与控制字符一律拒绝：上游是 base62 类的短码，不该出现这些
  if (/[\s\u0000-\u001f\u007f]/.test(s)) return ""
  return s
}

/** 只接受 https 的邀请链接；其它协议（含 http）一律不认。 */
export function pickHttpsUrl(raw) {
  const s = str(raw).trim()
  if (!s) return ""
  try {
    const u = new URL(s)
    if (u.protocol !== "https:") return ""
    if (!u.hostname) return ""
    return u.toString()
  } catch {
    return ""
  }
}

/** 从 `…?invitecode=XXXX` 里取邀请码（官方网页的入参名就是这个）。 */
export function codeFromInviteUrl(raw) {
  const s = str(raw).trim()
  if (!s) return ""
  try {
    const u = new URL(s)
    return cleanCode(u.searchParams.get("invitecode"))
  } catch {
    return ""
  }
}

/** 配置值当模式看：1/true → 首选；0/false/空 → 自动。 */
export function modeIsFirst(value) {
  return value === true || value === 1 || value === "1"
}

/**
 * 手填值是不是「一个真的邀请码」。
 *
 * 官方语义：同一个配置位既当开关又当码 —— `0` / `1` / 空走自动，
 * 其余非空值就是用户手填的邀请码，直接覆盖并**永久预留**。
 */
export function manualCodeOf(value) {
  const s = str(value).trim()
  if (!s || s === "0" || s === "1") return ""
  return cleanCode(s)
}

// ---- 存储（~/.cache/magpie，原子写，坏 JSON 不抛）--------------------------

/** 默认缓存目录：与其它模块一致，`~/.cache/magpie`。 */
export function defaultCacheDir() {
  const env = str(process.env.MAGPIE_CACHE_DIR).trim()
  if (env) return env
  return join(homedir(), ".cache", "magpie")
}

/** cacheDir === false → 内存态（给不想落盘的测试用）。 */
let memoryState = null

function emptyState() {
  return { version: 1, accounts: {}, codes: {}, reserved: {}, attempts: {} }
}

function asObj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {}
}

function normalizeState(j) {
  const o = asObj(j)
  return {
    version: 1,
    accounts: asObj(o.accounts),
    codes: asObj(o.codes),
    reserved: asObj(o.reserved),
    attempts: asObj(o.attempts),
  }
}

export function statePathFor(cacheDir) {
  return join(cacheDir, STATE_FILE)
}

/**
 * 读缓存。坏 JSON / 读不到 / 形状不对 → 空态，**从不抛**。
 */
export function readInviteState({ cacheDir = defaultCacheDir() } = {}) {
  if (cacheDir === false) return memoryState ? normalizeState(memoryState) : emptyState()
  try {
    const raw = readFileSync(statePathFor(cacheDir), "utf8")
    return normalizeState(JSON.parse(raw))
  } catch {
    return emptyState()
  }
}

/**
 * 原子写缓存（同目录临时文件 + rename）。任何失败静默 —— 邀请是附加能力，
 * 不许因为写不进缓存而拖垮登录或签到。
 */
export function writeInviteState(state, { cacheDir = defaultCacheDir() } = {}) {
  const next = normalizeState(state)
  if (cacheDir === false) {
    memoryState = next
    return true
  }
  try {
    mkdirSync(cacheDir, { recursive: true })
    const p = statePathFor(cacheDir)
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
    renameSync(tmp, p)
    return true
  } catch {
    return false
  }
}

/** 测试用：清掉内存态。 */
export function resetMemoryState() {
  memoryState = null
}

// ---- magpie 的两个文件（都只读，绝不写 ~/.config）-------------------------

function configDir() {
  const xdg = str(process.env.XDG_CONFIG_HOME)
  return xdg && xdg.startsWith("/") ? join(xdg, "magpie") : join(homedir(), ".config", "magpie")
}

/** magpie 的 plugin-auth.json：账号凭据的唯一来源。只读。 */
export function pluginAuthFile({ authFile } = {}) {
  const explicit = str(authFile).trim() || str(process.env.MAGPIE_CODEARTS_AUTH_FILE).trim()
  return explicit || join(configDir(), "plugin-auth.json")
}

/** magpie 的 logins.json：登录顺序 / 首选账号。只读。 */
export function loginsFile({ loginsFile: given } = {}) {
  const explicit = str(given).trim() || str(process.env.MAGPIE_CODEARTS_LOGINS_FILE).trim()
  return explicit || join(configDir(), "logins.json")
}

/**
 * 凭据里的 `access` 字段（CodeArts 是 oauth 型，access 是 JSON 串）。
 *
 * 与 index.mjs 的 `credentialOf` 同形状，但这里是**自包含副本**：本模块不许
 * 因为 index.mjs 正在被别人改而跟着坏。
 */
export function credentialOf(auth) {
  if (!auth || auth.type !== "oauth") return null
  const raw = str(auth.access)
  if (!raw) return null
  let cred
  try {
    cred = JSON.parse(raw)
  } catch {
    return null
  }
  if (!cred || typeof cred !== "object" || Array.isArray(cred)) return null
  if (typeof cred.access_key_id !== "string" || !cred.access_key_id) return null
  return { ...cred, oauth_client: cred.oauth_client || "codearts-agent" }
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

/**
 * 读 plugin-auth.json 里的 codearts 账号。
 *
 * @returns {Array|null} 条目数组；**文件读不到 / 坏 JSON → null**
 *   （null 表示「没校验」，调用方据此**不要**把已知账号判成已删除）
 */
export function readAuthEntries({ authFile } = {}) {
  const raw = readJsonFile(pluginAuthFile({ authFile }))
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const out = []
  for (const [key, auth] of Object.entries(raw)) {
    if (key !== "codearts" && !key.startsWith("codearts#")) continue
    if (!auth || typeof auth !== "object") continue
    const uid = str(auth.uid).trim() || str(auth.accountId).trim()
    if (!uid) continue
    out.push({ key, uid, accountId: str(auth.accountId).trim(), cred: credentialOf(auth) })
  }
  return out
}

// ---- 账号记录 --------------------------------------------------------------

/**
 * 记一个账号（firstSeenAt **只写一次**，lastSeenAt 每次都刷）。
 *
 * @returns {{uid, accountId, firstSeenAt, lastSeenAt}|null}
 */
export function noteAccount({ uid, accountId = "", cacheDir = defaultCacheDir(), now = Date.now() } = {}) {
  const id = str(uid).trim()
  if (!id) return null
  const state = readInviteState({ cacheDir })
  const prev = asObj(state.accounts[id])
  const firstSeenAt = Number.isFinite(Number(prev.firstSeenAt)) && Number(prev.firstSeenAt) > 0
    ? Number(prev.firstSeenAt)
    : now
  const rec = {
    uid: id,
    accountId: str(accountId).trim() || str(prev.accountId) || "",
    firstSeenAt,
    lastSeenAt: now,
  }
  state.accounts[id] = rec
  writeInviteState(state, { cacheDir })
  return rec
}

/**
 * 同步账号表：以 plugin-auth.json 为准，更新 firstSeenAt / lastSeenAt，
 * 并标出「已删除」（记录里有、文件里没了）—— 已删除的账号**不得作源**。
 *
 * ⚠ plugin-auth.json **读不到**（null）时按「不校验」处理：所有已知账号仍算
 *   在场，绝不因为一次读失败就把账号全判成已删除。
 *
 * @returns {{
 *   accounts: Array<{uid, accountId, firstSeenAt, lastSeenAt, present, cred, keys}>,
 *   byKey: Record<string,string>,
 *   present: Set<string>,
 *   authReadable: boolean,
 *   preferredUid: string|null
 * }}
 */
export function syncAccounts({ authFile, loginsFile: loginsGiven, cacheDir = defaultCacheDir(), now = Date.now() } = {}) {
  const state = readInviteState({ cacheDir })
  const entries = readAuthEntries({ authFile })
  const authReadable = entries !== null
  const list = entries ?? []
  const byKey = {}
  const present = new Set()
  const creds = new Map()
  const keysOf = new Map()

  for (const [index, e] of list.entries()) {
    byKey[e.key] = e.uid
    present.add(e.uid)
    if (e.cred) creds.set(e.uid, e.cred)
    if (!keysOf.has(e.uid)) keysOf.set(e.uid, [])
    keysOf.get(e.uid).push(e.key)
    const prev = asObj(state.accounts[e.uid])
    const firstSeenAt = Number.isFinite(Number(prev.firstSeenAt)) && Number(prev.firstSeenAt) > 0
      ? Number(prev.firstSeenAt)
      // 首次升级时 plugin-auth 的排列就是账号加入顺序；不能让所有旧账号同毫秒后，
      // 稳定排序把第一个（最老）误当“最新”。后来的条目排得更新。
      : now - (list.length - 1 - index)
    state.accounts[e.uid] = {
      uid: e.uid,
      accountId: e.accountId || str(prev.accountId) || "",
      firstSeenAt,
      lastSeenAt: now,
    }
  }
  writeInviteState(state, { cacheDir })

  const preferredUid = readPreferredUid({ loginsFile: loginsGiven, byKey, cacheDir, now })

  const accounts = Object.values(state.accounts)
    .map((r) => {
      const uid = str(asObj(r).uid)
      return {
        uid,
        accountId: str(asObj(r).accountId),
        firstSeenAt: Number(asObj(r).firstSeenAt) || 0,
        lastSeenAt: Number(asObj(r).lastSeenAt) || 0,
        // 读不到凭据文件时不校验：已知账号一律算在场
        present: authReadable ? present.has(uid) : true,
        cred: creds.get(uid) ?? null,
        keys: keysOf.get(uid) ?? [],
      }
    })
    .filter((a) => a.uid)

  // 新的在前：off 模式要「最新注册的账号」
  accounts.sort((a, b) => b.firstSeenAt - a.firstSeenAt)

  return { accounts, byKey, present, authReadable, preferredUid }
}

/**
 * 首选账号 uid：magpie 的 logins.json 里 agent=plugin:codearts 的行，
 * 先看 `first:true`，再取**最小正 order**，最后退到第一行；`home` 映射回 uid。
 */
export function readPreferredUid({ loginsFile: loginsGiven, byKey = {}, cacheDir = defaultCacheDir(), now = Date.now() } = {}) {
  const raw = readJsonFile(loginsFile({ loginsFile: loginsGiven }))
  if (!Array.isArray(raw)) return null
  const rows = raw.filter((r) => r && typeof r === "object" && str(r.agent) === "plugin:codearts")
  if (rows.length === 0) return null

  const uidOf = (r) => {
    const key = str(r?.home).trim()
    if (!key) return null
    return byKey[key] ?? null
  }

  const flagged = rows.find((r) => r.first === true)
  const ordered = rows
    .map((r, i) => ({ r, i, order: Number(r.order) }))
    .filter((x) => Number.isFinite(x.order) && x.order > 0)
    .sort((a, b) => (a.order - b.order) || (a.i - b.i))
  // 先选定用户指定的那一行，再映射一次。映射失败必须回预留，不能顺移到下一张卡，
  // 否则首选失效时会把邀请奖励静默送给另一个账号。
  const row = flagged ?? ordered[0]?.r ?? rows[0]
  return uidOf(row)
}

// ---- 码的读写 --------------------------------------------------------------

/** 取某账号已存的码（没有 → null）。 */
export function codeOfUid(uid, { cacheDir = defaultCacheDir() } = {}) {
  const state = readInviteState({ cacheDir })
  const rec = asObj(state.codes[str(uid)])
  const code = cleanCode(rec.code)
  if (!code) return null
  return { code, inviteUrl: pickHttpsUrl(rec.inviteUrl), at: Number(rec.at) || 0, uid: str(uid) }
}

function saveCode(uid, { code, inviteUrl, campaignId }, { cacheDir, now }) {
  const state = readInviteState({ cacheDir })
  state.codes[str(uid)] = {
    code: cleanCode(code),
    inviteUrl: pickHttpsUrl(inviteUrl),
    campaignId: str(campaignId),
    at: now,
  }
  writeInviteState(state, { cacheDir })
}

function savedReserved({ cacheDir }) {
  const state = readInviteState({ cacheDir })
  return { code: cleanCode(asObj(state.reserved).code), at: Number(asObj(state.reserved).at) || 0 }
}

function saveReserved(code, { cacheDir, now }) {
  const state = readInviteState({ cacheDir })
  state.reserved = { code: cleanCode(code), at: now }
  writeInviteState(state, { cacheDir })
}

// ---- 节流 ------------------------------------------------------------------

/** 该 uid 24 小时内试过 generate 吗（失败也算试过）。 */
export function isThrottled(uid, { cacheDir = defaultCacheDir(), now = Date.now() } = {}) {
  const state = readInviteState({ cacheDir })
  const at = Number(asObj(state.attempts)[str(uid)])
  if (!Number.isFinite(at) || at <= 0) return false
  return now - at < THROTTLE_MS
}

/** 记一次 generate 尝试（成功失败都记）。 */
export function noteAttempt(uid, { cacheDir = defaultCacheDir(), now = Date.now() } = {}) {
  const id = str(uid)
  if (!id) return false
  const state = readInviteState({ cacheDir })
  state.attempts[id] = now
  return writeInviteState(state, { cacheDir })
}

// ---- 协议调用（都靠注入的 request，零网络假设）----------------------------

/**
 * 活动列表里那一条邀请活动。
 *
 * @returns {{campaignId: string, item: object}|{error: string}}
 */
export async function findInviteCampaign({ cred, request, fetcher } = {}) {
  if (typeof request !== "function") return { error: "缺少 request" }
  const r = await request("GET", OPS_DELIVERY_URL, cred, fetcher)
  if (!r || !r.ok) return { error: `活动列表读取失败：${r?.message ?? "未知原因"}` }
  const data = r.data
  const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : []
  const item = items.find((it) => INVITE_TYPES.includes(text(it?.type)))
  if (!item) return { error: "当前账号没有邀请活动" }
  const campaignId = text(item.campaignId) || text(item.id)
  if (!campaignId) return { error: "邀请活动缺少 campaignId" }
  return { campaignId, item }
}

/**
 * 生成邀请链接：`POST /v1/ops/invite/generate`，body **必须**是
 * `{campaignId, channel: GENERATE_CHANNEL}`（官方证实的形状）。
 *
 * @returns {{ok:true, code, inviteUrl, campaignId}|{ok:false, error}}
 */
export async function generateInvite({ cred, campaignId, request, fetcher, campaign } = {}) {
  if (typeof request !== "function") return { ok: false, error: "缺少 request" }
  let id = text(campaignId)
  if (!id && campaign && typeof campaign === "object") {
    const found = await findInviteCampaign({ cred, request, fetcher })
    if (found.error) return { ok: false, error: found.error }
    id = found.campaignId
  }
  if (!id) return { ok: false, error: "缺少 campaignId" }

  const r = await request("POST", OPS_INVITE_GENERATE_URL, cred, fetcher, {
    campaignId: id,
    channel: GENERATE_CHANNEL,
  })
  if (!r || !r.ok) return { ok: false, error: `邀请接口调用失败：${r?.message ?? "未知原因"}` }

  const data = r.data ?? {}
  const inviteUrl = pickHttpsUrl(data.inviteUrl)
  const code = cleanCode(data.inviteCode) || codeFromInviteUrl(inviteUrl)
  // confirm-by-code 只认码；一个取不出 invitecode 的分享链接不能自动建立邀请关系。
  if (!code) return { ok: false, error: "邀请接口未返回可用邀请码", campaignId: id }
  return { ok: true, code, inviteUrl, campaignId: id }
}

/**
 * 被邀请方绑定：`POST /ops/invite/confirm-by-code?inviteCode=<code>`，**无 body**。
 * 新账号 OAuth 成功后调用（本模块不做，时机由 index.mjs 决定）。
 */
export async function confirmInviteByCode({ cred, code, request, fetcher } = {}) {
  if (typeof request !== "function") return { ok: false, error: "缺少 request" }
  const c = cleanCode(code)
  if (!c) return { ok: false, error: "邀请码为空或形状不合法" }
  const url = `${OPS_INVITE_CONFIRM_URL}?inviteCode=${encodeURIComponent(c)}`
  // payload 不传 ⇒ snapRequest 发空 body（官方就是无 body）
  const r = await request("POST", url, cred, fetcher)
  if (!r || !r.ok) return { ok: false, error: `邀请码确认失败：${r?.message ?? "未知原因"}` }
  return { ok: true, data: r.data ?? null }
}

// ---- 决策：纯本地 ----------------------------------------------------------

function presentAccounts(accounts) {
  return (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.uid && a.present !== false)
}

/**
 * 纯本地解析：**绝不联网**。算不出码就报出来，由 `ensureInviteCode` 决定是否去生成。
 *
 * 优先级（与产品语义一一对应）：
 *   1. 手填的邀请码（非空且非 0/1）→ 覆盖并永久预留
 *   2. off（默认）：firstSeenAt 最新的**有码**账号
 *   3. on：Make first 首选账号的码
 *   4. 预留码
 *
 * @returns {{code:string, source:string, uid?:string}}
 */
export function resolveInviteCode({
  mode,
  reservedInput = "",
  preferredUid = null,
  accounts = null,
  cacheDir = defaultCacheDir(),
  now = Date.now(),
} = {}) {
  const manual = manualCodeOf(reservedInput)
  if (manual) {
    saveReserved(manual, { cacheDir, now })
    return { code: manual, source: "manual" }
  }

  const list = presentAccounts(accounts)
  const first = modeIsFirst(mode)

  if (first) {
    if (preferredUid) {
      const hit = codeOfUid(preferredUid, { cacheDir })
      if (hit) return { code: hit.code, source: "preferred", uid: preferredUid }
    }
  } else {
    for (const a of list) {
      const hit = codeOfUid(a.uid, { cacheDir })
      if (hit) return { code: hit.code, source: "account", uid: a.uid }
    }
  }

  const reserved = savedReserved({ cacheDir })
  if (reserved.code) return { code: reserved.code, source: "reserved" }
  return { code: "", source: "none" }
}

/**
 * 需要就能联网的入口（**只在 magpie 的 ask 阶段调**）。
 *
 * off：最新账号有码就用；没码就用它的 cred 调一次 generate；失败才回退到
 *      「上一个有码的账号」，再回退预留码。
 * on ：只碰 Make first 首选账号；没码/失败**只回预留**，绝不换号。
 *
 * @returns {{code:string, source:string, uid?:string|null, error?:string}}
 */
export async function ensureInviteCode({
  preferFirst = false,
  reservedInput = "",
  request = null,
  fetcher = undefined,
  accounts = null,
  preferredUid = null,
  cacheDir = defaultCacheDir(),
  now = Date.now(),
  authFile,
  loginsFile: loginsGiven,
} = {}) {
  const manual = manualCodeOf(reservedInput)
  if (manual) {
    saveReserved(manual, { cacheDir, now })
    return { code: manual, source: "manual", uid: null }
  }

  let list = presentAccounts(accounts)
  let preferred = preferredUid
  if (!Array.isArray(accounts)) {
    const synced = syncAccounts({ authFile, loginsFile: loginsGiven, cacheDir, now })
    list = presentAccounts(synced.accounts)
    preferred = preferred ?? synced.preferredUid
  }
  if (preferredUid) preferred = preferredUid

  // 邀请源只由 provider 的 invite_mode 开关决定；0/1 输入不会被误当成另一个开关。
  const first = modeIsFirst(preferFirst)

  const reservedFallback = (error) => {
    const reserved = savedReserved({ cacheDir })
    if (reserved.code) return { code: reserved.code, source: "reserved", uid: null, ...(error ? { error } : {}) }
    return { code: "", source: "none", uid: null, ...(error ? { error } : {}) }
  }

  // on：只认首选，绝不换号
  if (first) {
    if (!preferred) return reservedFallback("没有首选账号")
    const hit = codeOfUid(preferred, { cacheDir })
    if (hit) return { code: hit.code, source: "preferred", uid: preferred }

    const acct = list.find((a) => a.uid === preferred)
    if (typeof request !== "function") return reservedFallback("缺少 request")
    if (!acct?.cred) return reservedFallback("首选账号没有可用凭据")
    if (isThrottled(preferred, { cacheDir, now })) return reservedFallback("首选账号 24 小时内已尝试过")

    noteAttempt(preferred, { cacheDir, now })
    const made = await generateFor(acct, { request, fetcher })
    if (made.ok) {
      saveCode(preferred, made, { cacheDir, now })
      return { code: made.code, source: "generated", uid: preferred }
    }
    return reservedFallback(made.error)
  }

  // off：目标就是「最新注册的那个账号」——它没码就现场给它生成。
  //
  // ⚠ 这里**不能**先扫一遍「谁有码」：那会让老账号的缓存码盖过新账号
  //   （用户要的是「最新注册账号的邀请链接」，不是「最近一次生成过的链接」）。
  //   顺序必须是：最新有码 → 最新现场生成 → 生成失败才退到上一个有码的账号 → 预留。
  const newest = list[0]
  if (!newest) return reservedFallback("没有可用账号")

  /** 生成路走不通时：退到「上一个有码的账号」，再预留。 */
  const fallbackOlder = (error) => {
    for (const a of list.slice(1)) {
      const hit = codeOfUid(a.uid, { cacheDir })
      if (hit) return { code: hit.code, source: "account", uid: a.uid, ...(error ? { error } : {}) }
    }
    return reservedFallback(error)
  }

  const cached = codeOfUid(newest.uid, { cacheDir })
  if (cached) return { code: cached.code, source: "account", uid: newest.uid }

  if (typeof request !== "function") return fallbackOlder("缺少 request")
  if (!newest.cred) return fallbackOlder("最新账号没有可用凭据")
  if (isThrottled(newest.uid, { cacheDir, now })) return fallbackOlder("最新账号 24 小时内已尝试过")

  noteAttempt(newest.uid, { cacheDir, now })
  const made = await generateFor(newest, { request, fetcher })
  if (made.ok) {
    saveCode(newest.uid, made, { cacheDir, now })
    return { code: made.code, source: "generated", uid: newest.uid }
  }
  return fallbackOlder(made.error)
}

/** 对某个账号跑一次「找活动 → 生成」。 */
async function generateFor(account, { request, fetcher }) {
  const found = await findInviteCampaign({ cred: account.cred, request, fetcher })
  if (found.error) return { ok: false, error: found.error }
  return generateInvite({ cred: account.cred, campaignId: found.campaignId, request, fetcher })
}
