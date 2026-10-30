// 受控 Chromium：把华为云控制台的登录态（cookie）抓下来、复用
//
// ═══════════════════════════════════════════════════════════════════
// 为什么需要它
// ═══════════════════════════════════════════════════════════════════
//
// 华为云控制台是 **cookie 会话**（`J_SESSION_ID`）。插件手里的 STS 凭据是 API
// 凭证，换不成控制台会话（实测：`POST /v3.0/OS-AUTH/securitytoken/logintokens`
// 对我们的 securityToken 回 401 `The security token is invalid.`）。
//
// 所以「用登录态完成华为云登录」只能这样做：
//   1. 插件自己起一个受控 Chromium（`--remote-debugging-port` + **持久**
//      `--user-data-dir`），让用户在这个窗口里登录一次；
//   2. 登录完成后用 CDP `Storage.getCookies` 抓 `.huaweicloud.com` 的 cookie，
//      落到 `~/.cache/magpie/officeace-huawei-<account>.json`；
//   3. 以后打开 MaaS 控制台就用**同一个 profile** —— 控制台直接进，不跳
//      auth.huaweicloud.com。
//
// 拿不到浏览器 / profile 不存在 → 调用方回退到「系统浏览器 + 控制台链接」。
//
// ⚠ 只抓 `.huaweicloud.com` 的 cookie；不写用户的日常浏览器 profile。

import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"

const ENV_BROWSER_VARS = ["MAGPIE_OFFICEACE_BROWSER", "MAGPIE_LINGXI_BROWSER"]

export function cacheDir(env = process.env) {
  const explicit = String(env?.MAGPIE_CACHE_DIR || "").trim()
  if (explicit) return explicit
  return path.join(os.homedir(), ".cache", "magpie")
}

/** 账号名 → 安全的文件名（避免 `officeace#7rt5as` 这类字符进路径）。 */
export function safeAccountKey(accountKey) {
  const raw = String(accountKey ?? "").trim()
  if (!raw) return "default"
  return raw.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "default"
}

export function profileDirFor(accountKey, env = process.env) {
  return path.join(cacheDir(env), `officeace-huawei-${safeAccountKey(accountKey)}`, "profile")
}

export function cookieFileFor(accountKey, env = process.env) {
  return path.join(cacheDir(env), `officeace-huawei-${safeAccountKey(accountKey)}.json`)
}

/** 一次性的浏览器候选（Windows 固定路径 + PATH；env 覆盖优先）。 */
function envBrowserOverride(env) {
  for (const key of ENV_BROWSER_VARS) {
    const raw = String(env?.[key] || "").trim()
    if (!raw) continue
    return raw.split(";").map((s) => s.trim().replace(/^"(.*)"$/, "$1").trim()).filter(Boolean)
  }
  return []
}

