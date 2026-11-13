// 进程相关的底层能力：用户 shell、进程发现、端口探测、信号、带超时的命令执行。
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import { execFile, spawn } from "node:child_process"

// 服务进程的环境标记；终止命令里也能读到 PID / 端口相关变量
export const SERVICE_ID_KEY = "LOCAL_SERVICE_ID"
export const INSTANCE_ID_KEY = "LOCAL_SERVICE_INSTANCE"
export const STOP_MARKER_KEY = "LOCAL_SERVICE_STOP"

// 唤醒过程中 ps 可能要十几秒才返回（实测一次 DarkWake 唤醒耗时约 14 秒）
const PS_TIMEOUT = 20_000

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

// 进程表环境变量扫描的轻量缓存：同一个 PID 在存活且命令行不变期间不会凭空获得新环境变量，
// 因此无关的宿主/系统/桌面进程只需在首次出现时查一次，后续无需重复触发跨进程 ps -E。
const envCache = new Map()
const ENV_BATCH_SIZE = 80
const SYSTEM_PREFIXES = ["/System/", "/usr/libexec/"]

export function clearEnvCache() {
  envCache.clear()
}

function isSystemDaemon(command) {
  return SYSTEM_PREFIXES.some((prefix) => command.startsWith(prefix))
}

function hasExactEnv(text, token) {
  let i = text.indexOf(token)
  while (i >= 0) {
    const before = text[i - 1]
    const after = text[i + token.length]
    if ((before === " " || before === undefined) && (after === " " || after === undefined)) return true
    i = text.indexOf(token, i + 1)
  }
  return false
}

function extractEnvMarkers(text) {
  const stopMarker = hasExactEnv(text, `${STOP_MARKER_KEY}=1`)
  const serviceIds = new Set()
  const prefix = `${SERVICE_ID_KEY}=`
  let i = text.indexOf(prefix)
  while (i >= 0) {
    const before = text[i - 1]
    if (before === " " || before === undefined) {
      let end = text.indexOf(" ", i + prefix.length)
      if (end < 0) end = text.length
      const val = text.slice(i + prefix.length, end)
      if (val) serviceIds.add(val)
    }
    i = text.indexOf(prefix, i + prefix.length)
  }
  return { stopMarker, serviceIds }
}

/**
 * 轻量核验已知 PID 是否仍然存在且命令行未发生 PID 复用（不带 -E，不触发跨进程环境变量读取）。
 * ps 超时或失败返回 null，调用方据此保持现状不误判。
 */
export async function verifyProcesses(pids) {
  const unique = [...new Set((pids ?? []).filter((p) => Number.isInteger(p) && p > 1))]
  if (!unique.length) return new Map()
  const { ok, stdout } = await exec("/bin/ps", ["-ww", "-o", "pid=,pgid=,command=", "-p", unique.join(",")], { timeout: PS_TIMEOUT })
  if (!ok) return null
  const out = new Map()
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const pgid = Number(m[2])
    const command = m[3]
    out.set(pid, { pid, pgid, name: processName(command), command })
  }
  return out
}

/**
 * 扫描当前所有进程，把属于各服务的进程找出来。
 * 识别依据：
 *  1. 环境变量 LOCAL_SERVICE_ID=<服务 id>（子孙进程都会继承）；
 *  2. 兜底：与启动 shell 同一进程组（/bin/sleep 这类受 SIP 保护的程序读不到环境变量），以及由已匹配父进程派生的子进程。
 * 带 LOCAL_SERVICE_STOP=1 的进程是终止命令自身，永远不算服务进程。
 *
 * 优化策略：
 *  - 先用单次无 -E 的 `ps -axo pid=,ppid=,pgid=,command=` 替代双全系统 ps；
 *  - 仅在 `scanEnv` 为 true 时，对未归属、非系统守护且未命中 `envCache` 的新增候选 PID 按批执行 `ps -E -p`；
 *  - 仅在 `includePorts` 为 true 且存在命中 PID 时调用 `lsof`。
 *
 * ps 失败（典型是系统从睡眠唤醒期间超时）时返回 null，而不是「一个进程都没有」：
 * 调用方必须把它当作「这次不知道」，否则会把仍在运行的服务误判为已结束。
 */
