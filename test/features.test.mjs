import { describe, expect, test } from "bun:test"
import { primaryCommandToken, versionCommandCandidates } from "../lib/version.mjs"
import { addressesOf } from "../lib/process.mjs"
import { normalizeService } from "../lib/store.mjs"

describe("版本命令自动检测", () => {
  test("跳过开头的环境变量赋值", () => {
    expect(primaryCommandToken("FOO=1 BAR=2 headroom proxy --port 8787")).toBe("headroom")
  })
  test("普通命令只试程序本身", () => {
    expect(versionCommandCandidates("headroom proxy --port 8787")).toEqual([
      "headroom --version",
      "headroom -v",
      "headroom -V",
      "headroom version",
    ])
  })
  test("运行器：先带运行器，再裸程序名，最后运行器本身", () => {
    const c = versionCommandCandidates("npx -y cli-proxy serve")
    expect(c.slice(0, 1)).toEqual(["npx cli-proxy --version"])
    expect(c).toContain("cli-proxy --version")
    expect(c.at(-1)).toBe("npx version")
    expect(versionCommandCandidates("bun x foo")[0]).toBe("bun x foo --version")
  })
  test("带空格的路径加引号", () => {
    expect(versionCommandCandidates(`'/Applications/My App/bin' run`)[0]).toBe(`'/Applications/My App/bin' --version`)
  })
  test("空命令没有候选", () => {
    expect(versionCommandCandidates("  ")).toEqual([])
  })
})

describe("可访问地址", () => {
  test("同一端口去重，本机优先", () => {
    expect(
      addressesOf([
        { host: "[::1]", port: 8787 },
        { host: "*", port: 8787 },
        { host: "192.168.1.5", port: 9000 },
        { host: "127.0.0.1", port: 3000 },
      ]),
    ).toEqual(["http://127.0.0.1:3000", "http://127.0.0.1:8787", "http://192.168.1.5:9000"])
  })
  test("只监听 IPv6 回环时保留原地址", () => {
    expect(addressesOf([{ host: "[::1]", port: 5000 }])).toEqual(["http://[::1]:5000"])
  })
})

describe("启动队列", () => {
  const base = { name: "a", command: "sleep 1" }
  test("默认 1，取整并限定在 1–99", () => {
    expect(normalizeService(base).startQueue).toBe(1)
    expect(normalizeService({ ...base, startQueue: 3 }).startQueue).toBe(3)
    expect(normalizeService({ ...base, startQueue: "2" }).startQueue).toBe(2)
    expect(normalizeService({ ...base, startQueue: 0 }).startQueue).toBe(1)
    expect(normalizeService({ ...base, startQueue: 500 }).startQueue).toBe(99)
  })
})

describe("版本命令自动检测开关", () => {
  test("默认开启，显式关闭才关闭", () => {
    expect(normalizeService({ name: "a", command: "x" }).autoDetectVersionCommand).toBe(true)
    expect(normalizeService({ name: "a", command: "x", versionCommand: "x -v" }).autoDetectVersionCommand).toBe(true)
    expect(normalizeService({ name: "a", command: "x", autoDetectVersionCommand: false }).autoDetectVersionCommand).toBe(false)
  })
})

