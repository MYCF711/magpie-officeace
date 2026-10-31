// 「个人体验版」（trial 套餐）下单体的形状 + claimTrialPackage 的请求/错误处理。
// ⚠ 这些测试只用假 fetch；真正的开通是写操作，未在测试中执行。

import test from "node:test"
import assert from "node:assert/strict"

import {
  claimTrialPackage,
  resolveProjectId,
  resolveTrialAtomicProductId,
  trialOrderBody,
  TRIAL_SKU_CODE,
} from "../src/api.mjs"

const cred = {
  access: "HSTAOZ3JN3WWYF3L",
  secret: "9hefA4eK2KTT",
  securityToken: "hQpjbi1ub3J0",
  projectId: "",
}

test("trialOrderBody：与客户端「免费开通」同构（MONTH×1、autoPay=1）", () => {
  const b = trialOrderBody({ atomicProductId: "atomic-1" })
  assert.equal(b.service_type, "hws.service.type.agentarts")
  assert.equal(b.subscribe_period_type, 2)
  assert.equal(b.subscribe_period_value, 1)
  assert.equal(b.auto_pay, 1)
  assert.equal(b.auto_renewal, 0)
  assert.equal(b.subscribe_sku_info.subscribe_sku_code, TRIAL_SKU_CODE)
  assert.equal(b.subscribe_sku_info.subscribe_sub_product_code, "hws.resource.type.agentarts.platform")
  assert.equal(b.subscribe_sku_info.subscribe_atomic_product_id, "atomic-1")
  assert.equal(b.agreement_list[0].agree_declaration, 1)
})

test("resolveProjectId：IAM 项目列表里取 cn-southwest-2", async () => {
  const fetcher = async (url) => {
    assert.match(String(url), /\/v3\/auth\/projects$/)
    return new Response(JSON.stringify({ projects: [
      { name: "cn-north-4", id: "p-north" },
      { name: "cn-southwest-2", id: "p-sw" },
    ] }), { status: 200 })
  }
  assert.equal(await resolveProjectId(cred, fetcher), "p-sw")
  assert.equal(await resolveProjectId({ ...cred, projectId: "given" }, fetcher), "given")
})

test("resolveTrialAtomicProductId：取 product_sales_cycles[0].id", async () => {
  const fetcher = async (url) => {
    assert.match(String(url), /\/v1\/skus\/officeace\.personal\.package\.trial\?/)
    return new Response(JSON.stringify({ product_sales_cycles: [{ id: "OFFI123" }] }), { status: 200 })
  }
  assert.equal(await resolveTrialAtomicProductId(cred, fetcher), "OFFI123")
})

test("claimTrialPackage：POST /v1/subscription/period（带 X-Project-ID，body 含 atomicId）", async () => {
  const calls = []
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ order_id: "order-1", status: "PAYING", cbc_order_id: "CS1" }), { status: 200 })
  }
  const r = await claimTrialPackage(cred, { fetcher, projectId: "p-sw", atomicProductId: "OFFI123" })
  assert.equal(r.ok, true)
  assert.equal(r.orderId, "order-1")
  assert.equal(r.orderStatus, "PAYING")
  assert.equal(calls.length, 1, "给了 projectId/atomicProductId 就只发下单请求")
  assert.match(calls[0].url, /\/v1\/subscription\/period$/)
  assert.equal(calls[0].init.method, "POST")
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.subscribe_sku_info.subscribe_atomic_product_id, "OFFI123")
  assert.equal(body.subscribe_sku_info.subscribe_sku_code, TRIAL_SKU_CODE)
  assert.ok(calls[0].init.headers.Authorization, "必须带签名头")
})

test("claimTrialPackage：云端报错 → ok:false 带状态码与原文，不吞", async () => {
  const fetcher = async () => new Response(JSON.stringify({ error_code: "AgentArts.00000131", error_msg: "未实名认证" }), { status: 400 })
  const r = await claimTrialPackage(cred, { fetcher, projectId: "p-sw", atomicProductId: "OFFI123" })
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
  assert.match(r.detail, /00000131/)
})