export async function scanProcesses(targets, { includePorts = true, scanEnv = true } = {}) {
  const result = new Map(targets.map((t) => [t.id, []]))
  if (!targets.length) return result
  const plain = await exec("/bin/ps", ["-ww", "-axo", "pid=,ppid=,pgid=,command="], { timeout: PS_TIMEOUT })
  // 正常情况下至少能看到宿主自己，输出为空同样说明这次扫描不可信
  if (!plain.ok || !plain.stdout.trim()) {
    console.error(`local-services: 进程扫描失败（ps 超时或出错），本次不更新服务状态`)
    return null
  }

  const self = process.pid
  const entries = []
  const livePids = new Set()
  for (const line of plain.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    const pgid = Number(m[3])
    const command = m[4]
    livePids.add(pid)
    if (pid === self) continue
    entries.push({ pid, ppid, pgid, command })
  }

  // 清理已经退出的旧 PID 缓存
  for (const cachedPid of envCache.keys()) {
    if (!livePids.has(cachedPid)) envCache.delete(cachedPid)
  }

  const targetById = new Map(targets.map((t) => [t.id, t]))
  const assigned = new Map() // pid -> targetId
  const excludedStop = new Set()
  // 进程组成员先暂存，确认这个组确实还属于该服务后再计入（防止 shell 退出很久后 pgid 被系统复用）
  const grouped = new Map(targets.map((t) => [t.id, { members: [], trusted: t.trustGroup === true }]))
  const infoOf = (e) => ({ pid: e.pid, ppid: e.ppid, pgid: e.pgid, name: processName(e.command), command: e.command, ports: [], sockets: [] })

  const envCandidates = []
  for (const e of entries) {
    const cached = envCache.get(e.pid)
    const cacheValid = cached && cached.command === e.command
    if (cacheValid && cached.stopMarker) {
      excludedStop.add(e.pid)
      continue
    }
    if (cacheValid && cached.serviceIds.size) {
      let matched = null
      for (const t of targets) {
        if (cached.serviceIds.has(t.id)) {
          matched = t
          break
        }
      }
      if (matched) {
        assigned.set(e.pid, matched.id)
        result.get(matched.id).push(infoOf(e))
        if (matched.pgid > 1 && e.pgid === matched.pgid) grouped.get(matched.id).trusted = true
        continue
      }
    }

    let inGroup = false
    for (const t of targets) {
      if (t.pgid > 1 && e.pgid === t.pgid) {
        const g = grouped.get(t.id)
        g.members.push(e)
        if (e.pid === t.pgid && t.leaderCommand && squash(e.command) === squash(t.leaderCommand)) g.trusted = true
        inGroup = true
        break
      }
    }

    if (scanEnv && !cacheValid && !isSystemDaemon(e.command)) {
      // 已明确属于可信组且不是需要进一步确认的（不可能同时带 STOP_MARKER，因为 stop 使用独立 detached 进程组）可跳过 -E，
      // 其余未知进程或未验证进程组仅按批次做定向 ps -E -p
      if (!inGroup) envCandidates.push(e)
    }
  }

  if (scanEnv && envCandidates.length) {
    const candByPid = new Map(envCandidates.map((e) => [e.pid, e]))
    for (let i = 0; i < envCandidates.length; i += ENV_BATCH_SIZE) {
      const batch = envCandidates.slice(i, i + ENV_BATCH_SIZE).map((e) => e.pid)
      const envRes = await exec("/bin/ps", ["-E", "-ww", "-o", "pid=,command=", "-p", batch.join(",")], { timeout: PS_TIMEOUT })
      if (!envRes.ok) continue
      for (const line of envRes.stdout.split("\n")) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/)
        if (!m) continue
        const pid = Number(m[1])
        const rest = m[2]
        const entry = candByPid.get(pid)
        if (!entry) continue
        const markers = extractEnvMarkers(rest)
        envCache.set(pid, { command: entry.command, ...markers })
        if (markers.stopMarker) {
          excludedStop.add(pid)
          continue
        }
        for (const t of targets) {
          if (markers.serviceIds.has(t.id)) {
            assigned.set(pid, t.id)
            result.get(t.id).push(infoOf(entry))
            if (t.pgid > 1 && entry.pgid === t.pgid) grouped.get(t.id).trusted = true
            break
          }
        }
      }
    }
  }

  for (const t of targets) {
    const g = grouped.get(t.id)
    if (!g.trusted) continue
    for (const e of g.members) {
      if (excludedStop.has(e.pid) || assigned.has(e.pid)) continue
      assigned.set(e.pid, t.id)
      result.get(t.id).push(infoOf(e))
    }
  }

  // 沿父进程链路把已归属进程的直接/间接子进程一并纳入（无需额外 ps -E）
  let propagated = true
  while (propagated) {
    propagated = false
    for (const e of entries) {
      if (assigned.has(e.pid) || excludedStop.has(e.pid)) continue
      const parentService = assigned.get(e.ppid)
      if (!parentService || !targetById.has(parentService)) continue
      assigned.set(e.pid, parentService)
      result.get(parentService).push(infoOf(e))
      propagated = true
    }
  }

  if (includePorts) {
    const pids = [...result.values()].flat().map((p) => p.pid)
    if (pids.length) {
      const sockets = await listeningPorts(pids)
      for (const list of result.values()) {
        for (const p of list) {
          const own = sockets.get(p.pid) ?? []
          p.ports = [...new Set(own.map((x) => x.port))].sort((a, b) => a - b)
          p.sockets = own
        }
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
