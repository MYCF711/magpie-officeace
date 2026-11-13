import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { CodeArtsAuthPlugin } from "../src/codearts/index.mjs"
import { OPS_INVITE_CONFIRM_URL, OPS_INVITE_GENERATE_URL, readInviteState } from "../src/codearts/invite.mjs"

const DELIVERY = "https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/delivery?channel=IDE"
const ok = (data) => new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { "Content-Type": "application/json" } })

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codearts-invite-wire-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return {
    cacheDir: path.join(dir, "cache"),
    authFile: path.join(dir, "plugin-auth.json"),
    loginsFile: path.join(dir, "logins.json"),
  }
}

function credential(ak, user = ak) {
  return {
    access_key_id: ak,
    secret_access_key: `SK-${ak}`,
    security_token: `ST-${ak}`,
    refresh_token: `RT-${ak}`,
    expires_at: "2031-01-01T00:00:00Z",
    model_app_key: "APP-KEY-TEST",
    user_name: user,
  }
}

function authEntry(cred) {
  return {
    type: "oauth",
    access: JSON.stringify(cred),
    refresh: cred.refresh_token,
    expires: Date.parse(cred.expires_at),
    accountId: cred.user_name,
    uid: cred.user_name,
  }
}

function seedAccounts(w, logins = []) {
  fs.writeFileSync(w.authFile, JSON.stringify({
    codearts: authEntry(credential("AK-OLD", "old")),
    "codearts#new": authEntry(credential("AK-NEW", "new")),
  }))
  fs.writeFileSync(w.loginsFile, JSON.stringify(logins))
}

function loginMethod(cred, closed) {
  return {
    start: async () => ({
      loginUrl: "https://codearts.huaweicloud.com/portal/authorize?test=1",
      result: Promise.resolve({
        access: JSON.stringify(cred),
        refresh: cred.refresh_token,
        expires: Date.parse(cred.expires_at),
      }),
      close: async () => { closed.count++ },
    }),
  }
}

function accessKeyOf(init) {
  return new Headers(init.headers).get("authorization")?.match(/Access=([^,]+)/)?.[1] ?? ""
}

test("邀请模式声明、prompts/ask 契约与 placement:top", async () => {
  const plugin = await CodeArtsAuthPlugin({ client: {} }, { fetch: async () => { throw new Error("不应联网") } })
  assert.equal(plugin.auth.options.length, 1)
  const option = plugin.auth.options[0]
  assert.equal(option.key, "invite_mode")
  assert.match(option.key, /^[a-z0-9_-]{1,40}$/)
  assert.equal(option.default, false)
  assert.equal(option.placement, "top")
  assert.equal("top" in option, false)
  assert.ok(option.description.length <= 300)
  for (const value of Object.values(option.labels)) assert.ok(value.length <= 60)
  for (const value of Object.values(option.descriptions)) assert.ok(value.length <= 300)

  const method = plugin.auth.methods[0]
  assert.equal(method.prompts[0].key, "invite")
  assert.equal((await method.ask({})).key, "invite")
  assert.equal(await method.ask({ invite: "" }), null)
})

test("off：最新账号现场取码，新账号 OAuth 成功后 confirm-by-code", async (t) => {
  const w = workspace(t)
  seedAccounts(w)
  const calls = []
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url) === DELIVERY) return ok({ items: [{ campaignId: 7, type: "INVITE_USER" }] })
    if (String(url) === OPS_INVITE_GENERATE_URL) return ok({ inviteUrl: "https://devcloud.cn-north-4.huaweicloud.com/chat/home?invitecode=NEWEST42" })
    if (String(url).startsWith(OPS_INVITE_CONFIRM_URL)) return ok({ bound: true })
    throw new Error(`unexpected ${url}`)
  }
  const closed = { count: 0 }
  const plugin = await CodeArtsAuthPlugin({ client: {}, magpie: { option: () => false } }, {
    fetch: fetcher,
    inviteCacheDir: w.cacheDir,
    inviteAuthFile: w.authFile,
    inviteLoginsFile: w.loginsFile,
    loginMethod: loginMethod(credential("AK-LOGIN", "new-user"), closed),
  })
  const method = plugin.auth.methods[0]
  await method.ask({})
  assert.equal(await method.ask({ invite: "" }), null)
  const generated = calls.find((c) => c.url === OPS_INVITE_GENERATE_URL)
  assert.equal(accessKeyOf(generated.init), "AK-NEW", "关闭=最新注册账号，不是最老账号")
  assert.deepEqual(JSON.parse(new TextDecoder().decode(generated.init.body)), { campaignId: "7", channel: "WEB" })

  const authorization = await method.authorize({ invite: "" })
  const result = await authorization.callback()
  assert.equal(result.type, "success")
  const confirmed = calls.find((c) => c.url.startsWith(OPS_INVITE_CONFIRM_URL))
  assert.equal(confirmed.url, `${OPS_INVITE_CONFIRM_URL}?inviteCode=NEWEST42`)
  assert.equal(confirmed.init.method, "POST")
  assert.equal("body" in confirmed.init, false)
  assert.equal(accessKeyOf(confirmed.init), "AK-LOGIN", "确认必须用新登录账号的凭据")
  assert.equal(closed.count, 1)
  assert.equal(readInviteState({ cacheDir: w.cacheDir }).accounts["new-user"].uid, "new-user")
})

