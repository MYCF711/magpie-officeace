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
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OfficeAceAuthPlugin, _internal } from "../index.mjs"

// 默认的 fetch 替身：权限接口回 401 = 「云端没有 model_info」，
// 免得 usage/loader 的旧记录补全去真打网络（测试里没有真凭据）。
const noModelInfo = async () => new Response(JSON.stringify({ error_code: "APIGW.0301" }), { status: 401 })

// 测试里绝不真起浏览器（openConsole 会被插件调用）
process.env.MAGPIE_OFFICEACE_NO_BROWSER = "1"

/** 一个空的临时目录 —— 测试永远不要读本机真的 plugin-auth.json。 */
function tempAuthFile(name = "plugin-auth.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "officeace-auth-"))
  return path.join(dir, name)
}

/** 写一份 magpie 形状的账号文件（就绪记录：{type, access, refresh, expires, accountId}）。 */
function writeAuthFile(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(entries, null, 2))
  return file
}

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

test("usage：没有 modelAppKey 的账号只标「未接入 MaaS」，不再误标登录失效", async () => {
  _internal.modelInfoCache.clear()
  const plugin = await OfficeAceAuthPlugin({}, { authFile: tempAuthFile(), fetch: noModelInfo })
  const out = await withSubscriptionFetch(() => plugin.auth.usage(async () => record(stsOnly), {}))
  assert.equal(out.plan, "未接入 MaaS")
  assert.equal("signIn" in out, false, "凭据是好的 —— 不能给 signIn: expired（会显示已退出登录）")
  assert.equal(out.error, undefined, "不能用 error：它会顶掉额度条")
  assert.ok(Array.isArray(out.windows), "额度条照常显示")
})

test("usage：有 modelAppKey 的账号两个字段都不给", async () => {
  const plugin = await OfficeAceAuthPlugin({}, { authFile: tempAuthFile(), fetch: noModelInfo })
  const out = await withSubscriptionFetch(() => plugin.auth.usage(async () => record(withMaas), {}))
  assert.equal(out.plan, "OfficeAce")
  assert.equal("signIn" in out, false)
})

// ---- 复用 OfficeAce 客户端登录态（authorize 快路径）-----------------------

