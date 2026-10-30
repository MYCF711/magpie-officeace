// 复用 OfficeAce 客户端的登录态
//
// ═══════════════════════════════════════════════════════════════════
// 为什么需要这个模块
// ═══════════════════════════════════════════════════════════════════
//
// OfficeAce 桌面客户端登录后会在本机留下两样东西：
//
//   1. `~/.office-claw/session.cookie`
//      `OC-DPAPI-1\n` + base64(DPAPI(CurrentUser, JSON { value, expires }))
//      —— `value` 就是本地 API（https://127.0.0.1:3003）的会话 cookie `oc_sid`。
//      2026-10-31 实测：用它请求 `GET /api/islogin` 返回 `{islogin:true,userId,sessionId,userName}`。
//
//   2. `%APPDATA%\@office-claw\desktop\Local Storage\leveldb\...`
//      `office-claw-sessionId`（UUID）。⚠ 这是**过期**的 Bearer —— 服务端只认
//      当前 `/api/islogin` 返回的 `sessionId`，leveldb 里的旧 UUID 会 401。
//
// 这个模块只做一件事：**只读地**判断「OfficeAce 客户端现在登录的是哪个账号」，
// 让插件在 authorize() 里优先复用它，而不是再把用户送去华为云登录页。
//
// ⚠ 不写任何文件、不改 OfficeAce 的任何状态、不发起登录。

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import https from "node:https"
import os from "node:os"
import path from "node:path"

/** OfficeAce 客户端的数据根目录（默认发行版是 ~/.office-claw）。 */
export function officeClawRoot(env = process.env) {
  const explicit = String(env?.OFFICEACE_USER_DATA_ROOT || env?.OFFICE_CLAW_DATA_DIR || "").trim()
  if (explicit) return explicit
  return path.join(os.homedir(), ".office-claw")
}

/** 会话 cookie 文件。 */
export function clientSessionFile(env = process.env) {
  return path.join(officeClawRoot(env), "session.cookie")
}

/** 解析 `session.cookie` 的原始内容：DPAPI 格式返回 {blobB64}，明文 JSON 返回 {value,expires}。 */
export function parseSessionCookie(raw) {
  const text = String(raw ?? "").replace(/^\uFEFF/, "").trim()
  if (!text) return null
  if (text.startsWith("OC-DPAPI-1")) {
    const b64 = text.slice("OC-DPAPI-1".length).trim()
    return b64 ? { blobB64: b64 } : null
  }
  try {
    const j = JSON.parse(text)
    if (typeof j?.value === "string" && j.value) return { value: j.value, expires: j.expires }
  } catch {}
  return null
}

/**
 * DPAPI 解密（Windows 当前用户）。Node 没有内置 DPAPI，走一次 PowerShell。
 * 输入是 base64 的 DPAPI blob；输出是明文 JSON 字符串。
 */
export function decryptDpapiBase64(blobB64, exec = execFileSync) {
  if (process.platform !== "win32") throw new Error("DPAPI 只在 Windows 上可用")
  const script = [
    "Add-Type -AssemblyName System.Security;",
    "$b=[Convert]::FromBase64String($env:OC_DPAPI_BLOB);",
    "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');",
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8;",
    "[Text.Encoding]::UTF8.GetString($p)",
  ].join(" ")
  const out = exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    env: { ...process.env, OC_DPAPI_BLOB: blobB64 },
  })
  return String(out).trim()
}

/**
 * 读 OfficeAce 客户端当前会话。
 *
 * @returns {{ocSid: string, expires?: number} | null} 没有登录态/解密失败 → null
 */
export function readClientSession({ env = process.env, decrypt = decryptDpapiBase64, readFile = fs.readFileSync } = {}) {
  const file = clientSessionFile(env)
  let raw
  try {
    raw = readFile(file, "utf8")
  } catch {
    return null
  }
  const parsed = parseSessionCookie(raw)
  if (!parsed) return null
  if (parsed.value) return { ocSid: parsed.value, expires: parsed.expires }
  try {
    const plain = decrypt(parsed.blobB64)
    const j = JSON.parse(plain)
    if (typeof j?.value !== "string" || !j.value) return null
    return { ocSid: j.value, expires: typeof j.expires === "number" ? j.expires : undefined }
  } catch {
    return null
  }
}

/** 自签名的本地 API 用 node:https（fetch 不方便关证书校验）。 */
export function httpsGetJson(url, headers = {}, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers, rejectUnauthorized: false, timeout: timeoutMs },
      (res) => {
        let data = ""
        res.setEncoding("utf8")
        res.on("data", (c) => (data += c))
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null })
          } catch (e) {
            reject(new Error(`不是 JSON: ${data.slice(0, 120)}`))
          }
        })
      },
    )
    req.on("timeout", () => req.destroy(new Error(`请求超过 ${timeoutMs}ms`)))
    req.on("error", reject)
  })
}

/**
 * 问本地 OfficeAce API：现在登录的是谁？
 *
 * @returns {Promise<{loggedIn: boolean, accountId?: string, userId?: string, userName?: string, sessionId?: string} | null>}
 *   客户端没开 / 没登录 / 超时 → null
 */
export async function probeClientLogin({ session, env = process.env, getJson = httpsGetJson, timeoutMs = 2000 } = {}) {
  const s = session ?? readClientSession({ env })
  if (!s?.ocSid) return null
  try {
    const r = await getJson("https://127.0.0.1:3003/api/islogin", { Cookie: `oc_sid=${s.ocSid}` }, timeoutMs)
    const j = r?.json
    if (!j?.islogin) return { loggedIn: false }
    const userId = typeof j.userId === "string" ? j.userId.trim() : ""
    return {
      loggedIn: true,
      userId,
      accountId: userId.split(":")[0] || undefined,
      userName: typeof j.userName === "string" ? j.userName : undefined,
      sessionId: typeof j.sessionId === "string" ? j.sessionId : undefined,
    }
  } catch {
    return null
  }
}
