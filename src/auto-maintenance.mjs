// 插件自身的自动更新（复刻 magpie 对 @magpie-community/* 包的自动更新）
//
// ═══════════════════════════════════════════════════════════════════
// 为什么要自己复刻
// ═══════════════════════════════════════════════════════════════════
//
// `internal/plugin/updates.go`：`Official(pkg) = strings.HasPrefix(pkg, "@magpie-community/")`
// —— magpie 只对社区 scope 的包自动更新；git 源的第三方插件永远只提示
// 「有新版」，等用户点。我们不在那个 scope 里，所以由插件自己读 magpie 写好的
// `~/.config/magpie/plugin-updates.json`，确认 waiting 里有自己，再调
// `magpie plugin update`；成功后补一条 `updated[]` —— magpie 的「已自动更新」
// 徽章读的就是它（`plugin.LastUpdated()`）。
//
// ⚠ 边界（源码结论，别想当然）：
//   · 插件进程拿不到 GUI 的 HTTP 端口；`MAGPIE_ADDR` 指向 gateway。
//   · `magpie plugin update` 更新所有非路径插件并重装，不会重启正在跑的 magpie；
//     新代码下次启动才加载 —— 这是这个兜底能做到的极限。
//   · 找不到 magpie 可执行文件时只记 `no-magpie-exe`，不伪造徽章、不硬编码路径；
//     可用 `MAGPIE_EXE` 明示。
//   · 失败不抛、不拖慢登录/额度/聊天 —— 但**不再无声**：原因写进节流状态文件
//     （issue #55 之前 `writeAutoState` 的异常被 `catch {}` 吞掉，写失败等于节流失效，
//      重试间隔退化成「每次插件重载」，被当成下载风暴的放大器）。
//
// ═══════════════════════════════════════════════════════════════════
// 锁的语义（issue #55）
// ═══════════════════════════════════════════════════════════════════
//
// 锁文件写两样东西：`pid`（插件进程）与 `child`（`magpie plugin update` 子进程）。
// **判定只看子进程还在不在**，不看时间戳「自愈」：
//
//   · 子进程活着 ⇒ 真的有人在更新，`locked`；
//   · 子进程死了（或锁里根本没有 PID）⇒ 孤儿锁，立刻接管，并在新锁里记下接管了谁；
//   · 只有时间戳兜底：超过 `LOCK_MS` 的一律作废。
//
// 为什么不能只靠 `child.on("exit")` 释放：插件进程（宿主）重启时那个回调永远不执行，
// 锁会带着 5 天前的时间戳留下来，任何人读到都会以为更新还在跑 —— 这正是 #55 的现场。
// 为什么不能只靠时间戳「自愈」：10 分钟后锁虽然被当成空闲，但**并发的那次 spawn 还在跑**，
// 于是同一台机器上会同时存在多个 `plugin update`，各自全量下载一轮。

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname, basename } from "node:path"
import { execFileSync, spawn } from "node:child_process"

/** 本包在 magpie 里的名字：git 装是 package.json 的 name，npm 装是 npm 包名。 */
const PKG_NAMES = ["magpie-officeace", "officeace-auth"]
const AUTO_DIR = () => join(homedir(), ".config", "magpie")
const CACHE_DIR = () => join(homedir(), ".cache", "magpie")
const THROTTLE_MS = 6 * 3600_000 // 同一次更新失败后，6 小时内不再试
const LOCK_MS = 10 * 60_000 // 一个更新进程最多占用 10 分钟
const STATE_PREFIX = "officeace-auto"

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return fallback
  }
}

/** 原子写：先写同目录临时文件再 rename，避免把 magpie 的 JSON 写半截 */
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n")
  renameSync(tmp, path)
}

/** magpie 的 waiting 里有没有「我自己」的新版本（git 源只有 commit，没有 npm version） */
export function pickSelfUpdate(waiting, { pkgs = PKG_NAMES } = {}) {
  if (!Array.isArray(waiting)) return null
  return waiting.find((w) => w && pkgs.includes(w.package) && w.git === true) || null
}

