#!/usr/bin/env bun
// Herdr -> AWTRIX indicator.
//
// Every 500 ms this reads the whole Herdr session and paints one AWTRIX
// indicator pixel with the highest-priority state any agent in it is in. Herdr
// already aggregates the state of every agent it manages — opencode, pi, agy,
// claude, and the rest — so one pixel speaks for the whole terminal, and no
// agent-specific code is needed.
//
// Modes:
//   (none)   run the poller, which is what the [[startup]] hook starts
//   --once   print the aggregate state and exit, without writing to the device
//   --test   cycle the indicator through every state, to check the wiring
//   --off    turn the indicator off and exit

import { statSync } from "node:fs"
import { createDevice, isOff, toHex } from "./src/awtrix"
import { defaultConfigPath, loadConfig } from "./src/config"
import { sessionSnapshot } from "./src/herdr"
import { attentionColor, attentionText } from "./src/notify"
import { createPainter } from "./src/painter"
import { requestWriterStop, tryAcquireWriter, writerLockPath } from "./src/ownership"
import {
  herdrStatusToState,
  notableAgents,
  summarize,
  type NotableAgent,
  type State,
  type Summary,
} from "./src/state"

const LOG = "[herdr-awtrix]"

/** The states `--test` walks through, in the order that tells them apart. */
const TEST_ORDER: State[] = ["working", "blocked", "done", "idle"]

/**
 * Reports the first failure and then only every time the run doubles, so an
 * hour of a device being unreachable is a handful of lines instead of
 * thousands. Recovering logs what was missed.
 */
function createBackoffLogger() {
  let run = 0
  let loggedAt = 0

  return {
    failure(message: string, error: unknown): void {
      run += 1
      if (run !== 1 && run < loggedAt * 2) return

      loggedAt = run
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`${LOG} ${message} (failure ${run}): ${detail}`)
    },
    ok(): void {
      if (run > 0) console.log(`${LOG} recovered after ${run} failure${run === 1 ? "" : "s"}`)
      run = 0
      loggedAt = 0
    },
  }
}

/** `working (2 working, 1 blocked)` — what the pixel says and why. */
function describe(summary: Summary): string {
  const counts = (["blocked", "working", "done"] as const)
    .filter((state) => summary.counts[state] > 0)
    .map((state) => `${summary.counts[state]} ${state}`)

  return counts.length > 0 ? `${summary.state} (${counts.join(", ")})` : summary.state
}

function usage(): void {
  console.log(`herdr-awtrix — drives an AWTRIX indicator with your Herdr session

Usage:
  herdr-awtrix           poll the session and drive the indicator
  herdr-awtrix --once    print the current state, write nothing
  herdr-awtrix --test    cycle the indicator through every state
  herdr-awtrix --off     turn the indicator off
  herdr-awtrix --stop    ask the running writer to clear the pixel and exit

From source: bun run index.ts [options]

Config: ${defaultConfigPath()}
  {
    "awtrixUrl": "http://clock.local",
    "indicator": 3,
    "pollMs": 500,
    "api": "auto",
    "colors": { "working": [0, 255, 0], "blocked": [255, 191, 0], "done": [0, 128, 255], "idle": "0" }
  }

Environment (a plugin started by Herdr does not inherit your shell, so prefer
the file): HERDR_AWTRIX_URL, HERDR_AWTRIX_INDICATOR, HERDR_AWTRIX_POLL_MS,
HERDR_AWTRIX_API, HERDR_AWTRIX_CONFIG_PATH.`)
}

async function reportOnce(): Promise<void> {
  const config = loadConfig()
  const snapshot = await sessionSnapshot(config.timeoutMs)
  const summary = summarize(snapshot.panes)
  const color = config.colors[summary.state]

  // The pixel can only say "something is happening". Naming the agents is what
  // answers "which session is it?".
  const sessions = notableAgents(snapshot.panes, snapshot.workspaces ?? []).map((agent) => ({
    agent: agent.agent,
    status: agent.status,
    workspace: agent.workspace,
    pane_id: agent.pane_id,
    title: agent.title,
  }))

  console.log(
    JSON.stringify(
      {
        state: summary.state,
        counts: summary.counts,
        agents: summary.agents,
        panes: snapshot.panes.length,
        color: toHex(color),
        lit: summary.state !== "idle" && !isOff(color),
        awtrixUrl: config.awtrixUrl || null,
        indicator: config.indicator,
        api: config.api,
        sessions,
      },
      null,
      2,
    ),
  )
}

