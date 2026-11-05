// Cloudflare 免费快速隧道（Quick Tunnel，*.trycloudflare.com），对应 Edx 的 CloudflaredService / TunnelManager。
// 与 Edx 不同：可以同时开多条隧道，每个端口一条。
//
// 安全约束：
//  - 隧道把本机端口公开到互联网，只能由用户在面板里确认后创建（不提供给智能体工具）；
//  - 隧道进程跟随插件宿主：宿主退出时全部终止，下次启动时清理残留，绝不在 magpie 退出后继续对外暴露。
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { pidAlive, runShell, signal } from "./process.mjs"

const BINARY_PATHS = ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/usr/bin/cloudflared"]
const URL_PATTERN = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/g
const START_TIMEOUT_MS = 30_000
const POLL_MS = 400
const DETECT_TTL_MS = 60_000
const LISTEN_REFRESH_MS = 3000

function exec(file, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 16 << 20 }, (error, stdout) => resolve({ ok: !error || error.code === 1, stdout: String(stdout ?? "") }))
  })
}

/** 当前所有 TCP 监听：端口 → 绑定地址集合。 */
async function listeningSockets() {
  const out = new Map()
  const { stdout } = await exec("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"], 4000)
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("n")) continue
    const m = line.slice(1).match(/^(.*):(\d+)$/)
    if (!m) continue
    const port = Number(m[2])
    if (!out.has(port)) out.set(port, new Set())
    out.get(port).add(m[1])
  }
  return out
}

/** 隧道要连的本机地址：服务只监听 IPv6 回环时用 [::1]，否则用 127.0.0.1（避免 localhost 解析到没监听的那一个）。 */
export function targetHost(hosts) {
  if (!hosts || !hosts.size) return "127.0.0.1"
  const v4 = ["*", "0.0.0.0", "127.0.0.1", "localhost"].some((h) => hosts.has(h))
  if (v4) return "127.0.0.1"
  if (hosts.has("[::1]") || hosts.has("[::]") || hosts.has("::1")) return "[::1]"
  return "127.0.0.1"
}

export function tunnelArgs(host, port) {
  return ["tunnel", "--no-autoupdate", "--config", "/dev/null", "--protocol", "http2", "--url", `http://${host}:${port}`]
}

export function validPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

/**
 * 从 cloudflared 输出里找分配到的公网地址。
 * 错误信息里也会出现 https://api.trycloudflare.com（申请隧道的接口），它不是隧道地址，必须排除。
 */
export function extractTunnelURL(text) {
  for (const m of String(text).matchAll(URL_PATTERN)) if (m[1] !== "api") return m[0]
  return null
}

/** 把常见失败翻译成能照着处理的说明，原始错误附在后面。 */
export function explainError(detail) {
  if (!detail) return null
  if (/429|too many requests|rate limit/i.test(detail)) return `Cloudflare 暂时限制了快速隧道的创建，请稍后再试（${detail}）`
  if (/api\.trycloudflare\.com/.test(detail) || /EOF|timeout|handshake|connection (refused|reset)|no such host|network is unreachable/i.test(detail))
    return `无法连接 Cloudflare 快速隧道服务，请检查网络或代理（${detail}）`
  return detail
}

/** 从 cloudflared 输出里取最后一条错误，去掉时间戳和级别前缀，便于直接展示。 */
export function lastError(text) {
  // 「Configuration file /dev/null was empty」是我们故意用空配置引起的，不是失败原因
  const lines = String(text)
    .split("\n")
    .filter((l) => /\bERR\b|error|failed/i.test(l) && !/Configuration file \/dev\/null was empty/.test(l))
  const last = lines.at(-1)
  if (!last) return null
  return last.replace(/^\S+\s+(ERR|INF|WRN)\s+/, "").trim().slice(0, 300) || null
}

export class TunnelManager {
  /** binary：指定 cloudflared 路径（测试用），不传则自动查找。 */
  constructor(store, { onChange, binary } = {}) {
    this.binary = binary ?? null
    this.dir = path.join(store.dir, "tunnels")
    this.stateFile = path.join(this.dir, "tunnels.json")
    fs.mkdirSync(this.dir, { recursive: true })
    this.tunnels = new Map()
    this.children = new Map()
    this.onChange = onChange ?? (() => {})
    this.install = null
    this.installAt = 0
    this.listening = new Map()
    this.listenTimer = null
    this.sweepStale()
  }

  // ---- 安装检测 ----------------------------------------------------------------

