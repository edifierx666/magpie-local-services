// magpie 插件入口：Edx「自定义服务」的 magpie 版。
// - 在 magpie 应用的插件宿主里管理长期运行的本地命令（启动/停止/日志/更新检查）；
// - 侧边栏页面跳转到本插件在 127.0.0.1 提供的面板；
// 注意：本模块只能导出这一个函数，magpie 会把导出的每个函数都当作插件函数调用。
import { execFileSync } from "node:child_process"
import { ServiceManager } from "./lib/manager.mjs"
import { startServer } from "./lib/server.mjs"

const DEFAULT_PORT = 3427
// 终端里的 magpie 命令（plugin、quota、provider test…）会各自启动一个短命宿主，它们不应接管服务
const APP_SUBCOMMANDS = new Set(["tray", "serve", "web", "daemon", "tui"])

let shared = null

function isAppHost() {
  const forced = process.env.EDX_SERVICES_LEADER
  if (forced === "1") return true
  if (forced === "0") return false
  try {
    const cmd = execFileSync("/bin/ps", ["-o", "command=", "-p", String(process.ppid)], { timeout: 3000 }).toString().trim()
    const sub = cmd.split(/\s+/)[1]
    return !sub || sub.startsWith("-") || APP_SUBCOMMANDS.has(sub)
  } catch {
    return false
  }
}

function resolvePort(options) {
  const fromEnv = Number(process.env.EDX_SERVICES_PORT)
  const fromOptions = Number(options?.port)
  for (const p of [fromEnv, fromOptions]) if (Number.isInteger(p) && p > 1023 && p < 65536) return p
  return DEFAULT_PORT
}

/**
 * 端口即互斥锁：同一时间只有绑定成功的宿主负责监控与自动启动。
 * 插件开关/更新时旧宿主可能还在收尾、暂时占着端口，所以失败后持续重试。
 */
function becomeLeader(state) {
  let attempts = 0
  const attempt = () => {
    try {
      state.server = startServer({ manager: state.manager, port: state.port, directory: state.directory, options: state.options })
      console.error(`edx-services: 面板已在 http://127.0.0.1:${state.port}/ 提供`)
      state.manager.boot().catch((e) => console.error(`edx-services: 接管服务失败：${e?.stack ?? e}`))
      state.leader = true
    } catch (e) {
      attempts++
      const inUse = e?.code === "EADDRINUSE" || /in use|EADDRINUSE/i.test(String(e?.message))
      if (!inUse) console.error(`edx-services: 启动面板失败：${e?.message ?? e}`)
      else if (attempts === 1) console.error(`edx-services: 端口 ${state.port} 被占用，稍后重试`)
      setTimeout(attempt, attempts < 60 ? 2000 : 30_000).unref?.()
    }
  }
  attempt()
}

export const EdxServicesPlugin = async (input, options) => {
  if (!shared) {
    const directory = input?.directory
    if (!directory) throw new Error("magpie 没有提供配置目录")
    shared = { directory, options, port: resolvePort(options), manager: new ServiceManager(directory), leader: false, server: null }
    if (isAppHost()) becomeLeader(shared)
    process.once("exit", () => shared?.leader && shared.manager.shutdown())
    // 宿主被信号结束时默认不会触发 exit：补上收尾，确保公网隧道随之关闭
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      process.once(sig, () => {
        if (shared?.leader) shared.manager.shutdown()
        process.exit(0)
      })
    }
  }
  // 只提供面板，不向智能体注册工具
  return {}
}
