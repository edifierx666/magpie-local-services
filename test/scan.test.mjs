import { describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as real from "../lib/process.mjs"

// 用替身控制进程扫描结果：null 表示 ps 失败（例如睡眠唤醒期间超时）
let scanResult = null
let scanCalls = 0
let lastScanOpts = null
let aliveOverride = null
mock.module("../lib/process.mjs", () => ({
  ...real,
  scanProcesses: async (_targets, opts) => {
    scanCalls++
    lastScanOpts = opts ?? null
    return scanResult
  },
  pidAlive: (pid) => (aliveOverride ? aliveOverride(pid) : real.pidAlive(pid)),
}))
const { ServiceManager } = await import("../lib/manager.mjs")

function runningManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-scan-test-"))
  const m = new ServiceManager(dir)
  const svc = m.create({ name: "demo", command: "sleep 100" })
  // 模拟宿主重启后接管的服务：shell 早已退出，只剩后台进程
  Object.assign(m.rt(svc.id), { status: "running", instanceId: "i-1", shellExited: true, detached: true, processes: [{ pid: 4242, pgid: 4242, ports: [] }] })
  return { m, id: svc.id, cleanup: () => { m.shutdown(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

describe("进程扫描失败时不误判服务已结束", () => {
  test("ps 失败：保持运行中，不写「进程已结束」", async () => {
    const { m, id, cleanup } = runningManager()
    try {
      scanCalls = 0
      aliveOverride = null
      scanResult = null
      await m.tick()
      expect(scanCalls).toBe(1)
      expect(m.view(id).runtime.status).toBe("running")
      expect(m.view(id).runtime.processes).toHaveLength(1)
      expect(m.readLogs(id).text).not.toContain("进程已结束")
    } finally {
      cleanup()
    }
  })

  test("扫描成功且确实没有进程：判为已结束并停止空闲监控定时器", async () => {
    const { m, id, cleanup } = runningManager()
    try {
      scanCalls = 0
      aliveOverride = null
      scanResult = new Map([[id, []]])
      await m.tick()
      expect(scanCalls).toBe(1)
      expect(m.view(id).runtime.status).toBe("stopped")
      expect(m.readLogs(id).text).toContain("进程已结束")
      expect(m.timer).toBeNull()
    } finally {
      cleanup()
    }
  })

  test("后台静默期已知进程存活时走 Fast Path，不重复触发全系统扫描与 lsof", async () => {
    const { m, id, cleanup } = runningManager()
    try {
      const fakePid = 4242
      let isAlive = true
      aliveOverride = (pid) => pid === fakePid && isAlive
      scanCalls = 0
      scanResult = new Map([[id, [{ pid: fakePid, pgid: fakePid, name: "sleep", command: "sleep 100", ports: [], sockets: [] }]]])

      // 首轮完成一次真实扫描建立基线（后台静默期 includePorts 应为 false）
      await m.tick()
      expect(scanCalls).toBe(1)
      expect(lastScanOpts?.includePorts).toBe(false)

      // 渡过启动窗口后，只要 pidAlive 为 true，后续 tick 不应再调用 scanProcesses
      m.rt(id).lastEventAt = Date.now() - 60_000
      m.rt(id).lastVerifyAt = Date.now()
      await m.tick()
      await m.tick()
      expect(scanCalls).toBe(1)

      // 一旦进程退出（pidAlive 返回 false），立即回退到 scanProcesses 确认并结束服务
      isAlive = false
      scanResult = new Map([[id, []]])
      await m.tick()
      expect(scanCalls).toBe(2)
      expect(m.view(id).runtime.status).toBe("stopped")
    } finally {
      aliveOverride = null
      cleanup()
    }
  })
})
