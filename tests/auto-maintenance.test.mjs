// 自动更新：waiting 匹配、updated 记录、无更新/未找到 exe 时不动作。

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { kick, noteUpdated, pickSelfUpdate, readAutoState, _internal as C } from "../src/auto-maintenance.mjs"

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "oa-auto-"))

test("pickSelfUpdate：只认本包（git）", () => {
  const waiting = [
    { package: "Other", git: true, version: "a", latest: "b" },
    { package: "magpie-officeace", git: true, version: "a", latest: "b" },
  ]
  assert.equal(pickSelfUpdate(waiting)?.package, "magpie-officeace")
  assert.equal(pickSelfUpdate([{ package: "officeace-auth", git: false }]), null)
})

test("noteUpdated：写 updated[]，同 from/to 24 小时内不重复", () => {
  const dir = temp()
  fs.writeFileSync(path.join(dir, "plugin-updates.json"), JSON.stringify({ checked: "", waiting: [], updated: [] }))
  assert.equal(noteUpdated("magpie-officeace", "a", "b", { dir }), true)
  assert.equal(noteUpdated("magpie-officeace", "a", "b", { dir }), true)
  const u = JSON.parse(fs.readFileSync(path.join(dir, "plugin-updates.json"), "utf8"))
  assert.equal(u.updated.length, 1)
  assert.equal(u.updated[0].package, "magpie-officeace")
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
    waiting: [{ package: "magpie-officeace", git: true, version: "a", latest: "b" }],
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
    waiting: [{ package: "magpie-officeace", git: true, version: "a", latest: "b" }],
  }))
  const cacheDir = temp()
  const r = await kick({ id: "officeace" }, { dir, cacheDir, exe: "" })
  assert.equal(r.skipped, "no-magpie-exe")
  assert.equal(readAutoState("officeace", { cacheDir }).reason, "no-magpie-exe")
})

// ── issue #55：孤儿锁 / 并发 spawn / 节流失效 ─────────────────────────

/** 一个等待清单 + 一个假的 magpie.exe，凑够 kick 能跑到 spawn 的条件。 */
function seed(dir) {
  fs.writeFileSync(path.join(dir, "plugin-updates.json"), JSON.stringify({
    waiting: [{ package: "magpie-officeace", git: true, version: "a", latest: "b" }],
  }))
  const exe = path.join(temp(), "magpie.exe")
  fs.writeFileSync(exe, "")
  return exe
}

/** 一个绝不存在的 PID：Windows 与 POSIX 上 `kill(pid, 0)` 都会回 ESRCH。 */
const DEAD = 999_999

test("kick：子进程已死的锁是孤儿锁，直接接管并在锁里记下接管了谁", async () => {
  const dir = temp()
  const cacheDir = temp()
  const exe = seed(dir)
  fs.writeFileSync(
    path.join(cacheDir, "officeace-auto-update.lock"),
    JSON.stringify({ pid: DEAD, child: DEAD - 1, at: Date.now() }),
  )

  let spawned = 0
  const r = await kick({ id: "officeace" }, {
    dir, cacheDir, exe,
    spawnFn: () => { spawned += 1; return { pid: DEAD - 2 } },
  })

  assert.equal(r.started, true, "孤儿锁不能把更新永久挡住")
  assert.equal(spawned, 1)
  const lock = JSON.parse(fs.readFileSync(path.join(cacheDir, "officeace-auto-update.lock"), "utf8"))
  assert.equal(lock.child, DEAD - 2, "新锁记的是更新子进程的 PID")
  assert.equal(lock.tookOver?.child, DEAD - 1, "排障时能看出接管了谁")
})

test("kick：子进程还活着的锁是真锁，不 spawn", async () => {
  const dir = temp()
  const cacheDir = temp()
  const exe = seed(dir)
  // 用当前进程的 PID 当作「还活着」的子进程
  fs.writeFileSync(
    path.join(cacheDir, "officeace-auto-update.lock"),
    JSON.stringify({ pid: process.pid, child: process.pid, at: Date.now() }),
  )

  let spawned = 0
  const r = await kick({ id: "officeace" }, {
    dir, cacheDir, exe,
    spawnFn: () => { spawned += 1; return { pid: process.pid } },
  })

  assert.equal(r.skipped, "locked")
  assert.equal(spawned, 0)
})

test("kick：spawn 之后立刻记 lastAttempt —— 子进程不 exit 也不会被再起一个", async () => {
  const dir = temp()
  const cacheDir = temp()
  const exe = seed(dir)

  // 永不 exit 的子进程（#55 现场：`magpie plugin update` 挂住）
  const hanging = () => ({ pid: DEAD - 3 })
  const first = await kick({ id: "officeace" }, { dir, cacheDir, exe, spawnFn: hanging })
  assert.equal(first.started, true)
  assert.equal(first.stateSaved, true, "状态写成功才谈得上节流")

  const second = await kick({ id: "officeace" }, { dir, cacheDir, exe, spawnFn: hanging })
  assert.equal(second.skipped, "throttled", "6 小时节流必须命中，否则每次插件重载都会再拉一轮")

  const state = readAutoState("officeace", { cacheDir })
  assert.equal(state.reason, "started")
  assert.equal(state.childPid, DEAD - 3)
})

test("lockHeld：旧格式锁（只有插件 pid、没有 child）在持有进程死后立即失效，不等 10 分钟", () => {
  const cacheDir = temp()
  // 本机 2026-11-20 留下的那把就是这种形状：{"pid": 60772, "at": ...}
  fs.writeFileSync(
    path.join(cacheDir, "officeace-auto-update.lock"),
    JSON.stringify({ pid: DEAD, at: Date.now() }),
  )
  assert.equal(C.lockHeld(cacheDir, Date.now()), false, "进程死了就是孤儿锁，与时间戳无关")

  // 持有者活着 ⇒ 10 分钟内仍然算占着
  fs.writeFileSync(
    path.join(cacheDir, "officeace-auto-update.lock"),
    JSON.stringify({ pid: process.pid, at: Date.now() }),
  )
  assert.equal(C.lockHeld(cacheDir, Date.now()), true)

  // 时间戳兜底：超过 LOCK_MS 一律作废
  fs.writeFileSync(
    path.join(cacheDir, "officeace-auto-update.lock"),
    JSON.stringify({ pid: process.pid, at: Date.now() - C.LOCK_MS - 1 }),
  )
  assert.equal(C.lockHeld(cacheDir, Date.now()), false)
})

test("pidAlive：自己活着、不存在的 PID 死了", () => {
  assert.equal(C.pidAlive(process.pid), true)
  assert.equal(C.pidAlive(DEAD), false)
  assert.equal(C.pidAlive(0), false)
  assert.equal(C.pidAlive(undefined), false)
})
