// 本地服务的生命周期管理：增删改、启动/停止/重启、进程追踪、日志、更新检查。
// 设计要点：
//  - 服务以独立进程组启动、输出直接写日志文件，所以 magpie 重启或插件开关（宿主重启）时服务不会中断，
//    新宿主启动后按 runtime.json 与进程标记重新接管。
//  - 自动启动每个 magpie 会话只执行一次（宿主重启不算新会话），避免把用户手动停掉的服务又拉起来。
import fs from "node:fs"
import os from "node:os"
import { spawn, execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { Store, isValidHomepage, normalizeService } from "./store.mjs"
import * as proc from "./process.mjs"
import { TunnelManager } from "./tunnel.mjs"
import { checkLatestRelease, isPlausibleToken, resolveToken, setConfiguredToken, verifyToken } from "./github.mjs"
import { effectiveVersionCommand, extractVersion, isUpdateAvailable, normalizeRepository, trimmed, versionCommandCandidates } from "./version.mjs"

const TICK_MS = 3000
const LOG_TRIM_AT = 16 << 20
const LOG_KEEP = 2 << 20
const STOP_COMMAND_TIMEOUT = 30_000
const STOP_SETTLE_TIMEOUT = 5_000
const TERMINATE_TIMEOUT = 3_000
const VERSION_TIMEOUT = 10_000
const PROBE_TIMEOUT = 8_000
const QUEUE_SETTLE_MS = 1_500
const UPDATE_TIMEOUT = 300_000
const RECENT_CHECK_MS = 30 * 60 * 1000
const GROUP_TRUST_MS = 60_000

const ACTIVE = new Set(["starting", "running", "stopping"])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function blankRuntime() {
  return {
    status: "stopped",
    pid: null,
    pgid: null,
    instanceId: null,
    launchedCommand: null,
    startedAt: null,
    lastExitCode: null,
    lastError: null,
    detached: false,
    processes: [],
    shellExited: false,
    expectedExit: false,
    // 最近一次确认进程组仍有成员的时间：组内还有进程时 pgid 不会被系统复用，据此延续对进程组的信任
    groupSeenAt: null,
  }
}

function clock() {
  return new Date().toTimeString().slice(0, 8)
}

function parentStartTime(pid) {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 3000 }, (e, out) => resolve(e ? null : String(out).trim() || null))
  })
}

export class ServiceManager {
  constructor(directory) {
    this.store = new Store(directory)
    setConfiguredToken(this.store.readGithubToken())
    this.tunnels = new TunnelManager(this.store)
    this.runtimes = new Map()
    this.children = new Map()
    this.stopTasks = new Map()
    this.updateStates = new Map()
    this.rateLimitedUntil = 0
    this.session = null
    this.timer = null
    this.ticking = false
    this.tickAgain = false
    this.updateTimer = null
    this.initialCheckTimer = null
    this.ticks = 0
    // 接管完成前不接受操作：否则可能把仍在运行、尚未接管的服务再启动一份
    this.ready = new Promise((resolve) => (this.markReady = resolve))
  }

  // ---- 查询 ----------------------------------------------------------------

  rt(id) {
    let r = this.runtimes.get(id)
    if (!r) {
      r = blankRuntime()
      this.runtimes.set(id, r)
    }
    return r
  }

  view(id) {
    const svc = this.store.get(id)
    if (!svc) return null
    const r = this.rt(id)
    const ports = [...new Set(r.processes.flatMap((p) => p.ports))].sort((a, b) => a - b)
    const addresses = proc.addressesOf(r.processes.flatMap((p) => p.sockets ?? []))
    return {
      ...svc,
      runtime: {
        status: r.status,
        pid: r.pid,
        startedAt: r.startedAt,
        lastExitCode: r.lastExitCode,
        lastError: r.lastError,
        detached: r.detached,
        processes: r.processes.map(({ pid, name, command, ports }) => ({ pid, name, command, ports })),
        ports,
        addresses,
        commandChanged: ACTIVE.has(r.status) && r.launchedCommand !== null && r.launchedCommand !== svc.command,
      },
      update: {
        available: isUpdateAvailable(svc),
        defaultVersionCommand: effectiveVersionCommand({ ...svc, versionCommand: null }),
        ...(this.updateStates.get(id) ?? { checking: false, updating: false, message: null }),
      },
    }
  }

  state() {
    return {
      services: this.store.services.map((s) => this.view(s.id)),
      settings: this.store.settings,
      rateLimitedUntil: this.rateLimitedUntil > Date.now() ? new Date(this.rateLimitedUntil).toISOString() : null,
      tunnels: this.tunnels.list(),
      // null 表示还没检测完
      cloudflared: this.tunnels.install,
    }
  }

