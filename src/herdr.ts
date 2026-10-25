// The subset of the Herdr socket API this plugin reads.
//
// Herdr speaks newline-delimited JSON over the socket named by
// HERDR_SOCKET_PATH and closes the connection after answering one request, so
// every call dials its own. That is why there is no connection state to
// reconcile and no reconnect logic anywhere: an outage is simply a run of
// failed dials, and recovery is the first dial that succeeds.

import net from "node:net"

export type PaneInfo = {
  pane_id: string
  workspace_id?: string
  tab_id?: string
  focused?: boolean
  /** The recognized agent holding the pane. Absent for a plain shell pane. */
  agent?: string | null
  /**
   * `idle | working | blocked | done | unknown`. Every pane carries one; a pane
   * with no agent reports `unknown`.
   */
  agent_status?: string | null
  terminal_title_stripped?: string | null
  revision?: number
}

export type WorkspaceInfo = {
  workspace_id: string
  label?: string | null
}

export type Snapshot = {
  version?: string
  protocol?: number
  focused_pane_id?: string
  workspaces?: WorkspaceInfo[]
  panes: PaneInfo[]
}

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "HerdrError"
  }
}

function socketPath(): string {
  const path = process.env.HERDR_SOCKET_PATH
  if (!path) {
    throw new Error("HERDR_SOCKET_PATH is not set: this plugin must be started by Herdr")
  }

  return path
}

/** Herdr names a Unix socket by path and a Windows socket by pipe name. */
function endpoint(path: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${path}` : path
}

let sequence = 0

/**
 * Sends one request and returns its result. Rejects on a Herdr error frame, a
 * timeout, or a socket failure.
 */
export function call<T = unknown>(
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<T> {
  const id = `herdr-awtrix-${++sequence}`

  return new Promise<T>((resolve, reject) => {
    const connection = net.createConnection(endpoint(socketPath()))
    let buffer = ""
    let settled = false

    const finish = (error: Error | undefined, result?: T) => {
      if (settled) return
      settled = true
      connection.destroy()
      if (error) reject(error)
      else resolve(result as T)
    }

    const handleLine = (line: string) => {
      let frame: { result?: T; error?: { code?: string; message?: string } }
      try {
        frame = JSON.parse(line)
      } catch (error) {
        finish(new Error(`could not decode the ${method} response: ${String(error)}`))
        return
      }

      if (frame.error) {
        finish(new HerdrError(frame.error.code ?? "unknown", frame.error.message ?? method))
        return
      }

      finish(undefined, frame.result)
    }

    connection.setTimeout(timeoutMs, () => finish(new Error(`${method} timed out`)))
    connection.on("error", (error) => finish(error))
    connection.on("end", () => {
      // Herdr answers with a single line, so a close without one is a failure.
      if (buffer.includes("\n")) handleLine(buffer.slice(0, buffer.indexOf("\n")))
      else finish(new Error(`${method} closed the connection without answering`))
    })
    connection.on("data", (chunk) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf("\n")
      if (newline !== -1) handleLine(buffer.slice(0, newline))
    })
    connection.on("connect", () => {
      connection.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  })
}

/**
 * The whole session in one request: every pane with its directory, terminal
 * title, agent and agent status. Measured at well under a millisecond, which is
 * what makes polling twice a second unremarkable.
 */
export async function sessionSnapshot(timeoutMs: number): Promise<Snapshot> {
  const result = await call<{ snapshot: Snapshot }>("session.snapshot", {}, timeoutMs)

  return result.snapshot
}
