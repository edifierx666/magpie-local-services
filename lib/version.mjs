// 版本相关的纯函数：命令分词、版本号提取与比较、GitHub 仓库规范化。

/** 按 POSIX shell 的引号/反斜杠规则分词（不做变量展开）。 */
export function tokenize(command) {
  const tokens = []
  let current = ""
  let hasCurrent = false
  let quote = null
  let escaped = false
  for (const ch of String(command ?? "")) {
    if (escaped) {
      current += ch
      hasCurrent = true
      escaped = false
      continue
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true
      hasCurrent = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      hasCurrent = true
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasCurrent = true
      continue
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (hasCurrent) {
        tokens.push(current)
        current = ""
        hasCurrent = false
      }
      continue
    }
    current += ch
    hasCurrent = true
  }
  if (hasCurrent) tokens.push(current)
  return tokens
}

/** 去掉首尾空白，空串视为未设置。 */
export function trimmed(value) {
  if (typeof value !== "string") return null
  const t = value.trim()
  return t ? t : null
}

/** 版本检测命令：用户未设置时退回 `<可执行文件> --version`。 */
export function effectiveVersionCommand(service) {
  const own = trimmed(service.versionCommand)
  if (own) return own
  const exe = (tokenize(service.command)[0] ?? "").trim()
  return exe ? `${exe} --version` : null
}

// ---- 版本命令自动检测的候选 ----

const VERSION_FLAGS = ["--version", "-v", "-V", "version"]
const RUNNERS = ["npx", "bunx", "pnpm", "yarn", "deno", "bun"]

/** `FOO=bar` 这类前置环境变量赋值。 */
function isEnvironmentAssignment(token) {
  const eq = token.indexOf("=")
  if (eq <= 0) return false
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, eq))
}

/** 命令里真正被执行的程序：跳过开头的环境变量赋值。 */
export function primaryCommandToken(command) {
  const tokens = tokenize(command)
  return tokens.find((t) => t && !isEnvironmentAssignment(t)) ?? tokens[0] ?? ""
}

function quoteIfNeeded(token) {
  return token.includes(" ") ? `'${token.replaceAll("'", "'\\''")}'` : token
}

/** `npx -y foo serve` → ["npx foo", "foo", "npx"]：先试带运行器的，再试裸程序名，最后试运行器本身。 */
function binaryBases(prefix, tokens, start) {
  let i = start
  while (i < tokens.length && tokens[i].startsWith("-")) i++
  if (i >= tokens.length) return [prefix]
  const bin = quoteIfNeeded(tokens[i])
  return [`${prefix} ${bin}`, bin, prefix]
}

/** 按优先顺序列出要试探的版本命令。 */
export function versionCommandCandidates(command) {
  const text = String(command ?? "").trim()
  const tokens = tokenize(text)
  if (!tokens.length) return []
  const [first, second] = tokens
  let bases
  if (first === "bun" && second === "x") bases = binaryBases("bun x", tokens, 2)
  else if (first === "pnpm" && (second === "exec" || second === "dlx")) bases = binaryBases(`pnpm ${second}`, tokens, 2)
  else if (first === "yarn" && second === "dlx") bases = binaryBases("yarn dlx", tokens, 2)
  else if (first === "deno" && second === "run") bases = binaryBases("deno run", tokens, 2)
  else if (RUNNERS.includes(first)) bases = binaryBases(first, tokens, 1)
  else {
    const primary = primaryCommandToken(text)
    bases = primary ? [quoteIfNeeded(primary)] : []
  }
  return [...new Set(bases)].flatMap((base) => VERSION_FLAGS.map((flag) => `${base} ${flag}`))
}

const EXTRACT_PATTERNS = [
  /[vV]?\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?/, // 1.2.3 / v1.2.3 / 1.2.3-beta.1
  /\d{4}[-./]\d{1,2}[-./]\d{1,2}/, // 2024-01-15
  /[vV]?\d+\.\d+/, // 1.2
  /\b\d{8}\b/, // 20240115
]

