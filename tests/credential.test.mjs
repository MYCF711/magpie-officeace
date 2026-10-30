// 凭据判定 —— 回归测试（node --test tests/）
//
// 覆盖的三件事：
//   ① 完整凭据（有 MaaS appKey）行为不变 —— 老用户不能掉登录
//   ② 只有 STS 三元组的账号（尚未接入 MaaS）也算已登录 —— 额度/签到能用
//   ③ 只有 STS 的账号不接管对话、目录回退静态表 —— 空 appKey 不发上游
import test from "node:test"
import assert from "node:assert/strict"
import { OfficeAceAuthPlugin } from "../index.mjs"
import { credentialOf, toStored, expiryMs } from "../src/credential.mjs"

const noModelInfo = async () => new Response(JSON.stringify({ error_code: "APIGW.0301" }), { status: 401 })

const sts = {
  access: "HSTAOZ3JN3WWYF3L",
  secret: "9hefA4eK2KTT",
  securityToken: "hQpjbi1ub3J0",
  expiresAt: "2026-10-29T10:00:00.000Z",
  accountId: "01a1642ad2ae7f93bf6387ad2fc5f09e",
}
const full = {
  ...sts,
  modelAppKey: "39161fdacb0c",
  modelAppSecret: "11644a70ea4d",
  maasBaseUrl: "",
}

const record = (inner, extra = {}) => ({
  type: "oauth",
  access: JSON.stringify(inner),
  refresh: "RT-JWT",
  expires: 1792841892266,
  accountId: inner.accountId,
  ...extra,
})

test("① 标准形状 + 完整凭据：照旧返回", () => {
  const cred = credentialOf(record(full))
  assert.equal(cred.modelAppKey, "39161fdacb0c")
  assert.equal(cred.securityToken, "hQpjbi1ub3J0")
  assert.equal(cred.refreshToken, "RT-JWT")
})

test("② 铺平形状 + 完整凭据：照旧返回", () => {
  const cred = credentialOf({ ...full, refresh: "RT-JWT" })
  assert.equal(cred.modelAppKey, "39161fdacb0c")
  assert.equal(cred.refreshToken, "RT-JWT")
})

test("③ STS-only（JSON 形状）：认作已登录，modelAppKey 为空", () => {
  const cred = credentialOf(record(sts))
  assert.ok(cred, "STS 三元组齐全时应返回凭据，而不是 null")
  assert.equal(cred.modelAppKey, undefined)
  assert.equal(cred.access, "HSTAOZ3JN3WWYF3L")
  assert.equal(cred.refreshToken, "RT-JWT")
})

test("③ STS-only（铺平形状）：认作已登录", () => {
  const cred = credentialOf({ ...sts, refresh: "RT-JWT" })
  assert.ok(cred)
  assert.equal(cred.securityToken, "hQpjbi1ub3J0")
})

test("③ STS 缺 securityToken：仍是未登录", () => {
  assert.equal(credentialOf(record({ ...sts, securityToken: "" })), null)
  assert.equal(credentialOf({ ...sts, securityToken: undefined }), null)
})

test("③ 空 access：仍是未登录", () => {
  assert.equal(credentialOf(record({ ...sts, access: "" })), null)
})

test("无 auth / 空对象：null", () => {
  assert.equal(credentialOf(null), null)
  assert.equal(credentialOf(undefined), null)
  assert.equal(credentialOf({}), null)
})

test("toStored：存储形状没变（老用户不掉登录）", () => {
  const out = toStored({ ...full, refreshToken: "RT-JWT" })
  assert.equal(out.type, "oauth")
  assert.equal(typeof out.access, "string")
  assert.equal(JSON.parse(out.access).modelAppKey, "39161fdacb0c")
  assert.equal(out.refresh, "RT-JWT")
  assert.equal(out.accountId, "01a1642ad2ae7f93bf6387ad2fc5f09e")
  assert.equal(out.uid, "01a1642ad2ae7f93bf6387ad2fc5f09e")
  assert.ok(Number.isFinite(out.expires))
})

test("expiryMs：解析不了时保守给 1 小时后（不改旧语义）", () => {
  const before = Date.now()
  const at = expiryMs({})
  assert.ok(at >= before + 59 * 60_000 && at <= Date.now() + 61 * 60_000)
})

test("loader：STS-only 回一个说清原因的 400，不发空 Basic 头", async () => {
  const plugin = await OfficeAceAuthPlugin({}, { fetch: noModelInfo })
  const loader = await plugin.auth.loader(async () => record(sts), {})
  assert.equal(loader.baseURL, undefined, "不该给 baseURL —— 请求不出网关")
  assert.equal(typeof loader.fetch, "function")
  const res = await loader.fetch("https://api.modelarts-maas.com/v2/chat/completions", { method: "POST" })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error.code, "MaaSNotLinked")
  assert.match(body.error.message, /还没有接入华为云 MaaS/)
})

test("loader：完全未登录时仍不接管（让 magpie 说「未登录」）", async () => {
  const plugin = await OfficeAceAuthPlugin({}, { fetch: noModelInfo })
  const loader = await plugin.auth.loader(async () => null, {})
  assert.deepEqual(loader, {})
})

test("loader：完整凭据照旧接管", async () => {
  const plugin = await OfficeAceAuthPlugin({}, { fetch: noModelInfo })
  const loader = await plugin.auth.loader(async () => record(full), {})
  assert.equal(loader.baseURL, "")
  assert.equal(typeof loader.fetch, "function")
})

test("models：STS-only 回退静态表", async () => {
  const plugin = await OfficeAceAuthPlugin({}, { fetch: noModelInfo })
  const models = await plugin.provider.models({}, { auth: record(sts) })
  assert.equal(typeof models, "object")
  assert.ok(Object.keys(models).length > 0, "静态表不能是空的")
})

test("models：无凭据也回退静态表", async () => {
  const plugin = await OfficeAceAuthPlugin({}, { fetch: noModelInfo })
  const models = await plugin.provider.models({}, { auth: null })
  assert.equal(typeof models, "object")
  assert.ok(Object.keys(models).length > 0)
})