async function cycle(interrupted: () => boolean): Promise<void> {
  const config = loadConfig()
  if (!config.awtrixUrl) {
    console.error(`${LOG} no AWTRIX URL configured; set awtrixUrl in ${defaultConfigPath()}`)
    process.exitCode = 1
    return
  }

  const device = createDevice(() => config)
  try {
    for (const state of TEST_ORDER) {
      if (interrupted()) return
      console.log(`${LOG} ${state} ${toHex(config.colors[state])}`)
      await device.set(state)
      await new Promise((resolve) => setTimeout(resolve, 1_500))
    }
    if (!interrupted()) await device.notify("Herdr-AWTRIX", config.colors.done)
    console.log(`${LOG} done`)
  } finally {
    await device.clear()
  }
}

async function turnOff(): Promise<void> {
  const config = loadConfig()
  if (!config.awtrixUrl) {
    console.error(`${LOG} no AWTRIX URL configured; set awtrixUrl in ${defaultConfigPath()}`)
    process.exitCode = 1
    return
  }

  await createDevice(() => config).set("idle")
  console.log(`${LOG} indicator off`)
}

async function exclusiveAction(action: (interrupted: () => boolean) => Promise<void>): Promise<void> {
  const lease = tryAcquireWriter()
  if (!lease) throw new Error(`writer is active or lock is stale at ${writerLockPath()}; use --stop first`)
  let interrupted = false
  const stop = () => { interrupted = true }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  try {
    await action(() => interrupted || lease.stopRequested())
  } finally {
    lease.release()
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
  }
}

