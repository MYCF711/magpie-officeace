// src/isolated-login.mjs —— 认证入口的「隔离浏览器」启动器
//
// ═══════════════════════════════════════════════════════════════════
// 为什么需要它（对应 Issue #31 的第二入口）
// ═══════════════════════════════════════════════════════════════════
//
// 华为云 OAuth 的授权页如果落在**用户日常浏览器**里，日常会话已经登录过，
// 加号点下去会**直接跳过登录**、换回旧账号的 code —— 用户以为自己加了新号，
// 实际还是原来那个。第二入口「添加其他华为云账号」要真的能加号，就必须每点
// 一次开一份**干净的浏览器配置**：
//
//   · 每次调用新建一个 os.tmpdir() 下的唯一目录当 user-data-dir（mkdtemp 保证唯一）
//   · 绝不读、不复制、不删除日常 profile / Cookie / LocalStorage
//   · 只把授权 URL 交给这个进程；**不开放任何调试端口**（不需要，也不该开），
//     也不复用 console-browser 里「连 CDP 取 Cookie」的持久 profile 通路
//   · 返回一个句柄给 callback 的 finally：关掉**本次**启动的进程 + 删掉本次的目录
//
// 设计边界（每一条都有 tests/isolated-login.test.mjs 钉住）：
//   · authorize 只需要「马上把窗口打开」：这里只等到进程真正起来（毫秒级），
//     **绝不等用户登录** —— 等用户是 callback 的事。
//   · 只能 kill 自己 spawn 出来的 child；绝不做按进程名 / 按端口的批量清理。
//   · 启动失败（没浏览器 / spawn 抛错 / ENOENT / 启动超时 / 中途取消）一律先清垃圾，
//     再返回 ok:false 的句柄；失败句柄与成功句柄同形，close() 重复调用安全。
//   · 不留常驻定时器：启动计时器在 settle 时清掉；close 里等退出用的计时器有界且清掉。
//   · 临时目录**不指向日常 profile**：mkdtemp 落在 tmpdir，且落点会被 isDailyProfilePath
//     复核一遍；万一指向日常 profile（含 officeace 自己的持久控制台 profile），
//     直接拒绝启动，并且**绝不删除**那个目录。
//
// 与 src/console-browser.mjs 的分工（别混）：
//   · console-browser  = 登录完成**之后**打开 MaaS/AgentArts 控制台，用**持久** profile
//     复用 J_SESSION_ID，并且靠 --remote-debugging-port + CDP 抓 Cookie；
//   · 本模块            = 登录**之前**打开 OAuth 授权页，用**一次性** profile，不开调试端口。
//     两者唯一共用的是「发现本机 Chromium 路径」这一条（findBrowser）。

import { spawn as nodeSpawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir as osTmpdir } from "node:os"
import { basename, join } from "node:path"

// 只复用「发现浏览器路径」这一条；console-browser 的持久 profile / 取 Cookie 通路不启用。
import { findBrowser } from "./console-browser.mjs"

const TEMP_PREFIX = "officeace-isolated-login-"
const STARTUP_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 3_000

// Chromium 的「干净启动」开关。少一个都可能弹首启/推荐页，或让扩展把会话带进来。
const REQUIRED_FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
]

/**
 * 日常浏览器 profile 的落点特征：命中即视为「不是我们的临时目录」。
 *
 * 最后一组是 officeace 自己的持久控制台 profile（console-browser.profileDirFor 的落点，
 * `~/.cache/magpie/officeace-huawei-<account>/profile`）—— 那里存着 J_SESSION_ID，
 * 拿来当一次性目录等于隔离白做，所以也按「日常 profile」拒绝。
 */
const DAILY_PROFILE_PATTERNS = [
  /[\\/]google[\\/]chrome[\\/]user data(?:[\\/]|$)/i,
  /[\\/]microsoft[\\/]edge[\\/]user data(?:[\\/]|$)/i,
  /[\\/]bravesoftware[\\/][^\\/]+[\\/]user data(?:[\\/]|$)/i,
  /[\\/]chromium[\\/]user data(?:[\\/]|$)/i,
  /[\\/]vivaldi[\\/](?:user data|default)(?:[\\/]|$)/i,
  /[\\/]360chrome[^\\/]*[\\/]user data(?:[\\/]|$)/i,
  /[\\/]tencent[\\/]qqbrowser[\\/]user data(?:[\\/]|$)/i,
  /[\\/]user data[\\/](?:default|profile \d+)(?:[\\/]|$)/i,
  /[\\/]\.config[\\/](?:google-chrome|chromium|brave-browser|microsoft-edge|vivaldi)(?:[\\/]|$)/i,
  /[\\/]library[\\/]application support[\\/](?:google[\\/]chrome|chromium|brave browser|microsoft edge|vivaldi)(?:[\\/]|$)/i,
  /[\\/]\.cache[\\/]magpie[\\/]officeace-huawei-[^\\/]+(?:[\\/]|$)/i,
]

