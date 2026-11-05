// 本地面板与 API。magpie 的插件页面运行在 connect-src 'none' 的沙盒框架里，不能 fetch，
// 只能把自己跳转到这里；跳转后的文档仍是沙盒的不透明源（Origin: null），因此：
//  - API 必须带 x-local-services-token，token 由插件页面生成并存进 magpie 的插件选项（plugins.json）；
//  - 只监听 127.0.0.1，并校验 Host 头，防止 DNS 重绑定；
//  - 带 token 的自定义头会触发预检，其他网页拿不到 token，无法跨站操作。
import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { timingSafeEqual } from "node:crypto"
import { fileURLToPath } from "node:url"

const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url))
const PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url))
const TUNNEL_URL = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?$/
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/i18n.js": ["i18n.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, x-local-services-token",
  "access-control-max-age": "600",
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS } })
}

function fail(message, status = 400) {
  return json({ error: message }, status)
}

function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length < 32) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/** 从 magpie 的 plugins.json 读出本插件的 token。只认 spec 指向本插件的那一项。 */
class TokenSource {
  constructor(directory, initial) {
    this.file = path.join(directory, "plugins.json")
    this.token = typeof initial?.token === "string" ? initial.token : null
    this.readAt = 0
    let real = PLUGIN_DIR
    try {
      real = fs.realpathSync(PLUGIN_DIR)
    } catch {}
    this.dirs = new Set([path.resolve(PLUGIN_DIR), path.resolve(real)])
  }

  ownsSpec(spec) {
    if (typeof spec !== "string") return false
    if (spec.includes("magpie-local-services")) return true
    try {
      const p = path.resolve(spec.replace(/^file:/, "").replace(/^~(?=\/)/, process.env.HOME ?? "~"))
      return this.dirs.has(p) || this.dirs.has(fs.realpathSync(p))
    } catch {
      return false
    }
  }

  reload() {
    // 限制重读频率，避免被当作探测口
    if (Date.now() - this.readAt < 500) return
    this.readAt = Date.now()
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"))
      const own = (data.plugins ?? []).find((p) => this.ownsSpec(p?.spec))
      if (typeof own?.options?.token === "string") this.token = own.options.token
    } catch {}
  }

  check(given) {
    if (sameToken(given, this.token)) return true
    this.reload()
    return sameToken(given, this.token)
  }
}

async function body(req) {
  const text = await req.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error("请求体不是合法的 JSON")
  }
}

/** 沙盒框架里剪贴板接口可能被禁用；面板在本机打开时，由宿主用 pbcopy 代为复制。 */
function copyText(text) {
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/pbcopy", [], { timeout: 3000 }, (e) => (e ? reject(e) : resolve()))
    child.stdin.end(text)
  })
}

function openURL(url) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/open", [url], { timeout: 5000 }, (e) => (e ? reject(e) : resolve()))
  })
}

