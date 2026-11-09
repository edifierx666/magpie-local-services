"use strict"
// 本地面板：由插件宿主在 127.0.0.1 提供，magpie 的插件页面把沙盒框架跳转到这里。
// 页面仍处在沙盒的不透明源中：没有 localStorage / alert / confirm / window.open，所以对话框、菜单都自己画。

const params = new URLSearchParams(location.hash.slice(1))
const TOKEN = params.get("token") || ""
const LANG = (params.get("lang") || navigator.language || "zh").toLowerCase().startsWith("zh") ? "zh" : "en"
const DICT = window.LOCAL_SERVICES_I18N[LANG]

function t(key, ...args) {
  let s = DICT[key] ?? window.LOCAL_SERVICES_I18N.zh[key] ?? key
  args.forEach((a, i) => (s = s.replaceAll(`{${i}}`, String(a))))
  return s
}

const $ = (sel) => document.querySelector(sel)

// ---- 主题 ---------------------------------------------------------------------

function applyTheme() {
  const root = document.documentElement
  const theme = params.get("theme")
  const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches
  root.dataset.theme = dark ? "dark" : "light"
  root.lang = LANG === "zh" ? "zh-CN" : "en"
  for (const [k, v] of params) {
    if (!k.startsWith("c-")) continue
    const name = k.slice(2)
    // 只接受简单的变量名与值，避免把任意 CSS 注入进来
    if (/^[a-z0-9-]{1,20}$/.test(name) && !/[;{}<>]/.test(v)) root.style.setProperty(`--${name}`, v)
  }
}

// ---- DOM 工具 ---------------------------------------------------------------------

function h(tag, props, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue
    if (k === "class") el.className = v
    else if (k === "text") el.textContent = v
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v)
    else if (k === "value" || k === "checked" || k === "disabled" || k === "hidden") el[k] = v
    else el.setAttribute(k, v === true ? "" : v)
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c))
  return el
}

const ICONS = {
  restart: '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5"/>',
  logs: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.6" r=".9" fill="currentColor" stroke="none"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke-linejoin="round"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>',
  grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  more: '<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>',
}

function icon(name) {
  const span = document.createElement("span")
  span.style.display = "contents"
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`
  return span
}

/**
 * 小圆圈 i：悬停或键盘聚焦时显示说明。浮层挂在 body 上并用 fixed 定位，
 * 不会被对话框的滚动区域裁掉；读屏通过 aria-label 读到同一段文字。
 */
let tipEl = null
function hideTip() {
  tipEl?.remove()
  tipEl = null
}
function infoTip(text) {
  const el = h("span", { class: "tip-icon", tabindex: "0", role: "img", "aria-label": text }, icon("info"))
  const show = () => {
    hideTip()
    tipEl = h("div", { class: "tooltip", role: "tooltip", text })
    document.body.append(tipEl)
    const r = el.getBoundingClientRect()
    const w = tipEl.offsetWidth
    const hgt = tipEl.offsetHeight
    tipEl.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8))}px`
    tipEl.style.top = `${r.top - hgt - 8 >= 8 ? r.top - hgt - 8 : r.bottom + 8}px`
  }
  el.addEventListener("mouseenter", show)
  el.addEventListener("focus", show)
  el.addEventListener("mouseleave", hideTip)
  el.addEventListener("blur", hideTip)
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && tipEl) {
      // 先收起说明，不让这次 Esc 关掉整个对话框
      e.stopPropagation()
      hideTip()
    }
  })
  return el
}

function setBusy(btn, on) {
  btn.classList.toggle("busy", on)
  btn.disabled = on || btn.dataset.locked === "1"
}

let toastTimer = null
/** action：{ label, run }，带一个按钮（如「撤销」）。带按钮时停留更久，鼠标停在上面时不消失。 */
function toast(message, error = false, action = null) {
  const el = $("#toast")
  el.replaceChildren(h("span", { text: message }))
  if (action)
    el.append(
      h("button", {
        type: "button",
        class: "toast-action",
        text: action.label,
        onclick: () => {
          el.hidden = true
          clearTimeout(toastTimer)
          action.run()
        },
      }),
    )
  el.classList.toggle("error", error)
  el.classList.toggle("has-action", !!action)
  el.hidden = false
  const ms = action ? 6000 : error ? 6000 : 2600
  const arm = () => {
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (el.hidden = true), ms)
  }
  el.onmouseenter = () => clearTimeout(toastTimer)
  el.onmouseleave = arm
  arm()
}

function notice(message, error = false) {
  const el = $("#notice")
  if (!message) {
    el.hidden = true
    return
  }
  el.textContent = message
  el.classList.toggle("error", error)
  el.hidden = false
}

function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return t("unit.s", s)
  const m = Math.floor(s / 60)
  if (m < 60) return t("unit.m", m)
  const hr = Math.floor(m / 60)
  if (hr < 48) return t("unit.h", hr)
  return t("unit.d", Math.floor(hr / 24))
}

function ago(iso) {
  const d = Date.now() - Date.parse(iso)
  if (!Number.isFinite(d) || d < 45_000) return t("justNow")
  return t("ago", duration(d))
}

// ---- API ---------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

