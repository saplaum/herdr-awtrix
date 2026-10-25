import { afterEach, beforeEach, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createServer as httpServer, type Server as HttpServer, type ServerResponse } from "node:http"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// Run this same lifecycle suite against a compiled executable, without a runtime on PATH.
const binary = process.env.HERDR_AWTRIX_TEST_BINARY
const executable = binary ? resolve(binary) : process.execPath

let directory: string
let socketPath: string
let configPath: string
let api: HttpServer
let session: Server
let url: string
let writes: Array<{ path: string; body: { on?: boolean; color?: string } }>
let children: ChildProcess[]
let connections: Set<Socket>
let agentStatus: string
let answerSnapshots: boolean
let holdResponse: (path: string, response: ServerResponse) => boolean

async function until(check: () => boolean, detail: () => string = () => "", ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`fixture timed out: ${detail()}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function serveSession(path: string): Server {
  const server = createServer((connection) => {
    connections.add(connection)
    connection.on("close", () => connections.delete(connection))
    let buffer = ""
    connection.on("data", (chunk) => {
      buffer += chunk.toString()
      if (!buffer.includes("\n")) return
      if (!answerSnapshots) return
      const request = JSON.parse(buffer.split("\n")[0]!)
      connection.end(JSON.stringify({ id: request.id, result: { snapshot: {
        panes: [{ pane_id: "w1:p1", agent: "fixture", agent_status: agentStatus }],
      } } }) + "\n")
    })
  })
  server.listen(path)
  return server
}

function configure(extra: Record<string, unknown> = {}): void {
  writeFileSync(configPath, JSON.stringify({ awtrixUrl: url, pollMs: 50, timeoutMs: 200, notify: false, ...extra }))
}

function start(args: string[] = [], throughLauncher = false) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith("HERDR_AWTRIX_") || key.startsWith("HERDR_PLUGIN_")) delete env[key]
  }
  const childArgs = binary ? args : ["run", "index.ts", ...args]
  const command = throughLauncher ? ["--eval", `
    const { spawn } = require("node:child_process");
    const child = spawn(${JSON.stringify(executable)}, ${JSON.stringify(childArgs)}, { stdio: ["ignore", "inherit", "inherit"] });
    console.log("fixture-child-pid:" + child.pid);
    setInterval(() => {}, 1000);
  `] : childArgs
  const child = spawn(throughLauncher ? process.execPath : executable, command, {
    cwd: join(import.meta.dir, ".."),
    env: { ...env, ...(binary ? { PATH: "" } : {}), HOME: directory, HERDR_SOCKET_PATH: socketPath, HERDR_AWTRIX_CONFIG_PATH: configPath,
      HERDR_PLUGIN_STATE_DIR: join(directory, "state") },
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.push(child)
  let output = ""
  let exited = false
  child.stdout!.on("data", (chunk) => { output += chunk.toString() })
  child.stderr!.on("data", (chunk) => { output += chunk.toString() })
  const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => { exited = true; resolve(code) }))
  return { child, exit, output: () => output, exited: () => exited }
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "a"))
  socketPath = join(directory, "s")
  configPath = join(directory, "config.json")
  writes = []
  children = []
  connections = new Set()
  agentStatus = "working"
  answerSnapshots = true
  holdResponse = () => false
  api = httpServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => { body += chunk.toString() })
    request.on("end", () => {
      if (request.method !== "GET") writes.push({ path: request.url!, body: JSON.parse(body) })
      if (holdResponse(request.url!, response)) return
      response.end("{}")
    })
  })
  api.listen(0, "127.0.0.1")
  await once(api, "listening")
  const address = api.address()
  if (!address || typeof address === "string") throw new Error("missing fixture port")
  url = `http://127.0.0.1:${address.port}`
  configure()
  session = serveSession(socketPath)
  await once(session, "listening")
})

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close")
      child.kill("SIGKILL")
      await closed
    }
  }
  for (const connection of connections) connection.destroy()
  if (session.listening) await new Promise<void>((resolve) => session.close(() => resolve()))
  api.closeAllConnections()
  await new Promise<void>((resolve) => api.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
})

test("once reports the snapshot without writing to the device", async () => {
  const command = start(["--once"])
  await until(command.exited, command.output)
  expect(await command.exit).toBe(0)
  const report = JSON.parse(command.output())
  expect(report.state).toBe("working")
  expect(report.color).toBe("#00ff00")
  expect(report.lit).toBe(true)
  expect(writes).toHaveLength(0)
})

test("status transitions paint the configured middle indicator and shutdown clears it", async () => {
  configure({ indicator: 2 })
  const daemon = start()
  for (const [state, color] of [["working", "#00ff00"], ["blocked", "#ffbf00"], ["done", "#0080ff"]]) {
    agentStatus = state!
    await until(() => writes.some((w) => w.path === "/api/v1/indicators/2" && w.body.color === color && w.body.on === true), daemon.output)
  }
  daemon.child.kill("SIGTERM")
  await until(daemon.exited, daemon.output)
  expect(await daemon.exit).toBe(0)
  expect(writes.at(-1)?.path).toBe("/api/v1/indicators/2")
  expect(writes.at(-1)?.body.on).toBe(false)
})