  // ---- 增删改 ----------------------------------------------------------------

  validate(svc) {
    if (!svc.name) throw new Error("名称不能为空")
    if (!svc.command) throw new Error("命令不能为空")
    if (svc.homepage && !isValidHomepage(svc.homepage)) throw new Error("首页地址应为有效的 http(s) 地址")
    if (svc.githubRepository && !normalizeRepository(svc.githubRepository)) throw new Error("GitHub 仓库格式无效，应为 owner/repo")
    const dup = this.store.services.find((s) => s.id !== svc.id && s.name.toLowerCase() === svc.name.toLowerCase())
    if (dup) throw new Error("已有同名服务")
  }

  create(input) {
    const svc = normalizeService(input, { keepId: false })
    this.validate(svc)
    this.store.services.push(svc)
    this.store.save()
    return this.view(svc.id)
  }

  update(id, input) {
    const idx = this.store.services.findIndex((s) => s.id === id)
    if (idx < 0) throw new Error("服务不存在")
    const prev = this.store.services[idx]
    // 运行时字段（更新状态、忽略版本、导入来源）不由编辑表单覆盖
    const next = normalizeService({ ...prev, ...input, id, updateStatus: prev.updateStatus, ignoredVersion: prev.ignoredVersion })
    this.validate(next)
    // 仓库变了，旧的 Release 缓存与 ETag 不再适用
    if (normalizeRepository(next.githubRepository) !== normalizeRepository(prev.githubRepository)) {
      next.updateStatus = null
      next.ignoredVersion = null
    }
    this.store.services[idx] = next
    this.store.save()
    return this.view(id)
  }

  duplicate(id) {
    const src = this.store.get(id)
    if (!src) throw new Error("服务不存在")
    let name = `${src.name} 副本`
    for (let n = 2; this.store.services.some((s) => s.name.toLowerCase() === name.toLowerCase()); n++) name = `${src.name} 副本 ${n}`
    // 不复制运行状态、已忽略版本、远端更新缓存；副本默认不自动启动
    const copy = normalizeService({ ...src, name, autoStart: false, ignoredVersion: null, updateStatus: null }, { keepId: false })
    const idx = this.store.services.findIndex((s) => s.id === id)
    this.store.services.splice(idx + 1, 0, copy)
    this.store.save()
    return this.view(copy.id)
  }

  /**
   * 删除服务并返回它的完整配置与原位置，供面板「撤销」使用。
   * 日志先改名为 .trash 而不是直接删除：撤销时可以连日志一起恢复；宿主下次启动时清理。
   */
  async remove(id) {
    const svc = this.store.get(id)
    if (!svc) throw new Error("服务不存在")
    await this.stop(id)
    const index = this.store.services.findIndex((s) => s.id === id)
    this.store.services = this.store.services.filter((s) => s.id !== id)
    this.store.save()
    this.runtimes.delete(id)
    this.updateStates.delete(id)
    try {
      fs.renameSync(this.store.logPath(id), `${this.store.logPath(id)}.trash`)
    } catch (e) {
      if (e?.code !== "ENOENT") fs.rmSync(this.store.logPath(id), { force: true })
    }
    this.persistRuntime()
    return { service: svc, index }
  }

  /** 撤销删除：按原 id 放回原位置（不会自动启动，删除时已停止的进程保持停止）。 */
  restore(raw, index) {
    const svc = normalizeService(raw)
    if (this.store.get(svc.id)) throw new Error("服务已存在")
    this.validate(svc)
    const at = Number.isInteger(index) ? Math.min(Math.max(index, 0), this.store.services.length) : this.store.services.length
    this.store.services.splice(at, 0, svc)
    this.store.save()
    try {
      fs.renameSync(`${this.store.logPath(svc.id)}.trash`, this.store.logPath(svc.id))
    } catch {}
    this.log(svc.id, "已撤销删除")
    return this.view(svc.id)
  }

