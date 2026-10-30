// OfficeAce 客户端登录态（src/officeace-client.mjs）的单元测试。
// 只测「读文件 + 解析 + 问 islogin」的逻辑；DPAPI 走注入替身（CI 非 Windows 也能跑）。

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  clientSessionFile,
  parseSessionCookie,
  probeClientLogin,
  readClientSession,
} from "../src/officeace-client.mjs"

test("parseSessionCookie：认 OC-DPAPI-1 与明文 JSON 两种形状", () => {
  assert.deepEqual(parseSessionCookie("OC-DPAPI-1\nAAAA"), { blobB64: "AAAA" })
  assert.deepEqual(parseSessionCookie('{"value":"abc","expires":123}'), { value: "abc", expires: 123 })
  assert.equal(parseSessionCookie(""), null)
  assert.equal(parseSessionCookie("garbage"), null)
})

test("readClientSession：DPAPI 解密出的 value 就是 oc_sid", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-client-"))
  const file = path.join(dir, "session.cookie")
  fs.writeFileSync(file, "OC-DPAPI-1\nQkxPQg==")
  const s = readClientSession({
    env: { ...process.env, OFFICEACE_USER_DATA_ROOT: dir },
    readFile: (p) => fs.readFileSync(p, "utf8"),
    decrypt: (b64) => JSON.stringify({ value: "oc-sid-value", expires: 456 }),
  })
  assert.deepEqual(s, { ocSid: "oc-sid-value", expires: 456 })
})

test("readClientSession：文件不存在 / 解密失败 → null（绝不抛）", () => {
  const env = { ...process.env, OFFICEACE_USER_DATA_ROOT: path.join(os.tmpdir(), "oa-none-" + Date.now()) }
  assert.equal(readClientSession({ env }), null)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-client-"))
  fs.writeFileSync(path.join(dir, "session.cookie"), "OC-DPAPI-1\nQkxPQg==")
  assert.equal(readClientSession({ env: { ...process.env, OFFICEACE_USER_DATA_ROOT: dir }, decrypt: () => { throw new Error("nope") } }), null)
})

test("clientSessionFile：默认指向 ~/.office-claw/session.cookie", () => {
  const p = clientSessionFile({ ...process.env, OFFICEACE_USER_DATA_ROOT: "" })
  assert.match(p.split(String.fromCharCode(92)).join("/"), /\.office-claw\/session\.cookie$/)
})

test("probeClientLogin：islogin=true → 从 userId 拆出 accountId", async () => {
  const r = await probeClientLogin({
    session: { ocSid: "abc" },
    getJson: async (url, headers) => {
      assert.equal(url, "https://127.0.0.1:3003/api/islogin")
      assert.equal(headers.Cookie, "oc_sid=abc")
      return { status: 200, json: { islogin: true, userId: "acc-1:user-1", userName: "hw1", sessionId: "sid-1" } }
    },
  })
  assert.deepEqual(r, { loggedIn: true, userId: "acc-1:user-1", accountId: "acc-1", userName: "hw1", sessionId: "sid-1" })
})

test("probeClientLogin：没登录 / 请求失败 → false / null", async () => {
  assert.deepEqual(await probeClientLogin({ session: { ocSid: "x" }, getJson: async () => ({ status: 200, json: { islogin: false } }) }), { loggedIn: false })
  assert.equal(await probeClientLogin({ session: { ocSid: "x" }, getJson: async () => { throw new Error("refused") } }), null)
  assert.equal(await probeClientLogin({ env: { ...process.env, OFFICEACE_USER_DATA_ROOT: path.join(os.tmpdir(), "oa-none-" + Date.now()) } }), null)
})
