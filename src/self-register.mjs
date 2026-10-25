// 自注册：把本插件写进 magpie 的市场缓存
//
// ═══════════════════════════════════════════════════════════════════
// 问题
// ═══════════════════════════════════════════════════════════════════
//
// magpie 的插件卡片上，「源码」按钮和卡片标题来自
// ~/.cache/magpie/plugin-market.json —— magpie 的社区插件列表缓存。
//
// 包不在那个列表里 ⇒ 卡片标题退回包名，没有源码按钮。
//
// ═══════════════════════════════════════════════════════════════════
// 做法：写一次，然后什么都不做
// ═══════════════════════════════════════════════════════════════════
//
// 实测（2026-10-25）：
//
//   手工往缓存里加一条 → 等 10 秒 → 没被覆盖
//   再跑 plugin update → 也没被覆盖
//   连续观察 3 分钟     → mtime 零变化
//
// magpie 只在启动时重写这个文件，静默运行期间完全不碰。
//
// 所以插件加载时写一次就够了。
//
// ⚠ 绝对不要用 fs.watch 或 setInterval 去「补」——
//   实测那样会死循环：我们写文件（rename）触发自己的 watch，
//   watch 又写，每秒 3-4 次，日志刷屏。
//
// ═══════════════════════════════════════════════════════════════════
// 多插件共存
// ═══════════════════════════════════════════════════════════════════
//
// 两个插件同时加载时，各自的读-改-写会互相覆盖。
// 所以写完要读回来验证自己的条目还在，不在就重试。
//
// ═══════════════════════════════════════════════════════════════════

import fs from "node:fs"
import path from "node:path"
import os from "node:os"

/** 官方 registry 的地址（缓存丢了时的兜底）*/
const OFFICIAL_REGISTRY =
  "https://raw.githubusercontent.com/magpie-community/plugins/main/registry.json"

/**
 * 从 magpie 的配置目录推出它的缓存目录。
 *
 * 插件的 directory 是 magpie 的 config folder（~/.config/magpie）。
 * XDG 规则下 cache 和 config 平级。
 */
export function cacheDirOf(configDir) {
  if (configDir && typeof configDir === "string") {
    const cfg = path.resolve(configDir)
    const guess = path.join(path.dirname(path.dirname(cfg)), ".cache", "magpie")
    if (fs.existsSync(guess)) return guess
    if (process.platform === "darwin") {
      const mac = path.join(os.homedir(), "Library", "Caches", "magpie")
      if (fs.existsSync(mac)) return mac
    }
    const xdg = process.env.XDG_CACHE_HOME
    if (xdg) return path.join(xdg, "magpie")
    return guess
  }
  const xdg = process.env.XDG_CACHE_HOME
  if (xdg) return path.join(xdg, "magpie")
  return path.join(os.homedir(), ".cache", "magpie")
}

/**
 * 把一条 registry entry 写进 magpie 的市场缓存。
 *
 * 幂等：已经有同名条目时不写盘。
 *
 * @param {object} entry  { package, name, providers?, community?, summary }
 * @param {{configDir?: string, log?: Function, timeoutMs?: number}} [opts]
 */
export async function registerSelf(entry, opts = {}) {
  const log = opts.log ?? (() => {})
  const cacheDir = cacheDirOf(opts.configDir)
  const marketPath = path.join(cacheDir, "plugin-market.json")

  // 多插件并发时重试
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await registerOnce(entry, { cacheDir, marketPath, log, timeoutMs: opts.timeoutMs })
    if (!r.ok) return r
    if (!r.changed) return r

    // 读回来验证：被别的插件覆盖了就重试
    try {
      const verify = JSON.parse(fs.readFileSync(marketPath, "utf8"))
      if (Array.isArray(verify.plugins) && verify.plugins.some((x) => x?.package === entry.package)) {
        return r
      }
    } catch {
      // 读失败也重试
    }
    await sleep(50 + attempt * 100)
  }

  return { ok: false, reason: "多次重试后仍被其它插件覆盖" }
}

/** 单次读-改-写 */
async function registerOnce(entry, { cacheDir, marketPath, log, timeoutMs = 15_000 }) {
  try {
    let current = null

    if (fs.existsSync(marketPath)) {
      try {
        current = JSON.parse(fs.readFileSync(marketPath, "utf8"))
      } catch {
        current = null
      }
    }

    if (!current || !Array.isArray(current.plugins)) {
      log("市场缓存不可用，拉官方 registry")
      const official = await fetchOfficial(timeoutMs)
      if (!official) {
        return { ok: false, reason: "拉不到官方 registry，且本地缓存也不可用" }
      }
      current = official
    }

    const snapshot = JSON.stringify(current, null, 2)

    // 原地更新：找到同名的就地替换，找不到才追加
    const idx = current.plugins.findIndex((x) => x?.package === entry.package)
    const had = idx >= 0
    if (had) {
      current.plugins[idx] = entry
    } else {
      current.plugins.push(entry)
    }

    // 内容没变就不写
    const next = JSON.stringify(current, null, 2)
    if (snapshot === next) {
      return { ok: true, total: current.plugins.length, added: false, changed: false }
    }

    fs.mkdirSync(cacheDir, { recursive: true })
    const tmp = `${marketPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 6)}`
    fs.writeFileSync(tmp, next, "utf8")
    fs.renameSync(tmp, marketPath)

    log(`已注册 ${entry.package}（${had ? "更新" : "新增"}，共 ${current.plugins.length} 条）`)
    return { ok: true, total: current.plugins.length, added: !had, changed: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log(`自注册失败：${msg}`)
    return { ok: false, reason: msg }
  }
}

/** 拉官方 registry（缓存丢了时用）*/
async function fetchOfficial(timeoutMs) {
  try {
    const r = await fetch(OFFICIAL_REGISTRY, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return null
    const j = await r.json()
    const plugins = Array.isArray(j) ? j : j?.plugins
    if (!Array.isArray(plugins)) return null
    return { version: j?.version ?? 1, plugins }
  } catch {
    return null
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 启动自注册。
 *
 * 只写一次，不等、不监听、不轮询。
 *
 * @param {object} entry
 * @param {{configDir?: string, log?: Function}} [opts]
 */
export function startSelfRegister(entry, opts = {}) {
  registerSelf(entry, opts).catch(() => {})
}

export const _internal = { cacheDirOf, OFFICIAL_REGISTRY }
