import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadConfig } from "./config"

let directory: string
let saved: NodeJS.ProcessEnv

beforeEach(() => {
  saved = { ...process.env }
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("HERDR_AWTRIX_")) delete process.env[name]
  }
  directory = mkdtempSync(join(tmpdir(), "awtrix-config-"))
  process.env.HERDR_AWTRIX_CONFIG_PATH = join(directory, "awtrix.json")
})

afterEach(() => {
  process.env = saved
  rmSync(directory, { recursive: true, force: true })
})

test.each([
  null, [], { indicator: 4 }, { indicator: 1.5 }, { pollMs: 0 },
  { timeoutMs: -1 }, { fadeMs: -1 }, { api: "guess" }, { notify: "yes" },
  { notifyStates: null }, { notifyStates: ["unknown"] },
  { notifyColor: "garbage" }, { notifyColor: [256, 0, 0] }, { notifyColor: false },
  { notifyShowAgent: "yes" }, { notifyShowAgent: null },
  { colors: { working: null } }, { colors: { working: [0, 1] } },
  { colors: { working: [256, 0, 0] } }, { colors: { working: "garbage" } },
  { awtrixUrl: "file:///etc/passwd" }, { awtrixUrl: "http://user:secret@clock.local" },
  { colors: null }, { sessionSocketPath: null }, { unknownOption: true },
].map((input) => ({ input })))("rejects invalid configuration %#", ({ input }) => {
  writeFileSync(process.env.HERDR_AWTRIX_CONFIG_PATH!, JSON.stringify(input))
  expect(() => loadConfig()).toThrow()
})

test("accepts partial configuration and normalizes colors and URL", () => {
  writeFileSync(process.env.HERDR_AWTRIX_CONFIG_PATH!, JSON.stringify({
    awtrixUrl: "http://clock.local/", colors: { working: " OFF " },
  }))
  const config = loadConfig()
  expect(config.awtrixUrl).toBe("http://clock.local")
  expect(config.colors.working).toBe("0")
  expect(config.indicator).toBe(3)
})

test("invalid JSON is not silently replaced by defaults", () => {
  writeFileSync(process.env.HERDR_AWTRIX_CONFIG_PATH!, "{")
  expect(() => loadConfig()).toThrow()
})

test("environment overrides are validated too", () => {
  writeFileSync(process.env.HERDR_AWTRIX_CONFIG_PATH!, "{}")
  process.env.HERDR_AWTRIX_INDICATOR = "NaN"
  expect(() => loadConfig()).toThrow()
})
