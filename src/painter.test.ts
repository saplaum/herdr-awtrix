import { describe, expect, test } from "bun:test"

import { createPainter, type PainterOptions } from "./painter"
import type { State } from "./state"

/** A device whose writes can be held open, so the queueing is observable. */
function device(options: Partial<PainterOptions> = {}) {
  const written: State[] = []
  const release: Array<() => void> = []

  const painter = createPainter({
    write: (state) => {
      written.push(state)
      return new Promise<void>((resolve) => release.push(resolve))
    },
    enabled: () => true,
    ...options,
  })

  return {
    painter,
    written,
    /** Lets the n-th write finish. */
    settle: async (index = 0) => {
      release[index]?.()
      // Two turns: one for the write to resolve, one for its finally.
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe("createPainter", () => {
  test("repaints a changed configuration without a state transition", async () => {
    let revision = "green"
    const writes: string[] = []
    const painter = createPainter({
      enabled: () => true,
      identity: () => revision,
      write: async (state) => { writes.push(`${state}:${revision}`) },
    })
    painter.want("working")
    await painter.settled()
    revision = "red"
    painter.want("working")
    await painter.settled()
    expect(writes).toEqual(["working:green", "working:red"])
  })

  test("a config edit during an in-flight write is applied next", async () => {
    let revision = "old"
    const { painter, written, settle } = device({ identity: () => revision })
    painter.want("working")
    revision = "new"
    painter.want("working")
    await settle(0)
    expect(written).toEqual(["working", "working"])
    await settle(1)
  })

  test("writes a state once, however many times it is polled", async () => {
    const { painter, written, settle } = device()

    painter.want("working")
    painter.flush()
    painter.flush()
    await settle()

    for (let poll = 0; poll < 20; poll += 1) painter.flush()

    expect(written).toEqual(["working"])
  })

  test("does not queue writes for a state that changed mid-write", async () => {
    // The defect a live run found: a five-second first write let every poll
    // queue another write of the same state.
    const { painter, written, settle } = device()

    painter.want("working")
    expect(written).toEqual(["working"])

    // Ten polls while the first write is still open.
    for (let poll = 0; poll < 10; poll += 1) painter.flush()
    expect(written).toEqual(["working"])

    await settle(0)
    expect(written).toEqual(["working"])

    // A state that arrived mid-write is written next, and only once.
    painter.want("blocked")
    expect(written).toEqual(["working", "blocked"])
  })

  test("writes the latest state, not the states it passed through", async () => {
    const { painter, written, settle } = device()

    painter.want("working")
    await settle(0)

    painter.want("idle")
    expect(written).toEqual(["working", "idle"])
    await settle(1)

    painter.want("done")
    await settle(2)

    expect(written).toEqual(["working", "idle", "done"])
  })

  test("reports the state the device was told about", async () => {
    const { painter, settle } = device()

    expect(painter.applied()).toBeUndefined()

    painter.want("working")
    await settle()

    expect(painter.applied()).toBe("working")
  })

  test("a failed write is retried only after the retry delay", async () => {
    let clock = 1_000
    const failures: string[] = []
    const painter = createPainter({
      write: () => Promise.reject(new Error("connection refused")),
      enabled: () => true,
      retryMs: 5_000,
      now: () => clock,
      onError: (state) => failures.push(state),
    })

    painter.want("working")
    await painter.settled()

    expect(failures).toEqual(["working"])
    expect(painter.applied()).toBeUndefined()

    // Every poll inside the delay does nothing at all.
    for (let poll = 0; poll < 20; poll += 1) painter.flush()
    await painter.settled()
    expect(failures).toHaveLength(1)

    clock += 5_000
    painter.flush()
    await painter.settled()
    expect(failures).toEqual(["working", "working"])
  })

  test("recovers once the device answers", async () => {
    let healthy = false
    const written: State[] = []
    const painter = createPainter({
      write: async (state) => {
        if (!healthy) throw new Error("connection refused")
        written.push(state)
      },
      enabled: () => true,
      retryMs: 0,
    })

    painter.want("working")
    await painter.settled()

    healthy = true
    painter.flush()
    await painter.settled()

    expect(written).toEqual(["working"])
    expect(painter.applied()).toBe("working")
  })

  test("writes nothing while the device is unconfigured", async () => {
    const { painter, written } = device({ enabled: () => false })

    painter.want("blocked")
    painter.flush()
    await painter.settled()

    expect(written).toEqual([])

    // Configuring it later takes effect without a restart.
    expect(painter.desired()).toBe("blocked")
  })

  test("writes nothing to an idle session, and clears the pixel when it goes idle", async () => {
    const { painter, written, settle } = device()

    painter.want("working")
    await settle()
    painter.want("idle")
    await settle()

    expect(written).toEqual(["working", "idle"])
  })

  test("stops writing after stop, and settles in-flight work", async () => {
    const { painter, written, settle } = device()

    painter.want("working")
    painter.stop()

    // The write already in flight is allowed to finish; nothing new starts.
    await settle(0)
    await painter.settled()

    painter.want("blocked")
    painter.flush()

    expect(written).toEqual(["working"])
  })
})
