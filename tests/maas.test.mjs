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

// ---- 单入口：先拿已保存的凭据探，探不通才登录 -----------------------------

/** 一个「永远不该被调用的登录」替身：真 beginLogin 会去 CLAW 注册 state 并后台轮询 10 分钟。 */
const loginStub = (url = "https://auth.huaweicloud.com/authui/login.html?service=stub") => async () => ({
  url,
  result: new Promise(() => {}),
})

/** 只读探测接口的替身：按调用序号决定「还没开通 / 已开通 / 被拒」。 */
function maasFetch(grants, { status = 200 } = {}) {
  const calls = []
  const fetcher = async (url) => {
    if (String(url).includes("/v1/claw/client-permission-validate")) {
      calls.push(String(url))
      if (status !== 200) return new Response(JSON.stringify({ error_code: "APIGW.0301" }), { status })
      const n = calls.length
      const granted = typeof grants === "function" ? grants(n) : grants
      const model_info = granted
        ? { model_auth_info: { model_app_key: "app-key", model_app_secret: "app-secret" }, model_api_url_base: "" }
        : {}
      return new Response(JSON.stringify({ subscription: { model_info } }), { status: 200 })
    }
    return new Response("{}", { status: 200 })
  }
  return { fetcher, calls }
}

const pendingCred = (extra = {}) => ({
  access: "HSTAOZ3JN3WWYF3L",
  secret: "9hefA4eK2KTT",
  securityToken: "hQpjbi1ub3J0",
  projectId: "",
  expiresAt: "2031-01-01T00:00:00Z",
  refreshToken: "RT-KEEP",
  accountId: "01a1642ad2ae7f93bf6387ad2fc5f09e",
  user_phone: "189****8051",
  ...extra,
})

test("说明文案：控制台那条如实写「要登录就用同一账号」，不假装免登", () => {
  assert.match(_internal.MAAS_CONSOLE_URL, /^https:\/\/console\.huaweicloud\.com\/agentarts\/$/)

  const open = _internal.MAAS_OPEN_INSTRUCTIONS
  assert.ok(open.includes("console.huaweicloud.com/agentarts"), "要带控制台链接")
  assert.ok(open.includes("批量开通模型"), "要带授权管理的步骤")
  assert.ok(open.includes("MaaS 服务创建 API Key"), "要带鉴权管理的步骤")
  assert.ok(open.includes("同一个华为云账号"), "要如实说控制台要登录就用同一账号")
  assert.ok(open.includes("没法替你登进去"), "不能假装凭据能换控制台会话")

  const oauth = _internal.MAAS_OAUTH_INSTRUCTIONS
  assert.ok(oauth.includes("华为云登录"), "登录那条要如实说是华为云登录")
  assert.ok(oauth.includes("不会替你开通 MaaS"), "登录那条不能暗示它会开通 MaaS")

  assert.ok(_internal.MAAS_ALREADY_INSTRUCTIONS.includes("已经开通"))
})

test("只有一个登录入口（用户不用选）", async () => {
  const plugin = await OfficeAceAuthPlugin({})
  assert.equal(plugin.auth.methods.length, 1)
  assert.equal(plugin.auth.methods[0].type, "oauth")
  assert.equal(plugin.auth.methods[0].label, "华为云账号")
})

test("单入口 · 凭据已能开通：直接完成，不轮询", async () => {
  _internal.maasPending.clear()
  _internal.noteMaasPending(pendingCred())
  const { fetcher, calls } = maasFetch(true)
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, beginLogin: loginStub() })
  const a = await plugin.auth.methods[0].authorize()
  assert.equal(a.url, _internal.MAAS_CONSOLE_URL, "顺带把控制台开给用户")
  assert.equal(calls.length, 1, "只探一次")
  const out = await a.callback()
  assert.equal(out.type, "success")
  assert.equal(JSON.parse(out.access).modelAppKey, "app-key")
  assert.equal(calls.length, 1, "已经开通就不轮询")
  _internal.maasPending.clear()
})

