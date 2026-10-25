// Turning a session full of panes into one pixel.

import type { PaneInfo, WorkspaceInfo } from "./herdr"

/** The four things the indicator can say. */
export type State = "blocked" | "working" | "done" | "idle"

/**
 * Which state wins when the session holds several at once. A blocked agent
 * needs you, an agent at work does not, and a finished agent only matters once
 * the machine is quiet. Lower is louder.
 */
export const STATE_PRIORITY: Record<State, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
}

/**
 * Herdr's agent status as an indicator state.
 *
 * `idle` is an agent waiting for input and `unknown` is an agent Herdr cannot
 * classify; neither is worth a lit pixel. A pane with no agent at all also
 * reports `unknown`, which `summarize` drops before it gets here.
 */
export function herdrStatusToState(status: string | null | undefined): State {
  switch (status) {
    case "blocked":
      return "blocked"
    case "working":
      return "working"
    case "done":
      return "done"
    default:
      return "idle"
  }
}

export type Summary = {
  /** The state the indicator should show. */
  state: State
  /** How many agents are in each state. */
  counts: Record<State, number>
  /** How many panes hold a recognized agent. */
  agents: number
}

/**
 * Aggregates every pane into the one state the indicator shows.
 *
 * Only panes Herdr has recognized an agent in count. A plain shell reports
 * `agent_status: "unknown"` exactly like an agent Herdr could not classify, and
 * the presence of `agent` is what tells the two apart.
 */
export function summarize(panes: readonly PaneInfo[]): Summary {
  const counts: Record<State, number> = { blocked: 0, working: 0, done: 0, idle: 0 }
  let agents = 0
  let state: State = "idle"

  for (const pane of panes) {
    if (!pane.agent) continue

    agents += 1
    const paneState = herdrStatusToState(pane.agent_status)
    counts[paneState] += 1

    if (STATE_PRIORITY[paneState] < STATE_PRIORITY[state]) state = paneState
  }

  return { state, counts, agents }
}

/** The indicator state for a whole session. */
export function aggregateState(panes: readonly PaneInfo[]): State {
  return summarize(panes).state
}

/** An agent doing something worth knowing about, and where it is. */
export type NotableAgent = {
  agent: string
  /** Herdr's own status, so nothing is lost in the mapping to a pixel. */
  status: string
  pane_id: string
  /** The workspace's label when Herdr knows one, its id otherwise. */
  workspace: string
  title: string | null
}

/**
 * The agents behind the pixel, loudest first. This is what answers "which
 * session is it?" — the pixel itself can only answer "something is happening".
 */
export function notableAgents(
  panes: readonly PaneInfo[],
  workspaces: readonly WorkspaceInfo[] = [],
): NotableAgent[] {
  const labels = new Map(
    workspaces.map((workspace) => [
      workspace.workspace_id,
      workspace.label ?? workspace.workspace_id,
    ]),
  )
  const notable: NotableAgent[] = []

  for (const pane of panes) {
    if (!pane.agent) continue
    if (herdrStatusToState(pane.agent_status) === "idle") continue

    notable.push({
      agent: pane.agent,
      status: pane.agent_status ?? "unknown",
      pane_id: pane.pane_id,
      workspace: labels.get(pane.workspace_id ?? "") ?? pane.workspace_id ?? "",
      title: pane.terminal_title_stripped ?? null,
    })
  }

  return notable.sort(
    (a, b) =>
      STATE_PRIORITY[herdrStatusToState(a.status)] - STATE_PRIORITY[herdrStatusToState(b.status)],
  )
}
