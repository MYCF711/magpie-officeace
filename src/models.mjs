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
export function modelEntry({ id, name, baseUrl = OFFICIAL_MAAS_BASE, context = 1_000_000, output = 128_000 }) {
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
export function liveModels(rows, baseUrl, rates) {
  const out = {}
  for (const row of rows) {
    const id = typeof row === "string" ? row : row?.id
    if (typeof id !== "string" || id.length === 0) continue

    // ⚠ 只留有倍率的模型 —— 这是 OfficeAce 桌面端自己的做法
    //
    // /v2/models 是**注册表**，把没上线或不可用的测试版也列出来：
    //   deepseek-v4.1-flash-1017   → 404 ModelArts.81009 Invalid model
    //   deepseek-v4.1-flash-bnt    → 404（同上）
    //   deepseek-v4.1-flash-0930   → 200，但上游返回 model="deepseek-v4.1-flash"
    //                                （即路由到主模型，不单独计价）
    //
    // /v1/model-token-rates 是**可计费清单**，桌面端只显示它有的（7 个）。
    // 直接用注册表会给出 26 个，其中 19 个选不了 —— 比少给更糟。
    //
    // rates 为空（接口失败）时不过滤，宁可多给也不给零个。
    if (rates && rates.size > 0 && !rates.has(id)) continue

    const name = typeof row?.name === "string" && row.name.length > 0 ? row.name : id
    const known = FALLBACK_MODELS[id]
    out[id] = modelEntry({
      id,
      name,
      baseUrl,
      context: known?.limit?.context ?? 1_000_000,
      output: known?.limit?.output ?? 128_000,
    })
  }
  return out
}