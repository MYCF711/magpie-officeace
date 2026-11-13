// 模型别名去重 + 账号可读名（不发网络请求）。

import test from "node:test"
import assert from "node:assert/strict"

import { _internal as C } from "../src/codearts/index.mjs"
import { _internal as O } from "../index.mjs"

const model = (id, extra = {}) => ({ id, name: id, ...extra })

test("dedupeAliases：没有 benefit 匹配时保留日期后缀 id", () => {
  const out = C.dedupeAliases([model("deepseek-v4.1-flash-1017"), model("deepseek-v4.1-flash")])
  assert.deepEqual(out.map((m) => m.id), ["deepseek-v4.1-flash-1017"])
})

test("dedupeAliases：benefit 清单为空且裸 id 在前时也保留日期后缀 id", () => {
  const out = C.dedupeAliases([model("deepseek-v4.1-flash"), model("deepseek-v4.1-flash-1017")], new Set())
  assert.deepEqual(out.map((m) => m.id), ["deepseek-v4.1-flash-1017"])
})

test("dedupeAliases：账号的 benefit/注册 id 优先于裸 id", () => {
  const out = C.dedupeAliases([model("deepseek-v4-flash"), model("deepseek-v4-flash-0731")], new Set(["deepseek-v4-flash-0731"]))
  assert.deepEqual(out.map((m) => m.id), ["deepseek-v4-flash-0731"])
})

test("dedupeAliases：benefit 指定裸 id 时仍保留裸 id", () => {
  const out = C.dedupeAliases([model("deepseek-v4.1-flash-1017"), model("deepseek-v4.1-flash")], new Set(["deepseek-v4.1-flash"]))
  assert.deepEqual(out.map((m) => m.id), ["deepseek-v4.1-flash"])
})

test("dedupeAliases：不同模型不受影响", () => {
  const out = C.dedupeAliases([model("glm-5.3"), model("glm-5.3-flash"), model("kimi-k3")])
  assert.deepEqual(out.map((m) => m.id).sort(), ["glm-5.3", "glm-5.3-flash", "kimi-k3"].sort())
})

test("shortAccountName / shortUserName：手机号优先，URN 只留尾 6 位", () => {
  assert.equal(C.shortAccountName({ user_phone: "138****8000" }), "138****8000")
  assert.match(C.shortAccountName({ accountId: "fedcba9876543210fedcba9876543210" }), /…543210$/)
  assert.equal(C.shortAccountName({ accountId: "iam::fedcba9876543210fedcba9876543210" }), "…543210")
  assert.equal(O.shortUserName({ accountId: "fedcba9876543210fedcba9876543210" }), "…543210")
})