export function browserCandidates(platform = process.platform, env = process.env, deps = {}) {
  const exists = deps.exists ?? ((p) => {
    try { return fs.existsSync(p) } catch { return false }
  })
  const out = []
  const seen = new Set()
  const push = (p) => {
    const k = String(p).toLowerCase()
    if (!k || seen.has(k)) return
    seen.add(k)
    out.push(p)
  }
  for (const p of envBrowserOverride(env)) push(p) // 用户显式指定：不查存在性

  const pool = []
  if (platform === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files"
    const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"
    const local = env.LOCALAPPDATA || ""
    const wjoin = path.win32.join
    pool.push(
      wjoin(pf, "Google", "Chrome", "Application", "chrome.exe"),
      wjoin(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      ...(local ? [wjoin(local, "Google", "Chrome", "Application", "chrome.exe")] : []),
      wjoin(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      wjoin(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      wjoin(pf86, "Microsoft", "Edge", "Application", "Microsoft Edge.exe"),
      wjoin(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      ...(local ? [wjoin(local, "Chromium", "Application", "chrome.exe")] : []),
    )
    const pathVar = String(env.PATH || env.Path || "")
    for (const dir of pathVar.split(";")) {
      const d = dir.trim().replace(/^"(.*)"$/, "$1")
      if (!d || !/^[a-z]:[\\/]/i.test(d)) continue
      for (const exe of ["chrome.exe", "msedge.exe", "chromium.exe", "brave.exe"]) pool.push(wjoin(d, exe))
    }
  } else if (platform === "darwin") {
    pool.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    )
  } else {
    pool.push("google-chrome", "chromium", "chromium-browser", "microsoft-edge")
  }
  for (const p of pool) if (exists(p)) push(p)
  return out
}

export function findBrowser(env = process.env, deps = {}) {
  return browserCandidates(process.platform, env, deps)[0] ?? null
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url, timeoutMs = 2000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/** 发一条 CDP 命令（一次性 WebSocket）。 */
export function cdp(wsUrl, method, params = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let ws
    const timer = setTimeout(() => {
      try { ws?.close() } catch {}
      reject(new Error(`CDP ${method} 超时`))
    }, timeoutMs)
    try {
      ws = new WebSocket(wsUrl)
    } catch (e) {
      clearTimeout(timer)
      reject(e)
      return
    }
    ws.addEventListener("open", () => {
      try { ws.send(JSON.stringify({ id: 1, method, params })) } catch (e) { clearTimeout(timer); reject(e) }
    })
    ws.addEventListener("message", (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.id !== 1) return
      clearTimeout(timer)
      try { ws.close() } catch {}
      msg.error ? reject(new Error(msg.error.message || "CDP error")) : resolve(msg.result)
    })
    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("CDP WebSocket 连接失败"))
    })
  })
}

/** 只留 `.huaweicloud.com` 域下、值非空的 cookie。 */
export function pickHuaweiCookies(cookies) {
  return (Array.isArray(cookies) ? cookies : []).filter(
    (c) => c && String(c.value || "").length > 0 && /(^|\.)huaweicloud\.com$/i.test(String(c.domain || "").replace(/^\./, "")),
  )
}

/** 控制台是否已登录：`J_SESSION_ID` 有值（未登录时服务端会把它清空）。 */
export function isConsoleLoggedIn(cookies) {
  return (Array.isArray(cookies) ? cookies : []).some(
    (c) => c && c.name === "J_SESSION_ID" && String(c.value || "").length > 0,
  )
}

/** 读盘上保存过的 cookie（没有就是 null）。 */
export function loadSavedCookies(accountKey, env = process.env) {
  try {
    const j = JSON.parse(fs.readFileSync(cookieFileFor(accountKey, env), "utf8"))
    return Array.isArray(j?.cookies) && j.cookies.length > 0 ? j : null
  } catch {
    return null
  }
}

/** 落盘（只保留 Huawei cookie；0600）。 */
export function saveCookies(accountKey, cookies, env = process.env) {
  const picked = pickHuaweiCookies(cookies)
  const file = cookieFileFor(accountKey, env)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), cookies: picked }, null, 2), { mode: 0o600 })
  return file
}

export const CONSOLE_URL = "https://console.huaweicloud.com/modelarts/?region=cn-southwest-2#/model-studio/homepage"

/**
 * 起一个受控 Chromium（持久 profile）。
 *
 * @returns {Promise<{ok:true, port:number, child:object, profileDir:string, url:string} | {ok:false, reason:string}>}
 */
export async function openConsoleWindow({ accountKey, url = CONSOLE_URL, env = process.env, deps = {} } = {}) {
  // 无浏览器环境（CI / 测试 / 无头机器）：直接说没有，让调用方回退系统浏览器
  if (String(env?.MAGPIE_OFFICEACE_NO_BROWSER || "") === "1") return { ok: false, reason: "disabled" }
  const browser = deps.browser ?? findBrowser(env, deps)
  if (!browser) return { ok: false, reason: "no-browser" }
  const port = await (deps.freePort ?? freePort)()
  const profileDir = profileDirFor(accountKey, env)
  fs.mkdirSync(profileDir, { recursive: true })
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-features=Translate,MediaRouter",
    "--window-size=1280,900",
    url,
  ]
  const child = (deps.spawn ?? spawn)(browser, args, { stdio: "ignore", detached: false, windowsHide: false })
  return { ok: true, port, child, profileDir, url }
}

