// 模型别名去重 + 账号可读名（不发网络请求）。

import test from "node:test"
import assert from "node:assert/strict"

import { _internal as C } from "../src/codearts/index.mjs"
import { _internal as O } from "../index.mjs"

const model = (id, extra = {}) => ({ id, name: id, ...extra })

test("dedupeAliases：相差一个日期后缀的同一模型只留一个（保留裸 id）", () => {
  const out = C.dedupeAliases([model("deepseek-v4.1-flash-1017"), model("deepseek-v4.1-flash")])
  assert.deepEqual(out.map((m) => m.id), ["deepseek-v4.1-flash"])
})

test("dedupeAliases：账号的 benefit/注册 id 优先于裸 id", () => {
  const out = C.dedupeAliases([model("deepseek-v4-flash"), model("deepseek-v4-flash-0731")], new Set(["deepseek-v4-flash-0731"]))
  assert.deepEqual(out.map((m) => m.id), ["deepseek-v4-flash-0731"])
})

test("dedupeAliases：不同模型不受影响", () => {
  const out = C.dedupeAliases([model("glm-5.3"), model("glm-5.3-flash"), model("kimi-k3")])
  assert.deepEqual(out.map((m) => m.id).sort(), ["glm-5.3", "glm-5.3-flash", "kimi-k3"].sort())
})

test("shortAccountName / shortUserName：手机号优先，URN 只留尾 6 位", () => {
  assert.equal(C.shortAccountName({ user_phone: "181****0632" }), "181****0632")
  assert.match(C.shortAccountName({ accountId: "01a18be16b297c5197d8569e4be6a47f" }), /…e6a47f$/)
  assert.equal(C.shortAccountName({ accountId: "iam::01a18be16b297c5197d8569e4be6a47f" }), "…e6a47f")
  assert.equal(O.shortUserName({ accountId: "01a18be16b297c5197d8569e4be6a47f" }), "…e6a47f")
})
