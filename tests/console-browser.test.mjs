// 受控浏览器（src/console-browser.mjs）的测试。
//
// 真起浏览器的那部分（窗口、CDP）在 tests 里不跑（MAGPIE_OFFICEACE_NO_BROWSER=1），
// 这里用注入的 spawn / capture 覆盖逻辑；真机验证见 tmp 的探针脚本输出。

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  cookieFileFor,
  isConsoleLoggedIn,
  loadSavedCookies,
  openConsoleWindow,
  pickHuaweiCookies,
  primeSession,
  profileDirFor,
  safeAccountKey,
  saveCookies,
  waitForLoginAndSave,
} from "../src/console-browser.mjs"

const tmpCache = () => fs.mkdtempSync(path.join(os.tmpdir(), "oa-console-"))
const envWith = (dir) => ({ ...process.env, MAGPIE_CACHE_DIR: dir, MAGPIE_OFFICEACE_NO_BROWSER: "" })

test("pickHuaweiCookies：只留 huaweicloud.com 的、值非空的 cookie", () => {
  const cookies = [
    { name: "J_SESSION_ID", value: "abc", domain: ".console.huaweicloud.com" },
    { name: "HWWAFSESID", value: "waf", domain: "console.huaweicloud.com" },
    { name: "J_SESSION_ID", value: "", domain: ".huaweicloud.com" },
    { name: "other", value: "x", domain: ".example.com" },
    { name: "notHuawei", value: "x", domain: ".nothuaweicloud.com" },
  ]
  const picked = pickHuaweiCookies(cookies)
  assert.deepEqual(picked.map((c) => c.name), ["J_SESSION_ID", "HWWAFSESID"])
})

test("isConsoleLoggedIn：只有非空的 J_SESSION_ID 才算登录", () => {
  assert.equal(isConsoleLoggedIn([{ name: "J_SESSION_ID", value: "x" }]), true)
  assert.equal(isConsoleLoggedIn([{ name: "J_SESSION_ID", value: "" }]), false)
  assert.equal(isConsoleLoggedIn([{ name: "HWWAFSESID", value: "x" }]), false)
  assert.equal(isConsoleLoggedIn([]), false)
})

test("账号 → 文件名/目录：安全字符，按账号分开", () => {
  assert.equal(safeAccountKey("officeace#7rt5as"), "officeace_7rt5as")
  assert.equal(safeAccountKey(""), "default")
  const env = envWith("D:\\\\cache")
  assert.match(cookieFileFor("officeace#7rt5as", env), /officeace-huawei-officeace_7rt5as\.json$/)
  assert.match(profileDirFor("officeace#7rt5as", env), /officeace-huawei-officeace_7rt5as[\\\\/]profile$/)
})

test("saveCookies / loadSavedCookies：落盘只留 Huawei cookie，能读回", () => {
  const cache = tmpCache()
  const env = envWith(cache)
  assert.equal(loadSavedCookies("officeace", env), null)

  const file = saveCookies(
    "officeace",
    [
      { name: "J_SESSION_ID", value: "abc", domain: ".console.huaweicloud.com" },
      { name: "x", value: "y", domain: ".example.com" },
    ],
    env,
  )
  assert.ok(fs.existsSync(file))
  const j = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(j.cookies.length, 1)
  assert.equal(j.cookies[0].name, "J_SESSION_ID")
  assert.equal(loadSavedCookies("officeace", env).cookies[0].value, "abc")
})

test("openConsoleWindow：MAGPIE_OFFICEACE_NO_BROWSER=1 时返回 ok:false（回退系统浏览器）", async () => {
  const r = await openConsoleWindow({ accountKey: "officeace", env: { ...process.env, MAGPIE_OFFICEACE_NO_BROWSER: "1" } })
  assert.deepEqual(r, { ok: false, reason: "disabled" })
})