// 一律用相对路径：经 magpie web 代理时，面板位于 …/_magpie/service/ 之下
async function api(method, path, body) {
  let res
  try {
    res = await fetch(path, {
      method,
      headers: { "x-local-services-token": TOKEN, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(t("offline"), 0)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.error || `HTTP ${res.status}`, res.status)
  return data
}

// ---- 浮层菜单 ---------------------------------------------------------------------

let menuEl = null
let menuCleanup = null

let menuAnchor = null
// 菜单可能在点击到达按钮之前就被关掉（按下时窗口失焦、外部点击处理等），
// 记住刚关掉的是哪个按钮的菜单，紧接着的那次点击就当作「收起」而不是重新打开
let lastClosed = { anchor: null, at: 0 }

function closeMenu() {
  menuEl?.remove()
  menuEl = null
  if (menuAnchor) {
    lastClosed = { anchor: menuAnchor, at: performance.now() }
    menuAnchor.classList.remove("open")
    menuAnchor.setAttribute("aria-expanded", "false")
    menuAnchor = null
  }
  menuCleanup?.()
  menuCleanup = null
}

function showMenu(anchor, items) {
  const hasControls = items.some((it) => it?.node)
  // 再点一次同一个按钮就是收起：外部点击处理会跳过按钮本身，所以开关在这里做
  if (menuEl && menuAnchor === anchor) {
    closeMenu()
    // 这次点击已经完成了收起，不要再让它影响下一次点击
    lastClosed = { anchor: null, at: 0 }
    return
  }
  if (!menuEl && lastClosed.anchor === anchor && performance.now() - lastClosed.at < 350) {
    lastClosed = { anchor: null, at: 0 }
    return
  }
  closeMenu()
  const menu = h("div", { class: "menu", role: "menu" })
  // menu 的直接后代只允许菜单项角色；复选框和下拉框属于分组内容，不能套 menuitem。
  if (hasControls) menu.setAttribute("role", "group")
  for (const it of items) {
    if (!it) continue
    if (it === "-") menu.append(h("hr"))
    else if (it.node) menu.append(it.node)
    else if (it.text) menu.append(h("div", { class: "menu-text", text: it.text }))
    else
      menu.append(
        h("button", {
          type: "button",
          role: "menuitem",
          class: it.danger ? "danger" : null,
          disabled: it.disabled,
          text: it.label,
          onclick: () => {
            closeMenu()
            // 选了菜单项不算「刚收起」，马上再点按钮应当正常打开
            lastClosed = { anchor: null, at: 0 }
            it.run()
          },
        }),
      )
  }
  document.body.append(menu)
  const r = anchor.getBoundingClientRect()
  const w = menu.offsetWidth
  const hgt = menu.offsetHeight
  menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`
  menu.style.top = `${r.bottom + hgt + 8 > innerHeight ? Math.max(8, r.top - hgt - 4) : r.bottom + 4}px`
  menuEl = menu
  menuAnchor = anchor
  anchor.classList.add("open")
  anchor.setAttribute("aria-expanded", "true")

  const outside = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu()
  }
  const key = (e) => {
    if (e.key === "Escape") {
      closeMenu()
      anchor.focus()
    }
  }
  // 菜单是 fixed 定位，页面或任何滚动区（如日志）滚动后会和按钮脱开，直接收起；菜单自身的滚动除外
  const scrolled = (e) => {
    if (!menu.contains(e.target)) closeMenu()
  }
  setTimeout(() => document.addEventListener("pointerdown", outside, true))
  document.addEventListener("keydown", key)
  addEventListener("blur", closeMenu)
  addEventListener("scroll", scrolled, true)
  addEventListener("resize", closeMenu)
  menuCleanup = () => {
    document.removeEventListener("pointerdown", outside, true)
    document.removeEventListener("keydown", key)
    removeEventListener("blur", closeMenu)
    removeEventListener("scroll", scrolled, true)
    removeEventListener("resize", closeMenu)
  }
  menu.querySelector("button, input, select")?.focus()
}

// ---- 对话框 ---------------------------------------------------------------------

/**
 * canDismiss：传了才允许点击对话框外部关闭，返回 false 时（例如正在保存）忽略这次点击。
 * 用户在对话框里输入或改动过任何控件后，外部点击不再关闭，只轻晃一下提示，避免丢掉输入。
 */
function openDialog({ title, small = false, body, footer, onEscape, canDismiss }) {
  closeMenu()
  const box = h("div", { class: `dialog${small ? " small" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title })
  const overlay = h("div", { class: "overlay" }, box)
  let dirty = false
  // 只认用户触发的 input/change；程序写入的值（如自动检测出的版本命令）不会触发这两个事件
  box.addEventListener("input", () => (dirty = true))
  box.addEventListener("change", () => (dirty = true))
  // 按下和松开都在遮罩本身上才算一次外部点击：在输入框里拖选文字拖到外面松手，不应关闭
  let downOnOverlay = false
  overlay.addEventListener("pointerdown", (e) => (downOnOverlay = e.target === overlay))
  overlay.addEventListener("click", (e) => {
    const outside = downOnOverlay && e.target === overlay
    downOnOverlay = false
    if (!outside || !canDismiss || !canDismiss()) return
    if (!dirty) return d.close()
    box.classList.remove("nudge")
    void box.offsetWidth
    box.classList.add("nudge")
  })
  box.append(h("header", null, h("h2", { text: title })), h("div", { class: "body" }, body), h("footer", null, footer))
  const previous = document.activeElement
  const key = (e) => {
    if (e.key === "Escape") {
      e.preventDefault()
      onEscape?.()
    }
  }
  document.addEventListener("keydown", key)
  document.body.append(overlay)
  const close = () => {
    document.removeEventListener("keydown", key)
    // 说明浮层挂在 body 上，图标随对话框移除时收不到 mouseleave，这里一并收起
    hideTip()
    overlay.remove()
    previous?.focus?.()
  }
  setTimeout(() => box.querySelector("input, textarea, button.primary, button")?.focus())
  const d = { box, close }
  return d
}

function confirmDialog({ title, message, actionLabel, danger, run }) {
  let working = false
  const action = h("button", { type: "button", class: danger ? "primary danger-fill" : "primary", text: actionLabel })
  if (danger) action.style.cssText = "background: var(--red); border-color: var(--red)"
  const cancel = h("button", { type: "button", text: t("form.cancel") })
  const err = h("span", { class: "form-error", role: "alert" })
  const d = openDialog({
    title,
    small: true,
    body: message ? h("p", { class: "muted", style: "margin:0", text: message }) : null,
    footer: [err, cancel, action],
    onEscape: () => !working && d.close(),
  })
  cancel.onclick = () => !working && d.close()
  action.onclick = async () => {
    if (working) return
    working = true
    setBusy(action, true)
    cancel.disabled = true
    try {
      await run()
      d.close()
    } catch (e) {
      err.textContent = e.message
      working = false
      setBusy(action, false)
      cancel.disabled = false
    }
  }
}

// ---- 编辑表单 ---------------------------------------------------------------------

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const REPO = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?(?:\.git)?\/?$/

function homepageOf(svc) {
  if (svc.homepage) return svc.homepage
  if (!svc.githubRepository || !REPO.test(svc.githubRepository.trim())) return null
  const repo = svc.githubRepository.trim().replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//, "").replace(/\.git\/?$/, "").replace(/\/$/, "")
  return `https://github.com/${repo}`
}

function validHomepage(value) {
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname
  } catch {
    return false
  }
}

function envToText(env) {
  return Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n")
}

function parseEnv(text) {
  const env = {}
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    const key = eq > 0 ? line.slice(0, eq).trim().replace(/^export\s+/, "") : ""
    if (!ENV_KEY.test(key)) return { error: t("err.env", i + 1) }
    let value = line.slice(eq + 1).trim()
    // 去掉成对的外层引号，方便从 .env 文件直接粘贴
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1)
    env[key] = value
  }
  return { env }
}

function field(label, control, error) {
  return h("label", { class: "field" }, h("span", { text: label }), control, error)
}

