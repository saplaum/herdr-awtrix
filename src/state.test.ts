import { describe, expect, test } from "bun:test"

import type { PaneInfo } from "./herdr"
import { aggregateState, herdrStatusToState, notableAgents, summarize } from "./state"

function pane(agent: string | null, agent_status: string | null): PaneInfo {
  return { pane_id: `w1:p${Math.random()}`, agent, agent_status }
}

describe("herdrStatusToState", () => {
  test("maps the three states worth a pixel", () => {
    expect(herdrStatusToState("blocked")).toBe("blocked")
    expect(herdrStatusToState("working")).toBe("working")
    expect(herdrStatusToState("done")).toBe("done")
  })

  test("treats idle, unknown and a missing status as dark", () => {
    expect(herdrStatusToState("idle")).toBe("idle")
    expect(herdrStatusToState("unknown")).toBe("idle")
    expect(herdrStatusToState(null)).toBe("idle")
    expect(herdrStatusToState(undefined)).toBe("idle")
  })
})

describe("summarize", () => {
  test("a session with no agents is idle", () => {
    expect(aggregateState([])).toBe("idle")
  })

  test("an agent waiting for input is idle", () => {
    expect(aggregateState([pane("opencode", "idle"), pane("pi", "idle")])).toBe("idle")
  })

  test("a pane with no agent is not an agent", () => {
    // A plain shell reports `agent_status: "unknown"` exactly like an agent
    // Herdr could not classify; only the absent `agent` tells them apart.
    const summary = summarize([pane(null, "unknown"), pane(null, "idle")])

    expect(summary.state).toBe("idle")
    expect(summary.agents).toBe(0)
  })

  test("an agent Herdr cannot classify is dark", () => {
    expect(aggregateState([pane("mystery", "unknown")])).toBe("idle")
  })

  test("a working agent is busy", () => {
    expect(aggregateState([pane("opencode", "working"), pane("pi", "idle")])).toBe("working")
  })

  test("a finished agent is done", () => {
    expect(aggregateState([pane("opencode", "done"), pane("pi", "idle")])).toBe("done")
  })

  test("work in flight outshouts work finished", () => {
    expect(aggregateState([pane("opencode", "done"), pane("pi", "working")])).toBe("working")
  })

  test("an agent asking for you outshouts everything", () => {
    expect(aggregateState([pane("opencode", "working"), pane("pi", "blocked")])).toBe("blocked")
  })

  test("counts every agent by state", () => {
    const summary = summarize([
      pane("opencode", "working"),
      pane("pi", "working"),
      pane("claude", "blocked"),
      pane("agy", "done"),
      pane(null, "unknown"),
    ])

    expect(summary.agents).toBe(4)
    expect(summary.counts).toEqual({ blocked: 1, working: 2, done: 1, idle: 0 })
    expect(summary.state).toBe("blocked")
  })
})

describe("notableAgents", () => {
  function named(agent: string | null, status: string | null, workspace = "w1"): PaneInfo {
    return {
      pane_id: `w1:p${Math.random()}`,
      agent,
      agent_status: status,
      workspace_id: workspace,
      terminal_title_stripped: "OC | do a thing",
    }
  }

  test("names the agents behind the pixel", () => {
    const notable = notableAgents([
      named("opencode", "working"),
      named("claude", "blocked"),
      named("pi", "idle"),
      named(null, "unknown"),
    ])

    expect(notable.map((agent) => agent.agent)).toEqual(["claude", "opencode"])
    expect(notable.map((agent) => agent.status)).toEqual(["blocked", "working"])
  })

  test("says nothing about a quiet session", () => {
    expect(notableAgents([named("pi", "idle"), named(null, "unknown")])).toEqual([])
  })

  test("carries where the agent is, so the answer is usable", () => {
    const [agent] = notableAgents([named("opencode", "working", "w9")])

    expect(agent?.workspace).toBe("w9")
    expect(agent?.title).toBe("OC | do a thing")
  })
})
