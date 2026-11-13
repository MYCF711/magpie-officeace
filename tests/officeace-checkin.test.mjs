// OfficeAce 每日签到（`auth.checkin` 的实现）的 outcome 语义锁。
//
// 依据 magpie-plugin-scaffold 0.3.13 的 `HOOKS.md`「二、`auth.checkin` 完整契约」与
// 「二之二、签到按钮与自动签到」：
//   - 判据是「**今天的领取是否已成立**」，不是「这一次是不是新按了一下」；
//   - 服务端 2xx 且 `bonus_skus` 为空 = 重复领取（幂等），今天已经领完 ⇒ 仍然报 `claimed`，
//     因为「这个账号今天签到过」的时间戳**只在 `outcome === "claimed"` 时才会盖上**，
//     报 `done` 会让那笔积分丢掉「今天的」归属（常见表现：额度卡一直黄着）；
//   - 重复领取的 `credit` 按契约给 0（本次没有新领取）；`streak` 读不到就不给。
//
// ⚠ 全部离线：`signV11Request` 走全局 `fetch`，这里整体替换成假实现，零真实网络。
//   用例结束后必须还原，否则会污染同进程里的其它测试文件。

import test from "node:test"
import assert from "node:assert/strict"

import { checkin } from "../src/api.mjs"

/** 假凭据：字段名与真实凭据一致，值是明显的测试串（绝不会被发出去）。 */
const cred = {
  access: "AK-TEST-0001",
  secret: "SK-TEST-0001",
  securityToken: "ST-TEST-0001",
  projectId: "",
}

/**
 * 装一个假 `fetch`：所有出站请求都落到 `makeResponse`，并记录调用。
 * 返回 `{ calls, restore }`；`restore` 必须放在 `finally` 里。
 */
function mockFetch(makeResponse) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return makeResponse(url, init)
  }
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

// ── ① 今天刚领到：claimed + 真实积分 ───────────────────────────────

test("checkin：2xx 且有奖励 → claimed，credit 是各条 points 的和", async () => {
  const body = JSON.stringify({
    bonus_skus: [
      { activity_name: "每日签到", points: 10 },
      { activity_name: "连续签到奖励", points: 5 },
    ],
  })
  const net = mockFetch(() => new Response(body, { status: 200 }))
  try {
    const r = await checkin(cred)
    assert.equal(r.outcome, "claimed")
    assert.equal(r.credit, 15, "credit 必须是真实 points 求和，不是写死的数")
    assert.match(r.message, /每日签到 \+10/)
    assert.match(r.message, /连续签到奖励 \+5/)
    assert.equal(net.calls.length, 1, "签到只该发一次请求")
    assert.match(net.calls[0].url, /\/v1\/subscription\/bonus\/claim$/)
    assert.equal(net.calls[0].init.method, "POST")
  } finally {
    net.restore()
  }
})

// ── ② 重复领取（本次任务的核心）：2xx + bonus_skus=[] → claimed ──

test("checkin：2xx 且 bonus_skus=[] → claimed「今日已签到」，本次 credit=0 且不编造 streak", async () => {
  const net = mockFetch(() => new Response(JSON.stringify({ bonus_skus: [] }), { status: 200 }))
  try {
    const r = await checkin(cred)

    // 今天的领取**已成立**（幂等重复），必须报 claimed —— 宿主只在这个 outcome 上盖当天时间戳。
    assert.equal(r.outcome, "claimed", "重复领取是幂等的：2xx + 空 bonus_skus 仍是 claimed，不是 done")
    assert.equal(r.message, "今日已签到")

    // 契约明确：今天已经领过仍报 claimed，credit 给 0 表示这次没有新领取。
    assert.equal(r.credit, 0)
    assert.equal(Object.hasOwn(r, "streak"), false, "不许编造 streak")

    assert.equal(net.calls.length, 1)
  } finally {
    net.restore()
  }
})

test("checkin：2xx 但响应体没有 bonus_skus 字段 → 同样按「今天已领完」报 claimed", async () => {
  const net = mockFetch(() => new Response(JSON.stringify({}), { status: 200 }))
  try {
    const r = await checkin(cred)
    assert.equal(r.outcome, "claimed")
    assert.equal(r.message, "今日已签到")
    assert.equal(r.credit, 0)
  } finally {
    net.restore()
  }
})

// ── ③ HTTP 失败：failed，带状态码与原文 ────────────────────────────

test("checkin：非 2xx → failed，带状态码，不冒充 claimed", async () => {
  for (const status of [400, 401, 409, 500]) {
    const net = mockFetch(() => new Response(`upstream-${status}`, { status }))
    try {
      const r = await checkin(cred)
      assert.equal(r.outcome, "failed", `HTTP ${status} 必须是 failed`)
      assert.match(r.message, new RegExp(`HTTP ${status}`))
      assert.match(r.message, new RegExp(`upstream-${status}`), "错误原文要带出来，不能吞")
    } finally {
      net.restore()
    }
  }
})

test("checkin：fetch 抛异常（未发出/无响应）→ failed，不抛给宿主", async () => {
  const net = mockFetch(() => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:1")
  })
  try {
    const r = await checkin(cred)
    assert.equal(r.outcome, "failed")
    assert.match(r.message, /未发出|无响应|ECONNREFUSED/)
  } finally {
    net.restore()
  }
})

// ── ④ 缺凭据：failed，且一次请求都不发 ────────────────────────────

test("checkin：缺 access 或 securityToken → failed，且零出站", async () => {
  const net = mockFetch(() => new Response("{}", { status: 200 }))
  try {
    for (const bad of [{}, { access: "", securityToken: "ST" }, { access: "AK", securityToken: "" }]) {
      const r = await checkin(bad)
      assert.equal(r.outcome, "failed", `凭据 ${JSON.stringify(bad)} 必须是 failed`)
      assert.match(r.message, /凭据缺失/)
    }
    assert.equal(net.calls.length, 0, "凭据不全时不许发请求")
  } finally {
    net.restore()
  }
})

// ── ⑤ 边界：2xx 但响应无法解析 —— 保持 done，不许越界改 claimed ────

test("checkin：2xx 但响应无法解析 → 仍是 done（没确认到今天的入账，不能报 claimed）", async () => {
  const net = mockFetch(() => new Response("<html>gateway</html>", { status: 200 }))
  try {
    const r = await checkin(cred)
    assert.equal(r.outcome, "done", "读不出账单 = 无法确认，按契约只能是 done")
    assert.match(r.message, /无法解析/)
  } finally {
    net.restore()
  }
})
