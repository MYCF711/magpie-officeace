// 账号名的语义锁：手机号打码、IAM 读取、名字与身份分离。
//
// 这一块出事的样子是「卡片上三串看不懂的 domain id」，不报错、不崩，
// 用户只会以为插件坏了（真实事故：codearts 0.2.4 拿 principal_urn 当账号名）。

import { test } from "node:test"
import assert from "node:assert/strict"

import { accountIdentityOf, fetchAccountPhone, iamUserIdOf, maskPhone, profileOf } from "../src/phone.mjs"

/** 造一个华为云 STS 形状的 refresh_token（未签名，只要求 claim 可解）。 */
function refreshToken(claims = {}) {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const profile = {
    account_id: "01a1642ad2ae7f93bf6387ad2fc5f09e",
    account_name: "hw061571365626786",
    principal_id: "01a1642ad2ae7623b72d576594aaf9ba",
    principal_urn: "iam::01a1642ad2ae7f93bf6387ad2fc5f09e:user:hw061571365626786",
    ...claims,
  }
  return `h.${b64u({ user_profile: b64u(profile) })}.s`
}

function cred(extra = {}) {
  return {
    access: "AK",
    secret: "SK",
    securityToken: "ST",
    accountId: "01a1642ad2ae7f93bf6387ad2fc5f09e",
    refreshToken: refreshToken(),
    ...extra,
  }
}

test("maskPhone：0086- / +86 / 裸号 / 已打码，一律 3+4", () => {
  assert.equal(maskPhone("0086-18970098051"), "189****8051")
  assert.equal(maskPhone("+86 189 7009 8051"), "189****8051")
  assert.equal(maskPhone("18970098051"), "189****8051")
  // 已经打码的值不能被二次破坏
  assert.equal(maskPhone("181****0632"), "181****0632")
  // 不是号码形状 → 空串（由调用方回落到 accountId）
  assert.equal(maskPhone(""), "")
  assert.equal(maskPhone(undefined), "")
  assert.equal(maskPhone("123"), "")
  // 86 开头的真号不能被当成国家码砍掉头两位
  assert.equal(maskPhone("86123456789"), "123****6789")
})

test("profileOf / iamUserIdOf：从 refresh_token 的 user_profile 取 IAM 用户 id", () => {
  const c = cred()
  assert.equal(profileOf(c)?.principal_id, "01a1642ad2ae7623b72d576594aaf9ba")
  assert.equal(iamUserIdOf(c), "01a1642ad2ae7623b72d576594aaf9ba")
  // 不是 JWT / 没有 claim → 空串，别去问 IAM
  assert.equal(iamUserIdOf({ refreshToken: "opaque" }), "")
  assert.equal(iamUserIdOf({}), "")
})

test("fetchAccountPhone：用同一套 STS 三元组读 IAM，且一个进程只读一次", async () => {
  const seen = []
  const fetcher = async (url, init) => {
    seen.push([String(url), new Headers(init.headers).get("authorization"), new Headers(init.headers).get("x-security-token")])
    return new Response(JSON.stringify({ user: { name: "hw061571365626786", phone: "0086-18970098051" } }), { status: 200 })
  }
  assert.equal(await fetchAccountPhone(cred(), fetcher), "189****8051")
  assert.equal(seen.length, 1)
  assert.equal(seen[0][0], "https://iam.cn-north-4.myhuaweicloud.com/v3.0/OS-USER/users/01a1642ad2ae7623b72d576594aaf9ba")
  assert.match(String(seen[0][1]), /^SDK-HMAC-SHA256 /)
  assert.equal(seen[0][2], "ST", "临时凭据的 security token 必须带上")
  // 缓存：第二次不再发请求
  assert.equal(await fetchAccountPhone(cred(), fetcher), "189****8051")
  assert.equal(seen.length, 1)
})

test("fetchAccountPhone：没有 claim / 被拒 / 没号码 → 空串，从不抛", async () => {
  assert.equal(await fetchAccountPhone({ refreshToken: "opaque" }, async () => { throw new Error("must not be called") }), "")
  // 每个用例换一个 IAM 用户：读成功会进进程缓存，复用同一个 id 会拿到上一次的结果
  const refused = cred({ refreshToken: refreshToken({ principal_id: "uid-refused" }) })
  assert.equal(await fetchAccountPhone(refused, async () => new Response("{}", { status: 403 })), "")
  const noNumber = cred({ refreshToken: refreshToken({ principal_id: "uid-nonumber" }) })
  assert.equal(await fetchAccountPhone(noNumber, async () => new Response(JSON.stringify({ user: {} }), { status: 200 })), "")
  const threw = cred({ refreshToken: refreshToken({ principal_id: "uid-threw" }) })
  assert.equal(await fetchAccountPhone(threw, async () => { throw new Error("boom") }), "")
})

test("accountIdentityOf：accountId 是手机号，uid 是 domain id", () => {
  // 有手机号：卡片显示 189****8051，身份仍是 domain id
  assert.deepEqual(accountIdentityOf({ user_phone: "189****8051", accountId: "01a1642ad2ae7f93bf6387ad2fc5f09e" }), {
    accountId: "189****8051",
    uid: "01a1642ad2ae7f93bf6387ad2fc5f09e",
  })
  // 取不到手机号：回落到 domain id（不编造，也不隐藏）
  assert.deepEqual(accountIdentityOf({ accountId: "01a1642ad2ae7f93bf6387ad2fc5f09e" }), {
    accountId: "01a1642ad2ae7f93bf6387ad2fc5f09e",
    uid: "01a1642ad2ae7f93bf6387ad2fc5f09e",
  })
  // 什么都没有：空对象
  assert.deepEqual(accountIdentityOf({}), {})
})