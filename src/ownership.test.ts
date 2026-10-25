import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { requestWriterStop, tryAcquireWriter } from "./ownership"

test("writer acquisition is exclusive and stop is token-bound", () => {
  const directory = mkdtempSync(join(tmpdir(), "awtrix-lock-"))
  const path = join(directory, "writer.lock")
  try {
    const first = tryAcquireWriter(path)!
    expect(tryAcquireWriter(path)).toBeUndefined()
    expect(first.stopRequested()).toBe(false)
    requestWriterStop(path)
    expect(first.stopRequested()).toBe(true)
    first.release()
    first.release()
    const next = tryAcquireWriter(path)!
    expect(next.stopRequested()).toBe(false)
    next.release()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a stale or incomplete lock is never automatically stolen", () => {
  const directory = mkdtempSync(join(tmpdir(), "awtrix-lock-"))
  try {
    const path = join(directory, "writer.lock")
    tryAcquireWriter(path)
    expect(tryAcquireWriter(path)).toBeUndefined()
    const incomplete = join(directory, "incomplete.lock")
    mkdirSync(incomplete)
    expect(tryAcquireWriter(incomplete)).toBeUndefined()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