/** 补一条「自动更新记录」—— magpie 的「已自动更新」徽章读 plugin-updates.json 的 updated[] */
export function noteUpdated(pkg, from, to, { dir = AUTO_DIR(), now = new Date() } = {}) {
  const file = join(dir, "plugin-updates.json")
  const u = readJson(file, null)
  if (!u || typeof u !== "object" || Array.isArray(u)) return false
  u.updated = Array.isArray(u.updated) ? u.updated : []
  const last = u.updated[u.updated.length - 1]
  // 同一次更新重复写会让徽章的计时一直刷新；24 小时内同 from/to 只记一次
  if (last && last.package === pkg && last.from === from && last.to === to) {
    const at = Date.parse(last.at)
    if (Number.isFinite(at) && now.getTime() - at < 24 * 3600_000) return true
  }
  u.updated.push({ package: pkg, from, to, at: now.toISOString() })
  if (u.updated.length > 20) u.updated = u.updated.slice(-20)
  writeJsonAtomic(file, u)
  return true
}

/** 自动更新的节流状态（每个 provider 一份） */
export function readAutoState(site, { cacheDir = CACHE_DIR() } = {}) {
  return readJson(join(cacheDir, `${STATE_PREFIX}-${site}.json`), {}) || {}
}

function writeAutoState(site, state, { cacheDir = CACHE_DIR() } = {}) {
  try {
    writeJsonAtomic(join(cacheDir, `${STATE_PREFIX}-${site}.json`), state)
    return true
  } catch {
    // 写失败 ⇒ 6 小时节流失效 ⇒ 每次插件重载都重试。返回值让调用方能说清这件事，
    // 而不是像 #55 之前那样把它一起吞掉。
    return false
  }
}

function updateLockPath(cacheDir) {
  return join(cacheDir, `${STATE_PREFIX}-update.lock`)
}

/** 进程还活着吗？`EPERM` = 存在但没权限发信号，仍然算活着。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === "EPERM"
  }
}

/**
 * 锁被谁占着。顺序：
 *   1. 锁里的 `child`（`magpie plugin update` 子进程）活着 ⇒ 占着；
 *   2. 只有老格式的 `pid`（插件进程）⇒ 按它的存活判断；
 *   3. 两者都没有（或读不出来）⇒ 只能按时间戳算，超时即作废。
 */
function lockHeld(cacheDir, now) {
  let v
  try {
    v = JSON.parse(readFileSync(updateLockPath(cacheDir), "utf8"))
  } catch {
    return false
  }
  if (!(now - Number(v?.at || 0) < LOCK_MS)) return false
  if (Number.isInteger(v?.child) && v.child > 0) return pidAlive(v.child)
  if (Number.isInteger(v?.pid) && v.pid > 0) return pidAlive(v.pid)
  return true
}

/**
 * 拿锁。`child` 是 `magpie plugin update` 的 PID —— 有它才判得准「还有人在更新」。
 * 上一把锁的持有者已经死了的时候，把死者的 PID 一并记进 `tookOver`，排障时能看出来。
 */
function takeLock(cacheDir, now, child = null) {
  try {
    const prev = readJson(updateLockPath(cacheDir), null)
    const rec = { pid: process.pid, at: now }
    if (Number.isInteger(child) && child > 0) rec.child = child
    const deadPid = Number.isInteger(prev?.pid) && !pidAlive(prev.pid) ? prev.pid : null
    const deadChild = Number.isInteger(prev?.child) && !pidAlive(prev.child) ? prev.child : null
    if (deadPid !== null || deadChild !== null) {
      rec.tookOver = { pid: deadPid, child: deadChild, at: Number(prev?.at || 0) || null }
    } else if (prev?.tookOver) {
      // 同一次 kick 里 spawn 之后会再写一遍（补子进程 PID）——别把接管记录冲掉
      rec.tookOver = prev.tookOver
    }
    writeJsonAtomic(updateLockPath(cacheDir), rec)
  } catch {}
}

