// 自注册：把本插件写进 magpie 的市场缓存
//
// ═══════════════════════════════════════════════════════════════════
// 问题
// ═══════════════════════════════════════════════════════════════════
//
// magpie 的插件卡片上，「源码」按钮、许可证、卡片标题都来自
// `~/.cache/magpie/plugin-market.json` —— 那是 magpie 每 6 小时
// 从官方 registry.json 拉取并**整体替换**的缓存。
//
// 官方 registry 里没有我们的包 ⇒ 卡片只有版本和更新时间，
// 标题退回包名，没有源码按钮。
//
// ═══════════════════════════════════════════════════════════════════
// 解法（用户提出的方案，比合并 registry 简单）
// ═══════════════════════════════════════════════════════════════════
//
//   检测 plugin-market.json 存在吗
//     有 → 读出来，把我们的条目加进去（去重），写回
//     没有 → 先复制一份官方的，再加
//
// 不做「托管 registry + 环境变量」，因为：
//   - 需要用户每次改启动方式
//   - magpie 更新可能改变内置 URL
//
// ⚠ 这个补丁会在 magpie 下次拉 registry 时被覆盖。
//   所以插件**每次加载都重新打**（插件在 magpie 启动时加载一次）。
//
// ═══════════════════════════════════════════════════════════════════
// 磁：为什么能覆盖回来
// ═══════════════════════════════════════════════════════════════════
//
//   实测时序（2026-10-25）：
//     magpie 启动       18:49:47
//     手动打补丁        18:52:59
//     magpie 覆盖缓存   18:53:00   ← 启动后 3 分钟
//
//   插件也在启动时加载。谁先谁后不确定。
//   所以除了启动时打一次，还要在**首次使用时**再打一次（幂等）。
//
// ═══════════════════════════════════════════════════════════════════

import fs from "node:fs"
import path from "node:path"
import os from "node:os"

/** 官方 registry 的地址（magpie 内置的那条）*/
const OFFICIAL_REGISTRY =
  "https://raw.githubusercontent.com/magpie-community/plugins/main/registry.json"

/**
 * 从 magpie 的配置目录推出它的缓存目录。
 *
 * 文档：插件的 `directory` 就是 magpie 的 config folder（`~/.config/magpie`）。
 * XDG 规则下 cache 和 config 平级，所以 `config.parent.parent/.cache/magpie`。
 *
 * @param {string} [configDir] 插件的 directory 参数
 * @returns {string} cache 目录
 */
function cacheDirOf(configDir) {
  if (configDir && typeof configDir === "string") {
    const cfg = path.resolve(configDir)
    // ~/.config/magpie → ~/.cache/magpie
    const guess = path.join(path.dirname(path.dirname(cfg)), ".cache", "magpie")
    if (fs.existsSync(guess)) return guess
    // macOS: ~/Library/Application Support/magpie → ~/Library/Caches/magpie
    if (process.platform === "darwin") {
      const mac = path.join(os.homedir(), "Library", "Caches", "magpie")
      if (fs.existsSync(mac)) return mac
    }
    // 兜底：XDG_CACHE_HOME
    const xdg = process.env.XDG_CACHE_HOME
    if (xdg) return path.join(xdg, "magpie")
    return guess
  }
  // 完全不传就用默认
  const xdg = process.env.XDG_CACHE_HOME
  if (xdg) return path.join(xdg, "magpie")
  return path.join(os.homedir(), ".cache", "magpie")
}

/**
 * 把一条 registry entry 写进 magpie 的市场缓存。
 *
 * 幂等：多次调用只留一条。
 *
 * @param {object} entry  registry entry，形如
 *   { package, name, providers, community, summary: { en, zh } }
 * @param {{configDir?: string, log?: Function, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, reason?: string, total?: number, added?: boolean}>}
 */
export async function registerSelf(entry, opts = {}) {
  const log = opts.log ?? (() => {})
  const cacheDir = cacheDirOf(opts.configDir)
  const marketPath = path.join(cacheDir, "plugin-market.json")

  // ⚠ 重试：多个插件同时启动时，各自读-改-写会互相覆盖。
  //
  //   插件 A 读（42 条）→ 写（43 条，含 A）
  //   插件 B 读（42 条，旧的）→ 写（43 条，含 B）   ← A 没了
  //
  //   检测方法：写盘后立刻读回来，看自己的条目在不在。
  //   不在就重读重试。最多 5 次。
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await registerOnce(entry, { ...opts, cacheDir, marketPath, log })
    if (!r.ok) return r
    if (!r.changed) return r

    // 写完后验证自己的条目还在
    try {
      const verify = JSON.parse(fs.readFileSync(marketPath, "utf8"))
      if (Array.isArray(verify.plugins) && verify.plugins.some((x) => x?.package === entry.package)) {
        return r
      }
      // 被别的插件覆盖了 → 等一小会儿重试
      await sleep(50 + attempt * 100)
    } catch {
      await sleep(50 + attempt * 100)
    }
  }

  return { ok: false, reason: "多次重试后仍被其它插件覆盖" }
}