function openEditor(svc) {
  const isNew = !svc
  const s = svc ?? { name: "", command: "", workingDirectory: "", environment: {}, stopCommand: "", autoStart: false, startQueue: 1, homepage: "", githubRepository: "", currentVersion: "", versionCommand: "", updateCommand: "", autoDetectVersionCommand: true }

  const name = h("input", { type: "text", value: s.name, placeholder: t("ph.name"), autocomplete: "off", spellcheck: "false" })
  const command = h("textarea", { rows: "2", value: s.command, placeholder: t("ph.command"), spellcheck: "false" })
  const cwd = h("input", { type: "text", value: s.workingDirectory ?? "", placeholder: t("ph.cwd"), spellcheck: "false" })
  const env = h("textarea", { rows: "3", value: envToText(s.environment), placeholder: t("ph.env"), spellcheck: "false" })
  const stopCommand = h("textarea", { rows: "2", value: s.stopCommand ?? "", placeholder: t("ph.stopCommand"), spellcheck: "false" })
  const homepage = h("input", { type: "url", value: s.homepage ?? "", placeholder: t("ph.homepage"), spellcheck: "false" })
  const autoStart = h("input", { type: "checkbox", checked: s.autoStart })
  // 启动队列只对「随 magpie 启动」生效：数字小的队列全部启动后，才启动下一个队列
  const startQueue = h("input", { type: "number", class: "queue", min: "1", max: "99", step: "1", value: String(s.startQueue ?? 1), disabled: !s.autoStart, "aria-label": t("form.startQueue") })
  autoStart.addEventListener("change", () => (startQueue.disabled = !autoStart.checked))
  const repo = h("input", { type: "text", value: s.githubRepository ?? "", placeholder: t("ph.repo"), spellcheck: "false" })
  const current = h("input", { type: "text", value: s.currentVersion ?? "", placeholder: t("ph.version"), spellcheck: "false" })
  const versionCommand = h("input", { type: "text", value: s.versionCommand ?? "", spellcheck: "false" })
  const updateCommand = h("input", { type: "text", value: s.updateCommand ?? "", placeholder: t("ph.updateCommand"), spellcheck: "false" })

  const errs = { name: h("span", { class: "error", role: "alert" }), command: h("span", { class: "error", role: "alert" }), env: h("span", { class: "error", role: "alert" }), homepage: h("span", { class: "error", role: "alert" }), repo: h("span", { class: "error", role: "alert" }), queue: h("span", { class: "error", role: "alert" }) }

  // 版本命令留空时使用 `<可执行文件> --version`，占位符跟随命令实时显示这个默认值
  const syncVersionPlaceholder = () => {
    const exe = command.value.trim().split(/\s+/)[0] ?? ""
    versionCommand.placeholder = exe ? `${exe} --version` : t("ph.versionCommand")
  }
  command.addEventListener("input", syncVersionPlaceholder)
  syncVersionPlaceholder()

  // 版本命令自动检测：默认开启，开关随服务保存；命令、工作目录、环境变量变化 500ms 后试探
  // `--version / -v / -V / version`，把第一个能输出版本号的命令填进来；手动修改版本命令即关闭。
  const detectBox = h("input", { type: "checkbox", checked: s.autoDetectVersionCommand !== false })
  const detecting = h("span", { class: "spinner", role: "status", "aria-label": t("detecting"), hidden: true })
  let detectSeq = 0
  let detectTimer = null
  const cancelDetect = () => {
    detectSeq++
    clearTimeout(detectTimer)
    detecting.hidden = true
  }
  const scheduleDetect = () => {
    if (!detectBox.checked) return
    cancelDetect()
    const seq = detectSeq
    detecting.hidden = false
    detectTimer = setTimeout(async () => {
      const parsed = parseEnv(env.value)
      let found = null
      try {
        found = await api("POST", "api/detect-version-command", { command: command.value, workingDirectory: cwd.value.trim() || null, environment: parsed.env ?? {} })
      } catch {
        // 检测失败不打断编辑，保留原值
      }
      // 期间命令又变了，或用户关掉了自动检测：这次结果作废
      if (seq !== detectSeq || !detectBox.checked) return
      detecting.hidden = true
      if (found?.versionCommand) versionCommand.value = found.versionCommand
    }, 500)
  }
  for (const input of [command, cwd, env]) input.addEventListener("input", scheduleDetect)
  versionCommand.addEventListener("input", () => {
    detectBox.checked = false
    cancelDetect()
  })
  detectBox.addEventListener("change", () => (detectBox.checked ? scheduleDetect() : cancelDetect()))
  // 打开时只在还没有版本命令时检测，避免覆盖已保存的结果
  if (!versionCommand.value.trim() && command.value.trim()) scheduleDetect()
  const versionField = h(
    "div",
    { class: "field" },
    h("div", { class: "field-head" }, h("span", { text: t("form.versionCommand") }), h("label", { class: "check small" }, detectBox, h("span", { text: t("form.autoDetect") }))),
    h("div", { class: "input-wrap" }, versionCommand, detecting),
  )

  const body = [
    field(t("form.name"), name, errs.name),
    field(t("form.command"), command, errs.command),
    field(t("form.cwd"), cwd),
    field(t("form.env"), env, errs.env),
    field(t("form.stopCommand"), stopCommand),
    field(t("form.homepage"), homepage, errs.homepage),
    h("p", { class: "hint", text: t("tip.homepage") }),
    h(
      "div",
      { class: "auto-row" },
      h("label", { class: "check" }, autoStart, h("span", { text: t("form.autoStart") })),
      h("span", { class: "queue-group" }, h("label", { class: "check queue-label" }, h("span", { text: t("form.startQueue") }), startQueue), infoTip(t("tip.startQueue"))),
      errs.queue,
    ),
    h(
      "fieldset",
      null,
      h("legend", { text: t("form.update") }),
      field(t("form.repo"), repo, errs.repo),
      h("div", { class: "grid2" }, field(t("form.currentVersion"), current), versionField),
      field(t("form.updateCommand"), updateCommand),
    ),
  ]

  const formError = h("span", { class: "form-error", role: "alert" })
  const cancel = h("button", { type: "button", text: t("form.cancel") })
  const save = h("button", { type: "button", class: "primary", text: t("form.save") })
  let saving = false
  const d = openDialog({
    title: t(isNew ? "form.createTitle" : "form.editTitle"),
    body,
    footer: [formError, cancel, save],
    onEscape: () => !saving && d.close(),
    canDismiss: () => !saving,
  })
  cancel.onclick = () => !saving && d.close()
  // 关闭对话框时丢弃还在等待的检测结果
  const closeDialog = d.close
  d.close = () => {
    cancelDetect()
    closeDialog()
  }

  const mark =(input, errEl, message) => {
    errEl.textContent = message ?? ""
    input.classList.toggle("invalid", !!message)
    input.setAttribute("aria-invalid", message ? "true" : "false")
  }
  for (const [input, key] of [[name, "name"], [command, "command"], [env, "env"], [homepage, "homepage"], [repo, "repo"], [startQueue, "queue"]]) input.addEventListener("input", () => mark(input, errs[key], null))

  const submit = async () => {
    if (saving) return
    formError.textContent = ""
    let ok = true
    const first = []
    const check = (input, key, message) => {
      mark(input, errs[key], message)
      if (message) {
        ok = false
        first.push(input)
      }
    }
    check(name, "name", name.value.trim() ? null : t("err.nameRequired"))
    check(command, "command", command.value.trim() ? null : t("err.commandRequired"))
    const parsed = parseEnv(env.value)
    check(env, "env", parsed.error ?? null)
    check(homepage, "homepage", !homepage.value.trim() || validHomepage(homepage.value.trim()) ? null : t("err.homepage"))
    check(repo, "repo", !repo.value.trim() || REPO.test(repo.value.trim()) ? null : t("err.repo"))
    const queue = Number(startQueue.value)
    check(startQueue, "queue", Number.isInteger(queue) && queue >= 1 && queue <= 99 ? null : t("err.startQueue"))
    if (!ok) {
      first[0]?.focus()
      return
    }

    const payload = {
      name: name.value.trim(),
      command: command.value.trim(),
      workingDirectory: cwd.value.trim() || null,
      environment: parsed.env,
      stopCommand: stopCommand.value.trim() || null,
      autoStart: autoStart.checked,
      startQueue: Number(startQueue.value) || 1,
      homepage: homepage.value.trim() || null,
      githubRepository: repo.value.trim() || null,
      currentVersion: current.value.trim() || null,
      versionCommand: versionCommand.value.trim() || null,
      autoDetectVersionCommand: detectBox.checked,
      updateCommand: updateCommand.value.trim() || null,
    }
    saving = true
    setBusy(save, true)
    cancel.disabled = true
    try {
      if (isNew) await api("POST", "api/services", payload)
      else await api("PUT", `api/services/${encodeURIComponent(svc.id)}`, payload)
      // 只有保存成功后才关闭，失败时保留用户输入
      d.close()
      await refresh()
    } catch (e) {
      formError.textContent = e.message
    } finally {
      saving = false
      setBusy(save, false)
      cancel.disabled = false
    }
  }
  save.onclick = submit
  d.box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit()
  })
}

// ---- 服务卡片 ---------------------------------------------------------------------

let state = null
const cards = new Map()
const busy = new Set()

function statusKey(svc) {
  const r = svc.runtime
  return r.status === "running" && r.detached ? "background" : r.status
}

function isActive(svc) {
  return ["starting", "running", "stopping"].includes(svc.runtime.status)
}

async function act(id, action, fn) {
  const key = `${id}:${action}`
  if (busy.has(key)) return
  busy.add(key)
  render()
  try {
    await fn()
  } catch (e) {
    toast(e.message, true)
  } finally {
    busy.delete(key)
    await refresh()
  }
}

const post = (id, action) => api("POST", `api/services/${encodeURIComponent(id)}/${action}`)

