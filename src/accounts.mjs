// 从磁盘上读已保存的登录态（只读，绝不写）
//
// ═══════════════════════════════════════════════════════════════════
// 为什么需要这个模块
// ═══════════════════════════════════════════════════════════════════
//
// `authorize()` 以前只看**内存**里那份「刚读过额度、还没接 MaaS」的凭据。
// magpie 一重启内存就是空的，或者这张卡的 `usage()` 还没被调过 —— 于是
// `authorize()` 认定「没有登录态」，直接把人送去华为云登录页；而磁盘上
// （magpie 的 `plugin-auth.json`）明明还存着这个账号的凭据。
//
// 用户看到的就是「点了重新登录却跳去登录页，没有复用凭证」。
//
// 这里把「已保存的登录态」从磁盘读出来，交给 `authorize()` 先去探测。
//
// ⚠ 只读：这个文件属于 magpie（host.js 自己维护它，并且带 .bak / .lock），
//   插件不写、不加锁、不落任何缓存文件。
//
// ⚠ 路径规则与 magpie 的 `appdir.Config()` 保持一致：
//   便携版（可执行文件旁边的数据目录）→ XDG_CONFIG_HOME/magpie → ~/.config/magpie。
//   便携版插件看不到，这时用 MAGPIE_OFFICEACE_AUTH_FILE 指一下即可。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { credentialOf } from "./credential.mjs"

/** 读哪个文件：显式给 > 环境变量 > XDG_CONFIG_HOME/magpie > ~/.config/magpie。 */
export function officeAceAuthFile(opts = {}) {
  if (typeof opts.file === "string" && opts.file.length > 0) return opts.file
  const env = process.env.MAGPIE_OFFICEACE_AUTH_FILE
  if (typeof env === "string" && env.length > 0) return env
  const xdg = process.env.XDG_CONFIG_HOME
  if (typeof xdg === "string" && path.isAbsolute(xdg)) return path.join(xdg, "magpie", "plugin-auth.json")
  return path.join(os.homedir(), ".config", "magpie", "plugin-auth.json")
}

/**
 * 读 magpie 保存的 officeace 账号。
 *
 * @returns {Array<{key: string, auth: object, cred: object}>}
 *   读不到 / 不是 JSON / 没有 officeace 条目 → 空数组（从不抛）
 */
export function readOfficeAceAccounts(opts = {}) {
  const file = officeAceAuthFile(opts)
  let raw
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return [] // 没有这个文件 = 没有登录态，不是错误
  }

  let all
  try {
    all = JSON.parse(raw)
  } catch {
    return []
  }
  if (!all || typeof all !== "object" || Array.isArray(all)) return []

  const out = []
  for (const [key, auth] of Object.entries(all)) {
    // magpie 按 provider id 存：第一个账号是 `officeace`，之后是 `officeace#xxxxxx`
    if (key !== "officeace" && !key.startsWith("officeace#")) continue
    if (!auth || typeof auth !== "object") continue
    const cred = credentialOf(auth)
    if (!cred) continue
    out.push({ key, auth, cred })
  }
  return out
}

/**
 * 挑一个用来探测的账号：优先「有凭据、但还没接 MaaS」的那个（用户点登录通常
 * 就是为了它），否则任意一个有凭据的账号。
 */
export function pickOfficeAceCredential(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) return null
  return (accounts.find((a) => !a.cred?.modelAppKey) ?? accounts[0]).cred ?? null
}