test("authorize：OfficeAce 客户端已登录且账号在 magpie 里 → 不开登录页，直接成功", async () => {
  const authFile = writeAuthFile(tempAuthFile(), {
    officeace: record({ ...withMaas, accountId: "acc-1", user_phone: "181****0632", expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
  })
  let beganLogin = false
  const plugin = await OfficeAceAuthPlugin(
    {},
    {
      authFile,
      fetch: noModelInfo,
      beginLogin: async () => { beganLogin = true; throw new Error("不该走 OAuth") },
      probeClient: async () => ({ loggedIn: true, accountId: "acc-1", userName: "hw1", sessionId: "sid" }),
    },
  )
  const r = await plugin.auth.methods[0].authorize()
  assert.equal(r.opened, true)
  assert.equal(r.url, "")
  assert.match(r.instructions, /已复用 OfficeAce 客户端的登录态/)
  const done = await r.callback()
  assert.equal(done.type, "success")
  assert.equal(JSON.parse(done.access).accountId, "acc-1")
  assert.equal(beganLogin, false, "不能打开任何登录页")
})

test("authorize：OfficeAce 客户端登录的是别的账号 → 回退现有 OAuth", async () => {
  const authFile = writeAuthFile(tempAuthFile(), {
    officeace: record({ ...withMaas, accountId: "acc-1", expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
  })
  let beganLogin = 0
  const plugin = await OfficeAceAuthPlugin(
    {},
    {
      authFile,
      fetch: noModelInfo,
      beginLogin: async () => { beganLogin += 1; return { url: "https://auth.huaweicloud.com/authui/login.html?service=stub", result: Promise.resolve(withMaas) } },
      probeClient: async () => ({ loggedIn: true, accountId: "acc-2", userName: "hw2" }),
    },
  )
  const r = await plugin.auth.methods[0].authorize()
  assert.equal(beganLogin, 1)
  assert.match(String(r.url), /auth\.huaweicloud\.com/)
})

// ---- 单入口：先拿已保存的凭据探，探不通才登录 -----------------------------

/** 一个「永远不该被调用的登录」替身：真 beginLogin 会去 CLAW 注册 state 并后台轮询 10 分钟。 */
const loginStub = (url = "https://auth.huaweicloud.com/authui/login.html?service=stub") => async () => ({
  url,
  result: new Promise(() => {}),
})

/** 一个「一旦被调用就炸」的登录替身：用来断言「这条路上不该出现华为云登录」。 */
const noLogin = () => async () => {
  throw new Error("should not start the Huawei Cloud sign-in")
}

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
  assert.match(_internal.MAAS_CONSOLE_URL, /^https:\/\/console\.huaweicloud\.com\/modelarts\//)
  assert.match(_internal.MAAS_API_KEY_URL, /model-studio\/authmanage$/)

  const open = _internal.MAAS_OPEN_INSTRUCTIONS
  assert.ok(open.includes("console.huaweicloud.com/modelarts"), "要带 MaaS 控制台链接")
  assert.ok(open.includes("预置服务"), "要带开通预置服务的步骤")
  assert.ok(open.includes("API Key 管理"), "要带创建 API Key 的步骤")
  assert.ok(open.includes("同一个华为云账号"), "要如实说控制台要登录就用同一账号")
  assert.ok(open.includes("没法替你登进去"), "不能假装凭据能换控制台会话")

  const oauth = _internal.MAAS_OAUTH_INSTRUCTIONS
  assert.ok(oauth.includes("华为云登录"), "登录那条要如实说是华为云登录")
  assert.ok(oauth.includes("不会替你开通 MaaS"), "登录那条不能暗示它会开通 MaaS")

  assert.ok(_internal.MAAS_ALREADY_INSTRUCTIONS.includes("已经开通"))
})

test("只有一个登录入口（用户不用选）", async () => {
  const plugin = await OfficeAceAuthPlugin({}, { authFile: tempAuthFile(), fetch: noModelInfo })
  assert.equal(plugin.auth.methods.length, 1)
  assert.equal(plugin.auth.methods[0].type, "oauth")
  assert.equal(plugin.auth.methods[0].label, "华为云账号")
})

test("单入口 · 凭据已能开通：直接完成，不轮询", async () => {
  _internal.maasPending.clear()
  _internal.noteMaasPending(pendingCred())
  const { fetcher, calls } = maasFetch(true)
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, beginLogin: loginStub(), authFile: tempAuthFile() })
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
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, beginLogin: loginStub(), authFile: tempAuthFile(), maasWatchMs: 3000, maasWatchIntervalMs: 5 })
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
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, beginLogin: loginStub(), authFile: tempAuthFile(), maasWatchMs: 40, maasWatchIntervalMs: 10 })
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
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, beginLogin: loginStub("https://auth.huaweicloud.com/authui/login.html?service=x"), authFile: tempAuthFile() })
  const a = await plugin.auth.methods[0].authorize()
  assert.match(a.url, /^https:\/\/auth\.huaweicloud\.com\//, "凭据不能用 → 真正的登录")
  assert.ok(a.instructions.includes("华为云登录"))
  _internal.maasPending.clear()
})

test("单入口 · 没有任何登录态：走华为云登录", async () => {
  _internal.maasPending.clear()
  const { fetcher, calls } = maasFetch(false)
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, beginLogin: loginStub("https://auth.huaweicloud.com/authui/login.html?service=y"), authFile: tempAuthFile() })
  const a = await plugin.auth.methods[0].authorize()
  assert.match(a.url, /^https:\/\/auth\.huaweicloud\.com\//)
  assert.equal(calls.length, 0, "没有凭据就不用探")
})

