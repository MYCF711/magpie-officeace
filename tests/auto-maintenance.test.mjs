// 自动更新：waiting 匹配、updated 记录、无更新/未找到 exe 时不动作。

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { kick, noteUpdated, pickSelfUpdate, readAutoState } from "../src/auto-maintenance.mjs"

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "oa-auto-"))

test("pickSelfUpdate：只认本包（git）", () => {
  const waiting = [
    { package: "Other", git: true, version: "a", latest: "b" },
    { package: "华为云 HUAWEI", git: true, version: "a", latest: "b" },
  ]
  assert.equal(pickSelfUpdate(waiting)?.package, "华为云 HUAWEI")
  assert.equal(pickSelfUpdate([{ package: "officeace-auth", git: false }]), null)
})

test("noteUpdated：写 updated[]，同 from/to 24 小时内不重复", () => {
  const dir = temp()
  fs.writeFileSync(path.join(dir, "plugin-updates.json"), JSON.stringify({ checked: "", waiting: [], updated: [] }))
  assert.equal(noteUpdated("华为云 HUAWEI", "a", "b", { dir }), true)
  assert.equal(noteUpdated("华为云 HUAWEI", "a", "b", { dir }), true)
  const u = JSON.parse(fs.readFileSync(path.join(dir, "plugin-updates.json"), "utf8"))
  assert.equal(u.updated.length, 1)
  assert.equal(u.updated[0].package, "华为云 HUAWEI")
})

test("kick：没有 waiting → no-update，不 spawn", async () => {
  const dir = temp()
  fs.writeFileSync(path.join(dir, "plugin-updates.json"), JSON.stringify({ waiting: [] }))
  let spawned = 0
  const r = await kick({ id: "officeace" }, { dir, cacheDir: temp(), spawnFn: () => { spawned += 1 } })
  assert.equal(r.skipped, "no-update")
  assert.equal(spawned, 0)
})

test("kick：有 waiting 且找到 exe → dryRun 只报告，不 spawn", async () => {
  const dir = temp()
  fs.writeFileSync(path.join(dir, "plugin-updates.json"), JSON.stringify({
    waiting: [{ package: "华为云 HUAWEI", git: true, version: "a", latest: "b" }],
  }))
  const exe = path.join(temp(), "magpie.exe")
  fs.writeFileSync(exe, "")
  const r = await kick({ id: "officeace" }, { dir, cacheDir: temp(), exe, dryRun: true })
  assert.ok(r.wouldRun)
  assert.equal(r.waiting.latest, "b")
})

test("kick：找不到 magpie exe → 记 no-magpie-exe，不 spawn", async () => {
  const dir = temp()
  fs.writeFileSync(path.join(dir, "plugin-updates.json"), JSON.stringify({
    waiting: [{ package: "华为云 HUAWEI", git: true, version: "a", latest: "b" }],
  }))
  const cacheDir = temp()
  const r = await kick({ id: "officeace" }, { dir, cacheDir, exe: "" })
  assert.equal(r.skipped, "no-magpie-exe")
  assert.equal(readAutoState("officeace", { cacheDir }).reason, "no-magpie-exe")
})
