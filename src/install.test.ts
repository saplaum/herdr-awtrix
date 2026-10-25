import { afterEach, beforeEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

type Manifest = { version: string; build: { command: string[] }[]; startup: { command: string[] }[]; actions: { command: string[] }[] }
function readManifest(path: string): Manifest {
  return Bun.TOML.parse(readFileSync(path, "utf8")) as Manifest
}

const source = resolve(import.meta.dir, "..")
let directory: string
let root: string
let releases: string
let env: NodeJS.ProcessEnv

function run(script: string, args: string[] = []) {
  return spawnSync("/bin/sh", [join(root, "scripts", script), ...args], {
    cwd: directory, env, encoding: "utf8", timeout: 10_000,
  })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "awtrix-install-"))
  root = join(directory, "plugin with spaces")
  releases = join(directory, "releases")
  const stubs = join(directory, "tools")
  for (const path of [join(root, "scripts"), releases, stubs]) mkdirSync(path, { recursive: true })
  for (const script of ["install.sh", "run.sh"]) copyFileSync(join(source, "scripts", script), join(root, "scripts", script))
  copyFileSync(join(source, "herdr-plugin.toml"), join(root, "herdr-plugin.toml"))
  env = { ...process.env, PATH: `${stubs}:/usr/bin:/bin`, FIXTURE_RELEASES: releases,
    FIXTURE_REQUESTS: join(directory, "requests"), FIXTURE_OS: "Darwin", FIXTURE_ARCH: "arm64" }
  writeFileSync(join(stubs, "uname"), '#!/bin/sh\ncase "$1" in -s) echo "$FIXTURE_OS";; -m) echo "$FIXTURE_ARCH";; esac\n', { mode: 0o755 })
  // Intercept only curl: selection, checksums, tar, staging and launcher are real.
  writeFileSync(join(stubs, "curl"), `#!/bin/sh
set -eu
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$url" >> "$FIXTURE_REQUESTS"
[ -n "$output" ] && [ -n "$url" ] || exit 2
cp "$FIXTURE_RELEASES/\${url##*/}" "$output"
`, { mode: 0o755 })
  const payload = join(directory, "payload")
  mkdirSync(payload)
  writeFileSync(join(payload, "herdr-awtrix"), '#!/bin/sh\nprintf "<%s>\\n" "$@"\n', { mode: 0o755 })
  let checksums = ""
  for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
    const name = `herdr-awtrix-${target}.tar.gz`
    const archive = join(releases, name)
    const packed = spawnSync("tar", ["-czf", archive, "-C", payload, "herdr-awtrix"])
    if (packed.status !== 0) throw new Error(packed.stderr.toString())
    checksums += `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${name}\n`
  }
  writeFileSync(join(releases, "SHA256SUMS"), checksums)
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

test.each([
  ["Darwin", "arm64", "darwin-arm64"],
  ["Darwin", "x86_64", "darwin-x64"],
  ["Linux", "aarch64", "linux-arm64"],
  ["Linux", "x86_64", "linux-x64"],
])("installer selects %s/%s and downloads version-pinned %s", (os, arch, target) => {
  env.FIXTURE_OS = os
  env.FIXTURE_ARCH = arch
  const installed = run("install.sh")
  expect(installed.stderr).toBe("")
  expect(installed.status).toBe(0)
  const version = readManifest(join(root, "herdr-plugin.toml")).version
  const base = `https://github.com/saplaum/herdr-awtrix/releases/download/v${version}`
  expect(readFileSync(env.FIXTURE_REQUESTS!, "utf8").trim().split("\n")).toEqual([
    `${base}/SHA256SUMS`, `${base}/herdr-awtrix-${target}.tar.gz`,
  ])
  expect(readFileSync(join(root, "bin", "version"), "utf8")).toBe(`${version}\n`)
  const launched = run("run.sh", ["--once", "argument with spaces"])
  expect(launched.status).toBe(0)
  expect(launched.stdout).toBe("<--once>\n<argument with spaces>\n")
  expect(readdirSync(join(root, "bin")).sort()).toEqual(["herdr-awtrix", "version"])
})

