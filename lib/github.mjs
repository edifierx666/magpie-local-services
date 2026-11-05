// GitHub Release 检查：条件请求（ETag，304 不计入限额）与限流识别。
import { runShell } from "./process.mjs"

export class UpdateError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.code = code
    Object.assign(this, extra)
  }
}

let tokenCache = { value: null, at: 0 }
let configuredToken = null

const API_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "magpie-local-services/0.1",
}

/** classic（ghp_…）、fine-grained（github_pat_…）以及 gh 输出的令牌都只含字母、数字和下划线。 */
export function isPlausibleToken(token) {
  return typeof token === "string" && /^[A-Za-z0-9_]{20,255}$/.test(token)
}

/** 设置面板里保存的令牌，优先级最高。传 null 表示清除。 */
export function setConfiguredToken(token) {
  configuredToken = isPlausibleToken(token) ? token : null
}

async function ghCliToken() {
  if (Date.now() - tokenCache.at < 60 * 60 * 1000) return tokenCache.value
  const r = await runShell("gh auth token 2>/dev/null", { timeoutMs: 5000, env: process.env })
  const t = r.exitCode === 0 ? r.output.trim() : ""
  tokenCache = { value: isPlausibleToken(t) ? t : null, at: Date.now() }
  return tokenCache.value
}

/**
 * GitHub token（可选，把匿名 60 次/小时提升到 5000 次/小时）：
 * 依次取设置里保存的令牌、GITHUB_TOKEN、GH_TOKEN、`gh auth token`。只会发给 api.github.com。
 * @returns {Promise<{token: string|null, source: "settings"|"env"|"gh"|null}>}
 */
export async function resolveToken() {
  if (configuredToken) return { token: configuredToken, source: "settings" }
  const env = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim()
  if (env) return { token: env, source: "env" }
  const gh = await ghCliToken()
  return gh ? { token: gh, source: "gh" } : { token: null, source: null }
}

/**
 * 用 /rate_limit 验证令牌（这个接口本身不消耗配额）。
 * @returns {Promise<{limit:number, remaining:number, resetAt:string|null}>}
 */
export async function verifyToken(token) {
  let res
  try {
    res = await fetch("https://api.github.com/rate_limit", {
      headers: { ...API_HEADERS, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    throw new UpdateError("network", `无法连接 GitHub 验证令牌：${e?.message ?? e}`)
  }
  if (res.status === 401) throw new UpdateError("unauthorized", "令牌无效或已过期")
  if (res.status !== 200) throw new UpdateError("http", `GitHub 返回 HTTP ${res.status}`, { statusCode: res.status })
  const core = (await res.json().catch(() => null))?.resources?.core ?? {}
  return {
    limit: Number(core.limit) || 0,
    remaining: Number(core.remaining) || 0,
    resetAt: Number(core.reset) > 0 ? new Date(Number(core.reset) * 1000).toISOString() : null,
  }
}

/**
 * 取 `owner/repo` 的最新 Release。
 * @returns {{kind:"updated", status:object} | {kind:"notModified"}}
 */
/** 把 fetch 的底层异常归成一句可读的原因；原始信息只保留错误码，Bun 的调试提示不展示给用户。 */
export function networkMessage(e) {
  const code = e?.code ?? e?.cause?.code ?? ""
  const text = String(e?.message ?? e)
  if (e?.name === "TimeoutError" || code === "ETIMEDOUT") return "连接 GitHub 超时，请检查网络或代理"
  if (/ENOTFOUND|EAI_AGAIN/.test(code + text)) return "无法解析 api.github.com，请检查网络或 DNS"
  if (/ECONNRESET|socket connection was closed|ECONNREFUSED|EPIPE/.test(code + text)) return "连接 GitHub 被中断，请检查网络或代理"
  if (/certificate|TLS|SSL/i.test(code + text)) return "与 GitHub 建立安全连接失败（TLS），请检查网络或代理"
  return `网络请求失败：${text.split(". For more information")[0]}`
}

export async function checkLatestRelease(repository, { etag, signal } = {}) {
  const headers = { ...API_HEADERS }
  const { token, source } = await resolveToken()
  if (token) headers.authorization = `Bearer ${token}`
  if (etag) headers["if-none-match"] = etag

  let res
  try {
    res = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, { headers, signal: signal ?? AbortSignal.timeout(20_000) })
  } catch (e) {
    throw new UpdateError("network", networkMessage(e))
  }

  if (res.status === 304) return { kind: "notModified" }
  if (res.status === 200) {
    const body = await res.json().catch(() => null)
    if (!body || typeof body.tag_name !== "string") throw new UpdateError("decode", "无法解析 GitHub 返回的 Release 数据")
    return {
      kind: "updated",
      status: {
        repository,
        latestVersion: body.tag_name,
        latestReleaseTitle: typeof body.name === "string" && body.name ? body.name : body.tag_name,
        latestReleaseURL: typeof body.html_url === "string" ? body.html_url : `https://github.com/${repository}/releases`,
        latestPublishedAt: typeof body.published_at === "string" ? body.published_at : null,
        lastCheckedAt: new Date().toISOString(),
        errorMessage: null,
        etag: res.headers.get("etag"),
      },
    }
  }
  if (res.status === 401 && token) {
    const where = source === "settings" ? "请在设置中更新 GitHub 访问令牌" : "请检查 GITHUB_TOKEN / GH_TOKEN 或 gh 登录状态"
    throw new UpdateError("unauthorized", `GitHub 令牌无效或已过期，${where}`)
  }
  if (res.status === 404) throw new UpdateError("notFound", "仓库不存在或还没有正式 Release")
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining")
    const reset = Number(res.headers.get("x-ratelimit-reset"))
    if (res.status === 429 || remaining === "0") {
      const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null
      throw new UpdateError("rateLimited", "GitHub 请求次数已达上限，稍后会自动重试", { resetAt })
    }
  }
  throw new UpdateError("http", `GitHub 返回 HTTP ${res.status}`, { statusCode: res.status })
}
