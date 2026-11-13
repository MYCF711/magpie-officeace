// tests/isolated-login.test.mjs —— 认证入口的「隔离浏览器」启动器
//
// 全程假 spawn / 假 fs / 假 browser：不启动真浏览器、不读写任何真实 profile、不碰网络。
// 每个用例钉住 src/isolated-login.mjs 顶部的一条边界：
//   · 每次登录一份全新 user-data-dir（日常会话/Cookie 不会带进来）
//   · 绝不指向、绝不删除日常浏览器 profile（也含 officeace 自己的持久控制台 profile）
//   · 不开调试端口，也不复用 console-browser 的持久 profile / 取 Cookie 通路
//   · close 只杀本次启动的 child；重复 close 幂等
//   · 启动失败 / 超时 / 取消都当场清理，不留子进程与定时器
//   · 并发登录各自隔离
//
// 反面对照：src/console-browser.mjs（登录**之后**开 MaaS 控制台）是持久 profile +
// `--remote-debugging-port` + CDP 抓 Cookie；本模块（登录**之前**开授权页）必须一条都不沾。

import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const mod = await import("../src/isolated-login.mjs")
const { launchIsolatedLogin, buildIsolatedArgs, isDailyProfilePath, normalizeBrowser, _internal } = mod

const URL_AUTH = "https://auth.huaweicloud.com/authui/login.html?service=https%3A%2F%2Fexample.test%2Foauth"
const BROWSER = { name: "Chrome", path: "C:\\fake\\bin\\chrome.exe" }
// ⚠ 这里刻意不用 C:\Users\… 形状：check.mjs 会把「硬编码本机用户路径」记成警告。
const TMP_ROOT = join("C:\\fakehome", "tmp")
const ENV = {
  USERPROFILE: "C:\\fakehome\\tester",
  LOCALAPPDATA: "C:\\fakehome\\tester\\AppData\\Local",
  APPDATA: "C:\\fakehome\\tester\\AppData\\Roaming",
}
const CHROME_USER_DATA = "C:\\fakehome\\tester\\AppData\\Local\\Google\\Chrome\\User Data"
const OFFICEACE_PERSISTENT_PROFILE = "C:\\fakehome\\tester\\.cache\\magpie\\officeace-huawei-abc\\profile"

// ── 假件 ──────────────────────────────────────────────────────────────

function makeChild({ mode = "spawn", pid = 4242, exitOnKill = true } = {}) {
  const ee = new EventEmitter()
  const child = {
    pid,
    exitCode: null,
    signalCode: null,
    killed: false,
    killCount: 0,
    signals: [],
    kill(signal = "SIGTERM") {
      child.killCount += 1
      child.signals.push(signal)
      child.killed = true
      if (!exitOnKill) return true
      setImmediate(() => {
        if (child.exitCode !== null) return
        child.exitCode = 0
        child.signalCode = signal
        ee.emit("exit", 0, signal)
      })
      return true
    },
    on: (event, fn) => ee.on(event, fn),
    once: (event, fn) => ee.once(event, fn),
    removeListener: (event, fn) => ee.removeListener(event, fn),
    emitExit(code = 0, signal = null) {
      if (child.exitCode === null) {
        child.exitCode = code
        child.signalCode = signal
      }
      ee.emit("exit", code, signal)
    },
  }
  if (mode === "spawn") setImmediate(() => ee.emit("spawn", child))
  if (mode === "error") {
    setImmediate(() => {
      const error = new Error("spawn C:\\fake\\bin\\chrome.exe ENOENT")
      error.code = "ENOENT"
      ee.emit("error", error)
    })
  }
  // mode === "hung"：既不 spawn 也不 error，专门用来验证启动超时
  return child
}

function fakeSpawn({ mode = "spawn", throwError = null, exitOnKill = true } = {}) {
  const calls = []
  const spawn = (command, args, options) => {
    if (throwError) throw throwError
    const child = makeChild({ mode, exitOnKill })
    calls.push({ command, args, options, child })
    return child
  }
  return { spawn, calls }
}

function fakeFs({ firstDir = null } = {}) {
  const mkdtempCalls = []
  const removeCalls = []
  let n = 0
  const mkdtemp = (prefix) => {
    mkdtempCalls.push(prefix)
    if (firstDir) return firstDir
    n += 1
    return `${prefix}${n.toString(36)}x7k`
  }
  const removeDir = (dir) => {
    removeCalls.push(dir)
  }
  return { mkdtemp, removeDir, mkdtempCalls, removeCalls }
}