function createCard(id) {
  const c = { id, logsOpen: false, offset: null, timer: null, pulling: false, partial: "", lines: 0 }
  c.dot = h("span", { class: "dot", role: "img" })
  c.name = h("span", { class: "name" })
  c.auto = h("span", { class: "pill", text: t("autoStart") })
  c.update = h("button", { type: "button", class: "pill update" })
  c.tunnel = h("button", { type: "button", class: "pill tunnel", "aria-haspopup": "menu" })
  c.cmd = h("div", { class: "cmd" })
  c.meta = h("div", { class: "meta" })
  c.toggle = h("button", { type: "button", class: "icon toggle" })
  c.handle = h("button", { type: "button", class: "icon handle", title: t("reorder"), "aria-label": t("reorder") }, icon("grip"))
  c.restart = h("button", { type: "button", class: "icon ghost", title: t("restart"), "aria-label": t("restart") }, icon("restart"))
  c.copy = h("button", { type: "button", class: "icon ghost", title: t("copyAddress"), "aria-label": t("copyAddress") }, icon("copy"))
  c.homepage = h("button", { type: "button", class: "icon ghost", title: t("openHomepage"), "aria-label": t("openHomepage") }, icon("external"))
  c.logsBtn = h("button", { type: "button", class: "icon ghost", title: t("logs"), "aria-label": t("logs"), "aria-expanded": "false" }, icon("logs"))
  c.more = h("button", { type: "button", class: "icon ghost", title: t("more"), "aria-label": t("more"), "aria-haspopup": "menu" }, icon("more"))
  c.pre = h("pre", { tabindex: "0" })
  c.tail = h("span")
  c.clear = h("button", { type: "button", class: "ghost small", text: t("clearLogs") })
  c.logs = h("section", { class: "logs", hidden: true }, h("div", { class: "logs-bar" }, c.clear), c.pre)

  c.el = h(
    "li",
    { class: "row-item" },
    h(
      "div",
      { class: "row-main" },
      c.handle,
      c.dot,
      h("div", { class: "info" }, h("div", { class: "title-line" }, c.name, c.auto, c.update, c.tunnel), c.cmd, c.meta),
      // 主操作（启动/停止）固定在最右侧，其余按钮按需出现时只向左增减，主按钮始终对齐
      h("div", { class: "actions" }, c.copy, c.homepage, c.restart, c.logsBtn, c.more, c.toggle),
    ),
    c.logs,
  )
  bindReorder(c)

  const svcOf = () => state.services.find((s) => s.id === id)
  c.toggle.onclick = () => {
    const svc = svcOf()
    if (!svc) return
    act(id, "toggle", () => post(id, isActive(svc) ? "stop" : "start"))
  }
  c.restart.onclick = () => act(id, "restart", () => post(id, "restart"))
  c.homepage.onclick = () => {
    const url = homepageOf(svcOf() ?? {})
    if (url) openURL(url)
  }
  c.logsBtn.onclick = () => toggleLogs(c)
  // 一个地址直接复制；多个地址下拉选择
  c.copy.onclick = () => {
    const addresses = svcOf()?.runtime.addresses ?? []
    if (addresses.length === 1) copyAddress(addresses[0])
    else if (addresses.length > 1) showMenu(c.copy, addresses.map((a) => ({ label: a, run: () => copyAddress(a) })))
  }
  c.clear.onclick = async () => {
    try {
      await api("DELETE", `api/services/${encodeURIComponent(id)}/logs`)
      resetLogs(c)
      pullLogs(c)
    } catch (e) {
      toast(e.message, true)
    }
  }
  c.more.onclick = () => {
    const svc = svcOf()
    if (svc) showMenu(c.more, moreItems(svc))
  }
  c.tunnel.onclick = () => {
    const tl = tunnelsFor(svcOf())[0]
    if (tl) showMenu(c.tunnel, tunnelItems(tl))
  }
  c.update.onclick = () => {
    const svc = svcOf()
    if (svc && svc.update.available) showMenu(c.update, updateItems(svc))
  }
  return c
}

function moreItems(svc) {
  const id = svc.id
  return [
    { label: t("edit"), run: () => openEditor(svc) },
    { label: t("duplicate"), run: () => act(id, "duplicate", () => post(id, "duplicate")) },
    isActive(svc) && svc.runtime.ports?.length ? { label: t("tunnel.share"), run: () => openTunnelDialog({ port: svc.runtime.ports[0], serviceId: id }) } : null,
    svc.githubRepository ? { label: t("checkUpdate"), disabled: svc.update.checking, run: () => act(id, "check", () => post(id, "check-update")) } : null,
    svc.ignoredVersion ? { label: t("clearIgnored"), run: () => act(id, "clear-ignored", () => post(id, "clear-ignored")) } : null,
    "-",
    {
      label: t("delete"),
      danger: true,
      run: () =>
        confirmDialog({
          title: t("confirm.delete", svc.name),
          message: isActive(svc) ? t("confirm.deleteRunning") : null,
          actionLabel: t("delete"),
          danger: true,
          run: async () => {
            const { removed } = await api("DELETE", `api/services/${encodeURIComponent(id)}`)
            await refresh()
            if (removed)
              toast(t("deleted", svc.name), false, {
                label: t("undo"),
                run: async () => {
                  try {
                    await api("POST", "api/services/restore", removed)
                    await refresh()
                    toast(t("restored", svc.name))
                  } catch (e) {
                    toast(e.message, true)
                  }
                },
              })
          },
        }),
    },
  ]
}

function updateItems(svc) {
  const id = svc.id
  const st = svc.updateStatus
  return [
    { text: [st.latestReleaseTitle || st.latestVersion, svc.currentVersion ? t("current", svc.currentVersion) : null].filter(Boolean).join(" · ") },
    { label: t("openRelease"), run: () => api("POST", "api/open", { url: st.latestReleaseURL }).catch((e) => toast(e.message, true)) },
    svc.updateCommand ? { label: t("updateNow"), disabled: svc.update.updating, run: () => act(id, "update", () => post(id, "update")) } : null,
    { label: t("markCurrent"), run: () => act(id, "mark-current", () => post(id, "mark-current")) },
    { label: t("ignoreVersion"), run: () => act(id, "ignore", () => post(id, "ignore-version")) },
  ]
}

function updateCard(c, svc) {
  const r = svc.runtime
  const key = statusKey(svc)
  c.dot.className = `dot ${key}`
  c.dot.title = t(`status.${key}`)
  c.dot.setAttribute("aria-label", t(`status.${key}`))
  c.name.textContent = svc.name
  // 这个服务的端口上有隧道时显示：建立中 / 公网 / 失败
  const tl = tunnelsFor(svc)[0]
  c.tunnel.hidden = !tl
  if (tl) {
    c.tunnel.className = `pill tunnel ${tl.status}`
    c.tunnel.replaceChildren(icon("globe"), h("span", { text: t(`tunnel.pill.${tl.status}`) }))
    c.tunnel.title = tl.url ?? tl.error ?? ""
  }
  c.auto.hidden = !svc.autoStart
  c.auto.textContent = svc.startQueue > 1 ? t("autoStartQueue", svc.startQueue) : t("autoStart")
  c.copy.hidden = !(isActive(svc) && r.addresses?.length)
  c.copy.setAttribute("aria-haspopup", r.addresses?.length > 1 ? "menu" : "false")
  c.homepage.hidden = !homepageOf(svc)
  c.homepage.title = homepageOf(svc) ?? ""
  c.cmd.textContent = svc.command
  c.cmd.title = svc.command

  // 更新徽标：检查中 / 更新中 / 有新版本
  const u = svc.update
  if (u.updating || u.checking) {
    c.update.hidden = false
    c.update.textContent = t(u.updating ? "updating" : "checking")
    c.update.disabled = true
  } else if (u.available) {
    c.update.hidden = false
    c.update.disabled = false
    c.update.textContent = t("updateTo", svc.updateStatus.latestVersion)
    c.update.setAttribute("aria-haspopup", "menu")
  } else c.update.hidden = true

  const meta = []
  if (key === "starting" || key === "stopping" || key === "background") meta.push(h("span", { text: t(`status.${key}`) }))
  if (key === "failed" && r.lastError) meta.push(h("span", { class: "err", text: r.lastError }))
  if (isActive(svc)) {
    // 端口与 PID 做成标签：端口最常用，用强调色放在最前；PID 用中性色
    const chip = (kind, label, values, title) =>
      h("span", { class: `chip ${kind}`, title: title ?? null }, h("span", { class: "chip-k", text: label }), values)
    // 端口号本身可以点：复制这个端口对应的地址
    const portButton = (port) => {
      const addr = r.addresses?.find((a) => a.endsWith(`:${port}`)) ?? `http://127.0.0.1:${port}`
      return h("button", { type: "button", class: "chip-v", title: t("copyThis", addr), "aria-label": t("copyThis", addr), text: String(port), onclick: () => copyAddress(addr) })
    }
    if (r.ports.length) meta.push(chip("port", t("chip.port"), r.ports.map(portButton)))
    const pids = r.processes.map((p) => p.pid)
    if (pids.length) meta.push(chip("pid", "PID", [...pids.slice(0, 4), ...(pids.length > 4 ? [`+${pids.length - 4}`] : [])].map((v) => h("b", { text: String(v) })), r.processes.map((p) => `${p.pid} ${p.command}`).join("\n")))
    if (r.startedAt && r.status === "running") meta.push(h("span", { text: t("uptime", duration(Date.now() - Date.parse(r.startedAt))) }))
  }
  if (r.commandChanged) meta.push(h("span", { class: "warn", text: t("commandChanged") }))
  if (svc.githubRepository) {
    if (svc.currentVersion) meta.push(h("span", { text: t("current", svc.currentVersion) }))
    if (svc.ignoredVersion && !u.available) meta.push(h("span", { text: t("ignored", svc.ignoredVersion) }))
    // 这是上次「检查更新」的失败原因，与服务能否启动无关；标明来源和时间，避免被当成启动错误
    if (svc.updateStatus?.errorMessage) {
      const at = svc.updateStatus.lastCheckedAt
      meta.push(h("span", { class: "err", title: at ? t("lastChecked", ago(at)) : null, text: t("updateCheckFailed", svc.updateStatus.errorMessage) }))
    }
    // 忽略了更新版本时不能说「已是最新」
    else if (svc.updateStatus?.lastCheckedAt && !u.available && !u.checking && !svc.ignoredVersion) meta.push(h("span", { title: t("lastChecked", ago(svc.updateStatus.lastCheckedAt)), text: t("upToDate") }))
  }
  if (u.message) meta.push(h("span", { class: "err", text: u.message }))
  c.meta.replaceChildren(...meta)
  c.meta.hidden = meta.length === 0

  // 操作按钮
  const active = isActive(svc)
  const toggleBusy = busy.has(`${svc.id}:toggle`)
  c.toggle.replaceChildren(icon(active ? "stop" : "play"))
  c.toggle.title = t(active ? "stop" : "start")
  c.toggle.setAttribute("aria-label", `${t(active ? "stop" : "start")} ${svc.name}`)
  c.toggle.classList.toggle("start", !active)
  c.el.classList.toggle("is-active", active)
  c.toggle.dataset.locked = r.status === "stopping" || r.status === "starting" ? "1" : "0"
  setBusy(c.toggle, toggleBusy && r.status !== "stopping")
  c.restart.hidden = !active
  c.restart.dataset.locked = r.status === "running" ? "0" : "1"
  setBusy(c.restart, busy.has(`${svc.id}:restart`))
  c.logsBtn.classList.toggle("active", c.logsOpen)
  c.logsBtn.setAttribute("aria-expanded", String(c.logsOpen))
}