function releaseLock(cacheDir) {
  try {
    unlinkSync(updateLockPath(cacheDir))
  } catch {}
}

/**
 * 找本机 magpie 可执行文件。顺序：
 *   1. 环境变量 MAGPIE_EXE（最可靠，给测试和自定义安装用）
 *   2. 祖父进程：插件跑在 magpie-bun.exe 里，它的父进程就是 magpie 主程序
 *   3. PATH 里的 magpie / magpie.exe / magpie-windows-amd64.exe
 * 找不到返回 ""
 */
export function findMagpieExe({ env = process.env, ppid = process.ppid, platform = process.platform } = {}) {
  const resolve = (p) => {
    if (!p || !existsSync(p)) return ""
    // magpie 的 `magpie.cmd` 只是同目录 exe 的包装；spawn 一个 .cmd 在 Windows 上还要 shell
    if (/\.(cmd|bat)$/i.test(p)) {
      for (const n of ["magpie-windows-amd64.exe", "magpie.exe"]) {
        const q = join(dirname(p), n)
        if (existsSync(q)) return q
      }
    }
    return p
  }
  if (env.MAGPIE_EXE) {
    const p = resolve(env.MAGPIE_EXE)
    if (p) return p
  }
  const exists = (p) => !!resolve(p)
  const tryExec = (cmd, args, timeout = 2500) => {
    try {
      return execFileSync(cmd, args, {
        encoding: "utf8",
        timeout,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
    } catch {
      return ""
    }
  }
  if (platform === "win32") {
    const ps = [
      "$p = Get-CimInstance Win32_Process -Filter \"ProcessId=" + Number(ppid) + "\"",
      "if ($p) { $q = Get-CimInstance Win32_Process -Filter \"ProcessId=$($p.ParentProcessId)\"; if ($q) { $q.ExecutablePath } }",
    ].join("; ")
    const out = tryExec("powershell.exe", ["-NoProfile", "-Command", ps])
    // 只认名字里带 magpie 的进程 —— 测试/宿主不在 magpie 下时可能是 bash / node
    if (exists(out) && /magpie/i.test(basename(out))) return resolve(out)
  } else {
    const out = tryExec("ps", ["-p", String(ppid), "-o", "ppid="])
    const grand = out.split(/\s+/)[0]
    if (grand) {
      const path = tryExec("ps", ["-p", grand, "-o", "comm="])
      if (exists(path) && /magpie/i.test(basename(path))) return resolve(path)
    }
  }
  for (const name of ["magpie-windows-amd64.exe", "magpie.exe", "magpie"]) {
    const lines = tryExec(platform === "win32" ? "where.exe" : "which", [name], 1500).split(/\r?\n/)
    for (const line of lines) {
      const p = line.trim()
      if (exists(p) && /magpie/i.test(basename(p))) return resolve(p)
    }
  }
  return ""
}

/**
 * 检查并（尽力）自动更新。
 * @param {{id:string}} c 站点上下文（用 c.id 存节流状态）
 * @param {{dir?:string, cacheDir?:string, pkgs?:string[], exe?:string, dryRun?:boolean, spawnFn?:Function}} opts
 * @returns {Promise<object>} 结果只用于日志/测试，不抛
 */
export async function kick(c, opts = {}) {
  const dir = opts.dir || AUTO_DIR()
  const cacheDir = opts.cacheDir || CACHE_DIR()
  const pkgs = opts.pkgs || PKG_NAMES
  try {
    const updates = readJson(join(dir, "plugin-updates.json"), null)
    const waiting = pickSelfUpdate(updates?.waiting, { pkgs })
    if (!waiting) return { skipped: "no-update" }

    const state = readAutoState(c.id, { cacheDir })
    const now = Date.now()
    if (state.done && state.done.to === waiting.latest) return { skipped: "done" }
    if (state.lastAttempt && state.latest === waiting.latest && now - state.lastAttempt < THROTTLE_MS) {
      return { skipped: "throttled" }
    }

    const exe = opts.exe !== undefined ? opts.exe : findMagpieExe(opts)
    if (!exe) {
      writeAutoState(c.id, { ...state, lastAttempt: now, latest: waiting.latest, reason: "no-magpie-exe" }, { cacheDir })
      return { skipped: "no-magpie-exe", waiting }
    }
    if (opts.dryRun) return { wouldRun: exe, waiting }
    if (lockHeld(cacheDir, now)) return { skipped: "locked", waiting }
    takeLock(cacheDir, now)

    let child
    try {
      child = (opts.spawnFn || spawn)(exe, ["plugin", "update"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: process.env,
      })
    } catch (e) {
      releaseLock(cacheDir)
      writeAutoState(c.id, { ...state, lastAttempt: now, latest: waiting.latest, reason: String(e?.message ?? e) }, { cacheDir })
      return { skipped: "spawn-failed", error: String(e?.message ?? e) }
    }

    const childPid = Number.isInteger(child?.pid) && child.pid > 0 ? child.pid : null
    // 锁里补上子进程 PID：之后不管插件进程死没死，「还有人在更新吗」都按它判断。
    takeLock(cacheDir, now, childPid)
    // **spawn 之后立刻**记 lastAttempt，而不是等 exit。子进程挂住时 exit 永不触发，
    // 旧写法下 lastAttempt 一直是空的 ⇒ 每次插件重载都再 spawn 一个 ⇒ #55 的并发风暴。
    const stateSaved = writeAutoState(
      c.id,
      { ...state, lastAttempt: now, latest: waiting.latest, reason: "started", childPid },
      { cacheDir },
    )

    // 看门狗：父进程还活着时兜住「子进程挂死」。父进程先死的情况由锁的 PID 校验处理
    // （子进程死掉后孤儿锁会被下一次 kick 直接接管）。
    let watchdog = null
    if (childPid !== null && typeof setTimeout === "function") {
      watchdog = setTimeout(() => {
        try { child.kill?.("SIGKILL") } catch {}
        releaseLock(cacheDir)
        writeAutoState(c.id, { ...state, lastAttempt: now, latest: waiting.latest, reason: "timeout" }, { cacheDir })
      }, LOCK_MS)
      watchdog.unref?.()
    }

    child.on?.("exit", (code) => {
      if (watchdog) clearTimeout(watchdog)
      releaseLock(cacheDir)
      if (code === 0) {
        noteUpdated(waiting.package, waiting.version, waiting.latest, { dir })
        writeAutoState(c.id, {
          ...state,
          lastAttempt: now,
          latest: waiting.latest,
          done: { from: waiting.version, to: waiting.latest, at: new Date().toISOString() },
        }, { cacheDir })
      } else {
        writeAutoState(c.id, { ...state, lastAttempt: now, latest: waiting.latest, reason: `exit-${code}` }, { cacheDir })
      }
    })
    child.unref?.()
    return { started: true, waiting, childPid, stateSaved }
  } catch (e) {
    return { skipped: "error", error: String(e?.message ?? e) }
  }
}

let scheduled = false

/** 插件加载时的初始化：延迟检查更新（不阻塞 config / 登录） */
export function initAutoMaintenance(c) {
  if (scheduled) return
  if (String(process.env.MAGPIE_OFFICEACE_NO_AUTO_UPDATE || "") === "1") return
  scheduled = true
  try {
    const t = setTimeout(() => {
      kick(c).catch(() => {})
    }, 20_000)
    t.unref?.()
  } catch {}
}

export const _internal = {
  LOCK_MS,
  THROTTLE_MS,
  STATE_PREFIX,
  pidAlive,
  lockHeld,
  takeLock,
  releaseLock,
  updateLockPath,
}
