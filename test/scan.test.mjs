import { describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as real from "../lib/process.mjs"

// 用替身控制进程扫描结果：null 表示 ps 失败（例如睡眠唤醒期间超时）
let scanResult = null
mock.module("../lib/process.mjs", () => ({ ...real, scanProcesses: async () => scanResult }))
const { ServiceManager } = await import("../lib/manager.mjs")

function runningManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-scan-test-"))
  const m = new ServiceManager(dir)
  const svc = m.create({ name: "demo", command: "sleep 100" })
  // 模拟宿主重启后接管的服务：shell 早已退出，只剩后台进程
  Object.assign(m.rt(svc.id), { status: "running", instanceId: "i-1", shellExited: true, detached: true, processes: [{ pid: 4242, pgid: 4242, ports: [] }] })
  return { m, id: svc.id, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

describe("进程扫描失败时不误判服务已结束", () => {
  test("ps 失败：保持运行中，不写「进程已结束」", async () => {
    const { m, id, cleanup } = runningManager()
    try {
      scanResult = null
      await m.tick()
      expect(m.view(id).runtime.status).toBe("running")
      expect(m.view(id).runtime.processes).toHaveLength(1)
      expect(m.readLogs(id).text).not.toContain("进程已结束")
    } finally {
      cleanup()
    }
  })

  test("扫描成功且确实没有进程：判为已结束", async () => {
    const { m, id, cleanup } = runningManager()
    try {
      scanResult = new Map([[id, []]])
      await m.tick()
      expect(m.view(id).runtime.status).toBe("stopped")
      expect(m.readLogs(id).text).toContain("进程已结束")
    } finally {
      cleanup()
    }
  })
})