test("openConsoleWindow：持久 profile（同一个账号第二次用同一个 --user-data-dir）", async () => {
  const cache = tmpCache()
  const env = envWith(cache)
  const spawned = []
  const deps = {
    browser: "C:\\\\fake\\\\chrome.exe",
    freePort: async () => 12345,
    spawn: (exe, args) => {
      spawned.push({ exe, args })
      return { pid: 4242, kill() {} }
    },
  }
  const a = await openConsoleWindow({ accountKey: "officeace#abc", env, deps })
  const b = await openConsoleWindow({ accountKey: "officeace#abc", env, deps })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  const dirA = spawned[0].args.find((x) => x.startsWith("--user-data-dir="))
  const dirB = spawned[1].args.find((x) => x.startsWith("--user-data-dir="))
  assert.equal(dirA, dirB, "同一个账号用同一个持久 profile")
  assert.ok(dirA.includes("officeace-huawei-officeace_abc"), dirA)
  assert.ok(spawned[0].args.some((x) => x.startsWith("--remote-debugging-port=")))
  assert.equal(spawned[0].args.at(-1), "https://console.huaweicloud.com/modelarts/?region=cn-southwest-2#/model-studio/homepage")
})

test("waitForLoginAndSave：登录后（J_SESSION_ID 有值）才保存 cookie", async () => {
  const cache = tmpCache()
  const env = envWith(cache)
  let calls = 0
  const result = await waitForLoginAndSave(12345, "officeace", {
    env,
    timeoutMs: 1000,
    intervalMs: 1,
    now: (() => { let t = 0; return () => (t += 10) })(),
    sleep: async () => {},
    captureCookies: async () => {
      calls += 1
      return calls < 3
        ? [{ name: "HWWAFSESID", value: "waf", domain: ".huaweicloud.com" }]
        : [{ name: "J_SESSION_ID", value: "session", domain: ".console.huaweicloud.com" }]
    },
  })
  assert.ok(result, "登录后应返回保存结果")
  assert.equal(result.cookies[0].value, "session")
  assert.equal(calls, 3)
  assert.equal(loadSavedCookies("officeace", env).cookies[0].value, "session")
})

test("waitForLoginAndSave：一直没登录 → 超时返回 null，不落盘", async () => {
  const cache = tmpCache()
  const env = envWith(cache)
  const result = await waitForLoginAndSave(12345, "officeace", {
    env,
    timeoutMs: 5,
    intervalMs: 1,
    now: (() => { let t = 0; return () => (t += 10) })(),
    sleep: async () => {},
    captureCookies: async () => [{ name: "HWWAFSESID", value: "waf", domain: ".huaweicloud.com" }],
  })
  assert.equal(result, null)
  assert.equal(loadSavedCookies("officeace", env), null)
})

test("primeSession：把保存的 cookie 注入 page target，再导航（先种 cookie 再开页面）", async () => {
  const cache = tmpCache()
  const env = envWith(cache)
  saveCookies("officeace", [
    { name: "J_SESSION_ID", value: "saved-session", domain: ".huaweicloud.com", path: "/" },
    { name: "SessionID", value: "saved2", domain: ".huaweicloud.com", path: "/" },
  ], env)
  const calls = []
  const deps = {
    getJson: async () => [{ type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://page" }],
    cdp: async (ws, method, params) => {
      calls.push({ ws, method, params })
      return method === "Network.setCookie" ? { success: true } : {}
    },
  }
  const r = await primeSession({ port: 1234 }, { accountKey: "officeace", url: "https://console.huaweicloud.com/x", env }, deps)
  assert.deepEqual(r, { injected: 2, navigated: true })
  const set = calls.filter((c) => c.method === "Network.setCookie")
  assert.equal(set.length, 2)
  assert.equal(set[0].params.domain, ".huaweicloud.com")
  const nav = calls.find((c) => c.method === "Page.navigate")
  assert.equal(nav.params.url, "https://console.huaweicloud.com/x")
  assert.ok(set.every((c) => c.ws === "ws://page"), "必须走 page target（浏览器级没有 Network 域）")
})

test("primeSession：没有保存过 cookie → 不注入，也要导航", async () => {
  const env = envWith(tmpCache())
  const calls = []
  const deps = {
    getJson: async () => [{ type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://page" }],
    cdp: async (ws, method, params) => { calls.push({ method, params }); return {} },
  }
  const r = await primeSession({ port: 1234 }, { accountKey: "nobody", url: "https://console.huaweicloud.com/x", env }, deps)
  assert.deepEqual(r, { injected: 0, navigated: true })
  assert.equal(calls.filter((c) => c.method === "Network.setCookie").length, 0)
})