function launchWith({ fs = fakeFs(), sp = fakeSpawn(), ...options } = {}) {
  return launchIsolatedLogin({
    url: URL_AUTH,
    browser: BROWSER,
    tmpdir: TMP_ROOT,
    env: ENV,
    spawn: sp.spawn,
    mkdtemp: fs.mkdtemp,
    removeDir: fs.removeDir,
    ...options,
  })
}

// ── 参数面 ────────────────────────────────────────────────────────────

test("启动参数：四个必需开关 + 独立 user-data-dir，不开调试端口、不指定 profile-directory", () => {
  const args = buildIsolatedArgs({ userDataDir: join(TMP_ROOT, "x"), url: URL_AUTH })
  for (const flag of [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
  ]) {
    assert.ok(args.includes(flag), `缺少必需开关 ${flag}`)
  }
  assert.deepEqual(
    args.filter((a) => a.startsWith("--user-data-dir=")),
    [`--user-data-dir=${join(TMP_ROOT, "x")}`],
    "user-data-dir 只能出现一次",
  )
  assert.equal(args.at(-1), URL_AUTH, "URL 必须是最后一个非开关参数")
  assert.ok(
    args.every((a) => !/remote-debugging|inspector|devtools/i.test(a)),
    "非必要不开 CDP 调试端口",
  )
  assert.ok(args.every((a) => !a.startsWith("--profile-directory")), "不指定日常 profile 名字")
  assert.ok(args.every((a) => !a.startsWith("--disable-sync")), "不复制 console-browser 的控制台专用开关")
})

// ── 每次一份全新 profile ───────────────────────────────────────────────

test("两次登录各开一个新的 user-data-dir，且都落在临时根目录下", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn()
  const a = await launchWith({ fs, sp })
  const b = await launchWith({ fs, sp })

  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.notEqual(a.userDataDir, b.userDataDir, "两次登录不能共用 profile")
  assert.ok(a.userDataDir.startsWith(TMP_ROOT), "必须落在临时根目录")
  assert.ok(b.userDataDir.startsWith(TMP_ROOT), "必须落在临时根目录")
  assert.ok(a.userDataDir.includes("officeace-isolated-login-"), "目录名要能一眼看出用途")
  assert.equal(_internal.TEMP_PREFIX, "officeace-isolated-login-")

  assert.equal(sp.calls.length, 2, "每次登录各 spawn 一次")
  assert.equal(sp.calls[0].command, BROWSER.path)
  assert.equal(sp.calls[0].options.stdio, "ignore")
  assert.deepEqual(sp.calls[0].args, a.args)
  assert.ok(sp.calls[0].args.includes(`--user-data-dir=${a.userDataDir}`))
  assert.ok(sp.calls[1].args.includes(`--user-data-dir=${b.userDataDir}`))
  assert.equal(a.pid, sp.calls[0].child.pid)
  assert.equal(a.browser.name, "Chrome")

  await a.close()
  await b.close()
  assert.equal(_internal.activeTimers(), 0)
})

test("authorize 只等进程 spawn（毫秒级），不等用户登录：spawn 即 ok", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn({ mode: "spawn" })
  const h = await launchWith({ fs, sp })
  // 没有任何「登录完成」信号，句柄也已经可用 —— 等用户是 callback 的事。
  assert.equal(h.ok, true)
  assert.equal(h.error, null)
  assert.equal(typeof h.close, "function")
  assert.equal(_internal.activeTimers(), 0, "spawn 之后不能留定时器")
  await h.close()
})

// ── 日常 profile 边界 ──────────────────────────────────────────────────

test("user-data-dir 不落在日常浏览器 profile 里；若被指向那里，拒绝启动且绝不删除", async () => {
  // ① 正常路径：明显不是日常 profile
  const ok = await launchWith()
  assert.equal(isDailyProfilePath(ok.userDataDir, ENV), false)
  await ok.close()

  // ② 注入「日常 profile 目录」当临时目录 → 必须拒绝，且不许 spawn、不许 rm
  for (const daily of [CHROME_USER_DATA, OFFICEACE_PERSISTENT_PROFILE]) {
    const fs = fakeFs({ firstDir: daily })
    const sp = fakeSpawn()
    const denied = await launchWith({ fs, sp })
    assert.equal(denied.ok, false, `${daily} 必须被拒绝`)
    assert.match(denied.error, /日常浏览器 profile/)
    assert.equal(sp.calls.length, 0, "不能把日常 profile 交给浏览器")
    assert.deepEqual(fs.removeCalls, [], "绝不删除用户的真实 profile")
    await denied.close()
    assert.deepEqual(fs.removeCalls, [], "close 也不许删")
    assert.equal(_internal.activeTimers(), 0)
  }
})

