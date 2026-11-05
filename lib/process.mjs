// 进程相关的底层能力：用户 shell、进程发现、端口探测、信号、带超时的命令执行。
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import { execFile, spawn } from "node:child_process"

// 服务进程的环境标记；终止命令里也能读到 PID / 端口相关变量
export const SERVICE_ID_KEY = "LOCAL_SERVICE_ID"
export const INSTANCE_ID_KEY = "LOCAL_SERVICE_INSTANCE"
export const STOP_MARKER_KEY = "LOCAL_SERVICE_STOP"

let shellCache = null

/** 用户的登录 shell：GUI 进程未必继承 SHELL，先查账户信息。 */
export function userShell() {
  if (shellCache) return shellCache
  const candidates = []
  try {
    candidates.push(os.userInfo().shell)
  } catch {}
  candidates.push(process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh")
  shellCache = candidates.find((s) => typeof s === "string" && s && fs.existsSync(s)) ?? "/bin/sh"
  return shellCache
}

/** 交互式登录 shell，确保 .zshrc / .zprofile 里的 PATH 和别名生效。 */
export function shellArgs(command) {
  return ["-i", "-l", "-c", command]
}

export function expandHome(p) {
  if (!p) return p
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  return p
}

function exec(file, args, { timeout = 5000, maxBuffer = 64 << 20 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer }, (error, stdout) => {
      // lsof 没有匹配时退出码为 1，也算正常结果
      resolve({ ok: !error || error.code === 1, stdout: String(stdout ?? "") })
    })
  })
}

/**
 * 扫描当前所有进程，把属于各服务的进程找出来。
 * 识别依据：
 *  1. 环境变量 LOCAL_SERVICE_ID=<服务 id>（子孙进程都会继承）；
 *  2. 兜底：与启动 shell 同一进程组（/bin/sleep 这类受 SIP 保护的程序读不到环境变量）。
 * 带 LOCAL_SERVICE_STOP=1 的进程是终止命令自身，永远不算服务进程。
 */
export async function scanProcesses(targets, { includePorts = true } = {}) {
  const result = new Map(targets.map((t) => [t.id, []]))
  if (!targets.length) return result
  const [withEnv, plain] = await Promise.all([
    exec("/bin/ps", ["-E", "-ww", "-axo", "pid=,pgid=,command="]),
    exec("/bin/ps", ["-ww", "-axo", "pid=,command="]),
  ])
  if (!withEnv.ok) return result

  const commands = new Map()
  for (const line of plain.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/)
    if (m) commands.set(Number(m[1]), m[2])
  }

  const self = process.pid
  // 进程组成员先暂存，确认这个组确实还属于该服务后再计入（防止 shell 退出很久后 pgid 被系统复用）
  const grouped = new Map(targets.map((t) => [t.id, { members: [], trusted: t.trustGroup === true }]))
  for (const line of withEnv.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const pgid = Number(m[2])
    const rest = m[3]
    if (pid === self) continue
    if (rest.includes(` ${STOP_MARKER_KEY}=1`)) continue
    const command = commands.get(pid) ?? rest
    const info = { pid, pgid, name: processName(command), command, ports: [], sockets: [] }
    for (const t of targets) {
      if (hasMarker(rest, t.id)) {
        result.get(t.id).push(info)
        if (t.pgid > 1 && pgid === t.pgid) grouped.get(t.id).trusted = true
        break
      }
      if (t.pgid > 1 && pgid === t.pgid) {
        const g = grouped.get(t.id)
        g.members.push(info)
        // 组长的命令行与当初启动的 shell 完全一致，才说明这个组没有被复用
        // ps 会把换行等不可打印字符替换掉，比较前去掉所有空白与不可打印字符
        if (pid === t.pgid && t.leaderCommand && squash(command) === squash(t.leaderCommand)) g.trusted = true
        break
      }
    }
  }
  for (const t of targets) {
    const g = grouped.get(t.id)
    if (g.trusted) result.get(t.id).push(...g.members)
  }

  if (includePorts) {
    const pids = [...result.values()].flat().map((p) => p.pid)
    const sockets = await listeningPorts(pids)
    for (const list of result.values()) {
      for (const p of list) {
        const own = sockets.get(p.pid) ?? []
        p.ports = [...new Set(own.map((x) => x.port))].sort((a, b) => a - b)
        p.sockets = own
      }
    }
  }
  return result
}