test("单入口 · 探测很慢也不会卡住 authorize（铁律：立刻返回）", async () => {
  _internal.maasPending.clear()
  _internal.noteMaasPending(pendingCred())
  const original = globalThis.fetch
  // 模拟「网络卡住」：真实 fetch 会一直占着 event loop，所以这里也拿一个
  // **ref 住的** timer 撑着（不能用「永不 settle 且没有任何 handle」的 promise
  // —— 进程会先退出，测试被 node --test 判成 cancelledByParent），
  // 并在 abort 时清掉它，保证这条用例自己干净退出。
  globalThis.fetch = (url, init) =>
    new Promise((_, reject) => {
      const hold = setTimeout(() => reject(new Error("fake fetch: no response")), 5000)
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(hold)
        reject(new Error("aborted"))
      })
    })
  try {
    const plugin = await OfficeAceAuthPlugin({}, { maasProbeMs: 80, maasWatchMs: 60, maasWatchIntervalMs: 10, authFile: tempAuthFile() })
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

// ---- 受控浏览器（cookie 登录态）-------------------------------------------

test("单入口 · 没开通时先起受控浏览器：opened=true，回退时不设 opened", async () => {
  _internal.maasPending.clear()
  _internal.noteMaasPending(pendingCred())
  const { fetcher } = maasFetch(false)

  const noWin = await OfficeAceAuthPlugin(
    {},
    { fetch: fetcher, beginLogin: noLogin(), authFile: tempAuthFile(), openConsole: async () => ({ ok: false }), waitConsoleLogin: async () => null },
  )
  const a1 = await noWin.auth.methods[0].authorize()
  assert.equal(a1.opened, undefined, "没有受控浏览器 → 回退系统浏览器，不设 opened")
  assert.equal(a1.url, _internal.MAAS_CONSOLE_URL)

  let openedArgs = null
  const withWin = await OfficeAceAuthPlugin(
    {},
    {
      fetch: fetcher,
      beginLogin: noLogin(),
      authFile: tempAuthFile(),
      openConsole: async (args) => { openedArgs = args; return { ok: true, port: 1234 } },
      waitConsoleLogin: async () => null,
    },
  )
  const a2 = await withWin.auth.methods[0].authorize()
  assert.equal(a2.opened, true, "受控浏览器起来了 → 告诉 magpie 不要再开系统浏览器")
  assert.equal(a2.url, _internal.MAAS_CONSOLE_URL)
  assert.match(a2.instructions, /受控浏览器/)
  assert.equal(openedArgs.accountKey, "01a1642ad2ae7f93bf6387ad2fc5f09e")
  _internal.maasPending.clear()
})

// ---- 旧记录补全：只有 STS、没有 modelAppKey → 向云端补 model_info -----------

/** 权限接口回一套完整 model_info（真实形状，2026-10-31 实测 181****0632）。 */
function grantedFetch() {
  const calls = []
  const fetcher = async (url) => {
    if (String(url).includes("/v1/claw/client-permission-validate")) {
      calls.push(String(url))
      return new Response(JSON.stringify({
        subscription: { model_info: {
          model_api_url_base: "modelgw-0006.officeace.cn-southwest-2.huaweicloud-agentarts.com",
          model_auth_info: { model_app_key: "app-key", model_app_secret: "app-secret", maas_api_key: "maas-key" },
        } },
      }), { status: 200 })
    }
    if (String(url).includes("/v1/subscription")) {
      return new Response(JSON.stringify({ skus: [], bonus_skus: [] }), { status: 200 })
    }
    return new Response("{}", { status: 200 })
  }
  return { fetcher, calls }
}

test("旧记录补全：STS-only 的账号云端有 model_info → 不再标「未接入 MaaS」", async () => {
  _internal.modelInfoCache.clear()
  const { fetcher, calls } = grantedFetch()
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, authFile: tempAuthFile() })
  const out = await plugin.auth.usage(async () => record(stsOnly), {})
  assert.notEqual(out.plan, "未接入 MaaS", "云端已给 model_info，不能再标未接入")
  assert.equal(out.signIn, undefined)
  assert.equal(calls.length, 1, "向云端补了一次")
  assert.equal(typeof out.windows, "object")
})

