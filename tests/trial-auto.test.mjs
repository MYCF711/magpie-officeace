// 自动补领「个人体验版」的触发条件与缓存（全部用注入替身，不下真单）。

import test from "node:test"
import assert from "node:assert/strict"

import { _internal } from "../index.mjs"

process.env.MAGPIE_OFFICEACE_NO_TRIAL_CLAIM = "0"

const cred = {
  access: "HSTAOZ3JN3WWYF3L",
  secret: "9hefA4eK2KTT",
  securityToken: "hQpjbi1ub3J0",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  user_phone: "181****6710",
}

const trialSku = {
  sku_code: "officeace.personal.package.trial",
  sku_name: "个人体验版",
  effective_time: "2026-10-31T14:22:41.586Z",
  expired_time: "2026-11-30T14:22:41.586Z",
}

test("缺 trial → 先读两次确认，再下一单，再读确认生效", async () => {
  _internal.trialClaimCache.clear()
  const reads = []
  const claims = []
  let call = 0
  const out = await _internal.ensureTrialPackage(cred, {
    readSubscription: async () => {
      reads.push(1)
      call += 1
      // 前两次：没有；下单后：有
      return call <= 2 ? { skus: [] } : { skus: [trialSku] }
    },
    claimTrialPackage: async () => { claims.push(1); return { ok: true, orderId: "o1", cbcOrderId: "c1" } },
    sleep: async () => {},
  })
  assert.equal(out.status, "claimed")
  assert.equal(claims.length, 1)
  assert.ok(reads.length >= 2, "下单前后都读过")
})

test("已有有效 trial → 绝不下单", async () => {
  _internal.trialClaimCache.clear()
  let claims = 0
  const out = await _internal.ensureTrialPackage(cred, {
    readSubscription: async () => ({ skus: [trialSku] }),
    claimTrialPackage: async () => { claims += 1; return { ok: true } },
    sleep: async () => {},
  })
  assert.equal(out.status, "present")
  assert.equal(claims, 0, "有 trial 时不能下单")
})

test("trial 已过期 → 按「没有」处理，允许再领", async () => {
  _internal.trialClaimCache.clear()
  const expired = { ...trialSku, expired_time: "2026-10-01T00:00:00Z" }
  let claims = 0
  const out = await _internal.ensureTrialPackage(cred, {
    readSubscription: async () => ({ skus: [expired] }),
    claimTrialPackage: async () => { claims += 1; return { ok: true, orderId: "o2" } },
    sleep: async () => {},
  })
  assert.equal(claims, 1)
  assert.equal(out.status, "pending") // 替身里读到的仍是过期那条
})

test("同一账号同一进程只尝试一次（失败也缓存，不重试）", async () => {
  _internal.trialClaimCache.clear()
  let claims = 0
  const deps = {
    readSubscription: async () => ({ skus: [] }),
    claimTrialPackage: async () => { claims += 1; return { ok: false, status: 400, detail: "AgentArts.00000131 未实名认证" } },
    sleep: async () => {},
  }
  const a = await _internal.ensureTrialPackage(cred, deps)
  const b = await _internal.ensureTrialPackage(cred, deps)
  assert.equal(a.status, "failed")
  assert.equal(b.status, "failed")
  assert.equal(claims, 1, "失败不能重试")
  assert.match(a.message, /00000131/)
})
