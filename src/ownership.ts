// Atomic, fail-closed ownership shared by plugin hooks and foreground runs.
// Never steal a lock based on a PID: PID reuse and an in-flight shutdown can
// otherwise let an old process clear a new owner's pixel.
import { mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function writerLockPath(): string {
  // A single canonical location, independent of the invoking session/plugin env.
  // This is a coordination lock, not user configuration or durable plugin state.
  return join(homedir(), ".cache", "herdr-awtrix", "writer.lock")
}

export type WriterLease = {
  stopRequested(): boolean
  release(): void
}

export function tryAcquireWriter(path = writerLockPath()): WriterLease | undefined {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 })
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined
    throw error
  }
  const token = crypto.randomUUID()
  try {
    writeFileSync(join(path, "owner.json"), JSON.stringify({
      token, pid: process.pid, socket: process.env.HERDR_SOCKET_PATH ?? null,
    }), { mode: 0o600, flag: "wx" })
  } catch (error) {
    rmdirSync(path)
    throw error
  }
  let released = false
  return {
    stopRequested() {
      try { return readFileSync(join(path, "stop"), "utf8") === token } catch { return false }
    },
    release() {
      if (released) return
      // Refuse to remove anything if a human has replaced this lease's directory.
      const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"))
      if (owner.token !== token) throw new Error("writer ownership changed; refusing to release it")
      // All HTTP work has finished. Atomically retire the directory before
      // cleanup so a concurrent stop request cannot make rmdir fail on it.
      const retired = `${path}.${token}`
      renameSync(path, retired)
      released = true
      try { unlinkSync(join(retired, "stop")) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      unlinkSync(join(retired, "owner.json"))
      rmdirSync(retired)
    },
  }
}

/** Cooperative stop; does not send a signal to a potentially recycled PID. */
export function requestWriterStop(path = writerLockPath()): () => boolean {
  let token: unknown
  try { token = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")).token } catch {
    throw new Error(`no readable writer owner at ${path}`)
  }
  if (typeof token !== "string") throw new Error("invalid writer owner")
  writeFileSync(join(path, "stop"), token, { mode: 0o600 })
  return () => {
    try { return JSON.parse(readFileSync(join(path, "owner.json"), "utf8")).token !== token } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
      throw error
    }
  }
}