test("isDailyProfilePath 认得各家日常 profile 与 officeace 持久控制台 profile，认不出临时目录", () => {
  for (const dir of [
    CHROME_USER_DATA,
    "C:\\fakehome\\tester\\AppData\\Local\\Microsoft\\Edge\\User Data",
    join("C:\\fakehome", "tester", "AppData", "Local", "Google", "Chrome", "User Data", "Default"),
    "/home/t/.config/google-chrome",
    "/home/t/.config/chromium",
    "/Users/t/Library/Application Support/Google/Chrome",
    OFFICEACE_PERSISTENT_PROFILE,
  ]) {
    assert.equal(isDailyProfilePath(dir, ENV), true, `应当认出：${dir}`)
  }
  for (const dir of [join(TMP_ROOT, "officeace-isolated-login-abc"), join(TMP_ROOT, "fresh-chrome")]) {
    assert.equal(isDailyProfilePath(dir, ENV), false, `不应误报：${dir}`)
  }
  // MAGPIE_CACHE_DIR 覆盖时要按显式缓存根比，而不是靠静态正则。
  const env = { ...ENV, MAGPIE_CACHE_DIR: "D:\\magpie-cache" }
  assert.equal(isDailyProfilePath("D:\\magpie-cache\\officeace-huawei-x\\profile", env), true)
  assert.equal(isDailyProfilePath("D:\\elsewhere\\officeace-huawei-x\\profile", env), false)
})

// ── close 的边界 ──────────────────────────────────────────────────────

test("close 只杀本次启动的 child，不碰另一个并发登录的浏览器", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn()
  const a = await launchWith({ fs, sp })
  const b = await launchWith({ fs, sp })

  await a.close()

  assert.equal(sp.calls[0].child.killCount, 1, "杀掉自己的 child")
  assert.equal(sp.calls[1].child.killCount, 0, "另一个登录的浏览器一律不碰")
  assert.deepEqual(fs.removeCalls, [a.userDataDir], "只删自己的目录")
  assert.equal(a.closed, true)
  assert.equal(b.closed, false)
  assert.equal(b.exited, false)

  await b.close()
  assert.equal(sp.calls[1].child.killCount, 1)
})

test("重复 close 幂等：只杀一次、只删一次，cleanup 是 close 的别名", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn()
  const h = await launchWith({ fs, sp })

  assert.equal(typeof h.cleanup, "function")
  const first = await h.close()
  const second = await h.close()
  await h.close()
  await h.cleanup()

  assert.equal(sp.calls[0].child.killCount, 1)
  assert.equal(fs.removeCalls.length, 1)
  assert.deepEqual(first, second)
  assert.deepEqual(first, { killed: true, removedDir: true })
})

test("用户自己关掉浏览器后临时目录自动清掉；随后 close 不再杀进程", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn()
  const baseline = _internal.activeTimers()
  const h = await launchWith({ fs, sp })

  sp.calls[0].child.emitExit(0, null)
  assert.equal(h.exited, true)
  assert.equal(fs.removeCalls.length, 1, "退出即清目录，不留垃圾")

  await h.close()
  assert.equal(h.closed, true)
  assert.equal(sp.calls[0].child.killCount, 0, "已经退出的进程不再 kill")
  assert.equal(fs.removeCalls.length, 1, "不重复删")
  assert.equal(_internal.activeTimers(), baseline)
})

test("关窗时进程赖着不走：有界等待后补 SIGKILL，并清掉目录与定时器", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn({ mode: "spawn", exitOnKill: false })
  const baseline = _internal.activeTimers()
  const h = await launchWith({ fs, sp, closeTimeoutMs: 20 })

  const result = await h.close()

  assert.deepEqual(sp.calls[0].child.signals, ["SIGTERM", "SIGKILL"], "先礼后兵")
  assert.equal(result.killed, true)
  assert.equal(result.removedDir, true)
  assert.equal(fs.removeCalls.length, 1)
  assert.equal(_internal.activeTimers(), baseline, "有界等待用的是会清掉的定时器")
})