// 本模块自己开的定时器（供测试断言「没有长驻定时器」）。
const liveTimers = new Set()

function startTimer(fn, ms) {
  const id = setTimeout(() => {
    liveTimers.delete(id)
    fn()
  }, ms)
  // 启动/关闭都在 await 这个定时器：必须 ref，否则 Linux 在假 child 或无其它句柄时
  // 会提前结束事件循环（CI 的 cancelledByParent）。settle/close 一定清掉，不会长驻。
  liveTimers.add(id)
  return id
}

function stopTimer(id) {
  if (id === null || id === undefined) return
  clearTimeout(id)
  liveTimers.delete(id)
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 统一成分隔符、去尾斜杠、小写，用于跨平台比路径。 */
function normalizePath(value) {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase()
}

function isInside(child, parent) {
  const c = normalizePath(child)
  const p = normalizePath(parent)
  if (c === "" || p === "") return false
  return c === p || c.startsWith(`${p}/`)
}

/**
 * 目标目录是不是用户的日常浏览器 profile（或 officeace 自己的持久控制台 profile）？
 * 命中就绝不能拿来当 user-data-dir，更不能删。
 *
 * @param {string} dir
 * @param {Record<string,string|undefined>} [env]
 */
export function isDailyProfilePath(dir, env = process.env) {
  if (typeof dir !== "string") return false
  const value = dir.replace(/[\\/]+$/, "")
  if (value === "") return false
  for (const key of ["USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    const home = env?.[key]
    if (typeof home === "string" && home !== "" && normalizePath(value) === normalizePath(home)) {
      return true
    }
  }
  if (DAILY_PROFILE_PATTERNS.some((re) => re.test(value))) return true
  // MAGPIE_CACHE_DIR 覆盖时，静态正则认不出来，按显式缓存根再比一次。
  const cacheRoot = String(env?.MAGPIE_CACHE_DIR || "").trim()
  if (cacheRoot !== "" && /[\\/]officeace-huawei-[^\\/]+(?:[\\/]|$)/i.test(value)) {
    return isInside(value, cacheRoot)
  }
  return false
}

/**
 * 「发现浏览器」的返回形状适配。
 *
 * ⚠ 本仓 src/console-browser.mjs 的 findBrowser 返回**字符串路径**（或 null），
 *   不是 PhanthyCode 那种 `{name, path}`；这里统一成 `{name, path}` 供调用方读 name。
 *
 * @param {{name?:string, path:string} | string | null | undefined} browser
 * @returns {{name:string, path:string} | null}
 */
export function normalizeBrowser(browser) {
  if (browser === null || browser === undefined) return null
  if (typeof browser === "string") {
    const path = browser.trim()
    return path === "" ? null : { name: basename(path), path }
  }
  if (typeof browser === "object" && typeof browser.path === "string" && browser.path.trim() !== "") {
    const path = browser.path.trim()
    return { name: typeof browser.name === "string" && browser.name !== "" ? browser.name : basename(path), path }
  }
  return null
}

/**
 * 本次启动的参数（纯函数，方便断言）。
 * 顺序固定：user-data-dir → 干净启动开关 → 授权 URL（URL 必须是最后一个非开关参数）。
 */
export function buildIsolatedArgs({ userDataDir, url } = {}) {
  if (typeof userDataDir !== "string" || userDataDir === "") {
    throw new TypeError("buildIsolatedArgs: 需要 userDataDir")
  }
  if (typeof url !== "string" || url.trim() === "") {
    throw new TypeError("buildIsolatedArgs: 需要 url")
  }
  return [`--user-data-dir=${userDataDir}`, ...REQUIRED_FLAGS, url]
}

/**
 * 用一次性 profile 打开授权页，返回清理句柄。
 *
 * ⚠ 只等「进程起来」（毫秒级），不等用户登录 —— 等用户的是 callback。
 *
 * @param {{
 *   url: string,
 *   browser?: {name?:string, path:string} | string | null,
 *   findBrowser?: (env?: Record<string,string|undefined>) => ({name?:string, path:string} | string | null),
 *   spawn?: Function,
 *   mkdtemp?: (prefix:string) => string,
 *   removeDir?: (dir:string) => void,
 *   tmpdir?: string,
 *   env?: Record<string,string|undefined>,
 *   startupTimeoutMs?: number,
 *   closeTimeoutMs?: number,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   error: string | null,
 *   browser: {name:string, path:string} | null,
 *   userDataDir: string | null,
 *   args: string[],
 *   child: object | null,
 *   pid: number | null,
 *   exited: boolean,
 *   closed: boolean,
 *   close: () => Promise<{killed:boolean, removedDir:boolean}>,
 *   cleanup: () => Promise<{killed:boolean, removedDir:boolean}>,
 * }>}
 */
export async function launchIsolatedLogin(options = {}) {
  const {
    url,
    browser: givenBrowser = null,
    findBrowser: discoverBrowser = findBrowser,
    spawn: spawnImpl = nodeSpawn,
    mkdtemp: mkdtempImpl = mkdtempSync,
    removeDir = (dir) => rmSync(dir, { recursive: true, force: true }),
    tmpdir = osTmpdir(),
    env = process.env,
    startupTimeoutMs = STARTUP_TIMEOUT_MS,
    closeTimeoutMs = CLOSE_TIMEOUT_MS,
    signal,
  } = options

  /** @type {{ok:boolean,error:string|null,browser:any,userDataDir:string|null,args:string[],child:any,exited:boolean,closed:boolean}} */
  const state = {
    ok: false,
    error: null,
    browser: normalizeBrowser(givenBrowser),
    userDataDir: null,
    args: [],
    child: null,
    exited: false,
    closed: false,
  }
  const closeResult = { killed: false, removedDir: false }
  let dirRemoved = false
  let dirKept = false
  let startupTimer = null
  let startSettled = false
  let resolveStart = () => {}
  let resolveExit = () => {}
  const startPromise = new Promise((resolve) => {
    resolveStart = resolve
  })
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve
  })

  function settleStart(result) {
    if (startSettled) return
    startSettled = true
    stopTimer(startupTimer)
    startupTimer = null
    resolveStart(result)
  }

  function removeTempDir() {
    if (dirRemoved || dirKept) return
    if (typeof state.userDataDir !== "string" || state.userDataDir === "") return
    dirRemoved = true
    try {
      removeDir(state.userDataDir)
    } catch {
      // 清理失败不阻塞登录流程：目录留在 tmp 下也不会污染日常 profile
    }
  }

  function onExit() {
    if (state.exited) return
    state.exited = true
    resolveExit()
    // 用户自己把窗口关了：顺手清掉本次的临时目录，不留垃圾。
    removeTempDir()
  }

  function onError(error) {
    const message = `启动浏览器失败：${errorText(error)}`
    state.error = message
    if (!startSettled) {
      try {
        state.child?.kill?.()
      } catch {}
      removeTempDir()
      settleStart({ ok: false, error: message })
      return
    }
    // 已经在运行之后才报错：兜底收掉，绝不留孤儿进程 / 目录。
    void close()
  }

  function onSpawn() {
    if (startSettled) return
    state.ok = true
    settleStart({ ok: true })
  }

  function onAbort() {
    const message = "登录启动已取消"
    if (!startSettled) {
      state.error = message
      try {
        state.child?.kill?.()
      } catch {}
      removeTempDir()
      settleStart({ ok: false, error: message })
      return
    }
    void close()
  }

  /** 有界等待进程退出：计时器一定被清掉，不会留下常驻定时器。 */
  async function waitExit(ms) {
    let timer = null
    const clock = new Promise((resolve) => {
      timer = startTimer(resolve, ms)
    })
    try {
      await Promise.race([exitPromise, clock])
    } finally {
      stopTimer(timer)
    }
  }

  /** 关闭本次启动的浏览器并删除本次的临时目录。幂等：重复调用只清一次。 */
  async function close() {
    if (state.closed) return closeResult
    state.closed = true
    stopTimer(startupTimer)
    startupTimer = null
    if (typeof signal?.removeEventListener === "function") {
      signal.removeEventListener("abort", onAbort)
    }
    if (!startSettled) settleStart({ ok: false, error: state.error ?? "登录启动已取消" })

    const child = state.child
    // 只处理「确实起起来过」的进程：spawn 失败时没有进程可杀（超时分支已自行收掉）。
    if (state.ok && child && !state.exited && child.exitCode === null && typeof child.kill === "function") {
      try {
        child.kill()
        closeResult.killed = true
        await waitExit(closeTimeoutMs)
        if (!state.exited && child.exitCode === null) {
          try {
            child.kill("SIGKILL")
          } catch {}
        }
      } catch {
        // kill 失败也要继续删目录
      }
    }
    removeTempDir()
    try {
      child?.removeListener?.("exit", onExit)
    } catch {}
    closeResult.removedDir = dirRemoved
    return closeResult
  }

  const handle = {
    get ok() {
      return state.ok
    },
    get error() {
      return state.error
    },
    get browser() {
      return state.browser
    },
    get userDataDir() {
      return state.userDataDir
    },
    get args() {
      return state.args
    },
    get child() {
      return state.child
    },
    get pid() {
      return state.child?.pid ?? null
    },
    get exited() {
      return state.exited
    },
    get closed() {
      return state.closed
    },
    close,
  }
  handle.cleanup = close

  function fail(message) {
    state.ok = false
    state.error = message
    return handle
  }

  if (typeof url !== "string" || url.trim() === "") {
    return fail("缺少授权 URL（url 必填）")
  }

  const browser = state.browser ?? normalizeBrowser(discoverBrowser(env))
  state.browser = browser
  if (!browser) {
    return fail("没有找到可用的 Chromium 浏览器：请先装 Chrome / Edge / Chromium 之一")
  }

  let userDataDir
  try {
    userDataDir = mkdtempImpl(join(tmpdir, TEMP_PREFIX))
  } catch (error) {
    return fail(`临时 profile 目录创建失败：${errorText(error)}`)
  }
  state.userDataDir = userDataDir

  if (isDailyProfilePath(userDataDir, env)) {
    // 只拒绝，不删除 —— 那个目录属于用户的日常浏览器 / 持久控制台 profile。
    dirKept = true
    return fail(`拒绝把日常浏览器 profile 当临时目录使用：${userDataDir}`)
  }

  let args
  try {
    args = buildIsolatedArgs({ userDataDir, url })
  } catch (error) {
    removeTempDir()
    return fail(errorText(error))
  }
  state.args = args

  let child
  try {
    child = spawnImpl(browser.path, args, { stdio: "ignore", windowsHide: false })
  } catch (error) {
    removeTempDir()
    return fail(`启动浏览器失败：${errorText(error)}`)
  }
  if (!child || typeof child.once !== "function" || typeof child.on !== "function") {
    removeTempDir()
    return fail("启动浏览器失败：没有拿到子进程句柄")
  }
  state.child = child

  child.once("spawn", onSpawn)
  child.once("error", onError)
  child.on("exit", onExit)

  startupTimer = startTimer(() => {
    startupTimer = null
    const message = `浏览器启动超时（${startupTimeoutMs}ms）`
    state.error = message
    try {
      child.kill()
    } catch {}
    removeTempDir()
    settleStart({ ok: false, error: message })
  }, startupTimeoutMs)

  if (signal) {
    if (signal.aborted) onAbort()
    else if (typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true })
    }
  }

  const started = await startPromise
  if (!started.ok) {
    // 各失败分支已经清过；这里兜底一次（removeTempDir 幂等），并把 abort 监听摘掉。
    removeTempDir()
    if (typeof signal?.removeEventListener === "function") {
      signal.removeEventListener("abort", onAbort)
    }
    if (!state.error) state.error = started.error ?? "启动浏览器失败"
    return handle
  }
  return handle
}

export const _internal = {
  TEMP_PREFIX,
  REQUIRED_FLAGS,
  STARTUP_TIMEOUT_MS,
  CLOSE_TIMEOUT_MS,
  DAILY_PROFILE_PATTERNS,
  activeTimers: () => liveTimers.size,
  isDailyProfilePath,
  buildIsolatedArgs,
  normalizeBrowser,
}