test("旧记录补全：补到 modelAppKey 后 loader 接管（不再回 MaaSNotLinked）", async () => {
  _internal.modelInfoCache.clear()
  const { fetcher } = grantedFetch()
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, authFile: tempAuthFile() })
  const loader = await plugin.auth.loader(async () => record(stsOnly), {})
  assert.equal(loader.baseURL, "", "有 modelAppKey 就正常接管")
  assert.equal(typeof loader.fetch, "function")
})

test("旧记录补全：按账号缓存，第二次不再请求", async () => {
  _internal.modelInfoCache.clear()
  const { fetcher, calls } = grantedFetch()
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, authFile: tempAuthFile() })
  await plugin.auth.usage(async () => record(stsOnly), {})
  await plugin.auth.usage(async () => record(stsOnly), {})
  assert.equal(calls.length, 1, "6 小时内复用缓存")
})

test("usage 记住没接 MaaS 的账号，接上了就忘掉；取的是最近那份", async () => {
  _internal.maasPending.clear()
  _internal.modelInfoCache.clear()
  const plugin = await OfficeAceAuthPlugin({}, { authFile: tempAuthFile(), fetch: noModelInfo })
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
  _internal.modelInfoCache.clear()
  const plugin = await OfficeAceAuthPlugin({}, { authFile: tempAuthFile(), fetch: noModelInfo })
  const loader = await plugin.auth.loader(async () => record(stsOnly), {})
  const res = await loader.fetch("https://api.modelarts-maas.com/v2/chat/completions", { method: "POST" })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error.code, "MaaSNotLinked")
  assert.equal(body.error.type, "officeace_maas_not_linked")
  assert.match(body.error.message, /还没有模型网关信息/)
  assert.match(body.error.message, /不是登录失效/)
  assert.match(body.error.message, /打开一次 OfficeAce 客户端/)
  assert.match(body.error.message, /officeace_02_0018\.html/)
})

// ---- 「复用已保存的凭据」：内存为空时从磁盘读 ------------------------------

/** magpie 形状的一条 officeace 记录（含续期要用的 DPoP 私钥）。 */
async function storedOfficeAceRecord(overrides = {}) {
  const { privateJwk } = await import("../src/crypto.mjs").then((m) => m.generateDpopKeyPair())
  const cred = {
    access: "AK-DISK",
    secret: "SK-DISK",
    securityToken: "ST-DISK",
    projectId: "",
    expiresAt: "2031-01-01T00:00:00Z",
    refreshToken: "RT-DISK",
    dpopPrivateJwk: privateJwk,
    accountId: "01a1642ad2ae7f93bf6387ad2fc5f09e",
    user_phone: "189****8051",
    ...overrides,
  }
  return {
    type: "oauth",
    access: JSON.stringify(cred),
    refresh: cred.refreshToken,
    expires: Date.parse("2031-01-01T00:00:00Z"),
    accountId: cred.accountId,
    uid: cred.accountId,
  }
}

test("重启后内存为空 · 磁盘有凭据：复用凭据去探测，不跳登录", async () => {
  _internal.maasPending.clear() // 模拟 magpie 刚重启：内存里什么都没有
  const authFile = writeAuthFile(tempAuthFile(), { officeace: await storedOfficeAceRecord() })
  const { fetcher, calls } = maasFetch(true)
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, beginLogin: noLogin(), authFile })
  const a = await plugin.auth.methods[0].authorize()
  assert.equal(a.url, _internal.MAAS_CONSOLE_URL, "从磁盘读到凭据 → 不该跳华为云登录")
  assert.equal(calls.length, 1, "探了一次")
  const out = await a.callback()
  assert.equal(out.type, "success")
  assert.equal(JSON.parse(out.access).modelAppKey, "app-key")
})

test("重启后内存为空 · 磁盘凭据没开通：开控制台 + 轮询", async () => {
  _internal.maasPending.clear()
  const authFile = writeAuthFile(tempAuthFile(), { officeace: await storedOfficeAceRecord() })
  const { fetcher } = maasFetch((n) => n >= 2)
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, beginLogin: noLogin(), authFile, maasWatchMs: 3000, maasWatchIntervalMs: 5 })
  const a = await plugin.auth.methods[0].authorize()
  assert.equal(a.url, _internal.MAAS_CONSOLE_URL)
  const out = await a.callback()
  assert.equal(out.type, "success")
  assert.equal(JSON.parse(out.access).variant, undefined)
})