test("独立 Node 进程：close 的等待定时器必须 ref，不能在 Linux 空事件循环里提前退出", () => {
  const moduleUrl = new URL("../src/isolated-login.mjs", import.meta.url).href
  const source = `
    import { EventEmitter } from "node:events";
    import { launchIsolatedLogin, _internal } from ${JSON.stringify(moduleUrl)};
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = () => true;
    const h = await launchIsolatedLogin({
      url: "https://auth.example.test/",
      browser: { name: "fake", path: "/fake" },
      spawn: () => { queueMicrotask(() => child.emit("spawn")); return child },
      startupTimeoutMs: 100,
      closeTimeoutMs: 20,
    });
    const result = await h.close();
    console.log(JSON.stringify({ killed: result.killed, timers: _internal.activeTimers() }));
  `
  // 子进程里除了 close 的 20ms 等待外没有其它句柄：unref 会让它连输出都来不及打印。
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 5000 })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(run.stdout.trim()), { killed: true, timers: 0 })
})

// ── 失败 / 超时 / 取消 ────────────────────────────────────────────────

test("spawn 报错（ENOENT）：清理临时目录、不留定时器、失败句柄的 close 仍然安全", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn({ mode: "error" })
  const baseline = _internal.activeTimers()
  const h = await launchWith({ fs, sp })

  assert.equal(h.ok, false)
  assert.match(h.error, /ENOENT|启动浏览器失败/)
  assert.deepEqual(fs.removeCalls, [h.userDataDir], "失败也要清理临时目录")
  assert.equal(_internal.activeTimers(), baseline, "不留定时器")

  const r1 = await h.close()
  const r2 = await h.close()
  assert.equal(fs.removeCalls.length, 1, "失败句柄的 close 不能重复删")
  assert.deepEqual(r1, r2)
  assert.equal(r1.killed, false, "没起来过的进程不 kill")
})

test("spawn 同步抛错：同样清理并返回失败句柄", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn({ throwError: new Error("EACCES 拒绝访问") })
  const h = await launchWith({ fs, sp })

  assert.equal(h.ok, false)
  assert.match(h.error, /EACCES/)
  assert.equal(fs.removeCalls.length, 1)
  assert.equal(h.userDataDir, fs.removeCalls[0])
})

test("启动超时有界：超时即杀掉半启动进程并清理，不遗留定时器", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn({ mode: "hung" })
  const baseline = _internal.activeTimers()
  const h = await launchWith({ fs, sp, startupTimeoutMs: 25 })

  assert.equal(h.ok, false)
  assert.match(h.error, /超时/)
  assert.equal(sp.calls[0].child.killCount, 1, "半启动的进程也要收掉")
  assert.equal(fs.removeCalls.length, 1)
  assert.equal(_internal.activeTimers(), baseline)
})

test("取消信号（abort）：启动中断、清理干净、不留定时器", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn({ mode: "hung" })
  const baseline = _internal.activeTimers()
  const controller = new AbortController()

  const pending = launchWith({ fs, sp, signal: controller.signal, startupTimeoutMs: 5_000 })
  controller.abort()
  const h = await pending

  assert.equal(h.ok, false)
  assert.match(h.error, /取消/)
  assert.equal(fs.removeCalls.length, 1)
  assert.equal(sp.calls[0].child.killCount, 1)
  assert.equal(_internal.activeTimers(), baseline)
  await h.close()
  assert.equal(fs.removeCalls.length, 1)
})

test("找不到浏览器 / 缺 url：直接失败，不建目录、不 spawn", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn()

  const noUrl = await launchWith({ fs, sp, url: "" })
  assert.equal(noUrl.ok, false)
  assert.match(noUrl.error, /url/i)

  const noBrowser = await launchIsolatedLogin({
    url: URL_AUTH,
    findBrowser: () => null,
    tmpdir: TMP_ROOT,
    env: ENV,
    spawn: sp.spawn,
    mkdtemp: fs.mkdtemp,
    removeDir: fs.removeDir,
  })
  assert.equal(noBrowser.ok, false)
  assert.match(noBrowser.error, /Chromium|浏览器/)
  assert.deepEqual(fs.mkdtempCalls, [], "没浏览器就别建目录")
  assert.equal(sp.calls.length, 0)
})

