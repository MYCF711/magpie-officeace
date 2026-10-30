// 「未接入 MaaS」的卡片标记与登录说明 —— 回归测试（node --test tests/）
//
// 守护三件事：
//   ① 没有 modelAppKey 的账号：usage() 回 plan「未接入 MaaS」+ signIn「expired」，
//      不用 error（error 会顶掉额度条、让账号从额度表消失、路由反而优先选它）
//   ② 有 modelAppKey 的账号：两个字段都不给
//   ③ loader 的 MaaSNotLinked 400 文案保持两条官方路径 + 文档链接；登录说明里
//      带 AgentArts 控制台入口（旧包没有可改的登录落地页，说明文字是唯一入口）
import test from "node:test"
import assert from "node:assert/strict"
import { OfficeAceAuthPlugin, _internal } from "../index.mjs"

const stsOnly = {
  access: "HSTAOZ3JN3WWYF3L",
  secret: "9hefA4eK2KTT",
  securityToken: "hQpjbi1ub3J0",
  expiresAt: "2026-10-29T10:00:00.000Z",
  accountId: "01a1642ad2ae7f93bf6387ad2fc5f09e",
}
const withMaas = { ...stsOnly, modelAppKey: "39161fdacb0c", modelAppSecret: "11644a70ea4d", maasBaseUrl: "" }

const record = (inner) => ({
  type: "oauth",
  access: JSON.stringify(inner),
  refresh: "RT-JWT",
  expires: 1792841892266,
  accountId: inner.accountId,
})

/** 订阅查询只读 STS，测试里用空 SKU 的响应即可。 */
async function withSubscriptionFetch(fn) {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ skus: [], bonus_skus: [] }), { status: 200 })
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

test("usage：没有 modelAppKey 的账号标「未接入 MaaS」并带 signIn expired", async () => {
  const plugin = await OfficeAceAuthPlugin({})
  const out = await withSubscriptionFetch(() => plugin.auth.usage(async () => record(stsOnly), {}))
  assert.equal(out.plan, "未接入 MaaS")
  assert.equal(out.signIn, "expired")
  assert.equal(out.error, undefined, "不能用 error：它会顶掉额度条")
})

test("usage：有 modelAppKey 的账号两个字段都不给", async () => {
  const plugin = await OfficeAceAuthPlugin({})
  const out = await withSubscriptionFetch(() => plugin.auth.usage(async () => record(withMaas), {}))
  assert.equal(out.plan, "OfficeAce")
  assert.equal("signIn" in out, false)
})

test("登录说明里带 AgentArts 控制台的 MaaS 入口", () => {
  assert.match(_internal.MAAS_CONSOLE_URL, /^https:\/\/console\.huaweicloud\.com\/agentarts\/$/)
  assert.ok(_internal.MAAS_STEPS.includes("console.huaweicloud.com/agentarts"), "要带控制台链接")
  assert.ok(_internal.MAAS_STEPS.includes("批量开通模型"), "要带授权管理的步骤")
  assert.ok(_internal.MAAS_STEPS.includes("MaaS 服务创建 API Key"), "要带鉴权管理的步骤")
})

test("loader：MaaSNotLinked 400 文案保持两条官方路径与文档链接", async () => {
  const plugin = await OfficeAceAuthPlugin({})
  const loader = await plugin.auth.loader(async () => record(stsOnly), {})
  const res = await loader.fetch("https://api.modelarts-maas.com/v2/chat/completions", { method: "POST" })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error.code, "MaaSNotLinked")
  assert.equal(body.error.type, "officeace_maas_not_linked")
  assert.match(body.error.message, /两条路都行/)
  assert.match(body.error.message, /officeace_02_0018\.html/)
})