// ---- 排序 ---------------------------------------------------------------------

/**
 * 只改变列表里的显示顺序（与启动队列无关）。
 * 用指针事件而不是 HTML5 拖放：magpie 的 WKWebView 与沙盒 iframe 里表现更稳定。
 * 拖动时直接在 DOM 中移动行，松手后把新顺序存到服务端；失败则回到服务端的顺序。
 */
let dragging = null

function currentOrder() {
  return [...$("#list").children].map((el) => [...cards.values()].find((c) => c.el === el)?.id).filter(Boolean)
}

async function saveOrder(before) {
  const ids = currentOrder()
  if (ids.join() === before.join()) return
  // 先在本地生效，轮询不会把行跳回原位
  const byId = new Map(state.services.map((s) => [s.id, s]))
  state.services = ids.map((id) => byId.get(id)).filter(Boolean)
  try {
    state = await api("POST", "api/services/reorder", { ids })
  } catch (e) {
    toast(e.message, true)
    await refresh()
  }
  render()
}

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)")
const SLIDE_MS = 170
const SLIDE_EASE = "cubic-bezier(.2, .8, .2, 1)"

/** 元素当前的 translateY（动画进行中取的是插值后的值）。 */
function translateOf(el) {
  const tf = getComputedStyle(el).transform
  return tf && tf !== "none" ? new DOMMatrixReadOnly(tf).m42 : 0
}

/** 视口坐标下行的「布局位置」（不含 transform）。列表是定位容器，offsetTop 相对它计算。 */
function layoutTop(el) {
  const list = el.parentNode
  return list.getBoundingClientRect().top + list.clientTop + el.offsetTop
}

/** FLIP：元素已经在 DOM 中换了位置，让它从原来看到的位置滑到新位置。 */
function slideFrom(el, visualTopBefore) {
  const dy = visualTopBefore - layoutTop(el)
  if (!dy || reduceMotion.matches) {
    el.style.transform = ""
    return
  }
  el.style.transition = "none"
  el.style.transform = `translateY(${dy}px)`
  void el.offsetHeight // 先让起点生效，再开始过渡
  el.style.transition = `transform ${SLIDE_MS}ms ${SLIDE_EASE}`
  el.style.transform = ""
  const done = () => {
    el.style.transition = ""
    el.removeEventListener("transitionend", done)
  }
  el.addEventListener("transitionend", done)
}

/**
 * 把这一行往上（-1）或往下（+1）挪一位。挪动的是相邻的那一行而不是被拖的行本身：
 * 被拖的行一旦离开文档（insertBefore 会先摘下再插回），指针捕获和焦点都会丢失。
 * animateSelf 为 false 时（拖动中），被拖的行由指针位置决定，不参与滑动。
 */
function shiftRow(el, dir, animateSelf = true) {
  const list = el.parentNode
  const other = dir < 0 ? el.previousElementSibling : el.nextElementSibling
  if (!other) return false
  const otherBefore = layoutTop(other) + translateOf(other)
  const selfBefore = layoutTop(el) + translateOf(el)
  if (dir < 0) list.insertBefore(other, el.nextElementSibling)
  else list.insertBefore(other, el)
  slideFrom(other, otherBefore)
  if (animateSelf) slideFrom(el, selfBefore)
  return true
}

function bindReorder(c) {
  let raf = 0
  // 根据指针位置摆放被拖的行；越过相邻行中线就让相邻行滑过去
  const place = () => {
    const d = dragging
    if (!d) return
    const list = c.el.parentNode
    const listRect = list.getBoundingClientRect()
    const height = c.el.offsetHeight
    // 限制在列表范围内，拖到外面也不会飞出去
    const top = Math.min(Math.max(d.y - d.grab, listRect.top), listRect.bottom - height)
    const center = top + height / 2
    for (let guard = 0; guard < 200; guard++) {
      const prev = c.el.previousElementSibling
      const next = c.el.nextElementSibling
      if (prev && center < layoutTop(prev) + prev.offsetHeight / 2) shiftRow(c.el, -1, false)
      else if (next && center > layoutTop(next) + next.offsetHeight / 2) shiftRow(c.el, 1, false)
      else break
    }
    c.el.style.transform = `translateY(${top - layoutTop(c.el)}px)`
  }
  // 靠近窗口上下边缘时持续自动滚动，并随滚动重新摆放
  const autoScroll = () => {
    raf = 0
    const d = dragging
    if (!d) return
    const step = d.y < 56 ? -Math.ceil((56 - d.y) / 4) : d.y > innerHeight - 56 ? Math.ceil((d.y - innerHeight + 56) / 4) : 0
    if (!step) return
    scrollBy(0, step)
    place()
    raf = requestAnimationFrame(autoScroll)
  }
  const move = (e) => {
    if (!dragging || e.pointerId !== dragging.pointerId) return
    dragging.y = e.clientY
    place()
    if (!raf) raf = requestAnimationFrame(autoScroll)
  }
  const finish = (e) => {
    if (!dragging || e.pointerId !== dragging.pointerId) return
    const { before } = dragging
    dragging = null
    cancelAnimationFrame(raf)
    raf = 0
    document.removeEventListener("pointermove", move)
    document.removeEventListener("pointerup", finish)
    document.removeEventListener("pointercancel", finish)
    document.body.classList.remove("sorting")
    // 松手后滑进空位，再去掉浮起效果
    const settle = () => {
      c.el.classList.remove("dragging")
      c.el.style.transition = ""
    }
    if (reduceMotion.matches || !translateOf(c.el)) {
      c.el.style.transform = ""
      settle()
    } else {
      c.el.style.transition = `transform ${SLIDE_MS}ms ${SLIDE_EASE}`
      c.el.style.transform = ""
      c.el.addEventListener("transitionend", settle, { once: true })
      setTimeout(settle, SLIDE_MS + 80) // transitionend 偶尔不触发时兜底收尾
    }
    saveOrder(before)
  }
  c.handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || dragging || cards.size < 2) return
    e.preventDefault()
    closeMenu()
    try {
      c.handle.setPointerCapture(e.pointerId)
    } catch {}
    const rect = c.el.getBoundingClientRect()
    dragging = { c, before: currentOrder(), pointerId: e.pointerId, y: e.clientY, grab: e.clientY - rect.top }
    c.el.style.transition = "none"
    c.el.classList.add("dragging")
    document.body.classList.add("sorting")
    // 监听挂在 document 上：即使指针捕获意外丢失，移动和松手也收得到
    document.addEventListener("pointermove", move)
    document.addEventListener("pointerup", finish)
    document.addEventListener("pointercancel", finish)
  })
  // 键盘：聚焦拖动手柄后用 ↑ ↓ 移动一位
  c.handle.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return
    e.preventDefault()
    const before = currentOrder()
    if (shiftRow(c.el, e.key === "ArrowUp" ? -1 : 1)) saveOrder(before)
  })
}