test("invalid reload preserves the last good config, then repaints the same state", async () => {
  const daemon = start()
  await until(() => writes.some((w) => w.body.on === true), daemon.output)
  writeFileSync(configPath, "null")
  await until(() => daemon.output().includes("configuration"), daemon.output)
  expect(daemon.exited()).toBe(false)
  configure({ colors: { working: "#ff0000" } })
  await until(() => writes.some((w) => w.body.color === "#ff0000"), daemon.output)
  daemon.child.kill("SIGTERM")
  await until(daemon.exited, daemon.output)
  expect(await daemon.exit).toBe(0)
  expect(writes.at(-1)?.body.on).toBe(false)
})

test("two daemons serialize ownership, including the old owner's final off", async () => {
  const first = start()
  await until(() => writes.some((w) => w.body.on === true), first.output)
  const second = start()
  await until(() => second.output().includes("writer"), second.output)
  expect(writes.filter((w) => w.body.on === true)).toHaveLength(1)
  first.child.kill("SIGTERM")
  await until(first.exited, first.output)
  await until(() => writes.filter((w) => w.body.on === true).length === 2, second.output)
  expect(writes.map((w) => w.body.on)).toEqual([true, false, true])
})

test("losing the session socket clears the pixel and releases ownership", async () => {
  const daemon = start()
  await until(() => writes.length > 0, daemon.output)
  await new Promise<void>((resolve) => session.close(() => resolve()))
  await until(daemon.exited, daemon.output)
  expect(writes.at(-1)?.body.on).toBe(false)
  expect(existsSync(join(directory, ".cache", "herdr-awtrix", "writer.lock"))).toBe(false)
})

test("socket replacement retires the old writer before the replacement writes", async () => {
  const first = start()
  await until(() => writes.length > 0, first.output)
  const oldSession = session
  renameSync(socketPath, `${socketPath}.old`)
  session = serveSession(socketPath)
  await once(session, "listening")
  try {
    const second = start()
    await until(first.exited, first.output)
    await until(() => writes.filter((w) => w.body.on === true).length === 2, second.output)
    expect(writes.map((w) => w.body.on)).toEqual([true, false, true])
  } finally {
    await new Promise<void>((resolve) => oldSession.close(() => resolve()))
  }
})

test("off action cannot overwrite a running writer; stop action shuts it down", async () => {
  configure({ pollMs: 60_000 })
  const daemon = start()
  await until(() => writes.length > 0, daemon.output)
  const off = start(["--off"])
  await until(off.exited, off.output)
  expect(await off.exit).toBe(1)
  expect(writes.at(-1)?.body.on).toBe(true)
  const stop = start(["--stop"])
  await until(stop.exited, stop.output)
  await until(daemon.exited, daemon.output)
  expect(await stop.exit).toBe(0)
  expect(writes.at(-1)?.body.on).toBe(false)
})

test("a non-selected session exits without touching the device", async () => {
  configure({ sessionSocketPath: `${socketPath}.other` })
  const daemon = start()
  await until(daemon.exited, daemon.output)
  expect(await daemon.exit).toBe(0)
  expect(writes).toHaveLength(0)
})

test.each(["indicator", "notification"])("shutdown drains an in-flight %s before transferring ownership", async (kind) => {
  let resume: (() => void) | undefined
  holdResponse = (path, response) => {
    const matches = kind === "notification" ? path.endsWith("/notifications") : path.includes("/indicators/")
    if (matches && !resume) {
      resume = () => response.end("{}")
      return true
    }
    return false
  }
  configure({ notify: true, notifyMinIntervalMs: 0, timeoutMs: 2000 })
  const first = start()
  await until(() => writes.some((w) => w.body.on === true), first.output)
  if (kind === "notification") agentStatus = "blocked"
  await until(() => resume !== undefined, first.output)
  first.child.kill("SIGTERM")
  const second = start()
  await until(() => second.output().includes("waiting for exclusive writer"), second.output)
  expect(first.exited()).toBe(false)
  const before = writes.filter((w) => w.body.on !== undefined).length
  resume!()
  await until(first.exited, first.output)
  await until(() => writes.filter((w) => w.body.on !== undefined).length === before + 2, second.output)
  expect(writes.filter((w) => w.body.on !== undefined).slice(-2).map((w) => w.body.on)).toEqual([false, true])
})

test("three failed snapshots retire the writer even if the socket file remains", async () => {
  const daemon = start()
  await until(() => writes.length > 0, daemon.output)
  answerSnapshots = false
  await until(daemon.exited, daemon.output)
  expect(writes.at(-1)?.body.on).toBe(false)
})

test("invalid arguments cannot accidentally start a writer", async () => {
  const command = start(["--of"])
  await until(command.exited, command.output)
  expect(await command.exit).toBe(1)
  expect(writes).toHaveLength(0)
})

test("launcher death retires the writer even when the session socket stays unchanged", async () => {
  const launcher = start([], true)
  await until(() => writes.length > 0, launcher.output)
  const pid = Number(launcher.output().match(/fixture-child-pid:(\d+)/)?.[1])
  expect(Number.isInteger(pid) && pid > 0).toBe(true)
  try {
    launcher.child.kill("SIGTERM")
    await until(() => launcher.output().includes("writer stopped"), launcher.output)
    expect(writes.at(-1)?.body.on).toBe(false)
  } finally {
    if (!launcher.output().includes("writer stopped")) {
      try { process.kill(pid, "SIGKILL") } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
  }
})
