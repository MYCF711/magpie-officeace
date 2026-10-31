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
//   · 一切失败都静默：不抛、不拖慢登录/额度/聊天。

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
  } catch {}
}

function updateLockPath(cacheDir) {
  return join(cacheDir, `${STATE_PREFIX}-update.lock`)
}

function lockHeld(cacheDir, now) {
  try {
    const v = JSON.parse(readFileSync(updateLockPath(cacheDir), "utf8"))
    return now - Number(v?.at || 0) < LOCK_MS
  } catch {
    return false
  }
}

function takeLock(cacheDir, now) {
  try {
    writeJsonAtomic(updateLockPath(cacheDir), { pid: process.pid, at: now })
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
    child.on?.("exit", (code) => {
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
    return { started: true, waiting }
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
