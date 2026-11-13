import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { OfficeAceAuthPlugin } from "../index.mjs"

test("添加其他华为云账号：已有健康凭据也直接起新 OAuth，不做复用探测", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "officeace-add-account-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const authFile = path.join(dir, "plugin-auth.json")
  const cred = {
    access: "AK-TEST-0001",
    secret: "SK-TEST-0001",
    securityToken: "ST-TEST-0001",
    expiresAt: "2031-01-01T00:00:00Z",
    refreshToken: "RT-TEST-KEEP",
    accountId: "0123456789abcdef0123456789abcdef",
    modelAppKey: "APP-KEY-TEST",
    modelAppSecret: "APP-SECRET-TEST",
    dpopPrivateJwk: null,
  }
  fs.writeFileSync(authFile, JSON.stringify({
    officeace: {
      type: "oauth",
      access: JSON.stringify(cred),
      refresh: cred.refreshToken,
      expires: Date.parse(cred.expiresAt),
      accountId: cred.accountId,
    },
  }))

  let loginCalls = 0
  let fetchCalls = 0
  let clientProbes = 0
  let isolatedCalls = 0
  const plugin = await OfficeAceAuthPlugin({}, {
    authFile,
    fetch: async () => {
      fetchCalls++
      throw new Error("添加账号不应探测已有凭据")
    },
    probeClient: async () => {
      clientProbes++
      throw new Error("添加账号不应复用客户端登录态")
    },
    beginLogin: async () => {
      loginCalls++
      return { url: "https://auth.huaweicloud.com/authui/login.html?service=add-account", result: new Promise(() => {}) }
    },
    isolatedLogin: async ({ url }) => {
      isolatedCalls++
      assert.equal(url, "https://auth.huaweicloud.com/authui/login.html?service=add-account")
      return { ok: true, close: async () => {} }
    },
  })

  const a = await plugin.auth.methods[1].authorize()
  assert.equal(a.url, "https://auth.huaweicloud.com/authui/login.html?service=add-account")
  assert.equal(a.opened, true, "opened:true 抑制宿主再次用系统浏览器打开")
  assert.equal(a.method, "auto")
  assert.equal(isolatedCalls, 1)
  assert.equal(loginCalls, 1)
  assert.equal(fetchCalls, 0)
  assert.equal(clientProbes, 0)
})

test("隔离窗口启动失败：callback 如实失败，不退回日常浏览器，并取消轮询", async () => {
  let loginClosed = 0
  const plugin = await OfficeAceAuthPlugin({}, {
    authFile: path.join(os.tmpdir(), "officeace-no-such-auth-file.json"),
    beginLogin: async () => ({
      url: "https://auth.huaweicloud.com/authui/login.html",
      result: new Promise(() => {}),
      close: () => { loginClosed++ },
    }),
    isolatedLogin: async () => ({ ok: false, error: "未找到 Chromium", close: async () => {} }),
  })
  const a = await plugin.auth.methods[1].authorize()
  assert.equal(a.url, "https://auth.huaweicloud.com/authui/login.html")
  assert.equal(a.opened, true)
  assert.deepEqual(await a.callback(), { type: "failed", error: "未找到 Chromium" })
  assert.equal(loginClosed, 1)
})

test("OAuth 结束后关闭本次隔离窗口", async () => {
  let closed = 0
  const plugin = await OfficeAceAuthPlugin({}, {
    authFile: path.join(os.tmpdir(), "officeace-no-such-auth-file.json"),
    beginLogin: async () => ({
      url: "https://auth.huaweicloud.com/authui/login.html",
      result: Promise.reject(new Error("登录已取消")),
    }),
    isolatedLogin: async () => ({ ok: true, close: async () => { closed++ } }),
  })
  const a = await plugin.auth.methods[1].authorize()
  assert.deepEqual(await a.callback(), { type: "failed", error: "登录已取消" })
  assert.equal(closed, 1)
})