// ── 浏览器发现：本仓 findBrowser 返回字符串 ────────────────────────────

test("未显式给 browser 时用注入的 findBrowser 发现路径，字符串结果适配成 {name, path}", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn()
  const h = await launchIsolatedLogin({
    url: URL_AUTH,
    findBrowser: () => "C:\\fake\\bin\\chrome.exe",
    tmpdir: TMP_ROOT,
    env: ENV,
    spawn: sp.spawn,
    mkdtemp: fs.mkdtemp,
    removeDir: fs.removeDir,
  })
  assert.equal(h.ok, true)
  assert.equal(sp.calls[0].command, "C:\\fake\\bin\\chrome.exe")
  assert.equal(h.browser.path, "C:\\fake\\bin\\chrome.exe")
  assert.equal(h.browser.name, "chrome.exe", "Windows 路径在 POSIX 上也要只取文件名")
  await h.close()

  // 纯函数的三种形状
  assert.deepEqual(normalizeBrowser("C:\\fake\\bin\\chrome.exe").path, "C:\\fake\\bin\\chrome.exe")
  assert.deepEqual(normalizeBrowser({ path: "C:\\fake\\bin\\msedge.exe" }).name, "msedge.exe")
  assert.equal(normalizeBrowser(null), null)
  assert.equal(normalizeBrowser({ path: "   " }), null)
  assert.equal(normalizeBrowser(""), null)
})

// ── 并发隔离 ──────────────────────────────────────────────────────────

test("并发登录各自隔离：三个目录互不相同，关一个不影响另外两个", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn()
  const [a, b, c] = await Promise.all([launchWith({ fs, sp }), launchWith({ fs, sp }), launchWith({ fs, sp })])

  const dirs = new Set([a.userDataDir, b.userDataDir, c.userDataDir])
  assert.equal(dirs.size, 3, "三个登录三份 profile")
  assert.equal(fs.mkdtempCalls.length, 3)

  await b.close()
  assert.equal(sp.calls[1].child.killCount, 1)
  assert.equal(sp.calls[0].child.killCount, 0)
  assert.equal(sp.calls[2].child.killCount, 0)
  assert.ok(!fs.removeCalls.includes(a.userDataDir))
  assert.ok(!fs.removeCalls.includes(c.userDataDir))

  await a.close()
  await c.close()
  assert.deepEqual([...fs.removeCalls].sort(), [...dirs].sort())
})

// ── 静态边界 ──────────────────────────────────────────────────────────

test("源码边界：不开调试端口 / 不取 Cookie / 不复制 profile；复用 console-browser 的 findBrowser", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/isolated-login.mjs", import.meta.url)), "utf8")
  // 注释里会写「为什么不做这些」，所以边界只查代码本身。
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+\/\/[^\n]*$/gm, "")

  assert.ok(!/remote-debugging/i.test(code), "不许出现调试端口开关")
  assert.ok(!/getAllCookies|Network\.enable|Storage\.getCookies|Network\.setCookie/i.test(code), "不许取/注入 Cookie")
  assert.ok(!/chromiumLogin|cdpCookies|selectCookies|primeSession|openConsoleWindow/.test(code), "不许复用控制台的持久 profile 通路")
  assert.ok(!/localStorage|local storage/i.test(code), "不碰 LocalStorage")
  assert.ok(!/\bcpSync\b|\bcopyFileSync?\b|recursive-copy/.test(code), "不复制任何 profile")
  assert.ok(!/os\.homedir|profileDirFor/.test(code), "不触碰持久 profile 的落点")
  assert.ok(/from "\.\/console-browser\.mjs"/.test(code), "复用 console-browser 的浏览器发现")
  assert.ok(/findBrowser/.test(code), "只复用 findBrowser")

  for (const [name, value] of Object.entries(mod)) {
    assert.ok(typeof value === "function" || name === "_internal", `多余的对象导出：${name}`)
  }

  // 反面对照：console-browser 的控制台窗口确实带调试端口 —— 两条通路必须分开。
  const consoleSource = readFileSync(fileURLToPath(new URL("../src/console-browser.mjs", import.meta.url)), "utf8")
  assert.ok(/--remote-debugging-port=/.test(consoleSource), "console-browser 的持久窗口本来就该有调试端口")
  assert.ok(/profileDirFor\(/.test(consoleSource), "console-browser 用的是持久 profile 落点")
})
