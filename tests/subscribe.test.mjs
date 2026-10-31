// 「自动接入模型」：client-subscription 的单元与插件级测试。

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { OfficeAceAuthPlugin, _internal } from "../index.mjs"
import { subscribeClientModelInfo } from "../src/maas.mjs"

const stsOnly = {
  access: "HSTAOZ3JN3WWYF3L",
  secret: "9hefA4eK2KTT",
  securityToken: "hQpjbi1ub3J0",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  user_phone: "181****6710",
}
const record = (inner) => ({
  type: "oauth",
  access: JSON.stringify(inner),
  refresh: "RT-JWT",
  expires: Date.now() + 3600_000,
})

const tempAuthFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oa-sub-")), "plugin-auth.json")
const writeAuth = (file, entries) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(entries, null, 2))
  return file
}

/** permission-validate 说没开通、client-subscription 给 model_info。 */
function autoSubscribeFetch() {
  const calls = []
  const fetcher = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, method: init.method || "GET", body: init.body })
    if (u.includes("/v1/claw/client-permission-validate")) {
      return new Response(JSON.stringify({ subscription: { model_info: null } }), { status: 200 })
    }
    if (u.includes("/v1/claw/client-subscription")) {
      return new Response(JSON.stringify({
        model_info: {
          model_api_url_base: "modelgw-0006.officeace.cn-southwest-2.huaweicloud-agentarts.com",
          model_auth_info: { model_app_key: "auto-key", model_app_secret: "auto-secret" },
        },
      }), { status: 200 })
    }
    if (u.includes("/v1/subscription")) {
      return new Response(JSON.stringify({ skus: [], bonus_skus: [] }), { status: 200 })
    }
    return new Response("{}", { status: 200 })
  }
  return { fetcher, calls }
}

test("subscribeClientModelInfo：POST client-subscription，带 x-subscription-type: v2，解析 model_info", async () => {
  const calls = []
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body, headers: init.headers })
    return new Response(JSON.stringify({
      model_info: {
        model_api_url_base: "modelgw-0006.example",
        model_auth_info: { model_app_key: "k1", model_app_secret: "s1" },
      },
    }), { status: 200 })
  }
  const r = await subscribeClientModelInfo(stsOnly, fetcher)
  assert.equal(r.ok, true)
  assert.equal(r.granted, true)
  assert.equal(r.modelAppKey, "k1")
  assert.equal(r.modelAppSecret, "s1")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, "POST")
  assert.match(calls[0].url, /\/v1\/claw\/client-subscription$/)
  assert.equal(calls[0].body, "{}")
  assert.equal(calls[0].headers["x-subscription-type"], "v2")
  assert.ok(calls[0].headers["X-Security-Token"] || calls[0].headers["x-security-token"])
})

test("subscribeClientModelInfo：云端报错 → ok:false 带状态码，不静默变 0", async () => {
  const fetcher = async () => new Response(JSON.stringify({ error_code: "AgentArts.00001090" }), { status: 400 })
  const r = await subscribeClientModelInfo(stsOnly, fetcher)
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
  assert.match(r.detail, /00001090/)
})

test("usage：缺 model_info 的账号 → 自动 client-subscription 补上，不再显示「未接入 MaaS」", async () => {
  _internal.modelInfoCache.clear()
  const { fetcher, calls } = autoSubscribeFetch()
  const plugin = await OfficeAceAuthPlugin({}, { fetch: fetcher, authFile: tempAuthFile() })
  const out = await plugin.auth.usage(async () => record(stsOnly), {})
  assert.notEqual(out.plan, "未接入 MaaS")
  assert.equal("signIn" in out, false)
  assert.ok(calls.some((c) => c.url.includes("/v1/claw/client-subscription")), "必须调过自动接入")
})

test("authorize：凭据有效但没 model_info → 自动接入后直接成功，不打开任何页面", async () => {
  _internal.modelInfoCache.clear()
  const { fetcher } = autoSubscribeFetch()
  const authFile = writeAuth(tempAuthFile(), { officeace: record(stsOnly) })
  const plugin = await OfficeAceAuthPlugin(
    {},
    { fetch: fetcher, authFile, probeClient: async () => null, beginLogin: async () => { throw new Error("不该走 OAuth") } },
  )
  const r = await plugin.auth.methods[0].authorize()
  assert.equal(r.opened, true)
  assert.equal(r.url, "")
  assert.match(r.instructions, /已自动为你接入模型/)
  const done = await r.callback()
  assert.equal(done.type, "success")
  assert.equal(JSON.parse(done.access).modelAppKey, "auto-key")
})