function squash(text) {
  return String(text).replace(/[^\x21-\x7e]+/g, "")
}

/** 启动 shell 在 ps 里显示的命令行，用于确认进程组仍属于该服务。 */
export function leaderCommandFor(command) {
  return [userShell(), ...shellArgs(command)].join(" ")
}

function hasMarker(text, id) {
  const needle = `${SERVICE_ID_KEY}=${id}`
  let i = text.indexOf(needle)
  while (i >= 0) {
    const before = text[i - 1]
    const after = text[i + needle.length]
    if ((before === " " || before === undefined) && (after === " " || after === undefined)) return true
    i = text.indexOf(needle, i + 1)
  }
  return false
}

function processName(command) {
  const first = String(command).trim().split(/\s+/)[0] ?? ""
  return path.basename(first) || first
}

/** 一次 lsof 调用解析出每个 pid 监听的 TCP 套接字：[{ host, port }]，host 为 lsof 给出的绑定地址。 */
export async function listeningPorts(pids) {
  const out = new Map()
  if (!pids.length) return out
  const { stdout } = await exec("/usr/sbin/lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(","), "-Fpn"], { timeout: 4000 })
  let current = null
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      current = Number(line.slice(1))
      if (!out.has(current)) out.set(current, [])
    } else if (line.startsWith("n") && current !== null) {
      const m = line.slice(1).match(/^(.*):(\d+)$/)
      if (!m) continue
      const entry = { host: m[1], port: Number(m[2]) }
      const list = out.get(current)
      if (!list.some((x) => x.host === entry.host && x.port === entry.port)) list.push(entry)
    }
  }
  return out
}

const WILDCARD_HOSTS = new Set(["*", "0.0.0.0", "[::]", "::"])

/**
 * 把监听套接字换成可以直接访问的地址，每个端口一个：
 * 监听全部网卡或 127.0.0.1 时用 http://127.0.0.1:端口；只监听其他地址（如 [::1]、局域网 IP）时用该地址。
 */
export function addressesOf(sockets) {
  const byPort = new Map()
  for (const { host, port } of sockets) {
    const local = WILDCARD_HOSTS.has(host) || host === "127.0.0.1" || host === "localhost"
    const prev = byPort.get(port)
    if (!prev || (local && !prev.local)) byPort.set(port, { local, host: local ? "127.0.0.1" : host })
  }
  return [...byPort.entries()].sort((a, b) => a[0] - b[0]).map(([port, { host }]) => `http://${host}:${port}`)
}

export function pidAlive(pid) {
  if (!(pid > 1)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === "EPERM"
  }
}

export function signal(pid, sig) {
  if (!(pid > 1) || pid === process.pid) return
  try {
    process.kill(pid, sig)
  } catch {}
}

/** 给整个进程组发信号（负 pid）。 */
export function signalGroup(pgid, sig) {
  if (!(pgid > 1) || pgid === process.pid) return
  try {
    process.kill(-pgid, sig)
  } catch {}
}

/**
 * 在登录 shell 中运行一条命令直到结束。
 * - logFile 给出时输出直接写入该文件（用于终止命令、更新命令，便于在日志里查看）；否则收集到内存（最多 1MB）。
 * - 超时后终止整个进程组。
 */
export function runShell(command, { cwd, env, timeoutMs, logFile } = {}) {
  return new Promise((resolve) => {
    const fd = logFile ? fs.openSync(logFile, "a") : null
    let child
    try {
      child = spawn(userShell(), shellArgs(command), {
        cwd: cwd || undefined,
        env,
        detached: true,
        stdio: fd !== null ? ["ignore", fd, fd] : ["ignore", "pipe", "pipe"],
      })
    } catch (e) {
      if (fd !== null) fs.closeSync(fd)
      resolve({ exitCode: -1, timedOut: false, output: "", launchError: e?.message ?? String(e) })
      return
    }
    if (fd !== null) fs.closeSync(fd)

    let output = ""
    const collect = (d) => {
      if (output.length < 1 << 20) output += d
    }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      signalGroup(child.pid, "SIGTERM")
      setTimeout(() => signalGroup(child.pid, "SIGKILL"), 1500)
    }, timeoutMs ?? 30_000)

    child.on("error", (e) => {
      clearTimeout(timer)
      resolve({ exitCode: -1, timedOut: false, output, launchError: e?.message ?? String(e) })
    })
    child.on("close", (code, sig) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : -1), timedOut, output })
    })
  })
}
