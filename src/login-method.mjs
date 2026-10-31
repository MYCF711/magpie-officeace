// 登录方式的统一入口（为「内置登录」留的插槽）
//
// ═══════════════════════════════════════════════════════════════════
// 为什么有这一层
// ═══════════════════════════════════════════════════════════════════
//
// 现在两个 provider 的登录都是「弹浏览器」：
//   · codearts  → 本地起回调服务器，走 codearts.huaweicloud.com/portal 的 OAuth
//   · officeace → CLAW 的 /v1/claw/auth/state + /v1/claw/auth/code 轮询
//
// 下一期要做「内置登录」：华为云账号/密码（或验证码）在 magpie 里完成，浏览器
// 只作回退。如果两边各写一套 authorize()，到时候就要改两处、且很容易改漏 ——
// 所以登录入口先收成这一层：
//
//   一个「登录方式」= { kind, start(context) -> 一个登录流程对象 }
//   流程对象 = { url?, instructions?, method?, result?, close? }
//   `result` 是 Promise，resolve 出凭据；`close()` 用来收掉回调服务器。
//
// 现在只有 browser 实现；builtin 实现接上时只要实现同一个 start()，两个 provider
// 一行都不用改（通过 options.loginMethod / loginKind 注入）。

export const LOGIN_KIND_BROWSER = "browser"
export const LOGIN_KIND_BUILTIN = "builtin"

/**
 * 把「弹浏览器」的启动函数包成一个登录方式。
 * @param {Function} start 现有的浏览器登录启动函数（fetcher → 流程对象）
 */
export function createBrowserLogin(start) {
  if (typeof start !== "function") throw new TypeError("browser login needs a start function")
  return { kind: LOGIN_KIND_BROWSER, start }
}

/**
 * 把「内置登录」的启动函数包成一个登录方式（下一期实现）。
 * @param {Function} start (context) => 流程对象
 */
export function createBuiltinLogin(start) {
  if (typeof start !== "function") throw new TypeError("builtin login needs a start function")
  return { kind: LOGIN_KIND_BUILTIN, start }
}

/**
 * 选一个登录方式：要内置但没有内置实现时，回退到浏览器（这就是「弹浏览器是回退选项」）。
 *
 * @param {{kind?: string, browser?: object, builtin?: object|null}} opts
 * @returns {{kind: string, start: Function}}
 */
export function chooseLoginMethod({ kind, browser, builtin } = {}) {
  if (kind === LOGIN_KIND_BUILTIN && builtin) return builtin
  if (browser) return browser
  if (builtin) return builtin
  throw new Error("no login method available")
}
