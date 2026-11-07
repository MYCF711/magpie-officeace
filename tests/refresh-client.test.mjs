import test from "node:test"
import assert from "node:assert/strict"
import { refreshOnce } from "../src/login.mjs"
import { generateDpopKeyPair } from "../src/crypto.mjs"
import { TOKEN_URL, CLIENT_ID } from "../src/constants.mjs"

const key = await generateDpopKeyPair()
const base = {
  refreshToken: "synthetic-refresh",
  dpopPrivateJwk: key.privateJwk,
  codeVerifier: "synthetic-verifier",
  modelAppKey: "synthetic-model-key",
  modelAppSecret: "synthetic-model-secret",
}

for (const [name, extra, expected, verifier] of [
  ["旧果办记录", {}, CLIENT_ID, null],
  ["显式果办 client", { oauth_client: CLIENT_ID }, CLIENT_ID, null],
  ["CodeArts 签发的果办记录", { oauth_client: "codearts-agent" }, "codearts-agent", "synthetic-verifier"],
  ["兼容驼峰 client", { oauthClient: "codearts-agent" }, "codearts-agent", "synthetic-verifier"],
  ["兼容下划线 verifier", { oauth_client: "codearts-agent", codeVerifier: undefined, code_verifier: "legacy-verifier" }, "codearts-agent", "legacy-verifier"],
]) {
  test(name, async (t) => {
    let tokenRequests = 0
    let saved
    t.mock.method(globalThis, "fetch", async (url, init) => {
      if (String(url) !== TOKEN_URL) {
        assert.ok(saved, "STS 成功后必须先保存，再查询模型信息")
        return new Response("{}", { status: 503 })
      }
      tokenRequests++
      const body = new URLSearchParams(init.body)
      assert.equal(body.get("client_id"), expected)
      assert.equal(body.get("code_verifier"), verifier)
      assert.equal(body.get("refresh_token"), base.refreshToken)
      const proof = JSON.parse(Buffer.from(init.headers.DPoP.split(".")[0], "base64url"))
      assert.equal(proof.jwk.x, key.publicJwk.x)
      assert.equal(proof.jwk.y, key.publicJwk.y)
      return new Response(JSON.stringify({
        credentials: { access_key_id: "new-ak", secret_access_key: "new-sk", security_token: "new-st", expiration: "2030-01-01T00:00:00Z" },
        refresh_token: "new-refresh",
      }))
    })
    const current = { ...base, ...extra }
    const a = refreshOnce(current, (next) => { saved = next })
    const b = refreshOnce(current)
    assert.equal(a, b, "同一 refresh token 只发送一次续期")
    const next = await a
    assert.equal(tokenRequests, 1)
    assert.equal(next.refreshToken, "new-refresh")
    assert.equal(saved.refreshToken, "new-refresh")
    assert.deepEqual(next.dpopPrivateJwk, key.privateJwk)
    assert.equal(next.modelAppKey, base.modelAppKey)
    assert.equal(next.oauth_client, current.oauth_client)
  })
}

for (const [name, extra, message] of [
  ["缺失 verifier 不消费 token", { oauth_client: "codearts-agent", codeVerifier: undefined }, /PKCE/],
  ["未知 client 不消费 token", { oauth_client: "unknown-client" }, /不受支持/],
]) {
  test(name, async (t) => {
    t.mock.method(globalThis, "fetch", () => { throw new Error("不应发送网络请求") })
    await assert.rejects(refreshOnce({ ...base, ...extra }), message)
    assert.equal(globalThis.fetch.mock.callCount(), 0)
  })
}