/** 抓一次浏览器里的 Huawei cookie。 */
export async function captureCookies(port, deps = {}) {
  const v = await (deps.getJson ?? getJson)(`http://127.0.0.1:${port}/json/version`, 3000)
  const r = await (deps.cdp ?? cdp)(v.webSocketDebuggerUrl, "Storage.getCookies", {})
  return pickHuaweiCookies(r?.cookies || [])
}

/**
 * 等用户在这个窗口里登录完成，然后保存 cookie。
 *
 * @returns {Promise<{cookies: Array, file: string} | null>} 超时返回 null
 */
export async function waitForLoginAndSave(port, accountKey, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000
  const intervalMs = opts.intervalMs ?? 1_500
  const now = opts.now ?? (() => Date.now())
  const sleepFn = opts.sleep ?? sleep
  const end = now() + timeoutMs
  while (now() < end) {
    try {
      const cookies = await (opts.captureCookies ?? captureCookies)(port, opts.deps ?? {})
      if (isConsoleLoggedIn(cookies)) {
        return { cookies, file: saveCookies(accountKey, cookies, opts.env ?? process.env) }
      }
    } catch {
      /* 页面还在跳转 / target 切换中，继续 */
    }
    await sleepFn(intervalMs)
  }
  return null
}

async function pageTargetOf(port, match, deps = {}) {
  const list = await (deps.getJson ?? getJson)(`http://127.0.0.1:${port}/json/list`, 2000)
  return (
    (Array.isArray(list) ? list : []).find((p) => p.type === "page" && match.test(String(p.url || ""))) ||
    (Array.isArray(list) ? list : []).find((p) => p.type === "page") ||
    null
  )
}

/**
 * 把上次保存的 cookie 注入新窗口，再导航到目标页 —— 这就是「用登录态完成登录」。
 *
 * ⚠ 必须走 page target 的 `Network.setCookie`（浏览器级的 ws 没有 Network 域）。
 *   注入后再 `Page.navigate`，否则页面已经自己跳到 auth 登录页了。
 *
 * @returns {Promise<{injected:number, navigated:boolean}>}
 */
export async function primeSession(win, { accountKey, url = CONSOLE_URL, env = process.env, timeoutMs = 15_000 } = {}, deps = {}) {
  const saved = loadSavedCookies(accountKey, env)
  const cookies = Array.isArray(saved?.cookies) ? saved.cookies : []
  const end = Date.now() + timeoutMs
  let page = null
  while (Date.now() < end) {
    page = await pageTargetOf(win.port, /huaweicloud\.com/, deps)
    if (page?.webSocketDebuggerUrl) break
    await sleep(300)
  }
  if (!page?.webSocketDebuggerUrl) return { injected: 0, navigated: false }

  let injected = 0
  for (const c of cookies) {
    try {
      const r = await (deps.cdp ?? cdp)(page.webSocketDebuggerUrl, "Network.setCookie", {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        ...(c.secure ? { secure: true } : {}),
        ...(c.httpOnly ? { httpOnly: true } : {}),
        ...(typeof c.expires === "number" && c.expires > 0 ? { expires: c.expires } : {}),
      })
      if (r?.success !== false) injected += 1
    } catch {
      /* 单个 cookie 失败不影响其余 */
    }
  }
  let navigated = false
  try {
    await (deps.cdp ?? cdp)(page.webSocketDebuggerUrl, "Page.navigate", { url })
    navigated = true
  } catch {}
  return { injected, navigated }
}

/** 关掉受控浏览器：先请它自己关闭（把 cookie 落盘），再按进程树兜底。 */
export async function closeWindow(win, deps = {}) {
  if (!win?.child) return
  try {
    const v = await (deps.getJson ?? getJson)(`http://127.0.0.1:${win.port}/json/version`, 1500)
    await (deps.cdp ?? cdp)(v.webSocketDebuggerUrl, "Browser.close", {}, 3000)
  } catch {}
  for (let i = 0; i < 10; i++) {
    if (win.child.exitCode !== null || win.child.killed) break
    await sleep(200)
  }
  try { win.child.kill() } catch {}
  if (process.platform === "win32") {
    try {
      (deps.execFileSync ?? execFileSync)("taskkill", ["/PID", String(win.child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
      })
    } catch {}
  }
}