test("磁盘凭据真的被拒（401）：才走华为云登录", async () => {
  _internal.maasPending.clear()
  const authFile = writeAuthFile(tempAuthFile(), { officeace: await storedOfficeAceRecord() })
  const { fetcher } = maasFetch(false, { status: 401 })
  let started = 0
  const beginLogin = async () => {
    started += 1
    return { url: "https://auth.huaweicloud.com/authui/login.html?service=disk401", result: new Promise(() => {}) }
  }
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, beginLogin, authFile })
  const a = await plugin.auth.methods[0].authorize()
  assert.match(a.url, /^https:\/\/auth\.huaweicloud\.com\//)
  assert.equal(started, 1)
})

test("磁盘上一个 officeace 账号都没有：才走华为云登录", async () => {
  _internal.maasPending.clear()
  // 文件里只有别的插件（codearts）的账号
  const authFile = writeAuthFile(tempAuthFile(), { codearts: { type: "oauth", refresh: "R", access: "{}", expires: 1 } })
  const { fetcher, calls } = maasFetch(false)
  let started = 0
  const beginLogin = async () => {
    started += 1
    return { url: "https://auth.huaweicloud.com/authui/login.html?service=none", result: new Promise(() => {}) }
  }
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, beginLogin, authFile })
  const a = await plugin.auth.methods[0].authorize()
  assert.match(a.url, /^https:\/\/auth\.huaweicloud\.com\//)
  assert.equal(calls.length, 0, "没有凭据就不用探")
  assert.equal(started, 1)
})

test("内存里那份优先（它是刚读过额度的最新凭据）", async () => {
  _internal.maasPending.clear()
  _internal.noteMaasPending(pendingCred({ securityToken: "ST-MEM" }))
  const authFile = writeAuthFile(tempAuthFile(), { officeace: await storedOfficeAceRecord() })
  const seen = []
  const fetcher = async (url, init) => {
    if (String(url).includes("/v1/claw/client-permission-validate")) {
      seen.push(init?.headers?.["x-security-token"])
      return new Response(JSON.stringify({ subscription: { model_info: { model_auth_info: { model_app_key: "k", model_app_secret: "s" } } } }), { status: 200 })
    }
    return new Response("{}", { status: 200 })
  }
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, beginLogin: noLogin(), authFile })
  await plugin.auth.methods[0].authorize()
  assert.deepEqual(seen, ["ST-MEM"], "用的是内存里那份，不是磁盘上的 ST-DISK")
  _internal.maasPending.clear()
})

test("磁盘凭据过期：先用 refresh_token 续一次，再探（不要求重新登录）", async () => {
  _internal.maasPending.clear()
  const record = await storedOfficeAceRecord({ expiresAt: "2026-01-01T00:00:00Z", refreshToken: "RT-OLD", access: "AK-OLD", securityToken: "ST-OLD" })
  const authFile = writeAuthFile(tempAuthFile(), { officeace: { ...record, refresh: "RT-OLD" } })

  const tokenCalls = []
  const sts = async (url, init = {}) => {
    if (String(url).includes("/v1/oauth2/tokens")) {
      tokenCalls.push(String(init.body ?? ""))
      return new Response(
        JSON.stringify({
          credentials: { access_key_id: "AK-NEW", secret_access_key: "SK-NEW", security_token: "ST-NEW", expiration: "2031-01-01T00:00:00Z" },
          refresh_token: "RT-NEW",
        }),
        { status: 200 },
      )
    }
    if (String(url).includes("/v1/claw/client-permission-validate")) {
      const st = init?.headers?.["x-security-token"]
      const granted = st === "ST-NEW"
      return new Response(JSON.stringify({ subscription: { model_info: granted ? { model_auth_info: { model_app_key: "k", model_app_secret: "s" } } : {} } }), { status: 200 })
    }
    return new Response("{}", { status: 200 })
  }

  const original = globalThis.fetch
  globalThis.fetch = sts // refreshOnce 走全局 fetch
  try {
    const plugin = await OfficeAceAuthPlugin({}, { fetch: sts, beginLogin: noLogin(), authFile })
    const a = await plugin.auth.methods[0].authorize()
    assert.equal(tokenCalls.length, 1, "续了一次")
    assert.equal(a.url, _internal.MAAS_CONSOLE_URL, "续期后探测成功 → 控制台，不是登录页")
    const out = await a.callback()
    assert.equal(out.type, "success")
    assert.equal(JSON.parse(out.access).securityToken, "ST-NEW", "回写的是续期后的凭据")
    assert.equal(JSON.parse(out.access).modelAppKey, "k")
  } finally {
    globalThis.fetch = original
    _internal.maasPending.clear()
  }
})