/** 从任意 `--version` 输出中取出第一个像版本号的片段。 */
export function extractVersion(output) {
  const text = String(output ?? "").trim()
  if (!text) return null
  for (const re of EXTRACT_PATTERNS) {
    const m = text.match(re)
    if (m) return m[0]
  }
  return null
}

function parseVersion(raw) {
  let text = String(raw ?? "").trim()
  if (!text) return null
  if (text[0] === "v" || text[0] === "V") text = text.slice(1)

  // 日期型版本：YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD / YYYYMMDD
  const date = text.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/)
  if (date) return { release: [Number(date[1]), Number(date[2]), Number(date[3])], pre: [] }
  if (/^\d{8}$/.test(text)) {
    return { release: [Number(text.slice(0, 4)), Number(text.slice(4, 6)), Number(text.slice(6, 8))], pre: [] }
  }

  const plus = text.indexOf("+")
  if (plus >= 0) text = text.slice(0, plus)
  const dash = text.indexOf("-")
  const core = dash >= 0 ? text.slice(0, dash) : text
  const pre = dash >= 0 ? text.slice(dash + 1).split(".").filter(Boolean) : []
  const fields = core.split(".")
  if (!fields.length || !fields.every((f) => /^\d+$/.test(f))) return null
  return { release: fields.map(Number), pre }
}

function comparePre(a, b) {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (i >= a.length) return -1
    if (i >= b.length) return 1
    if (a[i] === b[i]) continue
    const ai = /^\d+$/.test(a[i]) ? Number(a[i]) : null
    const bi = /^\d+$/.test(b[i]) ? Number(b[i]) : null
    if (ai !== null && bi !== null) return ai < bi ? -1 : 1
    return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/** 比较两个版本号：-1 / 0 / 1。都解析不出数字时按忽略大小写的字符串比较。 */
export function compareVersions(lhs, rhs) {
  const l = parseVersion(lhs)
  const r = parseVersion(rhs)
  if (!l && !r) {
    const a = String(lhs ?? "").trim().toLowerCase()
    const b = String(rhs ?? "").trim().toLowerCase()
    if (a === b) return 0
    return a < b ? -1 : 1
  }
  if (!l) return -1
  if (!r) return 1
  const n = Math.max(l.release.length, r.release.length)
  for (let i = 0; i < n; i++) {
    const a = l.release[i] ?? 0
    const b = r.release[i] ?? 0
    if (a !== b) return a < b ? -1 : 1
  }
  // 发布号相同时，带预发布后缀的更低
  if (!l.pre.length && !r.pre.length) return 0
  if (!l.pre.length) return 1
  if (!r.pre.length) return -1
  return comparePre(l.pre, r.pre)
}

/** 远端 Release 是否比已安装版本新，且未被用户忽略。 */
export function isUpdateAvailable(service) {
  const st = service.updateStatus
  if (!st || !trimmed(st.latestVersion) || !trimmed(st.latestReleaseURL)) return false
  const ignored = trimmed(service.ignoredVersion)
  if (ignored && compareVersions(st.latestVersion, ignored) === 0) return false
  const current = trimmed(service.currentVersion)
  // 没有已知基线时，任何 Release 都视为可用
  if (!current) return true
  return compareVersions(st.latestVersion, current) > 0
}

const SEGMENT = /^[A-Za-z0-9._-]+$/

/** 接受 `owner/repo`、`github.com/owner/repo`、`https://github.com/owner/repo(.git)`，返回 `owner/repo`。 */
export function normalizeRepository(input) {
  let text = trimmed(input)
  if (!text) return null
  text = text.replace(/^git@github\.com:/i, "")
  text = text.replace(/^https?:\/\//i, "").replace(/^(www\.)?github\.com\//i, "")
  text = text.replace(/[?#].*$/, "").replace(/\/+$/, "")
  const parts = text.split("/")
  if (parts.length < 2) return null
  const owner = parts[0]
  const name = parts[1].replace(/\.git$/i, "")
  if (!SEGMENT.test(owner) || !SEGMENT.test(name) || owner === "." || name === "." || owner === ".." || name === "..") return null
  return `${owner}/${name}`
}