  async detect(force = false) {
    if (!force && this.install && Date.now() - this.installAt < DETECT_TTL_MS) return this.install
    let bin = this.binary ?? BINARY_PATHS.find((p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK)
        return true
      } catch {
        return false
      }
    })
    if (!bin) {
      // 不在常见位置时，用登录 shell 的 PATH 再找一次（例如装在 ~/bin）
      const r = await runShell("command -v cloudflared", { timeoutMs: 8000, env: process.env })
      const found = r.exitCode === 0 ? r.output.trim().split("\n").at(-1) : ""
      if (found.startsWith("/")) bin = found
    }
    let version = null
    if (bin) {
      const { stdout } = await exec(bin, ["--version"], 5000)
      version = stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null
    }
    this.install = { installed: !!bin, path: bin ?? null, version }
    this.installAt = Date.now()
    return this.install
  }

  // ---- 视图 ----------------------------------------------------------------

  view(t) {
    return {
      id: t.id,
      port: t.port,
      host: t.host,
      serviceId: t.serviceId,
      status: t.status,
      url: t.url,
      error: t.error,
      startedAt: t.startedAt,
      // 端口上已经没有程序在监听时，公网访问会得到 502
      listening: this.listening.has(t.port),
    }
  }

  list() {
    return [...this.tunnels.values()].map((t) => this.view(t))
  }

  // ---- 启动与停止 ----------------------------------------------------------------

  async start({ port: rawPort, serviceId = null }) {
    const port = validPort(rawPort)
    if (!port) throw new Error("端口应为 1–65535 的整数")
    const same = [...this.tunnels.values()].find((t) => t.port === port && (t.status === "starting" || t.status === "active"))
    if (same) return this.view(same)
    // 同一端口之前失败的记录直接替换
    for (const t of this.tunnels.values()) if (t.port === port) this.tunnels.delete(t.id)

    const install = await this.detect(true)
    if (!install.installed) throw new Error("没有找到 cloudflared，请先安装：brew install cloudflared")

    this.listening = await listeningSockets()
    const host = targetHost(this.listening.get(port))
    const id = randomUUID()
    const logFile = path.join(this.dir, `${id}.log`)
    const fd = fs.openSync(logFile, "a")
    const args = tunnelArgs(host, port)
    let child
    try {
      // 不脱离进程组：宿主被整组结束时隧道一起结束
      child = spawn(install.path, args, { stdio: ["ignore", fd, fd], env: { ...process.env, EDX_TUNNEL_ID: id } })
    } catch (e) {
      throw new Error(`cloudflared 启动失败：${e?.message ?? e}`)
    } finally {
      fs.closeSync(fd)
    }

    const tunnel = { id, port, host, serviceId: serviceId || null, status: "starting", url: null, error: null, startedAt: null, pid: child.pid, logFile, stopping: false, signature: args.join(" ") }
    this.tunnels.set(id, tunnel)
    this.children.set(id, child)
    this.persist()
    console.error(`edx-services: 隧道启动中（端口 ${port}，PID ${child.pid}）`)

    child.on("error", (e) => this.fail(tunnel, `cloudflared 启动失败：${e?.message ?? e}`))
    child.on("exit", (code, sig) => {
      this.children.delete(id)
      if (tunnel.stopping || !this.tunnels.has(id)) return
      const detail = explainError(lastError(this.readLog(tunnel)))
      // 还没拿到地址就退出属于「没建立」，拿到地址后退出才是「断开」
      const lead = tunnel.status === "active" ? "隧道已断开" : "隧道没有建立"
      this.fail(tunnel, detail ? `${lead}：${detail}` : `${lead}：cloudflared 退出（${sig ?? `退出码 ${code}`}）`)
    })

    this.watchForURL(tunnel)
    this.ensureListenTimer()
    this.onChange()
    return this.view(tunnel)
  }

  readLog(tunnel) {
    try {
      return fs.readFileSync(tunnel.logFile, "utf8").slice(-64 * 1024)
    } catch {
      return ""
    }
  }

  /** 每 400ms 读一次输出找公网地址，30 秒找不到就算失败。 */
  watchForURL(tunnel) {
    const deadline = Date.now() + START_TIMEOUT_MS
    const timer = setInterval(() => {
      if (!this.tunnels.has(tunnel.id) || tunnel.status !== "starting") return clearInterval(timer)
      const text = this.readLog(tunnel)
      const url = extractTunnelURL(text)
      if (url) {
        clearInterval(timer)
        tunnel.url = url
        tunnel.status = "active"
        tunnel.startedAt = new Date().toISOString()
        console.error(`edx-services: 隧道已建立（端口 ${tunnel.port} → ${url}）`)
        this.onChange()
        return
      }
      if (Date.now() > deadline) {
        clearInterval(timer)
        const detail = explainError(lastError(text))
        this.fail(tunnel, detail ? `30 秒内没有建立隧道：${detail}` : "30 秒内没有建立隧道，请检查网络后重试")
        this.kill(tunnel)
      }
    }, POLL_MS)
  }

  fail(tunnel, message) {
    if (!this.tunnels.has(tunnel.id) || tunnel.status === "error") return
    tunnel.status = "error"
    tunnel.error = message
    console.error(`edx-services: 隧道失败（端口 ${tunnel.port}）：${message}`)
    this.persist()
    this.onChange()
  }

  kill(tunnel) {
    const pid = tunnel.pid
    if (!(pid > 1)) return
    signal(pid, "SIGTERM")
    setTimeout(() => pidAlive(pid) && this.ownsPid(pid, tunnel.id, tunnel.signature).then((own) => own && signal(pid, "SIGKILL")), 3000).unref?.()
  }

  /** 停止并移除隧道；失败的记录直接移除。 */
  async stop(id) {
    const tunnel = this.tunnels.get(id)
    if (!tunnel) throw new Error("隧道不存在")
    tunnel.stopping = true
    if (tunnel.status !== "error") {
      tunnel.status = "stopping"
      this.onChange()
      this.kill(tunnel)
      const deadline = Date.now() + 3500
      while (pidAlive(tunnel.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    }
    this.tunnels.delete(id)
    this.children.delete(id)
    fs.rmSync(tunnel.logFile, { force: true })
    this.persist()
    console.error(`edx-services: 隧道已关闭（端口 ${tunnel.port}）`)
    this.onChange()
    if (!this.tunnels.size) this.stopListenTimer()
  }

  /** 失败后重试：同一端口重新建立（会得到新的公网地址）。 */
  async retry(id) {
    const tunnel = this.tunnels.get(id)
    if (!tunnel) throw new Error("隧道不存在")
    const { port, serviceId } = tunnel
    await this.stop(id)
    return this.start({ port, serviceId })
  }

  /** 宿主退出时同步终止全部隧道（exit 事件里不能等待）。 */
  stopAllSync() {
    for (const t of this.tunnels.values()) if (t.pid > 1) signal(t.pid, "SIGTERM")
    this.tunnels.clear()
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ tunnels: [] }))
    } catch {}
  }

  // ---- 记录与清理 ----------------------------------------------------------------

  persist() {
    const tunnels = [...this.tunnels.values()].filter((t) => t.pid > 1 && t.status !== "error").map((t) => ({ id: t.id, pid: t.pid, signature: t.signature }))
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ tunnels }))
    } catch (e) {
      console.error(`edx-services: 保存隧道记录失败：${e?.code ?? e?.message}`)
    }
  }

  /**
   * 进程确实是这条隧道的 cloudflared 才处理，防止 PID 被复用后误杀：
   * 优先认 EDX_TUNNEL_ID 环境标记；读不到环境变量时（受 SIP 保护的解释器等），
   * 退而要求命令行以 cloudflared 开头、并以当初启动的完整参数结尾。
   */
  async ownsPid(pid, id, signature) {
    const { stdout } = await exec("/bin/ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], 3000)
    if (stdout.includes("cloudflared") && stdout.includes(`EDX_TUNNEL_ID=${id}`)) return true
    if (!signature) return false
    const plain = (await exec("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], 3000)).stdout.trim()
    return plain.includes("cloudflared") && plain.endsWith(` ${signature}`)
  }

  /** 上次宿主异常退出时留下的隧道：一律结束，不接管。 */
  sweepStale() {
    let saved = []
    try {
      saved = JSON.parse(fs.readFileSync(this.stateFile, "utf8")).tunnels ?? []
    } catch {}
    for (const t of saved) {
      if (!(t?.pid > 1) || typeof t.id !== "string" || !pidAlive(t.pid)) continue
      this.ownsPid(t.pid, t.id, typeof t.signature === "string" ? t.signature : null).then((own) => {
        if (!own) return
        console.error(`edx-services: 结束上次遗留的隧道进程 ${t.pid}`)
        signal(t.pid, "SIGTERM")
        setTimeout(() => pidAlive(t.pid) && signal(t.pid, "SIGKILL"), 3000).unref?.()
      })
    }
    try {
      for (const f of fs.readdirSync(this.dir)) if (f.endsWith(".log")) fs.rmSync(path.join(this.dir, f), { force: true })
      fs.writeFileSync(this.stateFile, JSON.stringify({ tunnels: [] }))
    } catch {}
  }

  // ---- 端口监听状态 ----------------------------------------------------------------

  ensureListenTimer() {
    if (this.listenTimer) return
    this.listenTimer = setInterval(async () => {
      if (!this.tunnels.size) return this.stopListenTimer()
      const before = [...this.tunnels.values()].map((t) => this.listening.has(t.port)).join()
      this.listening = await listeningSockets()
      const after = [...this.tunnels.values()].map((t) => this.listening.has(t.port)).join()
      if (before !== after) this.onChange()
    }, LISTEN_REFRESH_MS)
    this.listenTimer.unref?.()
  }

  stopListenTimer() {
    clearInterval(this.listenTimer)
    this.listenTimer = null
  }
}
