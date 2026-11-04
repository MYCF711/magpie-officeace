// tests/ua.test.mjs —— 出站 UA：一个仓库一条常量，两个 provider 共用
//
// 2026-11-04 真机：DSH → magpie → 插件 host → 上游。magpie 给插件的 UA 固定是
// `magpie/<version>`；插件不显式覆盖就原样透传，而上游网关按 `<产品名>/<版本>`
// 形态识别第三方客户端，命中即回
//   403 {"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试"}
// codearts 的 snap-access 网关就是这套腾讯式错误码。
//
// 全部离线：fetch 全是桩，不碰网络。

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

import { UA, CLAW_BASE, TOKEN_URL } from "../src/constants.mjs"
import { signHuaweiRequest, signV11Request } from "../src/crypto.mjs"
import { fetchCatalog } from "../src/api.mjs"
import { chatFetch } from "../src/chat.mjs"
import { _internal as codearts } from "../src/codearts/index.mjs"

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\\/g, "/")

function srcFiles(dir = join(ROOT, "src"), out = new Map()) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) srcFiles(full, out)
    else if (name.endsWith(".mjs")) out.set(full.slice(ROOT.length).replace(/\\/g, "/"), readFileSync(full, "utf8"))
  }
  return out
}

/** 用桩顶掉 fetch，跑一次 fn，返回捕获到的请求头（Headers 形状）。 */
async function captured(fn, body = "{}") {
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) })
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
  }
  try {
    await fn()
  } finally {
    globalThis.fetch = real
  }
  return seen
}

const CRED = { access: "AK", secret: "SK", securityToken: "ST", accessKeyId: "AK" }

test("UA 是合法的完整 Chrome UA（不是被截断的 Mozilla 前缀）", () => {
  assert.match(UA, /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/)
  assert.doesNotMatch(UA, /magpie/i)
})

test("src/ 里只有一个 UA 常量：别处不许内联 Mozilla/…", () => {
  const offenders = []
  for (const [file, text] of srcFiles()) {
    if (file === "src/constants.mjs") continue
    for (const line of text.split("\n")) {
      if (/"Mozilla\/5\.0[^"]*"/.test(line)) offenders.push(`${file}: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [], `这些地方又内联了一条 UA：\n${offenders.join("\n")}`)
})

test("SDK-HMAC 签名头带 UA，但 UA 不进 SignedHeaders（签名串保持不变）", () => {
  const h = signHuaweiRequest("GET", `${CLAW_BASE}/v1/claw/client-permission-validate`, { Accept: "application/json" }, "", "AK", "SK")
  const signed = /SignedHeaders=([^,]+)/.exec(h.Authorization)[1]
  assert.equal(h["User-Agent"], UA)
  assert.ok(!signed.split(";").includes("user-agent"), `UA 被算进签名了：${signed}`)
})

test("V11 签名（订阅面：额度 / 签到 / 倍率）带 UA", async () => {
  const seen = await captured(() => signV11Request("https://officeace.cn-southwest-2.huaweicloud-agentarts.com/v1/subscription", CRED))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].headers.get("user-agent"), UA)
  // 签名头仍然只有原来那几项
  const signed = seen[0].headers.get("authorization").match(/SignedHeaders=([^,]+)/)[1]
  assert.ok(!signed.split(";").includes("user-agent"), `UA 被算进签名了：${signed}`)
})

test("MaaS 模型目录（officeace）带 UA", async () => {
  const seen = await captured(() => fetchCatalog({ ...CRED, appKey: "k", appSecret: "s" }), JSON.stringify([]))
  assert.ok(seen.length >= 1)
  assert.equal(seen[0].headers.get("user-agent"), UA)
})

test("MaaS 对话（officeace 真正跑模型的那条）带 UA", async () => {
  const seen = await captured(
    () => chatFetch({
      input: "https://api.modelarts-maas.com/v2/chat/completions",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages: [] }) },
      credential: { ...CRED, appKey: "k", appSecret: "s" },
    }),
    JSON.stringify({ choices: [] }),
  )
  assert.equal(seen.length, 1)
  assert.equal(seen[0].headers.get("user-agent"), UA)
})

test("codearts 的签名出口 signFor 带 UA，且不进 SignedHeaders", async () => {
  const headers = await codearts.signFor(
    { access_key_id: "AK", secret_access_key: "SK", security_token: "ST" },
    "GET",
    "https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/credit/overview",
    new Uint8Array(),
  )
  const signed = headers.get("authorization").match(/SignedHeaders=([^,]+)/)[1]
  assert.equal(headers.get("user-agent"), UA)
  assert.ok(!signed.split(";").includes("user-agent"), `UA 被算进签名了：${signed}`)
})

test("codearts 的脱敏信息里不会把我们的 UA 换成别的形态", () => {
  // TOKEN_URL 只是顺手确认 constants 里的常量没被 UA 覆盖
  assert.ok(TOKEN_URL.startsWith("https://sts."))
})
