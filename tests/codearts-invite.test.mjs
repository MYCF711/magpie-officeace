// CodeArts 自动邀请模块（`src/codearts/invite.mjs`）的离线测试。
//
// ⚠ 全部离线、全部临时目录：
//   · `request` 是注入的假实现（形状同 index.mjs 的 snapRequest），零真实网络；
//   · 缓存目录用 mkdtemp，**绝不碰真实 ~/.cache/magpie**；
//   · plugin-auth.json / logins.json 用临时文件，**绝不读真实凭据**。
//
// 协议依据（只读实测，2026-11-13）：官方网页打包产物
// `CodeArtsWorkWeb/…/hws/assets/index-CtpvL1LP.js` 里
//   POST ${ri}/ops/invite/generate  body {campaignId, channel:"WEB"}
//   POST ${ri}/ops/invite/confirm-by-code?inviteCode=<code>   （无 body）
//   data.inviteUrl → data.inviteCode → window.location.href
// snap-access 上两条路由已发布（GET 探测回 APIG.0101 "method GET not found"，
// 与不存在的路由文案不同）。

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  GENERATE_CHANNEL,
  OPS_DELIVERY_URL,
  OPS_INVITE_CONFIRM_URL,
  OPS_INVITE_GENERATE_URL,
  STATE_FILE,
  THROTTLE_MS,
  codeFromInviteUrl,
  confirmInviteByCode,
  ensureInviteCode,
  generateInvite,
  noteAttempt,
  pickHttpsUrl,
  readInviteState,
  readPreferredUid,
  resolveInviteCode,
  syncAccounts,
} from "../src/codearts/invite.mjs"

// ---- 脚手架 ----------------------------------------------------------------

