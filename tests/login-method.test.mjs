// 登录入口抽象（src/login-method.mjs）的测试。
//
// 守护「内置登录」的插槽：两个 provider 都必须能通过 options 换掉登录实现，
// 而默认仍是浏览器（弹浏览器是回退选项）。

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { chooseLoginMethod, createBrowserLogin, createBuiltinLogin, LOGIN_KIND_BROWSER, LOGIN_KIND_BUILTIN } from "../src/login-method.mjs"
import { OfficeAceAuthPlugin } from "../index.mjs"
import { CodeArtsAuthPlugin } from "../src/codearts/index.mjs"

test("chooseLoginMethod：默认浏览器，builtin 有实现就用它，没有就回退浏览器", () => {
  const browser = { kind: LOGIN_KIND_BROWSER, start: () => "browser" }
  const builtin = { kind: LOGIN_KIND_BUILTIN, start: () => "builtin" }

  assert.equal(chooseLoginMethod({ browser }).start(), "browser")
  assert.equal(chooseLoginMethod({ browser, builtin, kind: LOGIN_KIND_BUILTIN }).start(), "builtin")
  assert.equal(chooseLoginMethod({ browser, kind: LOGIN_KIND_BUILTIN }).start(), "browser", "没有内置实现 → 回退浏览器")
  assert.equal(chooseLoginMethod({ builtin }).start(), "builtin")
  assert.throws(() => chooseLoginMethod({}), /no login method/)
})

test("createBrowserLogin / createBuiltinLogin：包住 start，并记下 kind", () => {
  const b = createBrowserLogin(async () => ({ url: "u" }))
  const i = createBuiltinLogin(async () => ({ url: "i" }))
  assert.equal(b.kind, "browser")
  assert.equal(i.kind, "builtin")
  assert.throws(() => createBrowserLogin(null), TypeError)
  assert.throws(() => createBuiltinLogin(null), TypeError)
})

test("OfficeAce：loginKind=builtin 时走内置登录（不再用浏览器）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-login-"))
  let browserCalls = 0
  let builtinCalls = 0
  const plugin = await OfficeAceAuthPlugin(
    {},
    {
      authFile: path.join(dir, "plugin-auth.json"), // 空的：没有可复用的凭据
      beginLogin: async () => {
        browserCalls += 1
        throw new Error("should not use the browser")
      },
      loginKind: "builtin",
      builtinLogin: createBuiltinLogin(async () => {
        builtinCalls += 1
        return { url: "https://builtin.example/login", result: new Promise(() => {}) }
      }),
    },
  )
  const a = await plugin.auth.methods[0].authorize()
  assert.equal(a.url, "https://builtin.example/login")
  assert.equal(builtinCalls, 1)
  assert.equal(browserCalls, 0)
})

test("CodeArts：options.loginMethod 换掉浏览器登录，接口不变", async () => {
  let calls = 0
  const plugin = await CodeArtsAuthPlugin(
    {},
    {
      ledgerPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ca-login-")), "ledger.json"),
      loginMethod: {
        kind: "builtin",
        start: async () => {
          calls += 1
          return { loginUrl: "https://builtin.example/codearts", instructions: "builtin", result: new Promise(() => {}), close: async () => {} }
        },
      },
    },
  )
  const a = await plugin.auth.methods[0].authorize()
  assert.equal(a.url, "https://builtin.example/codearts")
  assert.equal(calls, 1)
})
