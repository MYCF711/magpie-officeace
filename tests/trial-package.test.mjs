// 「个人体验版」（trial 套餐）下单体的形状 + claimTrialPackage 的请求/错误处理。
// ⚠ 这些测试只用假 fetch；真正的开通是写操作，未执行。

import test from "node:test"
import assert from "node:assert/strict"

import { claimTrialPackage, trialOrderBody, TRIAL_SKU_CODE } from "../src/api.mjs"

const cred = {
  access: "HSTAOZ3JN3WWYF3L",
  secret: "9hefA4eK2KTT",
  securityToken: "hQpjbi1ub3J0",
  projectId: "",
}

test("trialOrderBody：与客户端「免费开通」同构（MONTH×1、autoPay=1、空 atomic id）", () => {
  const b = trialOrderBody()
  assert.equal(b.service_type, "hws.service.type.agentarts")
  assert.equal(b.subscribe_period_type, 2)
  assert.equal(b.subscribe_period_value, 1)
  assert.equal(b.auto_pay, 1)
  assert.equal(b.auto_renewal, 0)
  assert.equal(b.subscribe_sku_info.subscribe_sku_code, TRIAL_SKU_CODE)
  assert.equal(b.subscribe_sku_info.subscribe_sub_product_code, "hws.resource.type.agentarts.platform")
  assert.equal(b.subscribe_sku_info.subscribe_atomic_product_id, "")
  assert.equal(b.agreement_list[0].agree_declaration, 1)
})

test("trialOrderBody：cloudMeta 能给的就用它（periodType/periodValue/subProductCode）", () => {
  const b = trialOrderBody({ periodType: 3, periodValue: 1, subProductCode: "x.y", atomicProductId: "atomic-1" })
  assert.equal(b.subscribe_period_type, 3)
  assert.equal(b.subscribe_period_value, 1)
  assert.equal(b.subscribe_sku_info.subscribe_sub_product_code, "x.y")
  assert.equal(b.subscribe_sku_info.subscribe_atomic_product_id, "atomic-1")
})

test("claimTrialPackage：POST /v1/subscription/period，带下单体（走 signV11Request 发请求）", async () => {
  const calls = []
  const fakeRequest = async (url, cred2, method, body) => {
    calls.push({ url, cred: cred2, method, body })
    return { ok: true, status: 200, text: JSON.stringify({ order_id: "order-1", status: "SUCCESS" }) }
  }
  const r = await claimTrialPackage(cred, fakeRequest)
  assert.equal(r.ok, true)
  assert.equal(r.orderId, "order-1")
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/v1\/subscription\/period$/)
  assert.equal(calls[0].method, "POST")
  assert.equal(calls[0].cred.access, cred.access)
  const body = JSON.parse(calls[0].body)
  assert.equal(body.subscribe_sku_info.subscribe_sku_code, TRIAL_SKU_CODE)
  assert.equal(body.auto_pay, 1)
})

test("claimTrialPackage：云端报错 → ok:false 带状态码与原文，不吞", async () => {
  const fakeRequest = async () => ({ ok: false, status: 400, text: JSON.stringify({ error_code: "AgentArts.00000131", error_msg: "未实名认证" }) })
  const r = await claimTrialPackage(cred, fakeRequest)
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
  assert.match(r.detail, /00000131/)
})