test("账号文件读取：只认 officeace，读不坏、只读", async () => {
  const file = writeAuthFile(tempAuthFile(), {
    officeace: await storedOfficeAceRecord(),
    "officeace#abc123": await storedOfficeAceRecord({ access: "AK-2", securityToken: "ST-2" }),
    codearts: { type: "oauth", refresh: "R", access: "{}" },
    "gemini-cli": { type: "api", key: "x" },
  })
  const before = fs.readFileSync(file, "utf8")
  const beforeStat = fs.statSync(file)

  const accounts = _internal.readOfficeAceAccounts({ file })
  assert.deepEqual(accounts.map((a) => a.key).sort(), ["officeace", "officeace#abc123"])
  assert.equal(accounts[0].cred.access, "AK-DISK")
  // 优先挑「还没接 MaaS」的那个
  assert.equal(_internal.pickOfficeAceCredential(accounts).securityToken, "ST-DISK")

  // 只读：内容与 mtime 都没变
  assert.equal(fs.readFileSync(file, "utf8"), before)
  assert.equal(fs.statSync(file).mtimeMs, beforeStat.mtimeMs)

  // 读不到 / 坏文件 / 空对象：都是空数组，从不抛
  assert.deepEqual(_internal.readOfficeAceAccounts({ file: path.join(path.dirname(file), "nope.json") }), [])
  fs.writeFileSync(file, "{ not json")
  assert.deepEqual(_internal.readOfficeAceAccounts({ file }), [])
  fs.writeFileSync(file, "[]")
  assert.deepEqual(_internal.readOfficeAceAccounts({ file }), [])
})

test("账号文件路径：MAGPIE_OFFICEACE_AUTH_FILE / XDG_CONFIG_HOME / 默认", () => {
  const saved = { a: process.env.MAGPIE_OFFICEACE_AUTH_FILE, x: process.env.XDG_CONFIG_HOME }
  try {
    // 显式指定（便携版/测试用）：原样返回
    const explicit = path.join(os.tmpdir(), "explicit-auth.json")
    process.env.MAGPIE_OFFICEACE_AUTH_FILE = explicit
    assert.equal(_internal.officeAceAuthFile(), explicit)
    delete process.env.MAGPIE_OFFICEACE_AUTH_FILE

    // XDG_CONFIG_HOME（绝对路径才算数，与 magpie 的 rooted() 判据一致）
    const xdg = path.join(os.tmpdir(), "xdg-root")
    process.env.XDG_CONFIG_HOME = xdg
    assert.equal(_internal.officeAceAuthFile(), path.join(xdg, "magpie", "plugin-auth.json"))

    // 相对路径不算数 → 退回 ~/.config/magpie
    process.env.XDG_CONFIG_HOME = "relative-dir"
    assert.equal(_internal.officeAceAuthFile(), path.join(os.homedir(), ".config", "magpie", "plugin-auth.json"))
    delete process.env.XDG_CONFIG_HOME

    assert.ok(_internal.officeAceAuthFile().endsWith(path.join("magpie", "plugin-auth.json")), "默认落在 magpie 的配置目录里")
  } finally {
    if (saved.a === undefined) delete process.env.MAGPIE_OFFICEACE_AUTH_FILE
    else process.env.MAGPIE_OFFICEACE_AUTH_FILE = saved.a
    if (saved.x === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = saved.x
  }
})