export function startServer({ manager, port, directory, options }) {
  const tokens = new TokenSource(directory, options)
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])

  async function api(req, url) {
    const parts = url.pathname.split("/").filter(Boolean).slice(1) // 去掉 "api"
    const m = req.method
    const [a, id, action] = parts

    if (m === "GET" && a === "state") return json(manager.state())
    if (m === "PUT" && a === "settings") return json(manager.updateSettings(await body(req)))
    if (m === "POST" && a === "copy") {
      const { text } = await body(req)
      // 只用来复制服务地址
      const ok = typeof text === "string" && text.length <= 200 && (/^https?:\/\/[A-Za-z0-9.\-[\]:]+:\d{1,5}\/?$/.test(text) || TUNNEL_URL.test(text))
      if (!ok) return fail("只能复制服务或隧道地址")
      await copyText(text)
      return json({ ok: true })
    }
    if (m === "POST" && a === "detect-version-command") return json(await manager.detectVersionCommand(await body(req)))
    if (m === "POST" && a === "check-all") {
      await manager.checkAll(true)
      return json(manager.state())
    }
    if (a === "github-token") {
      if (m === "GET") return json(await manager.githubTokenStatus())
      if (m === "PUT") {
        const { token } = await body(req)
        try {
          return json(await manager.setGithubToken(token))
        } catch (e) {
          // 验证失败属于用户输入问题，给 400 而不是 500
          return fail(e?.message ?? String(e), e?.code === "network" ? 502 : 400)
        }
      }
      if (m === "DELETE") return json(await manager.clearGithubToken())
    }
    if (a === "tunnels") {
      const tunnels = manager.tunnels
      if (id === "detect" && m === "POST") return json(await tunnels.detect(true))
      if (!id && m === "POST") {
        const { port, serviceId } = await body(req)
        try {
          return json(await tunnels.start({ port, serviceId: typeof serviceId === "string" && manager.store.get(serviceId) ? serviceId : null }))
        } catch (e) {
          return fail(e?.message ?? String(e))
        }
      }
      if (id && !action && m === "DELETE") {
        await tunnels.stop(id)
        return json({ ok: true })
      }
      if (id && action === "retry" && m === "POST") return json(await tunnels.retry(id))
      return fail("不支持的请求", 405)
    }
    if (m === "POST" && a === "open") {
      const { url: target } = await body(req)
      // 只打开 GitHub 的 https 链接（Release、创建令牌）和本插件建立的快速隧道地址
      const allowed = typeof target === "string" && (/^https:\/\/github\.com\//.test(target) || TUNNEL_URL.test(target))
      if (!allowed) return fail("只能打开 GitHub 或隧道链接")
      await openURL(target)
      return json({ ok: true })
    }
    if (a === "services") {
      if (!id) {
        if (m === "POST") return json(manager.create(await body(req)))
        return fail("不支持的请求", 405)
      }
      if (id === "restore" && m === "POST") {
        const { service, index } = await body(req)
        return json(manager.restore(service, index))
      }
      if (id === "reorder" && m === "POST") {
        manager.reorder((await body(req)).ids)
        return json(manager.state())
      }
      if (!manager.store.get(id)) return fail("服务不存在", 404)
      if (!action) {
        if (m === "PUT") return json(manager.update(id, await body(req)))
        if (m === "DELETE") return json({ ok: true, removed: await manager.remove(id) })
        if (m === "GET") return json(manager.view(id))
      }
      if (action === "logs") {
        if (m === "GET") {
          const off = url.searchParams.get("offset")
          return json(manager.readLogs(id, off === null ? undefined : Number(off)))
        }
        if (m === "DELETE") {
          manager.clearLogs(id)
          return json({ ok: true })
        }
      }
      if (m === "POST") {
        switch (action) {
          case "start":
            return json(await manager.start(id))
          case "stop":
            await manager.stop(id)
            return json(manager.view(id))
          case "restart":
            return json(await manager.restart(id))
          case "duplicate":
            return json(manager.duplicate(id))
          case "check-update":
            return json(await manager.checkForUpdates(id))
          case "update":
            return json(await manager.performUpdate(id))
          case "ignore-version":
            return json(manager.ignoreLatest(id))
          case "clear-ignored":
            return json(manager.clearIgnored(id))
          case "mark-current":
            return json(manager.markLatestAsCurrent(id))
        }
      }
    }
    return fail("不支持的请求", 404)
  }

  async function handle(req) {
    const url = new URL(req.url)
    if (!allowedHosts.has(req.headers.get("host") ?? "")) return new Response("forbidden", { status: 403 })
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })

    if (url.pathname.startsWith("/api/")) {
      if (!tokens.check(req.headers.get("x-local-services-token"))) return fail("未授权：请从 magpie 的「本地服务」页面打开", 401)
      try {
        await manager.ready
        return await api(req, url)
      } catch (e) {
        return fail(e?.message ?? String(e), 400)
      }
    }

    const hit = STATIC[url.pathname]
    if (req.method === "GET" && hit) {
      const file = Bun.file(path.join(WEB_DIR, hit[0]))
      return new Response(file, { headers: { "content-type": hit[1], "cache-control": "no-cache" } })
    }
    return new Response("not found", { status: 404 })
  }

  return Bun.serve({ hostname: "127.0.0.1", port, fetch: handle, idleTimeout: 60 })
}