// ---- 隧道 ---------------------------------------------------------------------

let tab = "services"
const tunnelRows = new Map()

function setTab(name) {
  tab = name
  document.body.dataset.tab = name
  for (const b of document.querySelectorAll("#tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === name))
  $("#view-services").hidden = name !== "services"
  $("#view-tunnels").hidden = name !== "tunnels"
  $("#btn-new").textContent = t(name === "tunnels" ? "tunnel.new" : "new")
  closeMenu()
  render()
}

/** 指向这个服务的隧道：创建时关联的，或端口正是它正在监听的端口。 */
function tunnelsFor(svc) {
  if (!svc || !state?.tunnels) return []
  const ports = new Set(svc.runtime.ports ?? [])
  return state.tunnels.filter((tl) => tl.serviceId === svc.id || ports.has(tl.port))
}

function serviceNameOf(tl) {
  const svc = state?.services.find((s) => s.id === tl.serviceId) ?? state?.services.find((s) => (s.runtime.ports ?? []).includes(tl.port) && isActive(s))
  return svc?.name ?? null
}

const openURL = (url) => api("POST", "api/open", { url }).catch((e) => toast(e.message, true))

async function stopTunnel(tl) {
  try {
    await api("DELETE", `api/tunnels/${encodeURIComponent(tl.id)}`)
  } catch (e) {
    toast(e.message, true)
  }
  await refresh()
}

function tunnelItems(tl) {
  if (tl.status === "error")
    return [
      { text: tl.error },
      { label: t("tunnel.retry"), run: () => api("POST", `api/tunnels/${encodeURIComponent(tl.id)}/retry`).then(refresh, (e) => toast(e.message, true)) },
      { label: t("tunnel.remove"), run: () => stopTunnel(tl) },
    ]
  return [
    { text: tl.url ?? t("tunnel.starting") },
    { label: t("tunnel.copy"), disabled: !tl.url, run: () => copyAddress(tl.url) },
    { label: t("tunnel.open"), disabled: !tl.url, run: () => openURL(tl.url) },
    "-",
    { label: t("tunnel.stop"), danger: true, run: () => stopTunnel(tl) },
  ]
}

function createTunnelRow(id) {
  const r = { id }
  const iconButton = (name, label) => h("button", { type: "button", class: "icon ghost", title: label, "aria-label": label }, icon(name))
  r.dot = h("span", { class: "dot", role: "img" })
  r.url = h("button", { type: "button", class: "tunnel-url" })
  r.meta = h("div", { class: "meta" })
  r.copy = iconButton("copy", t("tunnel.copy"))
  r.open = iconButton("external", t("tunnel.open"))
  r.retry = iconButton("restart", t("tunnel.retry"))
  r.stop = h("button", { type: "button", class: "icon toggle" })
  r.el = h(
    "li",
    { class: "row-item tunnel-row" },
    h(
      "div",
      { class: "row-main" },
      h("span", { class: "handle-space" }),
      r.dot,
      h("div", { class: "info" }, h("div", { class: "title-line" }, r.url), r.meta),
      h("div", { class: "actions" }, r.copy, r.open, r.retry, r.stop),
    ),
  )
  const cur = () => state.tunnels.find((x) => x.id === id)
  r.url.onclick = () => cur()?.url && copyAddress(cur().url)
  r.copy.onclick = () => cur()?.url && copyAddress(cur().url)
  r.open.onclick = () => cur()?.url && openURL(cur().url)
  r.retry.onclick = async () => {
    setBusy(r.retry, true)
    try {
      await api("POST", `api/tunnels/${encodeURIComponent(id)}/retry`)
    } catch (e) {
      toast(e.message, true)
    }
    await refresh()
  }
  r.stop.onclick = async () => {
    const tl = cur()
    if (!tl) return
    setBusy(r.stop, true)
    await stopTunnel(tl)
  }
  return r
}

function updateTunnelRow(r, tl) {
  const dot = { starting: "starting", active: "running", stopping: "stopping", error: "failed" }[tl.status] ?? "stopped"
  r.dot.className = `dot ${dot}`
  r.dot.setAttribute("aria-label", t(`tunnel.status.${tl.status}`))
  r.dot.title = t(`tunnel.status.${tl.status}`)
  r.el.classList.toggle("is-active", tl.status === "active")
  r.url.textContent = tl.url ? tl.url.replace(/^https:\/\//, "") : t(tl.status === "error" ? "tunnel.failed" : `tunnel.status.${tl.status}`)
  r.url.disabled = !tl.url
  r.url.title = tl.url ? t("copyThis", tl.url) : ""
  const name = serviceNameOf(tl)
  const meta = [h("span", { class: "chip port" }, h("span", { class: "chip-k", text: t("chip.port") }), h("b", { text: String(tl.port) }))]
  if (name) meta.push(h("span", { class: "chip pid" }, h("span", { class: "chip-k", text: t("tunnel.service") }), h("b", { text: name })))
  if (tl.status === "active" && tl.startedAt) meta.push(h("span", { text: t("uptime", duration(Date.now() - Date.parse(tl.startedAt))) }))
  if (tl.status === "active" && !tl.listening) meta.push(h("span", { class: "warn", text: t("tunnel.notListening", tl.port) }))
  if (tl.status === "error" && tl.error) meta.push(h("span", { class: "err", text: tl.error }))
  r.meta.replaceChildren(...meta)
  r.copy.hidden = r.open.hidden = !tl.url
  r.retry.hidden = tl.status !== "error"
  const isError = tl.status === "error"
  r.stop.replaceChildren(icon(isError ? "close" : "stop"))
  r.stop.title = t(isError ? "tunnel.remove" : "tunnel.stop")
  r.stop.setAttribute("aria-label", r.stop.title)
  r.stop.dataset.locked = tl.status === "stopping" ? "1" : "0"
  setBusy(r.stop, tl.status === "stopping")
}

function renderTunnelEmpty(box, cf) {
  if (!cf) {
    box.replaceChildren(h("p", { class: "muted", text: t("tunnel.detecting") }))
    return
  }
  if (!cf.installed) {
    const cmd = "brew install cloudflared"
    const copy = h("button", { type: "button", class: "icon ghost", title: t("copy"), "aria-label": t("copy") }, icon("copy"))
    copy.onclick = () => copyText(cmd)
    const again = h("button", { type: "button", text: t("tunnel.redetect") })
    again.onclick = async () => {
      setBusy(again, true)
      try {
        state.cloudflared = await api("POST", "api/tunnels/detect")
      } catch (e) {
        toast(e.message, true)
      }
      setBusy(again, false)
      render()
    }
    box.replaceChildren(
      h("h2", { text: t("tunnel.needInstall") }),
      h("p", { class: "muted", text: t("tunnel.needInstallHint") }),
      h("div", { class: "install-cmd" }, h("code", { text: cmd }), copy),
      h("div", { class: "row gap" }, again),
    )
    return
  }
  const create = h("button", { type: "button", class: "primary", text: t("tunnel.new") })
  create.onclick = () => openTunnelDialog()
  box.replaceChildren(h("h2", { text: t("tunnel.empty") }), h("p", { class: "muted", text: t("tunnel.emptyHint") }), h("div", { class: "row gap" }, create))
}

function renderTunnels() {
  const tunnels = state.tunnels ?? []
  const active = tunnels.filter((tl) => tl.status !== "error").length
  $("#count-tunnels").textContent = active ? String(active) : ""
  $("#count-services").textContent = String(state.services.length)
  if (tab !== "tunnels") return
  const list = $("#tunnel-list")
  const empty = $("#tunnel-empty")
  list.hidden = tunnels.length === 0
  empty.hidden = tunnels.length > 0
  if (!tunnels.length) {
    // 只在状态变化时重画空状态，避免轮询打断按钮的忙碌状态
    const key = state.cloudflared ? (state.cloudflared.installed ? "empty" : "install") : "detecting"
    if (empty.dataset.key !== key) {
      empty.dataset.key = key
      renderTunnelEmpty(empty, state.cloudflared)
    }
  }
  const seen = new Set()
  tunnels.forEach((tl, i) => {
    let r = tunnelRows.get(tl.id)
    if (!r) {
      r = createTunnelRow(tl.id)
      tunnelRows.set(tl.id, r)
    }
    updateTunnelRow(r, tl)
    if (list.children[i] !== r.el) list.insertBefore(r.el, list.children[i] ?? null)
    seen.add(tl.id)
  })
  for (const [id, r] of tunnelRows) {
    if (seen.has(id)) continue
    r.el.remove()
    tunnelRows.delete(id)
  }
}

/**
 * 新建隧道：可以直接输入端口，也可以点正在运行的服务的端口快速填入。
 * 从服务菜单进来时已经带上端口和服务。公开到互联网属于危险操作，对话框里保留一句明确提示。
 */
function openTunnelDialog({ port = null, serviceId = null } = {}) {
  if (state?.cloudflared && !state.cloudflared.installed) {
    setTab("tunnels")
    return
  }
  const portInput = h("input", { type: "number", class: "port-input", min: "1", max: "65535", step: "1", value: port ? String(port) : "", placeholder: "3000", "aria-label": t("tunnel.port") })
  const fieldErr = h("span", { class: "error", role: "alert" })
  let chosenService = serviceId
  const picks = []
  for (const svc of state.services) {
    if (!isActive(svc)) continue
    for (const p of svc.runtime.ports ?? []) {
      const b = h("button", { type: "button", class: "pick", "aria-pressed": String(p === port) }, h("span", { text: svc.name }), h("b", { text: String(p) }))
      b.onclick = () => {
        portInput.value = String(p)
        chosenService = svc.id
        for (const x of picks) x.setAttribute("aria-pressed", String(x === b))
        fieldErr.textContent = ""
        portInput.classList.remove("invalid")
      }
      picks.push(b)
    }
  }
  portInput.addEventListener("input", () => {
    chosenService = null
    for (const x of picks) x.setAttribute("aria-pressed", "false")
    fieldErr.textContent = ""
    portInput.classList.remove("invalid")
  })
  const start = h("button", { type: "button", class: "primary", text: t("tunnel.start") })
  const cancel = h("button", { type: "button", text: t("form.cancel") })
  let working = false
  const d = openDialog({
    title: t("tunnel.new"),
    small: true,
    body: [
      h("label", { class: "field" }, h("span", { text: t("tunnel.port") }), portInput, fieldErr),
      picks.length ? h("div", { class: "picks" }, picks) : null,
      h("p", { class: "warn-note", text: t("tunnel.warning") }),
    ],
    footer: [cancel, start],
    onEscape: () => !working && d.close(),
    canDismiss: () => !working,
  })
  cancel.onclick = () => !working && d.close()
  portInput.addEventListener("keydown", (e) => e.key === "Enter" && start.click())
  start.onclick = async () => {
    const value = Number(portInput.value)
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      fieldErr.textContent = t("tunnel.badPort")
      portInput.classList.add("invalid")
      portInput.focus()
      return
    }
    // 手动输入的端口如果正好是某个运行中服务的端口，也关联上，方便在服务行里显示
    const owner = chosenService ?? state.services.find((s) => isActive(s) && (s.runtime.ports ?? []).includes(value))?.id ?? null
    if (working) return
    working = true
    setBusy(start, true)
    cancel.disabled = true
    try {
      await api("POST", "api/tunnels", { port: value, serviceId: owner })
      d.close()
      toast(t("tunnel.creating", value), false, tab === "tunnels" ? null : { label: t("tunnel.view"), run: () => setTab("tunnels") })
      await refresh()
    } catch (e) {
      fieldErr.textContent = e.message
      portInput.classList.add("invalid")
    } finally {
      working = false
      setBusy(start, false)
      cancel.disabled = false
    }
  }
}

/** 复制任意文本（如安装命令）；宿主的 pbcopy 兜底只接受地址，这里失败时把文字留在提示里。 */
async function copyText(text) {
  let ok = false
  try {
    await navigator.clipboard.writeText(text)
    ok = true
  } catch {}
  if (!ok) {
    const ta = h("textarea", { value: text, readonly: "", style: "position:fixed;left:-9999px;top:0" })
    document.body.append(ta)
    ta.select()
    try {
      ok = document.execCommand("copy")
    } catch {}
    ta.remove()
  }
  toast(ok ? t("copied", text) : t("copyFailed", text), !ok)
}

// ---- 复制地址 ---------------------------------------------------------------------

/**
 * 沙盒框架里 navigator.clipboard 可能被权限策略禁用，依次退回 execCommand、
 * 再退回让本机宿主执行 pbcopy（只在面板就是本机服务时，经 magpie web 远程打开时不用）。
 */
async function copyAddress(text) {
  let ok = false
  try {
    await navigator.clipboard.writeText(text)
    ok = true
  } catch {}
  if (!ok) {
    const ta = h("textarea", { value: text, readonly: "", style: "position:fixed;left:-9999px;top:0" })
    document.body.append(ta)
    ta.select()
    try {
      ok = document.execCommand("copy")
    } catch {}
    ta.remove()
  }
  if (!ok && location.hostname === "127.0.0.1") {
    try {
      await api("POST", "api/copy", { text })
      ok = true
    } catch {}
  }
  if (ok) toast(t("copied", text))
  else toast(t("copyFailed", text), true)
}

// ---- 日志 ---------------------------------------------------------------------

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g
const MAX_LINES = 3000

function resetLogs(c) {
  c.offset = null
  c.partial = ""
  c.lines = 0
  c.pre.replaceChildren(c.tail)
  c.tail.textContent = ""
}

function lineNode(text) {
  // 进度条类输出用 \r 覆盖同一行，只保留最后一段
  const clean = text.replace(ANSI, "").split("\r").filter(Boolean).at(-1) ?? ""
  return h("span", { class: clean.startsWith("▸ ") ? "meta-line" : null, text: `${clean}\n` })
}

function appendLogText(c, text) {
  if (!text) return
  const parts = (c.partial + text).split("\n")
  c.partial = parts.pop() ?? ""
  if (parts.length) {
    const frag = document.createDocumentFragment()
    for (const p of parts) frag.append(lineNode(p))
    c.pre.insertBefore(frag, c.tail)
    c.lines += parts.length
    while (c.lines > MAX_LINES && c.pre.firstChild !== c.tail) {
      c.pre.firstChild.remove()
      c.lines--
    }
  }
  c.tail.textContent = c.partial.replace(ANSI, "")
}

async function pullLogs(c) {
  if (c.pulling || !c.logsOpen) return
  c.pulling = true
  try {
    const q = c.offset === null ? "" : `?offset=${c.offset}`
    const r = await api("GET", `api/services/${encodeURIComponent(c.id)}/logs${q}`)
    const pre = c.pre
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 12
    if (r.reset) resetLogs(c)
    appendLogText(c, r.text)
    c.offset = r.offset
    if (c.lines === 0 && !c.partial) c.tail.textContent = t("noLogs")
    else if (c.tail.textContent === t("noLogs")) c.tail.textContent = c.partial
    c.tail.className = c.lines === 0 && !c.partial ? "empty-line" : ""
    // 用户往上翻看时不打断，停在底部时自动跟随
    if (atBottom || r.reset) pre.scrollTop = pre.scrollHeight
  } catch {
    // 轮询失败由状态轮询统一提示
  } finally {
    c.pulling = false
  }
}

function toggleLogs(c) {
  c.logsOpen = !c.logsOpen
  c.logs.hidden = !c.logsOpen
  c.logsBtn.classList.toggle("active", c.logsOpen)
  c.logsBtn.setAttribute("aria-expanded", String(c.logsOpen))
  if (c.logsOpen) {
    resetLogs(c)
    pullLogs(c)
    c.timer = setInterval(() => !document.hidden && pullLogs(c), 1000)
  } else stopLogs(c)
}

function stopLogs(c) {
  clearInterval(c.timer)
  c.timer = null
}

// ---- 渲染与轮询 ---------------------------------------------------------------------

function render() {
  if (!state) return
  renderTunnels()
  const services = state.services
  $("#empty").hidden = services.length > 0
  $("#list").hidden = services.length === 0

  const list = $("#list")
  const seen = new Set()
  services.forEach((svc, i) => {
    let c = cards.get(svc.id)
    if (!c) {
      c = createCard(svc.id)
      cards.set(svc.id, c)
    }
    updateCard(c, svc)
    // 拖动排序进行中由拖动逻辑负责位置，轮询结果不去打乱它
    if (!dragging && list.children[i] !== c.el) list.insertBefore(c.el, list.children[i] ?? null)
    seen.add(svc.id)
  })
  for (const [id, c] of cards) {
    if (seen.has(id)) continue
    stopLogs(c)
    c.el.remove()
    cards.delete(id)
  }

  const rate = $("#rate")
  if (state.rateLimitedUntil) {
    rate.hidden = false
    rate.textContent = t("rateLimited", duration(Date.parse(state.rateLimitedUntil) - Date.now()))
  } else rate.hidden = true
}

let pollTimer = null
let stopped = false

async function refresh() {
  if (stopped) return
  try {
    state = await api("GET", "api/state")
    notice(null)
    render()
  } catch (e) {
    if (e.status === 401) return unauthorized()
    notice(e.message, true)
  }
}

function schedule() {
  clearTimeout(pollTimer)
  if (stopped) return
  const fast = state?.services.some((s) => s.runtime.status === "starting" || s.runtime.status === "stopping" || s.update.checking || s.update.updating)
  pollTimer = setTimeout(async () => {
    if (!document.hidden) await refresh()
    schedule()
  }, fast ? 800 : 2000)
}

function unauthorized() {
  stopped = true
  clearTimeout(pollTimer)
  for (const c of cards.values()) stopLogs(c)
  document.querySelector(".tools").hidden = true
  $("#list").hidden = true
  $("#empty").hidden = true
  notice(t("unauthorized"), true)
}

function settingsMenu() {
  const s = state?.settings ?? { autoCheck: true, autoUpdate: true, intervalHours: 12 }
  const box = h("input", { type: "checkbox", checked: s.autoCheck })
  const autoUpdate = h("input", { type: "checkbox", checked: s.autoUpdate, disabled: !s.autoCheck })
  const select = h(
    "select",
    { "aria-label": t("settings.interval", s.intervalHours), disabled: !s.autoCheck },
    [1, 3, 6, 12, 24, 48].map((n) => h("option", { value: String(n), selected: n === s.intervalHours, text: t("settings.interval", n) })),
  )
  let saveSeq = 0
  const save = async (control, patch) => {
    const previous = control.type === "checkbox" ? !control.checked : s.intervalHours
    const seq = ++saveSeq
    let settings
    try {
      settings = await api("PUT", "api/settings", patch)
    } catch (e) {
      if (seq === saveSeq) {
        if (control.type === "checkbox") control.checked = previous
        else control.value = String(previous)
      }
      toast(e.message, true)
      return
    }
    if (seq !== saveSeq) return
    state.settings = settings
    box.checked = settings.autoCheck
    autoUpdate.checked = settings.autoUpdate
    select.disabled = !settings.autoCheck
    autoUpdate.disabled = !settings.autoCheck
  }
  box.onchange = () => save(box, { autoCheck: box.checked })
  autoUpdate.onchange = () => save(autoUpdate, { autoUpdate: autoUpdate.checked })
  select.onchange = () => save(select, { intervalHours: Number(select.value) })
  return [
    { node: h("label", null, box, h("span", { text: t("settings.autoCheck") })) },
    { node: select },
    { node: h("label", { title: t("tip.autoUpdate") }, autoUpdate, h("span", { text: t("settings.autoUpdate") })) },
    "-",
    { label: t("token.menu"), run: openTokenDialog },
  ]
}

const TOKEN_CREATE_URL = "https://github.com/settings/tokens/new?description=magpie%20Local%20Services"

/** GitHub 访问令牌：只用于查询 Release，提高请求配额。令牌由宿主验证后保存，面板只看到末 4 位。 */
async function openTokenDialog() {
  let status
  try {
    status = await api("GET", "api/github-token")
  } catch (e) {
    toast(e.message, true)
    return
  }
  const input = h("input", { type: "password", autocomplete: "off", spellcheck: "false", placeholder: "ghp_… / github_pat_…", "aria-label": t("token.label") })
  const fieldErr = h("span", { class: "error", role: "alert" })
  const current = h("p", { class: "token-status", text: t(`token.source.${status.source ?? "none"}`, status.tail ?? "") })
  const createBtn = h("button", { type: "button", class: "link-btn" }, icon("external"), h("span", { text: t("token.create") }))
  createBtn.onclick = async () => {
    try {
      await api("POST", "api/open", { url: TOKEN_CREATE_URL })
    } catch (e) {
      toast(e.message, true)
    }
  }
  const save = h("button", { type: "button", class: "primary", text: t("form.save") })
  const cancel = h("button", { type: "button", text: t("form.cancel") })
  const remove = status.source === "settings" ? h("button", { type: "button", class: "danger", text: t("token.remove") }) : null
  let working = false
  const d = openDialog({
    title: t("token.title"),
    small: true,
    body: [
      current,
      h("label", { class: "field" }, h("span", { text: t("token.label") }), input, h("span", { class: "hint", text: t("token.scopeHint") }), fieldErr),
      createBtn,
    ],
    footer: [remove, h("span", { class: "spacer" }), cancel, save],
    onEscape: () => !working && d.close(),
    canDismiss: () => !working,
  })
  cancel.onclick = () => !working && d.close()
  input.addEventListener("input", () => {
    fieldErr.textContent = ""
    input.classList.remove("invalid")
  })
  input.addEventListener("keydown", (e) => e.key === "Enter" && save.click())
  const run = async (btn, fn) => {
    if (working) return
    working = true
    setBusy(btn, true)
    cancel.disabled = true
    try {
      await fn()
    } finally {
      working = false
      setBusy(btn, false)
      cancel.disabled = false
    }
  }
  save.onclick = () => {
    const token = input.value.trim()
    if (!token) {
      fieldErr.textContent = t("token.required")
      input.classList.add("invalid")
      input.focus()
      return
    }
    run(save, async () => {
      try {
        const r = await api("PUT", "api/github-token", { token })
        d.close()
        toast(t("token.saved", r.rate?.limit ?? 5000))
        state = await api("GET", "api/state")
        render()
      } catch (e) {
        fieldErr.textContent = e.message
        input.classList.add("invalid")
        input.focus()
      }
    })
  }
  if (remove)
    remove.onclick = () =>
      run(remove, async () => {
        try {
          await api("DELETE", "api/github-token")
          d.close()
          toast(t("token.removed"))
        } catch (e) {
          fieldErr.textContent = e.message
        }
      })
}

function init() {
  applyTheme()
  document.title = t("title")
  $("#title").textContent = t("title")
  $("#btn-new").textContent = t("new")
  $("#empty-new").textContent = t("new")
  $("#empty-title").textContent = t("empty.title")
  $("#empty-hint").textContent = t("empty.hint")
  for (const [sel, label] of [["#btn-check", "checkAll"], ["#btn-settings", "settings"]]) {
    $(sel).title = t(label)
    $(sel).setAttribute("aria-label", t(label))
  }

  if (!TOKEN) return unauthorized()

  $("#tab-services").textContent = t("tab.services")
  $("#tab-tunnels").textContent = t("tab.tunnels")
  for (const b of document.querySelectorAll("#tabs [data-tab]")) b.onclick = () => setTab(b.dataset.tab)
  document.body.dataset.tab = "services"
  $("#btn-new").onclick = () => (tab === "tunnels" ? openTunnelDialog() : openEditor(null))
  $("#empty-new").onclick = () => openEditor(null)
  $("#btn-settings").onclick = () => showMenu($("#btn-settings"), settingsMenu())
  $("#btn-check").onclick = async () => {
    const btn = $("#btn-check")
    if (btn.classList.contains("busy")) return
    setBusy(btn, true)
    try {
      state = await api("POST", "api/check-all")
      render()
    } catch (e) {
      toast(e.message, true)
    } finally {
      setBusy(btn, false)
    }
  }
  document.addEventListener("visibilitychange", () => !document.hidden && refresh())

  refresh().then(schedule)
}

init()