async function daemon(): Promise<void> {
  if (!process.env.HERDR_SOCKET_PATH) {
    console.error(`${LOG} HERDR_SOCKET_PATH is not set: this plugin must be started by Herdr`)
    process.exitCode = 1
    return
  }

  let config = loadConfig()
  const socket = process.env.HERDR_SOCKET_PATH
  if (config.sessionSocketPath && config.sessionSocketPath !== socket) {
    console.log(`${LOG} this is not the selected session; exiting without writing`)
    return
  }
  const socketIdentity = () => {
    const info = statSync(socket, { bigint: true })
    return `${info.dev}:${info.ino}`
  }
  const generation = socketIdentity()
  const launcherPid = process.ppid
  let stopped = false
  const stopWaiting = () => { stopped = true }
  process.on("SIGINT", stopWaiting)
  process.on("SIGTERM", stopWaiting)
  let lease: ReturnType<typeof tryAcquireWriter>
  try {
    const deadline = Date.now() + 30_000
    let reportedBusy = false
    while (!(lease = tryAcquireWriter())) {
      if (stopped || process.ppid !== launcherPid || socketIdentity() !== generation) return
      if (Date.now() >= deadline) throw new Error(`writer busy or stale lock at ${writerLockPath()}`)
      if (!reportedBusy) console.log(`${LOG} waiting for exclusive writer ownership`)
      reportedBusy = true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (stopped || process.ppid !== launcherPid || socketIdentity() !== generation) {
      lease.release()
      return
    }
  } catch (error) {
    lease?.release()
    throw error
  } finally {
    process.off("SIGINT", stopWaiting)
    process.off("SIGTERM", stopWaiting)
  }
  const owner = lease
  if (!owner) throw new Error("writer ownership was not acquired")
  // The getter reads the config the poll loop last loaded, so a change to the
  // URL, the colors or the indicator takes effect without a restart.
  const device = createDevice(() => config)

  const sessionFailures = createBackoffLogger()
  const deviceFailures = createBackoffLogger()
  const configFailures = createBackoffLogger()

  /**
   * The only thing that talks to the device. It never blocks the poll loop, and
   * it collapses a session that changes while it is writing into the latest
   * state rather than a queue — see src/painter.ts for the live run behind that.
   */
  const painter = createPainter({
    write: (state) => device.set(state),
    // A removed URL must still get a chance to clear the old target.
    enabled: () => true,
    identity: () => JSON.stringify([config.awtrixUrl, config.indicator, config.api, config.colors, config.fadeMs]),
    onWritten: (state) => {
      deviceFailures.ok()
      console.log(`${LOG} indicator ${state}`)
    },
    onError: (state, error) => {
      deviceFailures.failure(`could not set the indicator to ${state}`, error)
    },
  })

  let lastReported: State | undefined
  let warnedNoUrl = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let shutdownPromise: Promise<void> | undefined
  let sessionFailureRun = 0

  /**
   * Every agent that was doing something at the last poll, as `pane:status`.
   * An agent that appears in this set with a state worth announcing has just
   * started asking, which is the moment worth a notification — the state
   * staying true afterwards is not.
   */
  let attention = new Set<string>()
  let firstPoll = true
  let lastNotifiedAt = 0
  let notifying = false
  let notification: Promise<void> = Promise.resolve()

  function retirementReason(): string | undefined {
    if (owner.stopRequested()) return "stop requested"
    if (process.ppid !== launcherPid) return "launcher exited"
    try {
      if (socketIdentity() !== generation) return "session socket replaced"
    } catch {
      return "session socket disappeared"
    }
    return undefined
  }

  const attentionKey = (agent: NotableAgent) => `${agent.pane_id}:${agent.status}`

  /**
   * Shows the agent's name over whatever the clock is displaying. Not awaited
   * by the poll loop, and one at a time: a notification is news, and news that
   * arrives while the previous one is still scrolling is not worth a queue.
   */
  function announce(agents: NotableAgent[]): void {
    if (notifying || stopped || !config.awtrixUrl) return

    const now = Date.now()
    if (now - lastNotifiedAt < config.notifyMinIntervalMs) return

    const text = attentionText(agents, config.notifyShowAgent)
    const loudest = agents[0]
    if (!text || !loudest) return

    lastNotifiedAt = now
    notifying = true

    const state = herdrStatusToState(loudest.status)

    notification = device
      .notify(text, attentionColor(state, config))
      .then(() => {
        deviceFailures.ok()
        console.log(`${LOG} announced ${state}: ${text}`)
      })
      .catch((error) => deviceFailures.failure(`could not announce "${text}"`, error))
      .finally(() => {
        notifying = false
      })
  }

  async function tick(): Promise<void> {
    if (stopped) return
    try {
      const next = loadConfig()
      if (next.sessionSocketPath !== config.sessionSocketPath) {
        throw new Error("sessionSocketPath changes require a writer restart")
      }
      config = next
      configFailures.ok()
    } catch (error) {
      configFailures.failure("invalid configuration; retaining last good settings", error)
    }

    const reason = retirementReason()
    if (reason) {
      await shutdown(reason)
      return
    }

    if (!config.awtrixUrl && !warnedNoUrl) {
      warnedNoUrl = true
      console.warn(`${LOG} no AWTRIX URL configured; set awtrixUrl in ${defaultConfigPath()}`)
    }

    try {
      const snapshot = await sessionSnapshot(config.timeoutMs)
      if (stopped) return
      if (socketIdentity() !== generation) {
        await shutdown("session socket replaced")
        return
      }
      sessionFailures.ok()
      sessionFailureRun = 0

      const summary = summarize(snapshot.panes)

      if (summary.state !== lastReported) {
        lastReported = summary.state
        console.log(`${LOG} ${describe(summary)}`)
      }

      // The device is told what is true now, or nothing at all.
      painter.want(summary.state)

      const notable = notableAgents(snapshot.panes, snapshot.workspaces ?? [])
      const appeared = notable.filter(
        (agent) =>
          !attention.has(attentionKey(agent)) &&
          config.notify &&
          config.notifyStates.includes(herdrStatusToState(agent.status)),
      )
      attention = new Set(notable.map(attentionKey))

      // Nothing is announced on the first poll: whatever was already waiting
      // when the session started was waiting before this process existed, and
      // read as a burst of notifications for events the user has already seen.
      if (!firstPoll) announce(appeared)
      firstPoll = false
    } catch (error) {
      sessionFailures.failure("could not read the session", error)
      sessionFailureRun += 1
      if (sessionFailureRun >= 3) {
        await shutdown("session unavailable after three polls")
        return
      }
    }

    if (!stopped) timer = setTimeout(() => {
      void tick().catch((error) => {
        process.exitCode = 1
        console.error(`${LOG} poll failed unexpectedly: ${String(error)}`)
        void shutdown("poll failure").catch(fatalShutdown)
      })
    }, config.pollMs)
  }

  function shutdown(signal: string): Promise<void> {
    if (shutdownPromise) return shutdownPromise
    stopped = true
    if (timer) clearTimeout(timer)
    clearInterval(lifecycleTimer)

    console.log(`${LOG} ${signal} — turning the indicator off`)

    painter.stop()
    shutdownPromise = (async () => {
      try {
        await Promise.all([painter.settled(), notification])
        await device.clear()
      } catch (error) {
        deviceFailures.failure("could not reset the indicator on shutdown", error)
        process.exitCode = 1
      } finally {
        owner.release()
        console.log(`${LOG} writer stopped`)
        process.off("SIGINT", onInterrupt)
        process.off("SIGTERM", onTerminate)
      }
    })()
    return shutdownPromise
  }

  const onInterrupt = () => { void shutdown("SIGINT").catch(fatalShutdown) }
  const onTerminate = () => { void shutdown("SIGTERM").catch(fatalShutdown) }
  const fatalShutdown = (error: unknown) => {
    console.error(`${LOG} shutdown failed: ${String(error)}`)
    process.exitCode = 1
  }
  process.on("SIGINT", onInterrupt)
  process.on("SIGTERM", onTerminate)
  // Lifecycle checks must not wait for a user-configured long poll interval or
  // an in-flight snapshot. They perform no device writes outside shutdown().
  const lifecycleTimer = setInterval(() => {
    if (stopped) return
    const reason = retirementReason()
    if (reason) void shutdown(reason).catch(fatalShutdown)
  }, 250)

  console.log(
    `${LOG} watching ${process.env.HERDR_SOCKET_PATH} every ${config.pollMs} ms` +
      (config.awtrixUrl
        ? `, writing to ${config.awtrixUrl}` +
          (config.notify ? ` (announcing ${config.notifyStates.join("/")})` : "")
        : ", no AWTRIX URL configured yet"),
  )

  // set() performs and shares its probe; no detached warm-up can outlive a lease.

  await tick()
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  const known = ["--help", "-h", "--once", "--stop", "--test", "--off"]
  if ([...args].some((arg) => !known.includes(arg))) throw new Error("unknown argument; use --help")
  if (["--once", "--stop", "--test", "--off"].filter((mode) => args.has(mode)).length > 1) {
    throw new Error("choose exactly one mode; use --help")
  }

  if (args.has("--help") || args.has("-h")) return usage()
  if (args.has("--once")) return reportOnce()
  if (args.has("--stop")) {
    const stopped = requestWriterStop()
    const deadline = Date.now() + 30_000
    while (!stopped()) {
      if (Date.now() >= deadline) throw new Error("stop requested, but writer has not released ownership; inspect its log")
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    console.log(`${LOG} writer released ownership; check its log for device reset errors`)
    return
  }
  if (args.has("--test")) return exclusiveAction(cycle)
  if (args.has("--off")) return exclusiveAction(turnOff)
  return daemon()
}

try {
  await main()
} catch (error) {
  // A plugin action runs with no terminal, so a stack trace is noise in the
  // action log. The daemon handles its own failures and never lands here.
  console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