test("checksum failure preserves the previous binary and removes staging", () => {
  expect(run("install.sh").status).toBe(0)
  const previous = readFileSync(join(root, "bin", "herdr-awtrix"))
  writeFileSync(join(releases, "herdr-awtrix-darwin-arm64.tar.gz"), "corrupt")
  const failed = run("install.sh")
  expect(failed.status).not.toBe(0)
  expect(failed.stderr).toContain("checksum mismatch")
  expect(readFileSync(join(root, "bin", "herdr-awtrix"))).toEqual(previous)
  expect(readdirSync(join(root, "bin")).sort()).toEqual(["herdr-awtrix", "version"])
})

test("missing checksum fails closed before extraction", () => {
  writeFileSync(join(releases, "SHA256SUMS"), "")
  const failed = run("install.sh")
  expect(failed.status).not.toBe(0)
  expect(failed.stderr).toContain("missing or invalid checksum")
  expect(existsSync(join(root, "bin", "herdr-awtrix"))).toBe(false)
})

test("missing release aborts installation with an actionable message", () => {
  rmSync(join(releases, "SHA256SUMS"))
  const failed = run("install.sh")
  expect(failed.status).not.toBe(0)
  expect(failed.stderr).toContain("check that the release is published")
  expect(existsSync(join(root, "bin", "herdr-awtrix"))).toBe(false)
})

test("unsupported architectures fail before downloading", () => {
  env.FIXTURE_ARCH = "riscv64"
  const failed = run("install.sh")
  expect(failed.status).not.toBe(0)
  expect(failed.stderr).toContain("unsupported architecture")
  expect(existsSync(env.FIXTURE_REQUESTS!)).toBe(false)
})

test("launcher explains a missing binary and rejects a different version", () => {
  expect(run("run.sh").stderr).toContain("bun run build")
  expect(run("install.sh").status).toBe(0)
  writeFileSync(join(root, "bin", "version"), "0.0.0\n")
  const failed = run("run.sh")
  expect(failed.status).toBe(1)
  expect(failed.stderr).toContain("matching binary is missing")
})

const binary = process.env.HERDR_AWTRIX_TEST_BINARY
const binaryTest = binary ? test : test.skip
binaryTest("real compiled executable survives packaging, verified installation and launch", () => {
  const target = `${process.platform}-${process.arch}`
  env.FIXTURE_OS = process.platform === "darwin" ? "Darwin" : "Linux"
  env.FIXTURE_ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
  copyFileSync(resolve(binary!), join(directory, "payload", "herdr-awtrix"))
  const name = `herdr-awtrix-${target}.tar.gz`
  const archive = join(releases, name)
  const packed = spawnSync("tar", ["-czf", archive, "-C", join(directory, "payload"), "herdr-awtrix"])
  expect(packed.status).toBe(0)
  writeFileSync(join(releases, "SHA256SUMS"), `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${name}\n`)
  const installed = run("install.sh")
  expect(installed.stderr).toBe("")
  expect(installed.status).toBe(0)
  const launched = run("run.sh", ["--help"])
  expect(launched.status).toBe(0)
  expect(launched.stdout).toContain("herdr-awtrix — drives an AWTRIX indicator")
}, 20_000)

test("manifest uses the installer and launcher, not an external Bun runtime", () => {
  const manifest = readManifest(join(source, "herdr-plugin.toml"))
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"))
  expect(manifest.version).toBe(pkg.version)
  expect(manifest.build).toEqual([{ command: ["sh", "scripts/install.sh"] }])
  for (const entry of [...manifest.startup, ...manifest.actions]) {
    expect(entry.command.slice(0, 2)).toEqual(["sh", "scripts/run.sh"])
  }
})