test("on：运行时 magpie.option=true 只取 Make first，不静默换最新账号", async (t) => {
  const w = workspace(t)
  seedAccounts(w, [{ agent: "plugin:codearts", home: "codearts", first: true }])
  const calls = []
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url) === DELIVERY) return ok({ items: [{ id: 9, type: "invite_user" }] })
    if (String(url) === OPS_INVITE_GENERATE_URL) return ok({ inviteCode: "FIRST42" })
    throw new Error(`unexpected ${url}`)
  }
  const plugin = await CodeArtsAuthPlugin({ client: {}, magpie: { option: (provider, key) => provider === "codearts" && key === "invite_mode" } }, {
    fetch: fetcher,
    inviteCacheDir: w.cacheDir,
    inviteAuthFile: w.authFile,
    inviteLoginsFile: w.loginsFile,
  })
  await plugin.auth.methods[0].ask({ invite: "" })
  const generated = calls.find((c) => c.url === OPS_INVITE_GENERATE_URL)
  assert.equal(accessKeyOf(generated.init), "AK-OLD")
  assert.deepEqual(JSON.parse(new TextDecoder().decode(generated.init.body)), { campaignId: "9", channel: "WEB" })
  assert.equal(calls.filter((c) => c.url === OPS_INVITE_GENERATE_URL).length, 1)
})

test("手填预留码直接确认；上游拒绝邀请也不让 OAuth 失败", async (t) => {
  const w = workspace(t)
  fs.writeFileSync(w.authFile, "{}")
  fs.writeFileSync(w.loginsFile, "[]")
  const calls = []
  const warnings = []
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return new Response("invite rejected", { status: 409 })
  }
  const plugin = await CodeArtsAuthPlugin({ client: { app: { log: (entry) => warnings.push(entry) } } }, {
    fetch: fetcher,
    inviteCacheDir: w.cacheDir,
    inviteAuthFile: w.authFile,
    inviteLoginsFile: w.loginsFile,
    loginMethod: loginMethod(credential("AK-LOGIN", "new-user"), { count: 0 }),
  })
  const authorization = await plugin.auth.methods[0].authorize({ invite: "RESERVED42" })
  const result = await authorization.callback()
  assert.equal(result.type, "success")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${OPS_INVITE_CONFIRM_URL}?inviteCode=RESERVED42`)
  assert.equal(readInviteState({ cacheDir: w.cacheDir }).reserved.code, "RESERVED42")
  assert.equal(warnings.length, 1)
})

test("已有账号重新登录：不再确认邀请，只有新注册账号才建立关系", async (t) => {
  const w = workspace(t)
  seedAccounts(w)
  let calls = 0
  const fetcher = async () => { calls++; throw new Error("旧账号重登不应打邀请接口") }
  const plugin = await CodeArtsAuthPlugin({ client: {} }, {
    fetch: fetcher,
    inviteCacheDir: w.cacheDir,
    inviteAuthFile: w.authFile,
    inviteLoginsFile: w.loginsFile,
    loginMethod: loginMethod(credential("AK-OLD", "old"), { count: 0 }),
  })
  const authorization = await plugin.auth.methods[0].authorize({ invite: "RESERVED42" })
  const result = await authorization.callback()
  assert.equal(result.type, "success")
  assert.equal(calls, 0)
})
