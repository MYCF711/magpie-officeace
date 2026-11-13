import test from "node:test"
import assert from "node:assert/strict"

import { beginLogin } from "../src/login.mjs"
import { STATE_PATH } from "../src/constants.mjs"

test("beginLogin.close：隔离窗口启动失败后取消轮询，不再请求授权码", async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).endsWith(STATE_PATH)) {
      return new Response(JSON.stringify({ state: "test-state" }), { status: 200 })
    }
    throw new Error(`close 后不应再请求 ${url}`)
  }
  try {
    const flow = await beginLogin()
    assert.equal(typeof flow.close, "function")
    flow.close()
    flow.close()
    await assert.rejects(flow.result, /登录已取消/)
    assert.equal(calls.length, 1, "只登记 state；close 后一次 code 轮询都没有")
  } finally {
    globalThis.fetch = original
  }
})