/** 单次读-改-写 */
async function registerOnce(entry, { cacheDir, marketPath, log, timeoutMs = 15_000 }) {
  try {
    let current

    if (fs.existsSync(marketPath)) {
      try {
        current = JSON.parse(fs.readFileSync(marketPath, "utf8"))
      } catch {
        current = null
      }
    }

    if (!current || !Array.isArray(current.plugins)) {
      log("市场缓存不可用，先拉官方 registry")
      const official = await fetchOfficial(timeoutMs)
      if (!official) {
        return { ok: false, reason: "拉不到官方 registry，且本地缓存也不可用" }
      }
      current = official
    }

    // 留一份原始快照，用于判断「写进去会不会有变化」
    const snapshot = JSON.stringify(current, null, 2)

    // 原地更新，不搬位置
    //
    // ⚠ 不能 filter + push —— 那会改变数组顺序，
    //   于是「内容比对」永远不相等，每次都要写盘，
    //   写盘又触发自己的 watch ⇒ 无限循环（实测一秒十几次）。
    const idx = current.plugins.findIndex((x) => x?.package === entry.package)
    const had = idx >= 0
    if (had) {
      current.plugins[idx] = entry
    } else {
      current.plugins.push(entry)
    }

    // 内容没变就不写 —— 这是终止写-触发-watch 循环的闸门
    const next = JSON.stringify(current, null, 2)
    if (snapshot === next) {
      return { ok: true, total: current.plugins.length, added: false, changed: false }
    }

    fs.mkdirSync(cacheDir, { recursive: true })
    const tmp = marketPath + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 6)
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 拉官方 registry。
 *
 * 失败静默返回 null —— 自注册不能因为网络问题让插件加载失败。
 */
async function fetchOfficial(timeoutMs) {
  try {
    const r = await fetch(OFFICIAL_REGISTRY, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) return null
    const j = await r.json()
    const plugins = Array.isArray(j) ? j : j?.plugins
    if (!Array.isArray(plugins)) return null
    return { version: j?.version ?? 1, plugins }
  } catch {
    return null
  }
}

/**
 * 启动自注册。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 为什么要四重保险
 * ═══════════════════════════════════════════════════════════════════
 *
 * 实测（2026-10-25）：
 *
 *   19:12  plugin update → 插件加载 → 自注册写入（39 条）
 *   19:13  magpie 拉 registry → 整体覆盖（38 条）   ← 被冲掉
 *
 * 只打一次**必然失效** —— magpie 拉 registry 的时机不固定。
 *
 * 所以：
 *   ① 加载时         立刻打一次
 *   ② 5 秒后         等 magpie 首次拉取完成
 *   ③ 文件变化时      magpie 一覆盖就补回来（关键）
 *   ④ 每 10 分钟      兜底，防 watch 失效
 *
 * 四条路径都幂等，重复打不会产生重复条目。
 *
 * @param {object} entry
 * @param {{configDir?: string, log?: Function, watch?: boolean}} [opts]
 */
export function startSelfRegister(entry, opts = {}) {
  const log = opts.log ?? (() => {})
  const ensure = () => {
    registerSelf(entry, opts).catch(() => {})
  }

  // ① 加载时
  ensure()

  // ② 5 秒后（等 magpie 首次拉 registry 完成）
  const t1 = setTimeout(ensure, 5_000)
  if (typeof t1.unref === "function") t1.unref()

  // ③ 监听缓存文件：被覆盖就立刻补回来
  if (opts.watch !== false) {
    const marketPath = path.join(cacheDirOf(opts.configDir), "plugin-market.json")
    let watcher = null
    let pending = null

    const attach = () => {
      try {
        watcher = fs.watch(marketPath, () => {
          // ⚠ 我们自己写的文件也会触发这个回调。
          //   靠 registerSelf 的内容比对短路来终止循环（内容没变就不写），
          //   这里只做去抖，让 magpie 的一次覆盖只引发一次检查。
          if (pending) return
          pending = setTimeout(() => {
            pending = null
            ensure()
          }, 500)
          if (typeof pending.unref === "function") pending.unref()
        })
        watcher.on("error", () => {
          // 文件被删/替换时 watch 会断，稍后重挂
          try { watcher?.close() } catch {}
          watcher = null
          const t = setTimeout(attach, 5_000)
          if (typeof t.unref === "function") t.unref()
        })
        if (typeof watcher.unref === "function") watcher.unref()
      } catch {
        // 挂不上就算了，④ 会兜底
      }
    }

    attach()

    // ④ 每 10 分钟兜底
    const t2 = setInterval(ensure, 10 * 60 * 1000)
    if (typeof t2.unref === "function") t2.unref()
  }

  log("自注册已启动（加载时 + 5 秒后 + 文件变化 + 每 10 分钟）")
}

export const _internal = { cacheDirOf, OFFICIAL_REGISTRY }
