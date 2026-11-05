import { describe, expect, test } from "bun:test"
import { compareVersions, effectiveVersionCommand, extractVersion, isUpdateAvailable, normalizeRepository, tokenize } from "../lib/version.mjs"

describe("tokenize", () => {
  test("引号与转义", () => {
    expect(tokenize(`headroom proxy --port 8787 --url "http://127.0.0.1:8317"`)).toEqual(["headroom", "proxy", "--port", "8787", "--url", "http://127.0.0.1:8317"])
    expect(tokenize(`'/Applications/My App/bin' run`)).toEqual(["/Applications/My App/bin", "run"])
    expect(tokenize(`a\\ b c`)).toEqual(["a b", "c"])
  })
})

describe("compareVersions", () => {
  test("语义版本", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0)
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1)
    expect(compareVersions("1.2", "1.2.0")).toBe(0)
    expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(-1)
    expect(compareVersions("1.2.3-beta.2", "1.2.3-beta.10")).toBe(-1)
  })
  test("日期版本与非数字", () => {
    expect(compareVersions("2024-01-15", "2024.1.9")).toBe(1)
    expect(compareVersions("20240115", "2024-01-15")).toBe(0)
    expect(compareVersions("nightly", "Nightly")).toBe(0)
    expect(compareVersions("nightly", "1.0.0")).toBe(-1)
  })
})

describe("extractVersion", () => {
  test("常见输出", () => {
    expect(extractVersion("mytool version 1.4.2")).toBe("1.4.2")
    expect(extractVersion("v1.4.2-beta.3 (abc)")).toBe("v1.4.2-beta.3")
    expect(extractVersion("built 2024-01-15")).toBe("2024-01-15")
    expect(extractVersion("no version here")).toBeNull()
  })
})

describe("isUpdateAvailable", () => {
  const base = { updateStatus: { latestVersion: "v2.0.0", latestReleaseURL: "https://github.com/a/b/releases/tag/v2.0.0" } }
  test("比较与忽略", () => {
    expect(isUpdateAvailable({ ...base, currentVersion: "1.9.0" })).toBe(true)
    expect(isUpdateAvailable({ ...base, currentVersion: "2.0.0" })).toBe(false)
    expect(isUpdateAvailable({ ...base, currentVersion: null })).toBe(true)
    expect(isUpdateAvailable({ ...base, currentVersion: "1.0.0", ignoredVersion: "2.0.0" })).toBe(false)
    expect(isUpdateAvailable({ updateStatus: null })).toBe(false)
  })
})

describe("normalizeRepository / effectiveVersionCommand", () => {
  test("仓库格式", () => {
    expect(normalizeRepository("owner/repo")).toBe("owner/repo")
    expect(normalizeRepository("https://github.com/owner/repo.git")).toBe("owner/repo")
    expect(normalizeRepository("github.com/owner/repo/releases")).toBe("owner/repo")
    expect(normalizeRepository("git@github.com:owner/repo.git")).toBe("owner/repo")
    expect(normalizeRepository("owner")).toBeNull()
    expect(normalizeRepository("../x")).toBeNull()
  })
  test("默认版本命令", () => {
    expect(effectiveVersionCommand({ command: `"/opt/my tool" serve`, versionCommand: "" })).toBe("/opt/my tool --version")
    expect(effectiveVersionCommand({ command: "x", versionCommand: " x -V " })).toBe("x -V")
  })
})