  reorder(ids) {
    if (!Array.isArray(ids)) throw new Error("ids 必须是数组")
    const byId = new Map(this.store.services.map((s) => [s.id, s]))
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean)
    const rest = this.store.services.filter((s) => !ids.includes(s.id))
    this.store.services = [...ordered, ...rest]
    this.store.save()
  }

  // ---- 日志 ----------------------------------------------------------------

  log(id, text) {
    try {
      const lines = String(text).split("\n").map((l) => `▸ ${clock()} ${l}`).join("\n")
      fs.appendFileSync(this.store.logPath(id), `${lines}\n`)
    } catch (e) {
      console.error(`local-services: 写日志失败 ${id}: ${e?.message ?? e}`)
    }
  }

  /** 读取日志：给 offset 时返回其后的增量；否则返回末尾约 256KB（按行对齐）。 */
  readLogs(id, offset) {
    const file = this.store.logPath(id)
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      return { text: "", offset: 0, reset: true }
    }
    const incremental = Number.isFinite(offset) && offset >= 0 && offset <= size
    // 不是增量读取（首次加载，或文件被清空/截断过）时取末尾一段，前端整段替换
    const start = incremental ? offset : Math.max(0, size - 256 * 1024)
    const len = Math.min(size - start, 4 << 20)
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(file, "r")
    try {
      fs.readSync(fd, buf, 0, len, start)
    } finally {
      fs.closeSync(fd)
    }
    let text = buf.toString("utf8")
    if (!incremental && start > 0) {
      const nl = text.indexOf("\n")
      text = nl >= 0 ? text.slice(nl + 1) : ""
    }
    return { text, offset: start + len, reset: !incremental }
  }

  clearLogs(id) {
    // 截断而不是删除：服务进程仍以追加方式持有该文件
    try {
      fs.truncateSync(this.store.logPath(id), 0)
    } catch {}
  }

  trimLog(id) {
    const file = this.store.logPath(id)
    try {
      const { size } = fs.statSync(file)
      if (size <= LOG_TRIM_AT) return
      const keep = Buffer.alloc(LOG_KEEP)
      const fd = fs.openSync(file, "r+")
      try {
        fs.readSync(fd, keep, 0, LOG_KEEP, size - LOG_KEEP)
        fs.ftruncateSync(fd, 0)
        fs.writeSync(fd, keep, 0, LOG_KEEP, 0)
      } finally {
        fs.closeSync(fd)
      }
    } catch {}
  }

  // ---- 启动 / 停止 ------------------------------------------------------------

  baseEnv(svc) {
    return { ...process.env, ...svc.environment }
  }

  cwdFor(svc) {
    return svc.workingDirectory ? proc.expandHome(svc.workingDirectory.trim()) : os.homedir()
  }

  fail(id, message) {
    const r = this.rt(id)
    Object.assign(r, blankRuntime(), { status: "failed", lastError: message, lastExitCode: r.lastExitCode })
    this.log(id, message)
    this.persistRuntime()
  }

  async start(id) {
    const svc = this.store.get(id)
    if (!svc) throw new Error("服务不存在")
    const r = this.rt(id)
    if (ACTIVE.has(r.status)) return this.view(id)
    if (!svc.command) {
      this.fail(id, "命令为空")
      return this.view(id)
    }
    const cwd = this.cwdFor(svc)
    if (!fs.existsSync(cwd)) {
      this.fail(id, `工作目录不存在：${cwd}`)
      return this.view(id)
    }

    this.trimLog(id)
    const instanceId = randomUUID()
    Object.assign(r, blankRuntime(), { status: "starting", instanceId, launchedCommand: svc.command })
    this.log(id, `$ ${svc.command}`)

    // 标记放在用户变量之后，避免被覆盖；所有子孙进程都会继承，用于在 shell 退出后找回后台进程
    const env = { ...this.baseEnv(svc), [proc.SERVICE_ID_KEY]: id, [proc.INSTANCE_ID_KEY]: instanceId }
    const fd = fs.openSync(this.store.logPath(id), "a")
    let child
    try {
      // detached：独立会话与进程组。宿主退出时服务不受影响，停止时可以整组发信号
      child = spawn(proc.userShell(), proc.shellArgs(svc.command), { cwd, env, detached: true, stdio: ["ignore", fd, fd] })
    } catch (e) {
      fs.closeSync(fd)
      this.fail(id, `启动失败：${e?.message ?? e}`)
      return this.view(id)
    }
    fs.closeSync(fd)

    const spawned = await new Promise((resolve) => {
      child.once("spawn", () => resolve(null))
      child.once("error", (e) => resolve(e))
    })
    // spawn 之后的 error（例如向已退出进程发信号）不应让宿主崩溃
    child.on("error", () => {})
    if (spawned) {
      if (r.instanceId === instanceId) this.fail(id, `启动失败：${spawned.message}`)
      return this.view(id)
    }
    child.unref()
    child.on("exit", (code, sig) => this.onShellExit(id, instanceId, code, sig))
    this.children.set(id, child)

    if (r.instanceId !== instanceId) return this.view(id)
    Object.assign(r, { status: "running", pid: child.pid, pgid: child.pid, startedAt: new Date().toISOString(), groupSeenAt: Date.now() })
    this.persistRuntime()
    this.ensureMonitor()
    this.tickSoon()
    return this.view(id)
  }

  onShellExit(id, instanceId, code, sig) {
    const r = this.runtimes.get(id)
    if (!r || r.instanceId !== instanceId) return
    this.children.delete(id)
    r.shellExited = true
    r.lastExitCode = code ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : null)
    this.tickSoon()
  }

  childAlive(id) {
    const c = this.children.get(id)
    return !!c && c.exitCode === null && c.signalCode === null
  }

  target(id) {
    const r = this.rt(id)
    return {
      id,
      pgid: r.pgid,
      leaderCommand: r.launchedCommand ? proc.leaderCommandFor(r.launchedCommand) : null,
      trustGroup: this.childAlive(id) || (r.groupSeenAt !== null && Date.now() - r.groupSeenAt < GROUP_TRUST_MS),
    }
  }

  /** 返回该服务的进程列表；扫描失败时返回 null（不知道），调用方不能把它当成「没有进程」。 */
  async scanOne(id, includePorts = false) {
    const found = await proc.scanProcesses([this.target(id)], { includePorts })
    return found ? found.get(id) ?? [] : null
  }

  async stop(id) {
    const running = this.stopTasks.get(id)
    if (running) return running
    const r = this.rt(id)
    if (!ACTIVE.has(r.status)) {
      if (r.status === "failed") Object.assign(r, { status: "stopped", lastError: null })
      return
    }
    const task = this.doStop(id).finally(() => this.stopTasks.delete(id))
    this.stopTasks.set(id, task)
    return task
  }

  async doStop(id) {
    const r = this.rt(id)
    const svc = this.store.get(id)
    const instanceId = r.instanceId
    r.status = "stopping"
    r.expectedExit = true
    this.log(id, "正在停止…")

    const stopCommand = trimmed(svc?.stopCommand)
    if (stopCommand) {
      await this.runStopCommand(svc, stopCommand, r)
    }
    // 先让 shell 优雅退出，再处理所有带标记的后台进程
    if (this.childAlive(id)) this.children.get(id).kill("SIGTERM")
    await this.terminateAll(id, TERMINATE_TIMEOUT)

    if (r.instanceId !== instanceId) return
    const exit = r.lastExitCode
    Object.assign(r, blankRuntime(), { status: "stopped", lastExitCode: exit })
    this.children.delete(id)
    this.log(id, "已停止")
    this.persistRuntime()
  }

  /** 执行终止命令；结束后最多再等 5 秒让进程自行退出，仍有存活则交给强制终止。 */
  async runStopCommand(svc, stopCommand, r) {
    const current = (await this.scanOne(svc.id, true)) ?? []
    const pids = current.map((p) => p.pid)
    const ports = [...new Set(current.flatMap((p) => p.ports))].sort((a, b) => a - b)
    const env = {
      ...this.baseEnv(svc),
      [proc.SERVICE_ID_KEY]: svc.id,
      ...(r.instanceId ? { [proc.INSTANCE_ID_KEY]: r.instanceId } : {}),
      // 终止命令自身带此标记，进程发现会排除它
      [proc.STOP_MARKER_KEY]: "1",
      LOCAL_SERVICE_PID: String(r.pid ?? pids[0] ?? ""),
      LOCAL_SERVICE_PIDS: pids.join(" "),
      LOCAL_SERVICE_PORTS: ports.join(" "),
    }
    this.log(svc.id, `$ ${stopCommand}`)
    const out = await proc.runShell(stopCommand, { cwd: this.cwdFor(svc), env, timeoutMs: STOP_COMMAND_TIMEOUT, logFile: this.store.logPath(svc.id) })
    if (out.launchError) this.log(svc.id, `终止命令无法启动：${out.launchError}`)
    else if (out.timedOut) this.log(svc.id, `终止命令超过 ${STOP_COMMAND_TIMEOUT / 1000} 秒未结束，已中止`)
    else if (out.exitCode !== 0) this.log(svc.id, `终止命令退出码 ${out.exitCode}`)

    const deadline = Date.now() + STOP_SETTLE_TIMEOUT
    for (;;) {
      const alive = await this.scanOne(svc.id)
      if (alive && !alive.length && !this.childAlive(svc.id)) return
      if (Date.now() >= deadline) break
      await sleep(300)
    }
    this.log(svc.id, "终止命令执行后仍有进程存活，改为直接终止")
  }

  /** SIGTERM 所有归属进程（含进程组），超时后对幸存者 SIGKILL。 */
  async terminateAll(id, timeout) {
    const r = this.rt(id)
    const first = await this.scanOne(id)
    // 进程组只有在扫描确认仍属于该服务时才整组发信号；扫描失败时退回到监控记录的信任状态
    const groupTrusted = r.pgid > 1 && (first ? first.some((p) => p.pgid === r.pgid) : this.target(id).trustGroup)
    // 扫描失败时沿用最近一次监控看到的进程，不能当作已全部退出
    let found = first ?? r.processes
    const gone = (list) => list !== null && !list.length && !this.childAlive(id)
    const send = (sig) => {
      for (const p of found) proc.signal(p.pid, sig)
      if (groupTrusted) proc.signalGroup(r.pgid, sig)
      if (this.childAlive(id)) this.children.get(id).kill(sig)
    }
    if (gone(first)) return
    send("SIGTERM")
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await sleep(250)
      const next = await this.scanOne(id)
      if (gone(next)) return
      if (next) found = next
    }
    this.log(id, `进程未在 ${timeout / 1000} 秒内退出，强制结束`)
    send("SIGKILL")
    await sleep(300)
  }

  async restart(id) {
    if (!this.store.get(id)) throw new Error("服务不存在")
    await this.stop(id)
    return this.start(id)
  }

  // ---- 监控 ----------------------------------------------------------------

  ensureMonitor() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  tickSoon() {
    setTimeout(() => this.tick(), 400)
  }

  async tick() {
    if (this.ticking) {
      this.tickAgain = true
      return
    }
    this.ticking = true
    try {
      this.ticks++
      const ids = [...this.runtimes.entries()].filter(([, r]) => r.status === "running" || r.status === "stopping").map(([id]) => id)
      if (ids.length) {
        const snapshot = new Map(ids.map((id) => [id, this.rt(id).instanceId]))
        const found = await proc.scanProcesses(ids.map((id) => this.target(id)))
        // 扫描失败（如睡眠唤醒时 ps 超时）：保持现状，下一轮再判断
        if (!found) return
        let changed = false
        for (const id of ids) {
          const r = this.rt(id)
          // 扫描期间实例已更换（重启/停止），这次结果作废
          if (r.instanceId !== snapshot.get(id)) continue
          const procs = found.get(id) ?? []
          r.processes = procs
          if (r.pgid > 1 && procs.some((p) => p.pgid === r.pgid)) r.groupSeenAt = Date.now()
          if (r.status !== "running") continue
          const shellAlive = this.children.has(id) ? this.childAlive(id) : !r.shellExited && r.pid !== null && procs.some((p) => p.pid === r.pid)
          if (!shellAlive) r.shellExited = true
          if (shellAlive) r.detached = false
          else if (procs.length) r.detached = true
          else {
            this.finishInstance(id, r)
            changed = true
          }
        }
        // 定期保存 groupSeenAt，宿主重启后据此继续追踪只剩系统程序的进程组
        if (changed || this.ticks % 5 === 0) this.persistRuntime()
      }
      // 大约每分钟检查一次日志体积
      if (this.ticks % 20 === 0) for (const s of this.store.services) this.trimLog(s.id)
    } catch (e) {
      console.error(`local-services: 监控出错：${e?.stack ?? e}`)
    } finally {
      this.ticking = false
    }
    if (this.tickAgain) {
      this.tickAgain = false
      this.tickSoon()
    }
  }

  /** shell 与所有后台进程都已退出：非预期且退出码非 0 记为失败。 */
  finishInstance(id, r) {
    const code = r.lastExitCode
    if (!r.expectedExit && code !== null && code !== 0) {
      Object.assign(r, blankRuntime(), { status: "failed", lastExitCode: code, lastError: `进程异常退出，退出码 ${code}` })
      this.log(id, r.lastError)
    } else {
      Object.assign(r, blankRuntime(), { status: "stopped", lastExitCode: code })
      this.log(id, code === null ? "进程已结束" : `进程已退出，退出码 ${code}`)
    }
    this.children.delete(id)
  }

  persistRuntime() {
    const instances = {}
    // 失败状态也保存下来，宿主重启后仍能看到上次为什么失败
    const failures = {}
    for (const [id, r] of this.runtimes) {
      if (r.status === "failed") failures[id] = { lastExitCode: r.lastExitCode, lastError: r.lastError }
      if (!ACTIVE.has(r.status) || !r.instanceId) continue
      instances[id] = { pid: r.pid, pgid: r.pgid, instanceId: r.instanceId, launchedCommand: r.launchedCommand, startedAt: r.startedAt, shellExited: r.shellExited, groupSeenAt: r.groupSeenAt }
    }
    try {
      this.store.writeRuntime({ session: this.session, instances, failures })
    } catch (e) {
      console.error(`local-services: 保存运行时失败：${e?.message ?? e}`)
    }
  }

  // ---- 启动接管 ----------------------------------------------------------------

  /**
   * 宿主成为主实例后调用：接管上一个宿主留下的服务进程，必要时执行自动启动，并开启更新检查。
   */
  async boot() {
    try {
      await this.adopt()
    } finally {
      this.markReady()
    }
    this.scheduleUpdateChecks(true)
    this.tunnels.detect().catch(() => {})
  }

  async adopt() {
    const saved = this.store.readRuntime()
    for (const [id, f] of Object.entries(saved.failures)) {
      if (this.store.get(id) && f) Object.assign(this.rt(id), blankRuntime(), { status: "failed", lastExitCode: f.lastExitCode ?? null, lastError: f.lastError ?? null })
    }
    for (const [id, inst] of Object.entries(saved.instances)) {
      if (!this.store.get(id) || !inst?.instanceId) continue
      Object.assign(this.rt(id), blankRuntime(), {
        status: "running",
        pid: inst.pid ?? null,
        pgid: inst.pgid ?? null,
        instanceId: inst.instanceId,
        launchedCommand: inst.launchedCommand ?? null,
        startedAt: inst.startedAt ?? null,
        shellExited: inst.shellExited === true || !proc.pidAlive(inst.pid),
        groupSeenAt: Number.isFinite(inst.groupSeenAt) ? inst.groupSeenAt : null,
        expectedExit: false,
      })
    }

    // 没有运行时记录、但仍有带标记进程的服务（例如运行时文件丢失）也接管过来
    const unknown = this.store.services.filter((s) => !ACTIVE.has(this.rt(s.id).status)).map((s) => ({ id: s.id, pgid: null }))
    if (unknown.length) {
      const found = (await proc.scanProcesses(unknown, { includePorts: false })) ?? new Map()
      for (const [id, list] of found) {
        if (!list.length) continue
        Object.assign(this.rt(id), blankRuntime(), { status: "running", instanceId: randomUUID(), shellExited: true, detached: true, processes: list })
        this.log(id, "发现仍在运行的服务进程，已接管")
      }
    }

    // 同一个 magpie 进程内的宿主重启不算新会话
    const ppid = process.ppid
    this.session = { ppid, started: await parentStartTime(ppid) }
    const sameSession = saved.session && saved.session.ppid === this.session.ppid && saved.session.started === this.session.started
    this.persistRuntime()
    this.ensureMonitor()
    await this.tick()

    if (!sameSession) this.autoStart().catch((e) => console.error(`local-services: 自动启动出错：${e?.stack ?? e}`))
  }

  /**
   * 按启动队列自动启动：队列号小的先启动；一个队列里的服务全部启动（进程已运行）后，
   * 再观察片刻确认没有立即崩溃，才开始下一个队列。失败的服务不阻塞后面的队列。
   */
  async autoStart() {
    const list = this.store.services.filter((s) => s.autoStart && !ACTIVE.has(this.rt(s.id).status))
    const queues = [...new Set(list.map((s) => s.startQueue))].sort((a, b) => a - b)
    for (const [index, queue] of queues.entries()) {
      const members = list.filter((s) => s.startQueue === queue && this.store.get(s.id)?.autoStart)
      if (queues.length > 1) for (const s of members) this.log(s.id, `自动启动：队列 ${queue}`)
      // 队列内仍分批启动，避免大量登录 shell 同时争抢资源（每批 4 个）
      for (let i = 0; i < members.length; i += 4) {
        await Promise.all(members.slice(i, i + 4).map((s) => this.start(s.id).catch((e) => this.log(s.id, `自动启动失败：${e?.message ?? e}`))))
      }
      if (index < queues.length - 1) await this.settle(members.map((s) => s.id))
    }
  }

  /** 等待这些服务离开「启动中」，再给 1.5 秒确认没有立即退出（最多等 30 秒）。 */
  async settle(ids) {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && ids.some((id) => this.rt(id).status === "starting")) await sleep(200)
    await sleep(QUEUE_SETTLE_MS)
    await this.tick()
  }

  shutdown() {
    // 隧道不随宿主保留：宿主退出就不再对外暴露
    this.tunnels.stopAllSync()
    clearInterval(this.timer)
    clearInterval(this.updateTimer)
    clearTimeout(this.initialCheckTimer)
    this.timer = null
    this.persistRuntime()
  }

  // ---- 更新检查 ----------------------------------------------------------------

  scheduleUpdateChecks(initial = false) {
    clearInterval(this.updateTimer)
    clearTimeout(this.initialCheckTimer)
    this.updateTimer = null
    const { autoCheck, intervalHours } = this.store.settings
    if (!autoCheck) return
    if (initial) this.initialCheckTimer = setTimeout(() => this.checkAll(false), 5000)
    this.updateTimer = setInterval(() => this.checkAll(false), intervalHours * 3600 * 1000)
  }

  updateSettings(patch) {
    const settings = this.store.updateSettings(patch)
    this.scheduleUpdateChecks(false)
    return settings
  }

  setUpdateState(id, patch) {
    const prev = this.updateStates.get(id) ?? { checking: false, updating: false, message: null }
    this.updateStates.set(id, { ...prev, ...patch })
  }

  patchService(id, patch) {
    const idx = this.store.services.findIndex((s) => s.id === id)
    if (idx < 0) return
    this.store.services[idx] = { ...this.store.services[idx], ...patch }
    this.store.save()
  }

  /**
   * 为编辑中的命令找出一个能输出版本号的版本命令。
   * 参数来自尚未保存的表单，所以先走与保存相同的归一化；依次试探候选，第一个在 8 秒内输出版本号的即为结果。
   */
  async detectVersionCommand(input) {
    const draft = normalizeService({ command: input?.command, workingDirectory: input?.workingDirectory, environment: input?.environment })
    if (!draft.command) return { versionCommand: null, version: null }
    const cwd = this.cwdFor(draft)
    if (!fs.existsSync(cwd)) return { versionCommand: null, version: null }
    for (const candidate of versionCommandCandidates(draft.command)) {
      const out = await proc.runShell(candidate, { cwd, env: this.baseEnv(draft), timeoutMs: PROBE_TIMEOUT })
      if (out.timedOut || out.launchError) continue
      // 有的工具把版本打在 stderr 或以非 0 退出，只要输出里有版本号就算
      if (out.exitCode !== 0 && !out.output.trim()) continue
      const version = extractVersion(out.output)
      if (version) return { versionCommand: candidate, version }
    }
    return { versionCommand: null, version: null }
  }

  async detectVersion(svc) {
    const command = effectiveVersionCommand(svc)
    if (!command) return null
    const out = await proc.runShell(command, { cwd: this.cwdFor(svc), env: this.baseEnv(svc), timeoutMs: VERSION_TIMEOUT })
    if (out.timedOut || out.launchError) return null
    return extractVersion(out.output)
  }

  /** 检测已安装版本并查询最新 Release。silent 时出错只记录在服务上，不作为提示返回。 */
  async checkForUpdates(id, { silent = false } = {}) {
    const svc = this.store.get(id)
    if (!svc) throw new Error("服务不存在")
    const repository = normalizeRepository(svc.githubRepository)
    if (!repository) {
      if (!silent) this.setUpdateState(id, { message: "未设置有效的 GitHub 仓库" })
      return this.view(id)
    }
    if (this.updateStates.get(id)?.checking) return this.view(id)
    this.setUpdateState(id, { checking: true, message: null })

    const detecting = this.detectVersion(svc).catch(() => null)
    try {
      const outcome = await checkLatestRelease(repository, { etag: svc.updateStatus?.etag })
      const detected = await detecting
      this.rateLimitedUntil = 0
      const patch = {}
      if (detected && detected !== svc.currentVersion) patch.currentVersion = detected
      if (outcome.kind === "updated") {
        patch.githubRepository = repository
        patch.updateStatus = outcome.status
      } else if (svc.updateStatus) {
        // 304：GitHub 上没有变化，只刷新检查时间
        patch.updateStatus = { ...svc.updateStatus, lastCheckedAt: new Date().toISOString(), errorMessage: null }
      }
      this.patchService(id, patch)
      this.setUpdateState(id, { checking: false, message: null })
    } catch (e) {
      const detected = await detecting
      if (e?.code === "rateLimited") this.rateLimitedUntil = (e.resetAt?.getTime?.() ?? Date.now() + 3600_000)
      const prev = svc.updateStatus
      this.patchService(id, {
        ...(detected && detected !== svc.currentVersion ? { currentVersion: detected } : {}),
        updateStatus: {
          repository,
          latestVersion: prev?.latestVersion ?? "",
          latestReleaseTitle: prev?.latestReleaseTitle ?? "",
          latestReleaseURL: prev?.latestReleaseURL ?? "",
          latestPublishedAt: prev?.latestPublishedAt ?? null,
          lastCheckedAt: new Date().toISOString(),
          errorMessage: e?.message ?? String(e),
          etag: null,
        },
      })
      this.setUpdateState(id, { checking: false, message: silent ? null : e?.message ?? String(e) })
    }
    return this.view(id)
  }

  // ---- GitHub 访问令牌 ----------------------------------------------------------------

  /** 面板只拿到来源与末 4 位，令牌本身不离开插件宿主。 */
  async githubTokenStatus() {
    const { token, source } = await resolveToken()
    return { source, tail: token ? token.slice(-4) : null }
  }

  /** 先用 GitHub 验证再保存；换了令牌后解除限流冷却，让检查可以立即恢复。 */
  async setGithubToken(raw) {
    const token = typeof raw === "string" ? raw.trim() : ""
    if (!isPlausibleToken(token)) throw new Error("令牌格式不对：应为 ghp_… 或 github_pat_… 开头的字符串")
    const rate = await verifyToken(token)
    this.store.writeGithubToken(token)
    setConfiguredToken(token)
    this.rateLimitedUntil = 0
    console.error(`local-services: 已保存 GitHub 访问令牌（…${token.slice(-4)}，每小时 ${rate.limit} 次）`)
    return { ...(await this.githubTokenStatus()), rate }
  }

  async clearGithubToken() {
    this.store.writeGithubToken(null)
    setConfiguredToken(null)
    console.error("local-services: 已移除 GitHub 访问令牌")
    return this.githubTokenStatus()
  }

  /** 检查所有配置了仓库的服务；自动检查跳过 30 分钟内查过的，并遵守限流冷却。 */
  async checkAll(force) {
    if (!force && this.rateLimitedUntil > Date.now()) return
    const now = Date.now()
    for (const svc of [...this.store.services]) {
      if (!svc.githubRepository) continue
      const last = svc.updateStatus?.lastCheckedAt ? Date.parse(svc.updateStatus.lastCheckedAt) : 0
      if (!force && now - last < RECENT_CHECK_MS) continue
      await this.checkForUpdates(svc.id, { silent: true })
      const current = this.store.get(svc.id)
      // 手动检查只报告新版本；后台检查才可执行用户配置的更新命令并重启正在运行的服务。
      if (!force && current && !current.updateStatus?.errorMessage && isUpdateAvailable(current) && trimmed(current.updateCommand) && this.store.settings.autoUpdate) {
        await this.performUpdate(svc.id, { restart: ACTIVE.has(this.rt(svc.id).status) })
      }
      if (!force && this.rateLimitedUntil > Date.now()) return
    }
  }

  /** 执行更新命令，输出写进服务日志；成功后按需重启，再重新检测版本与 Release。 */
  async performUpdate(id, { restart = false } = {}) {
    const svc = this.store.get(id)
    if (!svc) throw new Error("服务不存在")
    const command = trimmed(svc.updateCommand)
    if (!command) throw new Error("未设置更新命令")
    if (this.updateStates.get(id)?.updating) return this.view(id)
    this.setUpdateState(id, { updating: true, message: null })
    this.log(id, `$ ${command}`)
    const out = await proc.runShell(command, { cwd: this.cwdFor(svc), env: this.baseEnv(svc), timeoutMs: UPDATE_TIMEOUT, logFile: this.store.logPath(id) })
    const ok = !out.launchError && !out.timedOut && out.exitCode === 0
    if (out.launchError) this.log(id, `更新命令无法启动：${out.launchError}`)
    else if (out.timedOut) this.log(id, `更新命令超过 ${UPDATE_TIMEOUT / 1000} 秒未结束，已中止`)
    else this.log(id, ok ? "更新完成" : `更新命令退出码 ${out.exitCode}`)
    let message = ok ? null : "更新失败，详情见日志"
    if (ok && restart) {
      this.log(id, "更新完成，正在重启服务…")
      try {
        const restarted = await this.restart(id)
        if (!restarted || !ACTIVE.has(this.rt(id).status)) throw new Error(restarted?.runtime?.lastError || "服务未能重新启动")
        this.log(id, "服务已重启")
      } catch (e) {
        message = `更新完成，但重启失败：${e?.message ?? String(e)}`
        this.log(id, message)
      }
    }
    if (ok) await this.checkForUpdates(id, { silent: true })
    this.setUpdateState(id, { updating: false, message })
    return this.view(id)
  }

  ignoreLatest(id) {
    const svc = this.store.get(id)
    const latest = trimmed(svc?.updateStatus?.latestVersion)
    if (latest) this.patchService(id, { ignoredVersion: latest })
    return this.view(id)
  }

  clearIgnored(id) {
    this.patchService(id, { ignoredVersion: null })
    return this.view(id)
  }

  markLatestAsCurrent(id) {
    const svc = this.store.get(id)
    const latest = trimmed(svc?.updateStatus?.latestVersion)
    if (latest) this.patchService(id, { currentVersion: latest, ignoredVersion: null })
    return this.view(id)
  }
}
