// The one place that talks to the device, so the poll loop never waits on it.
//
// A live run found the bug this exists to prevent: the first write after a
// server start can take seconds (a cold mDNS lookup for a `.local` hostname
// measured 5 s), and during that time every poll queued another write for the
// same state. Ten writes went out for one colour.
//
// Two rules replace that. At most one write is in flight, and a state that
// changes while a write is in flight is the state written next rather than
// something queued behind it — the device is told what is true now, not what
// was true three seconds ago.

import type { State } from "./state"

export type PainterOptions = {
  /** Performs the write. Rejecting means the device was not told. */
  write: (state: State) => Promise<void>
  /** Whether a write is possible at all — with no URL configured, none is. */
  enabled: () => boolean
  /** Target and payload identity; a config edit must repaint even the same state. */
  identity?: () => string
  /** Called after a successful write. */
  onWritten?: (state: State) => void
  /** Called after a failed write. */
  onError?: (state: State, error: unknown) => void
  /** How long a failed write suppresses the next attempt. */
  retryMs?: number
  /** Injectable clock, for tests. */
  now?: () => number
}

export type Painter = {
  /** Note the state the device should show. Starts a write if one is due. */
  want(state: State): void
  /** Attempt a write if one is due and none is in flight. Called every poll. */
  flush(): void
  /** The state the device was last told about, or undefined before any write. */
  applied(): State | undefined
  /** The state the device should show. */
  desired(): State
  /** Resolves when no write is in flight. */
  settled(): Promise<void>
  /** Stops writing. In-flight work is not interrupted. */
  stop(): void
}

export function createPainter(options: PainterOptions): Painter {
  const { write, enabled, identity = () => "", onWritten, onError, retryMs = 5_000, now = Date.now } = options

  let target: State = "idle"
  let written: State | undefined
  let writtenIdentity: string | undefined
  let writing: Promise<void> | undefined
  let retryAt = 0
  let stopped = false

  function flush(): void {
    if (writing || stopped || !enabled() || (written === target && writtenIdentity === identity())) return
    if (now() < retryAt) return

    // Assigned synchronously, and only settled from the finally below, so one
    // write is in flight even if the write itself settles immediately.
    let done!: () => void
    const inFlight = new Promise<void>((resolve) => {
      done = resolve
    })
    writing = inFlight

    const run = async (): Promise<void> => {
      while (!stopped && enabled() && (written !== target || writtenIdentity !== identity())) {
        const next = target
        const nextIdentity = identity()

        try {
          await write(next)
        } catch (error) {
          retryAt = now() + retryMs
          onError?.(next, error)
          return
        }

        written = next
        writtenIdentity = nextIdentity
        retryAt = 0
        onWritten?.(next)
      }
    }

    void run().finally(() => {
      writing = undefined
      done()
    })
  }

  return {
    want(state: State): void {
      target = state
      flush()
    },
    flush,
    applied: () => written,
    desired: () => target,
    settled: () => writing ?? Promise.resolve(),
    stop(): void {
      stopped = true
    },
  }
}
