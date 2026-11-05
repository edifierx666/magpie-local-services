// magpie 侧边栏页面：沙盒框架（connect-src 'none'）里不能 fetch，
// 所以只负责准备 token 和主题，然后把框架跳转到插件宿主提供的本地面板。
const DEFAULT_PORT = 3427
const THEME_KEYS = ["bg", "card", "card-2", "pill", "line", "fg", "fg-2", "muted", "faint", "accent", "accent-soft", "green", "red", "amber", "font", "code"]

const statusEl = document.getElementById("status")

function say(zh, en) {
  const lang = window.magpie?.theme?.lang ?? navigator.language ?? "zh"
  statusEl.textContent = String(lang).startsWith("zh") ? zh : en
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function tokenValue(tokens, key) {
  return tokens?.[`--magpie-${key}`] ?? tokens?.[`--${key}`] ?? tokens?.[key]
}

async function open() {
  let theme = null
  try {
    theme = await window.magpie?.ready
  } catch {}
  say("正在打开…", "Opening…")

  // token 只在本插件的选项里保存；本地面板据此校验每个请求
  let opts = {}
  try {
    opts = (await window.magpie.options.get()) ?? {}
    if (typeof opts.token !== "string" || opts.token.length < 32) {
      const next = { ...opts, token: randomToken() }
      opts = (await window.magpie.options.set(next)) ?? next
    }
  } catch (e) {
    say(`无法读取插件选项：${e?.message ?? e}`, `Cannot read plugin options: ${e?.message ?? e}`)
    return
  }

  const port = Number.isInteger(Number(opts.port)) && Number(opts.port) > 1023 ? Number(opts.port) : DEFAULT_PORT
  const params = new URLSearchParams()
  params.set("token", opts.token)
  const t = theme ?? window.magpie?.theme
  if (t?.dark === true) params.set("theme", "dark")
  else if (t?.dark === false) params.set("theme", "light")
  if (t?.lang) params.set("lang", t.lang)
  for (const key of THEME_KEYS) {
    const v = tokenValue(t?.tokens, key)
    if (typeof v === "string" && v && v.length < 200) params.set(`c-${key}`, v)
  }
  // 桌面窗口里 magpie.service 为空，直接去本机端口；通过 magpie web 在别的电脑上打开时，
  // magpie 会给出它代理该服务的地址（package.json 的 magpie.page.service）
  const base = window.magpie?.service || `http://127.0.0.1:${port}/`
  // token 放在 # 片段里：不会出现在请求行和服务端日志中
  window.location.href = `${base}#${params}`
}

open()
