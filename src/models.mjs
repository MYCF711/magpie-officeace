// 模型表与模型条目形状
//
// ═══════════════════════════════════════════════════════════════════
// 两个表的分工
// ═══════════════════════════════════════════════════════════════════
//
//   FALLBACK_MODELS   config 钩子用 —— 未登录时也要有内容
//                     ⚠ 没有它 magpie 显示 "0 models"
//
//   provider.models   登录后拉真实目录，失败回退 FALLBACK
//
// ═══════════════════════════════════════════════════════════════════

import { FALLBACK_MODELS, OFFICIAL_MAAS_BASE } from "./constants.mjs"

/** npm 包 → 决定 API 形状 */
export const NPM = "@ai-sdk/openai-compatible"

/**
 * 构造一个 magpie model 条目。
 *
 * 契约要求：id / name / api:{id,url,npm} / limit / capabilities / cost
 */
export function modelEntry({ id, name, baseUrl = OFFICIAL_MAAS_BASE, context = 128_000, output = 8192 }) {
  return {
    id,
    name,
    api: { id, url: `${baseUrl}/v2`, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context, output },
    capabilities: {
      temperature: true,
      // 实测上游支持推理链
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

/** 未登录时的静态表（config 钩子用）*/
export function staticModels(baseUrl = OFFICIAL_MAAS_BASE) {
  const out = {}
  for (const [id, def] of Object.entries(FALLBACK_MODELS)) {
    out[id] = modelEntry({
      id,
      name: def.name,
      baseUrl,
      context: def.limit.context,
      output: def.limit.output,
    })
  }
  return out
}

/**
 * 把服务端拉回的目录转成 magpie 的形状。
 *
 * ⚠ 保留静态表里的配置（上下文窗口等），只更新 id/name ——
 *   上游的目录只有 id 和 name，**没有能力元数据**。
 */
export function liveModels(rows, baseUrl) {
  const out = {}
  for (const row of rows) {
    const id = typeof row === "string" ? row : row?.id
    if (typeof id !== "string" || id.length === 0) continue
    const name = typeof row?.name === "string" && row.name.length > 0 ? row.name : id
    const known = FALLBACK_MODELS[id]
    out[id] = modelEntry({
      id,
      name,
      baseUrl,
      context: known?.limit?.context ?? 128_000,
      output: known?.limit?.output ?? 8192,
    })
  }
  return out
}