test("单入口 · 没开通：开控制台 + 轮询，回写同一份凭据", async () => {
  _internal.maasPending.clear()
  _internal.noteMaasPending(pendingCred())
  const { fetcher, calls } = maasFetch((n) => n >= 3)
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, beginLogin: loginStub(), maasWatchMs: 3000, maasWatchIntervalMs: 5 })
  const a = await plugin.auth.methods[0].authorize()
  assert.equal(a.url, _internal.MAAS_CONSOLE_URL, "打开控制台，不是华为云登录")
  assert.notEqual(a.opened, true, "不自己开页面：要让 magpie 开")
  assert.equal(calls.length, 1, "authorize 里只探一次")

  const out = await a.callback()
  assert.equal(out.type, "success")
  const written = JSON.parse(out.access)
  assert.equal(written.modelAppKey, "app-key", "把检测到的 MaaS 凭据合并进同一份记录")
  assert.equal(written.refreshToken, "RT-KEEP", "没有换 token：还是原来那份登录态")
  assert.equal(written.user_phone, "189****8051", "手机号保留")
  assert.ok(calls.length >= 3, "轮询到开通为止")
  _internal.maasPending.clear()
})

test("单入口 · 等不到开通：如实报错，并指路再点一次", async () => {
  _internal.maasPending.clear()
  _internal.noteMaasPending(pendingCred())
  const { fetcher } = maasFetch(false)
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, beginLogin: loginStub(), maasWatchMs: 40, maasWatchIntervalMs: 10 })
  const a = await plugin.auth.methods[0].authorize()
  const out = await a.callback()
  assert.equal(out.type, "failed")
  assert.match(out.error, /还没有检测到 MaaS 开通/)
  assert.match(out.error, /批量开通模型|鉴权管理/)
  assert.match(out.error, /再点一次「重新登录」/)
  _internal.maasPending.clear()
})

test("单入口 · 凭据被拒（401）：走华为云登录，不开控制台", async () => {
  _internal.maasPending.clear()
  _internal.noteMaasPending(pendingCred())
  const { fetcher } = maasFetch(false, { status: 401 })
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, beginLogin: loginStub("https://auth.huaweicloud.com/authui/login.html?service=x") })
  const a = await plugin.auth.methods[0].authorize()
  assert.match(a.url, /^https:\/\/auth\.huaweicloud\.com\//, "凭据不能用 → 真正的登录")
  assert.ok(a.instructions.includes("华为云登录"))
  _internal.maasPending.clear()
})

test("单入口 · 没有任何登录态：走华为云登录", async () => {
  _internal.maasPending.clear()
  const { fetcher, calls } = maasFetch(false)
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, beginLogin: loginStub("https://auth.huaweicloud.com/authui/login.html?service=y") })
  const a = await plugin.auth.methods[0].authorize()
  assert.match(a.url, /^https:\/\/auth\.huaweicloud\.com\//)
  assert.equal(calls.length, 0, "没有凭据就不用探")
})

test("单入口 · 探测很慢也不会卡住 authorize（铁律：立刻返回）", async () => {
  _internal.maasPending.clear()
  _internal.noteMaasPending(pendingCred())
  const original = globalThis.fetch
  // 模拟「网络卡住」：只有在 abort 时才 reject（真实 fetch 就是这样）
  globalThis.fetch = (url, init) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
    })
  try {
    const plugin = await OfficeAceAuthPlugin({}, { maasProbeMs: 80, maasWatchMs: 60, maasWatchIntervalMs: 10 })
    const t0 = Date.now()
    const a = await plugin.auth.methods[0].authorize()
    const took = Date.now() - t0
    assert.ok(took < 1000, `authorize 必须立刻返回，实际 ${took}ms`)
    assert.equal(a.url, _internal.MAAS_CONSOLE_URL, "读不通时按「没开通」处理：开控制台")
    assert.ok(typeof a.callback === "function")
  } finally {
    globalThis.fetch = original
    _internal.maasPending.clear()
  }
})

test("usage 记住没接 MaaS 的账号，接上了就忘掉；取的是最近那份", async () => {
  _internal.maasPending.clear()
  const plugin = await OfficeAceAuthPlugin({})
  const body = JSON.stringify({ skus: [], bonus_skus: [] })
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(body, { status: 200 })
  try {
    await plugin.auth.usage(async () => record(stsOnly), {})
    assert.equal(_internal.maasPending.size, 1, "没接 MaaS 的账号被记住")
    assert.equal(_internal.latestMaasPending().securityToken, "hQpjbi1ub3J0")
    await plugin.auth.usage(async () => record(withMaas), {})
    assert.equal(_internal.maasPending.size, 0, "接上 MaaS 之后忘掉")
  } finally {
    globalThis.fetch = original
    _internal.maasPending.clear()
  }
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
