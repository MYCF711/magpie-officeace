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

test("控制台那条路的说明带链接与步骤，并说清不会重新登录", () => {
  assert.match(_internal.MAAS_CONSOLE_URL, /^https:\/\/console\.huaweicloud\.com\/agentarts\/$/)
  const open = _internal.MAAS_OPEN_INSTRUCTIONS
  assert.ok(open.includes("console.huaweicloud.com/agentarts"), "要带控制台链接")
  assert.ok(open.includes("批量开通模型"), "要带授权管理的步骤")
  assert.ok(open.includes("MaaS 服务创建 API Key"), "要带鉴权管理的步骤")
  assert.ok(open.includes("不会重新登录华为云"), "不能承诺做不到的事：说明这一步不重登")
  assert.ok(open.includes("已保存的登录态"), "要说清是用已保存的登录态检测")

  const oauth = _internal.MAAS_OAUTH_INSTRUCTIONS
  assert.ok(oauth.includes("华为云登录"), "登录那条要如实说是华为云登录")
  assert.ok(oauth.includes("不会替你开通 MaaS"), "登录那条不能暗示它会开通 MaaS")
  assert.ok(oauth.includes("去 AgentArts 控制台开通 MaaS"), "要指路到控制台那一条")
})

test("两个登录方式：华为云登录 + 去控制台开通 MaaS", async () => {
  const plugin = await OfficeAceAuthPlugin({})
  const ms = plugin.auth.methods
  assert.equal(ms.length, 2)
  assert.equal(ms[0].type, "oauth")
  assert.equal(ms[1].type, "oauth")
  assert.match(ms[1].label, /AgentArts 控制台/)
})

test("usage 记住没接 MaaS 的账号，接上了就忘掉", async () => {
  _internal.maasPending.clear()
  const plugin = await OfficeAceAuthPlugin({})
  const body = JSON.stringify({ skus: [], bonus_skus: [] })
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(body, { status: 200 })
  try {
    await plugin.auth.usage(async () => record(stsOnly), {})
    assert.equal(_internal.maasPending.size, 1, "没接 MaaS 的账号被记住")
    await plugin.auth.usage(async () => record(withMaas), {})
    assert.equal(_internal.maasPending.size, 0, "接上 MaaS 之后忘掉")
  } finally {
    globalThis.fetch = original
    _internal.maasPending.clear()
  }
})

test("去控制台开通：authorize 直接给控制台地址，不发任何请求", async () => {
  _internal.maasPending.clear()
  const key = { access: "AK", secret: "SK", securityToken: "ST", expiresAt: "2031-01-01T00:00:00Z", accountId: "01a1" }
  _internal.noteMaasPending(key)
  const plugin = await OfficeAceAuthPlugin({})
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => { calls++; return new Response("{}", { status: 200 }) }
  try {
    const a = await plugin.auth.methods[1].authorize()
    assert.equal(a.url, _internal.MAAS_CONSOLE_URL, "打开的是控制台，不是华为云登录")
    assert.notEqual(a.opened, true, "没自己开页面：要让 magpie 开")
    assert.ok(a.instructions.includes("console.huaweicloud.com/agentarts"))
    assert.equal(calls, 0, "authorize 不发请求")
  } finally {
    globalThis.fetch = original
    _internal.maasPending.clear()
  }
})

test("去控制台开通：检测到 MaaS 就回写同一份凭据（不重新登录）", async () => {
  _internal.maasPending.clear()
  const key = {
    access: "AK", secret: "SK", securityToken: "ST", projectId: "",
    expiresAt: "2031-01-01T00:00:00Z", refreshToken: "RT-KEEP",
    accountId: "01a1642ad2ae7f93bf6387ad2fc5f09e", user_phone: "189****8051",
  }
  _internal.noteMaasPending(key)
  const plugin = await OfficeAceAuthPlugin({ client: undefined }, { maasWatchMs: 2000, maasWatchIntervalMs: 5 })
  let tries = 0
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes("/v1/claw/client-permission-validate")) {
      tries += 1
      const granted = tries >= 2
      return new Response(
        JSON.stringify({ subscription: { model_info: granted ? { model_auth_info: { model_app_key: "app-key", model_app_secret: "app-secret" }, model_api_url_base: "" } : {} } }),
        { status: 200 },
      )
    }
    return new Response("{}", { status: 200 })
  }
  try {
    const b = await plugin.auth.methods[1].authorize().then((a) => a.callback())
    assert.equal(b.type, "success")
    const written = JSON.parse(b.access)
    assert.equal(written.modelAppKey, "app-key", "把检测到的 MaaS 凭据合并进同一份记录")
    assert.equal(written.refreshToken, "RT-KEEP", "没有换 token：还是原来那份登录态")
    assert.equal(written.user_phone, "189****8051", "手机号保留")
    assert.equal(b.accountId, "189****8051")
    assert.ok(tries >= 2, "轮询到第二次才拿到")
  } finally {
    globalThis.fetch = original
    _internal.maasPending.clear()
  }
})

test("去控制台开通：等不到就说清楚，不假装成功", async () => {
  _internal.maasPending.clear()
  _internal.noteMaasPending({ access: "AK", secret: "SK", securityToken: "ST", expiresAt: "2031-01-01T00:00:00Z", accountId: "01a1" })
  const plugin = await OfficeAceAuthPlugin({}, { maasWatchMs: 40, maasWatchIntervalMs: 10 })
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ subscription: { model_info: {} } }), { status: 200 })
  try {
    const b = await plugin.auth.methods[1].authorize().then((a) => a.callback())
    assert.equal(b.type, "failed")
    assert.match(b.error, /还没有检测到 MaaS 开通/)
    assert.match(b.error, /批量开通模型|鉴权管理/)
  } finally {
    globalThis.fetch = original
    _internal.maasPending.clear()
  }
})

test("去控制台开通：没有已保存的登录态时如实报错", async () => {
  _internal.maasPending.clear()
  const plugin = await OfficeAceAuthPlugin({})
  const b = await plugin.auth.methods[1].authorize().then((a) => a.callback())
  assert.equal(b.type, "failed")
  assert.match(b.error, /没有可检测的登录态/)
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