/** 一个全新的临时工作区：缓存、plugin-auth、logins 全在里面。 */
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codearts-invite-"))
  return {
    dir,
    cacheDir: path.join(dir, "cache"),
    authFile: path.join(dir, "plugin-auth.json"),
    loginsFile: path.join(dir, "logins.json"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

/** magpie 的 plugin-auth.json 里一条 codearts 凭据（值是假的，绝不出网）。 */
function authEntry({ uid, accountId, ak }) {
  return {
    type: "oauth",
    refresh: `RT-${uid}`,
    access: JSON.stringify({ access_key_id: ak, secret_access_key: `SK-${uid}`, security_token: `ST-${uid}` }),
    uid,
    accountId,
  }
}

function writeAuth(file, entries) {
  fs.writeFileSync(file, JSON.stringify(entries, null, 2))
}

/** 假 request：形状同 snapRequest，记录每一次调用。 */
function fakeRequest(handler) {
  const calls = []
  const request = async (method, url, cred, fetcher, payload) => {
    calls.push({ method, url, cred, fetcher, payload })
    return handler(method, url, payload, calls.length - 1)
  }
  return { request, calls }
}

const ok = (data) => ({ ok: true, data })
const fail = (message) => ({ ok: false, message })

const credOf = (n) => ({ access_key_id: `AK-${n}`, secret_access_key: `SK-${n}`, security_token: `ST-${n}` })

const inviteItem = (campaignId = 7, type = "INVITE_USER") => ({ campaignId, type, claimable: false })

const INVITE_URL_LINK = "https://devcloud.cn-north-4.huaweicloud.com/chat/home?invitecode=AB12CD"

/** 账号记录（ensureInviteCode 的 accounts 入参形状）。 */
function account(uid, firstSeenAt, cred) {
  return { uid, accountId: `acct-${uid}`, firstSeenAt, lastSeenAt: firstSeenAt, present: true, cred, keys: [uid] }
}

// ---- 1. 协议：URL / body / 注入调用 ----------------------------------------

test("generateInvite：POST /ops/invite/generate，body 必须是 {campaignId, channel:'WEB'}", async () => {
  const w = workspace()
  try {
    const cred = credOf(1)
    const { request, calls } = fakeRequest(() => ok({ inviteUrl: INVITE_URL_LINK }))
    const r = await generateInvite({ cred, campaignId: "7", request })
    assert.equal(r.ok, true)
    assert.equal(r.code, "AB12CD")
    assert.equal(r.inviteUrl, INVITE_URL_LINK)
    assert.equal(calls.length, 1, "只该发一次 generate")
    assert.equal(calls[0].method, "POST")
    assert.equal(calls[0].url, OPS_INVITE_GENERATE_URL)
    assert.equal(calls[0].cred, cred, "凭据必须原样透传给注入的 request（签名由它做）")
    assert.deepEqual(calls[0].payload, { campaignId: "7", channel: GENERATE_CHANNEL })
    assert.equal(GENERATE_CHANNEL, "WEB", "官方证实的 channel 就是 WEB")
  } finally {
    w.cleanup()
  }
})

test("findInviteCampaign：GET delivery，认 INVITE_USER / invite_user", async () => {
  const { request, calls } = fakeRequest(() =>
    ok({ items: [{ campaignId: 1, type: "USER_LOGIN" }, { id: "42", type: "invite_user" }] }),
  )
  const { findInviteCampaign } = await import("../src/codearts/invite.mjs")
  const found = await findInviteCampaign({ cred: credOf(1), request })
  assert.equal(found.campaignId, "42", "campaignId 优先，缺失时退到 id")
  assert.equal(calls[0].method, "GET")
  assert.equal(calls[0].url, OPS_DELIVERY_URL)
  assert.equal(calls[0].payload, undefined)
})

test("findInviteCampaign：活动列表里没有邀请活动 → 明确报错，不猜", async () => {
  const { findInviteCampaign } = await import("../src/codearts/invite.mjs")
  const { request } = fakeRequest(() => ok({ items: [{ campaignId: 1, type: "USER_LOGIN" }] }))
  const found = await findInviteCampaign({ cred: credOf(1), request })
  assert.match(found.error, /没有邀请活动/)
})

test("confirmInviteByCode：POST 且**无 body**，码走 query 且被 URL 编码", async () => {
  const { request, calls } = fakeRequest(() => ok(null))
  const r = await confirmInviteByCode({ cred: credOf(1), code: "AB12+CD", request })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, "POST")
  assert.equal(calls[0].url, `${OPS_INVITE_CONFIRM_URL}?inviteCode=AB12%2BCD`)
  assert.equal(calls[0].payload, undefined, "官方就是无 body：payload 必须是 undefined")
})

test("confirmInviteByCode：空码 / 空白码 → 直接拒绝，不发请求", async () => {
  const { request, calls } = fakeRequest(() => ok(null))
  assert.equal((await confirmInviteByCode({ cred: credOf(1), code: "   ", request })).ok, false)
  assert.equal((await confirmInviteByCode({ cred: credOf(1), code: "A B", request })).ok, false)
  assert.equal(calls.length, 0)
})

// ---- 2. inviteUrl 提码 / https 限制 ----------------------------------------

test("codeFromInviteUrl：从 ?invitecode= 提码（官方入参名）", () => {
  assert.equal(codeFromInviteUrl(INVITE_URL_LINK), "AB12CD")
  assert.equal(codeFromInviteUrl("https://x.y/z?invitecode="), "")
  assert.equal(codeFromInviteUrl("not a url"), "")
})

test("pickHttpsUrl：只接受 https —— http / javascript / 垃圾串一律不认", () => {
  assert.equal(pickHttpsUrl(INVITE_URL_LINK), INVITE_URL_LINK)
  assert.equal(pickHttpsUrl("http://devcloud.cn-north-4.huaweicloud.com/x"), "")
  assert.equal(pickHttpsUrl("javascript:alert(1)"), "")
  assert.equal(pickHttpsUrl("   "), "")
})

test("generateInvite：只回 inviteCode（没链接）也能用", async () => {
  const { request } = fakeRequest(() => ok({ inviteCode: "CODE99" }))
  const r = await generateInvite({ cred: credOf(1), campaignId: "7", request })
  assert.equal(r.ok, true)
  assert.equal(r.code, "CODE99")
  assert.equal(r.inviteUrl, "")
})

test("generateInvite：http 链接被拒绝，且没有 inviteCode → 明确失败", async () => {
  const { request } = fakeRequest(() => ok({ inviteUrl: "http://x.y/?invitecode=AA" }))
  const r = await generateInvite({ cred: credOf(1), campaignId: "7", request })
  assert.equal(r.ok, false)
  assert.match(r.error, /未返回/)
})

// ---- 3. off：最新 → 上一个 → 预留 ------------------------------------------

test("off：最新账号已有码 → 直接用，不联网", async () => {
  const w = workspace()
  try {
    const { request, calls } = fakeRequest(() => ok({ inviteCode: "SHOULD-NOT-BE-USED" }))
    // 没有「直接写码」的公开入口：先用一次成功的 generate 把 u3 的码灌进去
    const first = fakeRequest((method, url) =>
      url === OPS_DELIVERY_URL ? ok({ items: [inviteItem(7)] }) : ok({ inviteUrl: INVITE_URL_LINK }),
    )
    await ensureInviteCode({
      accounts: [account("u3", 300, credOf(3))],
      reservedInput: "",
      request: first.request,
      cacheDir: w.cacheDir,
    })
    const r = await ensureInviteCode({
      accounts: [account("u3", 300, credOf(3)), account("u2", 200, credOf(2))],
      reservedInput: "",
      request: request,
      cacheDir: w.cacheDir,
    })
    assert.equal(r.code, "AB12CD")
    assert.equal(r.source, "account")
    assert.equal(r.uid, "u3")
    assert.equal(calls.length, 0, "已有码就不该再打网络")
  } finally {
    w.cleanup()
  }
})

test("off：最新账号没码 → 用它的 cred 调 generate；成功即存下", async () => {
  const w = workspace()
  try {
    const { request, calls } = fakeRequest((method, url) =>
      url === OPS_DELIVERY_URL ? ok({ items: [inviteItem(7)] }) : ok({ inviteUrl: INVITE_URL_LINK }),
    )
    const r = await ensureInviteCode({
      accounts: [account("u3", 300, credOf(3)), account("u2", 200, credOf(2))],
      request,
      cacheDir: w.cacheDir,
    })
    assert.equal(r.code, "AB12CD")
    assert.equal(r.source, "generated")
    assert.equal(r.uid, "u3")
    assert.equal(calls[0].cred.access_key_id, "AK-3", "用的是最新账号的凭据")
    assert.equal(calls[1].payload.channel, "WEB")
    // 第二次调用应当直接命中缓存
    const again = await ensureInviteCode({
      accounts: [account("u3", 300, credOf(3))],
      request,
      cacheDir: w.cacheDir,
    })
    assert.equal(again.source, "account")
    assert.equal(calls.length, 2, "第二次没有再联网")
  } finally {
    w.cleanup()
  }
})

test("off：最新账号 generate 失败 → 回退到「上一个有码的账号」", async () => {
  const w = workspace()
  try {
    const { request, calls } = fakeRequest((method, url, payload, n) => {
      if (url === OPS_DELIVERY_URL) return ok({ items: [inviteItem(7)] })
      return fail("HTTP 500: boom")
    })
    // u2 先有码
    const seed = fakeRequest((method, url) =>
      url === OPS_DELIVERY_URL ? ok({ items: [inviteItem(7)] }) : ok({ inviteCode: "U2CODE" }),
    )
    await ensureInviteCode({ accounts: [account("u2", 200, credOf(2))], request: seed.request, cacheDir: w.cacheDir })

    const r = await ensureInviteCode({
      accounts: [account("u3", 300, credOf(3)), account("u2", 200, credOf(2))],
      request,
      cacheDir: w.cacheDir,
    })
    assert.equal(r.code, "U2CODE", "最新失败 → 上一个有码账号")
    assert.equal(r.uid, "u2")
    assert.equal(r.source, "account")
    assert.equal(calls[0].cred.access_key_id, "AK-3", "先试的是最新账号")
    assert.match(r.error, /boom/)
  } finally {
    w.cleanup()
  }
})

test("off：全都没码且生成失败 → 回退预留码", async () => {
  const w = workspace()
  try {
    const { request } = fakeRequest(() => fail("HTTP 401"))
    const r = await ensureInviteCode({
      accounts: [account("u3", 300, credOf(3))],
      reservedInput: "",
      request,
      cacheDir: w.cacheDir,
    })
    assert.equal(r.source, "none")
    assert.equal(r.code, "")
    // 先写一个预留码，再失败一次
    const r2 = await ensureInviteCode({ reservedInput: "RESERVED01", request, cacheDir: w.cacheDir })
    assert.equal(r2.source, "manual")
    const r3 = await ensureInviteCode({
      accounts: [account("u9", 400, credOf(9))],
      request,
      cacheDir: w.cacheDir,
    })
    assert.equal(r3.source, "reserved")
    assert.equal(r3.code, "RESERVED01")
  } finally {
    w.cleanup()
  }
})

// ---- 4. on：只认首选，绝不换号 ---------------------------------------------

test("on：首选账号已有码 → 用它，且不碰其它账号", async () => {
  const w = workspace()
  try {
    const seed = fakeRequest((method, url) =>
      url === OPS_DELIVERY_URL ? ok({ items: [inviteItem(7)] }) : ok({ inviteCode: "FIRSTCODE" }),
    )
    await ensureInviteCode({
      preferFirst: true,
      accounts: [account("uB", 300, credOf("B"))],
      preferredUid: "uB",
      request: seed.request,
      cacheDir: w.cacheDir,
    })
    const { request, calls } = fakeRequest(() => ok({ inviteCode: "WRONG" }))
    const r = await ensureInviteCode({
      preferFirst: true,
      accounts: [account("uA", 400, credOf("A")), account("uB", 300, credOf("B"))],
      preferredUid: "uB",
      request,
      cacheDir: w.cacheDir,
    })
    assert.equal(r.code, "FIRSTCODE")
    assert.equal(r.uid, "uB", "只能命中首选，不能串到更新的 uA")
    assert.equal(calls.length, 0)
  } finally {
    w.cleanup()
  }
})

test("on：首选无码 → 只对首选调 generate，成功就存下", async () => {
  const w = workspace()
  try {
    const { request, calls } = fakeRequest((method, url) =>
      url === OPS_DELIVERY_URL ? ok({ items: [inviteItem(9)] }) : ok({ inviteCode: "FB01" }),
    )
    const r = await ensureInviteCode({
      preferFirst: true,
      accounts: [account("uA", 400, credOf("A")), account("uB", 300, credOf("B"))],
      preferredUid: "uB",
      request,
      cacheDir: w.cacheDir,
    })
    assert.equal(r.code, "FB01")
    assert.equal(r.uid, "uB")
    assert.equal(calls[0].cred.access_key_id, "AK-B", "永远只碰首选账号")
    assert.equal(calls.length, 2)
  } finally {
    w.cleanup()
  }
})

test("on：首选失败 → 只回预留码，绝不换号", async () => {
  const w = workspace()
  try {
    const { request, calls } = fakeRequest(() => fail("HTTP 403 TM.00000001"))
    await ensureInviteCode({ reservedInput: "MYRESERVE", request, cacheDir: w.cacheDir })
    const r = await ensureInviteCode({
      preferFirst: true,
      accounts: [account("uA", 400, credOf("A")), account("uB", 300, credOf("B"))],
      preferredUid: "uB",
      request,
      cacheDir: w.cacheDir,
    })
    assert.equal(r.source, "reserved")
    assert.equal(r.code, "MYRESERVE")
    const usedCreds = calls.map((c) => c.cred.access_key_id)
    assert.deepEqual([...new Set(usedCreds)], ["AK-B"], "on 模式绝不换号")
  } finally {
    w.cleanup()
  }
})

test("on：没有首选账号 → 直接回预留，不联网", async () => {
  const w = workspace()
  try {
    const { request, calls } = fakeRequest(() => ok({ inviteCode: "X" }))
    await ensureInviteCode({ reservedInput: "R9", request, cacheDir: w.cacheDir })
    const r = await ensureInviteCode({ preferFirst: true, accounts: [], preferredUid: null, request, cacheDir: w.cacheDir })
    assert.equal(r.source, "reserved")
    assert.equal(r.code, "R9")
    assert.equal(calls.length, 0)
  } finally {
    w.cleanup()
  }
})

// ---- 5. 手填覆盖 -----------------------------------------------------------

test("手填的码（非 0/1）覆盖一切并永久预留，且绝不联网", async () => {
  const w = workspace()
  try {
    const { request, calls } = fakeRequest(() => ok({ inviteCode: "SHOULD-NOT" }))
    const r = await ensureInviteCode({
      preferFirst: true,
      accounts: [account("uB", 300, credOf("B"))],
      preferredUid: "uB",
      reservedInput: "  MANUAL42 ",
      request,
      cacheDir: w.cacheDir,
    })
    assert.equal(r.code, "MANUAL42", "手填值要 trim 后覆盖")
    assert.equal(r.source, "manual")
    assert.equal(calls.length, 0, "手填路径不许联网")
    // 之后再问一次，预留码还在
    const r2 = await ensureInviteCode({ accounts: [], reservedInput: "", request, cacheDir: w.cacheDir })
    assert.equal(r2.source, "reserved")
    assert.equal(r2.code, "MANUAL42")
  } finally {
    w.cleanup()
  }
})

test("reservedInput 是 '0' / '1' / 空 → 走自动源，不当码，也不覆盖 invite_mode", async () => {
  const w = workspace()
  try {
    const { request } = fakeRequest(() => ok({ inviteCode: "X" }))
    assert.equal((await ensureInviteCode({ reservedInput: "0", accounts: [], request, cacheDir: w.cacheDir })).source, "none")
    assert.equal((await ensureInviteCode({ reservedInput: "1", accounts: [], request, cacheDir: w.cacheDir })).source, "none")
    assert.equal(readInviteState({ cacheDir: w.cacheDir }).reserved.code ?? "", "")
  } finally {
    w.cleanup()
  }
})

test("resolveInviteCode：纯本地，永不联网；off 取最新有码账号", async () => {
  const w = workspace()
  try {
    const seed = fakeRequest((method, url) =>
      url === OPS_DELIVERY_URL ? ok({ items: [inviteItem(7)] }) : ok({ inviteCode: "NEWEST" }),
    )
    await ensureInviteCode({ accounts: [account("u3", 300, credOf(3))], request: seed.request, cacheDir: w.cacheDir })
    const r = resolveInviteCode({
      mode: "0",
      accounts: [account("u3", 300, credOf(3)), account("u2", 200, credOf(2))],
      cacheDir: w.cacheDir,
    })
    assert.equal(r.code, "NEWEST")
    assert.equal(r.source, "account")
    assert.equal(r.uid, "u3")
  } finally {
    w.cleanup()
  }
})

// ---- 6. 24h 节流 -----------------------------------------------------------

test("24h 节流：同一 uid 第二次不再发 generate（失败也记）", async () => {
  const w = workspace()
  try {
    const { request, calls } = fakeRequest(() => fail("HTTP 500"))
    const acct = account("u3", 300, credOf(3))
    await ensureInviteCode({ accounts: [acct], request, cacheDir: w.cacheDir })
    const n1 = calls.length
    assert.ok(n1 > 0, "第一次应当真的试了")
    const r = await ensureInviteCode({ accounts: [acct], request, cacheDir: w.cacheDir })
    assert.equal(calls.length, n1, "24 小时内不再试")
    assert.match(r.error, /24 小时/)
  } finally {
    w.cleanup()
  }
})

test("24h 节流：过期后可以再试", async () => {
  const w = workspace()
  try {
    const { request, calls } = fakeRequest(() => fail("HTTP 500"))
    const acct = account("u3", 300, credOf(3))
    const t0 = Date.now()
    await ensureInviteCode({ accounts: [acct], request, cacheDir: w.cacheDir, now: t0 })
    const n1 = calls.length
    await ensureInviteCode({ accounts: [acct], request, cacheDir: w.cacheDir, now: t0 + THROTTLE_MS + 1 })
    assert.ok(calls.length > n1, "超过 24 小时应当重试")
  } finally {
    w.cleanup()
  }
})

// ---- 7. 坏文件 / 不写盘 ----------------------------------------------------

test("坏 JSON / 目录不存在 → 空态，从不抛", () => {
  const w = workspace()
  try {
    const missing = path.join(w.dir, "nope", "cache")
    assert.deepEqual(readInviteState({ cacheDir: missing }), {
      version: 1, accounts: {}, codes: {}, reserved: {}, attempts: {},
    })
    fs.mkdirSync(w.cacheDir, { recursive: true })
    fs.writeFileSync(path.join(w.cacheDir, STATE_FILE), "{ this is not json")
    assert.equal(readInviteState({ cacheDir: w.cacheDir }).reserved.code ?? "", "")
    fs.writeFileSync(path.join(w.cacheDir, STATE_FILE), "[1,2,3]")
    assert.equal(Array.isArray(readInviteState({ cacheDir: w.cacheDir }).accounts), false)
  } finally {
    w.cleanup()
  }
})

test("cacheDir=false → 全内存，一个字节都不落盘", async () => {
  const w = workspace()
  try {
    const { resetMemoryState } = await import("../src/codearts/invite.mjs")
    resetMemoryState()
    const before = fs.readdirSync(w.dir)
    const r = await ensureInviteCode({ reservedInput: "MEMONLY", cacheDir: false })
    assert.equal(r.source, "manual")
    assert.deepEqual(fs.readdirSync(w.dir), before, "工作区里不许多出任何文件")
    assert.equal(readInviteState({ cacheDir: false }).reserved.code, "MEMONLY")
  } finally {
    w.cleanup()
  }
})

// ---- 8. 账号源：plugin-auth + logins ---------------------------------------

test("syncAccounts：firstSeenAt 只写一次，lastSeenAt 每次刷", () => {
  const w = workspace()
  try {
    writeAuth(w.authFile, { codearts: authEntry({ uid: "u1", accountId: "acct1", ak: "AK1" }) })
    const a1 = syncAccounts({ authFile: w.authFile, loginsFile: w.loginsFile, cacheDir: w.cacheDir, now: 1000 })
    assert.equal(a1.accounts.length, 1)
    assert.equal(a1.accounts[0].uid, "u1")
    assert.equal(a1.accounts[0].firstSeenAt, 1000)
    assert.equal(a1.authReadable, true)

    const a2 = syncAccounts({ authFile: w.authFile, loginsFile: w.loginsFile, cacheDir: w.cacheDir, now: 5000 })
    assert.equal(a2.accounts[0].firstSeenAt, 1000, "firstSeenAt 不许被刷")
    assert.equal(a2.accounts[0].lastSeenAt, 5000, "lastSeenAt 要刷新")
  } finally {
    w.cleanup()
  }
})

test("syncAccounts：plugin-auth 读不到 → 按「不校验」，不把已知账号判成已删除", () => {
  const w = workspace()
  try {
    writeAuth(w.authFile, { codearts: authEntry({ uid: "u1", accountId: "acct1", ak: "AK1" }) })
    syncAccounts({ authFile: w.authFile, loginsFile: w.loginsFile, cacheDir: w.cacheDir, now: 1000 })
    fs.rmSync(w.authFile)
    const a = syncAccounts({ authFile: w.authFile, loginsFile: w.loginsFile, cacheDir: w.cacheDir, now: 2000 })
    assert.equal(a.authReadable, false)
    assert.equal(a.accounts[0].present, true, "读不到文件 ≠ 账号被删")
  } finally {
    w.cleanup()
  }
})

test("syncAccounts：账号从 plugin-auth 消失 → present:false，不得作源", async () => {
  const w = workspace()
  try {
    writeAuth(w.authFile, {
      codearts: authEntry({ uid: "u1", accountId: "acct1", ak: "AK1" }),
      "codearts#bb": authEntry({ uid: "u2", accountId: "acct2", ak: "AK2" }),
    })
    syncAccounts({ authFile: w.authFile, loginsFile: w.loginsFile, cacheDir: w.cacheDir, now: 1000 })
    writeAuth(w.authFile, { "codearts#bb": authEntry({ uid: "u2", accountId: "acct2", ak: "AK2" }) })
    const a = syncAccounts({ authFile: w.authFile, loginsFile: w.loginsFile, cacheDir: w.cacheDir, now: 2000 })
    const gone = a.accounts.find((x) => x.uid === "u1")
    assert.equal(gone.present, false)

    // 已删除的账号不许作源
    const { request, calls } = fakeRequest(() => fail("HTTP 500"))
    // 先单独留一个预留码（手填路径），再在「无手填」的情况下问一次
    await ensureInviteCode({ reservedInput: "R1", cacheDir: w.cacheDir })
    const r = await ensureInviteCode({
      accounts: a.accounts,
      request,
      cacheDir: w.cacheDir,
    })
    assert.equal(r.source, "reserved")
    assert.equal(r.code, "R1")
    const used = calls.filter((c) => c.cred)
    assert.equal(used.length, 1, "只会拿在场的 u2 去试")
    assert.equal(used[0].cred.access_key_id, "AK2")
  } finally {
    w.cleanup()
  }
})

test("readPreferredUid：first:true → 最小正 order → 第一行；home 映射回 uid", () => {
  const w = workspace()
  try {
    const byKey = { codearts: "u0", "codearts#aa": "uA", "codearts#bb": "uB" }
    fs.writeFileSync(w.loginsFile, JSON.stringify([
      { agent: "plugin:codearts", home: "codearts#aa", order: 5 },
      { agent: "plugin:codearts", home: "codearts#bb", order: 2 },
    ]))
    assert.equal(readPreferredUid({ loginsFile: w.loginsFile, byKey }), "uB", "最小正 order 优先")

    fs.writeFileSync(w.loginsFile, JSON.stringify([
      { agent: "plugin:codearts", home: "codearts#aa", order: 5 },
      { agent: "plugin:codearts", home: "codearts#bb", order: 2, first: true },
    ]))
    assert.equal(readPreferredUid({ loginsFile: w.loginsFile, byKey }), "uB", "first:true 最高优先")

    fs.writeFileSync(w.loginsFile, JSON.stringify([
      { agent: "plugin:codearts", home: "codearts#aa" },
      { agent: "plugin:codearts", home: "codearts#bb" },
    ]))
    assert.equal(readPreferredUid({ loginsFile: w.loginsFile, byKey }), "uA", "没有 first/order 就取第一行")

    fs.writeFileSync(w.loginsFile, JSON.stringify([{ agent: "plugin:officeace", home: "codearts#aa" }]))
    assert.equal(readPreferredUid({ loginsFile: w.loginsFile, byKey }), null, "别的 provider 不算")

    fs.rmSync(w.loginsFile)
    assert.equal(readPreferredUid({ loginsFile: w.loginsFile, byKey }), null, "读不到 logins.json → null")
  } finally {
    w.cleanup()
  }
})

test("readPreferredUid：指定行失效时回预留，不顺移到另一个账号", () => {
  const w = workspace()
  try {
    const byKey = { codearts: "u0", "codearts#aa": "uA", "codearts#bb": "uB" }
    for (const rows of [
      [
        { agent: "plugin:codearts", home: "missing", first: true },
        { agent: "plugin:codearts", home: "codearts#bb", order: 2 },
      ],
      [
        { agent: "plugin:codearts", home: "codearts#aa", order: 5 },
        { agent: "plugin:codearts", home: "missing", order: 2 },
      ],
      [
        { agent: "plugin:codearts", home: "missing" },
        { agent: "plugin:codearts", home: "codearts#bb" },
      ],
    ]) {
      fs.writeFileSync(w.loginsFile, JSON.stringify(rows))
      assert.equal(readPreferredUid({ loginsFile: w.loginsFile, byKey }), null)
    }
  } finally {
    w.cleanup()
  }
})

test("syncAccounts：preferredUid 能从 logins.json 解析出来", () => {
  const w = workspace()
  try {
    writeAuth(w.authFile, {
      codearts: authEntry({ uid: "u1", accountId: "acct1", ak: "AK1" }),
      "codearts#bb": authEntry({ uid: "u2", accountId: "acct2", ak: "AK2" }),
    })
    fs.writeFileSync(w.loginsFile, JSON.stringify([{ agent: "plugin:codearts", home: "codearts#bb" }]))
    const a = syncAccounts({ authFile: w.authFile, loginsFile: w.loginsFile, cacheDir: w.cacheDir, now: 1000 })
    assert.equal(a.preferredUid, "u2")
  } finally {
    w.cleanup()
  }
})

// ---- 9. 无活动 / 无码 ------------------------------------------------------

test("没有邀请活动 → 不猜 campaignId，直接失败", async () => {
  const w = workspace()
  try {
    const { request, calls } = fakeRequest(() => ok({ items: [{ campaignId: 1, type: "USER_LOGIN" }] }))
    const r = await ensureInviteCode({ accounts: [account("u3", 300, credOf(3))], request, cacheDir: w.cacheDir })
    assert.equal(r.code, "")
    assert.match(r.error, /没有邀请活动/)
    assert.equal(calls.length, 1, "找不到活动就不该再打 generate")
  } finally {
    w.cleanup()
  }
})

test("活动有、但接口不回码 → 失败并说明", async () => {
  const { request } = fakeRequest((method, url) =>
    url === OPS_DELIVERY_URL ? ok({ items: [inviteItem(7)] }) : ok({}),
  )
  const r = await generateInvite({ cred: credOf(3), campaign: {}, request })
  assert.equal(r.ok, false)
})

test("generateInvite：缺少 campaignId 且没给 campaign → 直接拒绝", async () => {
  const { request, calls } = fakeRequest(() => ok({ inviteCode: "X" }))
  const r = await generateInvite({ cred: credOf(1), request })
  assert.equal(r.ok, false)
  assert.equal(calls.length, 0)
})

// ---- 10. noteAttempt / 节流读写 --------------------------------------------

test("noteAttempt 落盘，isThrottled 认它", async () => {
  const w = workspace()
  try {
    const { isThrottled } = await import("../src/codearts/invite.mjs")
    const t0 = 1_000_000
    assert.equal(isThrottled("u9", { cacheDir: w.cacheDir, now: t0 }), false)
    noteAttempt("u9", { cacheDir: w.cacheDir, now: t0 })
    assert.equal(isThrottled("u9", { cacheDir: w.cacheDir, now: t0 + 1000 }), true)
    assert.equal(isThrottled("u9", { cacheDir: w.cacheDir, now: t0 + THROTTLE_MS + 1 }), false)
  } finally {
    w.cleanup()
  }
})

test("首次同步多个旧账号：plugin-auth 后面的账号才是最新，不被同毫秒排序反转", async () => {
  const w = workspace()
  try {
    writeAuth(w.authFile, {
      codearts: authEntry({ uid: "old", accountId: "old", ak: "AK-OLD" }),
      "codearts#new": authEntry({ uid: "new", accountId: "new", ak: "AK-NEW" }),
    })
    const synced = syncAccounts({ authFile: w.authFile, loginsFile: w.loginsFile, cacheDir: w.cacheDir, now: 10_000 })
    assert.equal(synced.accounts[0].uid, "new")
    assert.ok(synced.accounts[0].firstSeenAt > synced.accounts[1].firstSeenAt)
  } finally {
    w.cleanup()
  }
})

test("inviteUrl 取不出 invitecode：不能当成可自动绑定的邀请源", async () => {
  const { request } = fakeRequest(() => ok({ inviteUrl: "https://devcloud.cn-north-4.huaweicloud.com/chat/home" }))
  const r = await generateInvite({ cred: credOf(1), campaignId: 7, request })
  assert.equal(r.ok, false)
  assert.match(r.error, /邀请码/)
})
