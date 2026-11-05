// 侧边栏页面与插件入口的形状：页面在 connect-src 'none' 的沙盒框架里运行，
// 只能通过 _magpie/bridge.js 和 magpie 打交道，然后把框架跳转到本插件的本地服务。
import { expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const dir = join(import.meta.dir, "..")
const page = join(dir, "page")
const read = (f) => readFileSync(join(page, f), "utf8")
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))

test("不申请任何读取权限，页面脚本也不读、不联网", () => {
  expect(pkg.magpie.permissions).toEqual([])
  for (const f of readdirSync(page).filter((f) => f.endsWith(".js"))) {
    expect(read(f)).not.toMatch(/magpie\.read\(/)
    // 沙盒策略本来就会拒绝这些；页面唯一的出口是把自己跳转到本地服务
    expect(read(f)).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts/)
  }
})

test("页面文件都在 page/ 里，脚本都是外部文件", () => {
  expect(pkg.magpie.page.file).toBe("page/index.html")
  expect(pkg.magpie.page.icon).toBe("page/icon.svg")
  const html = read("index.html")
  expect(html).toContain('<script src="_magpie/bridge.js"></script>')
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    expect(m[1]).toMatch(/\ssrc="/)
    expect(m[2].trim()).toBe("")
  }
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (m[1].startsWith("_magpie/")) continue
    expect(m[1]).not.toMatch(/^(?:[a-z]+:|\/|\.\.)/i)
    expect(readdirSync(page)).toContain(m[1])
  }
})

test("页面只跳转到本机地址或 magpie 代理的服务地址", () => {
  const app = read("app.js")
  // 跳转目标来自 magpie.service（magpie web 代理）或 127.0.0.1:<端口>
  expect(app).toMatch(/http:\/\/127\.0\.0\.1:/)
  for (const m of app.matchAll(/https?:\/\/[^\s"'`$]+/g)) expect(m[0]).toMatch(/^http:\/\/127\.0\.0\.1:/)
})

test("入口只默认导出 {id, server}，导入时不启动服务", async () => {
  expect(pkg.main).toBe("./index.mjs")
  const mod = await import(join(dir, pkg.main))
  expect(Object.keys(mod)).toEqual(["default"])
  expect(typeof mod.default.id).toBe("string")
  expect(typeof mod.default.server).toBe("function")
  expect(pkg.magpie.page.service).toEqual({ port: 3427, option: "port" })
})