describe("GitHub 访问令牌", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const { Store } = await import("../lib/store.mjs")
  const { isPlausibleToken, resolveToken, setConfiguredToken } = await import("../lib/github.mjs")

  test("格式校验", () => {
    expect(isPlausibleToken("ghp_" + "a".repeat(36))).toBe(true)
    expect(isPlausibleToken("github_pat_" + "A1_".repeat(20))).toBe(true)
    expect(isPlausibleToken("short")).toBe(false)
    expect(isPlausibleToken("ghp_abc def 1234567890123456")).toBe(false)
  })
  test("保存为 0600 文件，可清除", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-token-test-"))
    try {
      const store = new Store(dir)
      store.save()
      expect(store.readGithubToken()).toBe(null)
      store.writeGithubToken("ghp_" + "b".repeat(36))
      expect(store.readGithubToken()).toBe("ghp_" + "b".repeat(36))
      expect(fs.statSync(store.githubTokenFile).mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(store.servicesFile, "utf8").includes("ghp_")).toBe(false)
      store.writeGithubToken(null)
      expect(store.readGithubToken()).toBe(null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  test("设置里的令牌优先于环境变量", async () => {
    setConfiguredToken("ghp_" + "c".repeat(36))
    expect(await resolveToken()).toEqual({ token: "ghp_" + "c".repeat(36), source: "settings" })
    setConfiguredToken(null)
  })
})

describe("更新检查设置：旧默认值迁移", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const { Store } = await import("../lib/store.mjs")
  const withSaved = (settings, fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-settings-mig-"))
    try {
      fs.mkdirSync(path.join(dir, "local-services"), { recursive: true })
      fs.writeFileSync(path.join(dir, "local-services/services.json"), JSON.stringify({ version: 1, services: [], settings }))
      fn(new Store(dir))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  test("没选过的旧默认 6 小时迁移为 12 小时", () => {
    withSaved({ autoCheck: true, intervalHours: 6 }, (s) => expect(s.settings.intervalHours).toBe(12))
  })
  test("用户选过的值保留，包括 6 小时", () => {
    withSaved({ autoCheck: true, intervalHours: 6, intervalHoursCustom: true }, (s) => expect(s.settings.intervalHours).toBe(6))
    withSaved({ autoCheck: true, intervalHours: 24 }, (s) => expect(s.settings.intervalHours).toBe(24))
  })
  test("在面板里选择间隔后记为自定义，只改自动检查不算", () => {
    withSaved({ autoCheck: true, intervalHours: 6 }, (s) => {
      s.updateSettings({ autoCheck: false })
      expect(s.settings).toMatchObject({ intervalHours: 12, intervalHoursCustom: false })
      s.updateSettings({ intervalHours: 6 })
      expect(s.settings).toMatchObject({ intervalHours: 6, intervalHoursCustom: true })
      s.updateSettings({ autoCheck: true })
      expect(s.settings).toMatchObject({ intervalHours: 6, intervalHoursCustom: true })
    })
  })
})

describe("更新检查设置", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const { Store } = await import("../lib/store.mjs")
  test("默认自动检查，每 12 小时", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-settings-test-"))
    try {
      expect(new Store(dir).settings).toEqual({ autoCheck: true, autoUpdate: true, intervalHours: 12, intervalHoursCustom: false })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("保存令牌（GitHub 接口替身）", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const { ServiceManager } = await import("../lib/manager.mjs")
  const { setConfiguredToken } = await import("../lib/github.mjs")

  test("验证通过才保存，换令牌后解除限流冷却；无效令牌不落盘", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-token-mgr-"))
    const realFetch = globalThis.fetch
    const seen = []
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), auth: init?.headers?.authorization })
      const ok = init?.headers?.authorization === "Bearer ghp_" + "d".repeat(36)
      return ok
        ? new Response(JSON.stringify({ resources: { core: { limit: 5000, remaining: 4999, reset: 1900000000 } } }), { status: 200 })
        : new Response("{}", { status: 401 })
    }
    try {
      const m = new ServiceManager(dir)
      m.rateLimitedUntil = Date.now() + 3600_000
      await expect(m.setGithubToken("ghp_" + "e".repeat(36))).rejects.toThrow("令牌无效或已过期")
      expect(m.store.readGithubToken()).toBe(null)
      const r = await m.setGithubToken("  ghp_" + "d".repeat(36) + "\n")
      expect(r).toMatchObject({ source: "settings", tail: "dddd", rate: { limit: 5000, remaining: 4999 } })
      expect(m.rateLimitedUntil).toBe(0)
      expect(seen.every((s) => s.url === "https://api.github.com/rate_limit")).toBe(true)
      expect((await m.clearGithubToken()).source).not.toBe("settings")
      expect(m.store.readGithubToken()).toBe(null)
      m.shutdown()
    } finally {
      globalThis.fetch = realFetch
      setConfiguredToken(null)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("删除后撤销", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const { ServiceManager } = await import("../lib/manager.mjs")
  const { Store } = await import("../lib/store.mjs")

  test("按原位置、原配置恢复，日志一并恢复；重复恢复报错；重启后清理残留日志", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-undo-"))
    try {
      const m = new ServiceManager(dir)
      const a = m.create({ name: "a", command: "true" })
      const b = m.create({ name: "b", command: "true", autoStart: true, startQueue: 3, githubRepository: "o/r" })
      m.create({ name: "c", command: "true" })
      m.log(b.id, "hello")
      const { service, index } = await m.remove(b.id)
      expect(index).toBe(1)
      expect(m.store.services.map((s) => s.name)).toEqual(["a", "c"])
      expect(fs.existsSync(m.store.logPath(b.id))).toBe(false)
      const back = m.restore(JSON.parse(JSON.stringify(service)), index)
      expect(back.id).toBe(b.id)
      expect(m.store.services.map((s) => s.name)).toEqual(["a", "b", "c"])
      expect(m.store.get(b.id)).toMatchObject({ autoStart: true, startQueue: 3, githubRepository: "o/r" })
      expect(fs.readFileSync(m.store.logPath(b.id), "utf8")).toContain("hello")
      expect(() => m.restore(service, index)).toThrow("服务已存在")
      // 删除后不撤销：宿主重启时清理 .trash
      await m.remove(a.id)
      expect(fs.existsSync(`${m.store.logPath(a.id)}.trash`) || !fs.existsSync(m.store.logPath(a.id))).toBe(true)
      m.shutdown()
      new Store(dir)
      expect(fs.readdirSync(m.store.logDir).some((f) => f.endsWith(".trash"))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("隧道", async () => {
  const { targetHost, validPort, lastError } = await import("../lib/tunnel.mjs")
  test("按监听地址选择连接目标", () => {
    expect(targetHost(new Set(["127.0.0.1"]))).toBe("127.0.0.1")
    expect(targetHost(new Set(["*"]))).toBe("127.0.0.1")
    expect(targetHost(new Set(["[::1]"]))).toBe("[::1]")
    expect(targetHost(new Set(["[::1]", "127.0.0.1"]))).toBe("127.0.0.1")
    expect(targetHost(undefined)).toBe("127.0.0.1")
  })
  test("端口校验", () => {
    expect(validPort("3000")).toBe(3000)
    expect(validPort(0)).toBe(null)
    expect(validPort(65536)).toBe(null)
    expect(validPort("3.5")).toBe(null)
    expect(validPort("abc")).toBe(null)
  })
  test("从 cloudflared 输出取最后一条错误", () => {
    const log = [
      "2026-11-05T05:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...",
      "2026-11-05T05:00:01Z ERR Error unmarshaling QuickTunnel response: 429 Too Many Requests",
      "2026-11-05T05:00:02Z ERR failed to request quick Tunnel: rate limited",
    ].join("\n")
    expect(lastError(log)).toBe("failed to request quick Tunnel: rate limited")
    expect(lastError("2026 INF all good")).toBe(null)
  })
})

describe("隧道地址识别与错误说明", async () => {
  const { extractTunnelURL, explainError, lastError } = await import("../lib/tunnel.mjs")
  test("排除 api.trycloudflare.com", () => {
    expect(extractTunnelURL('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF')).toBe(null)
    const ok = "INF Requesting new quick Tunnel on trycloudflare.com...\n|  https://fancy-words-here.trycloudflare.com  |"
    expect(extractTunnelURL(ok)).toBe("https://fancy-words-here.trycloudflare.com")
  })
  test("忽略空配置提示，翻译网络与限流错误", () => {
    const log = "2026 ERR Configuration file /dev/null was empty\nfailed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\": EOF"
    expect(explainError(lastError(log))).toContain("请检查网络或代理")
    expect(lastError("2026 ERR Configuration file /dev/null was empty")).toBe(null)
    expect(explainError("429 Too Many Requests")).toContain("稍后再试")
  })
})
