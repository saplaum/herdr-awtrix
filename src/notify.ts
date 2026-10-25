// Saying which agent it is.
//
// AWTRIX shows a notification over whatever the clock is currently displaying
// and then moves on. That is the right shape for this: an attention event is
// news, not a status display — the indicator pixel is the status display.
// Putting the agent name in a permanent app slot would replace the clock with
// the plugin, which is not the trade being made here.

import type { IndicatorColor, ResolvedConfig } from "./config"
import type { NotableAgent, State } from "./state"

/**
 * The panel is 32 pixels wide and scrolls, so a notification is a headline
 * rather than a sentence. Long workspace labels are cut rather than allowed to
 * occupy the display for too long.
 */
const MAX_TEXT = 48

/**
 * `STS Test`, optionally prefixed with the harness name, and suffixed with `+2`
 * when more than one additional agent asked for attention at once.
 * The verb is left out because the notification's colour
 * already carries it, and on a 32-pixel panel every character costs a moment of
 * scrolling.
 */
export function attentionText(agents: readonly NotableAgent[], showAgent = false): string {
  const [loudest] = agents
  if (!loudest) return ""

  const workspace = collapse(loudest.workspace)
  const name = workspace
    ? (showAgent ? `${loudest.agent} ${workspace}` : workspace)
    : loudest.agent
  const others = agents.length - 1

  return collapse(`${name}${others > 0 ? ` +${others}` : ""}`).slice(0, MAX_TEXT)
}

/** Follow the state unless a separate notification text color is configured. */
export function attentionColor(state: State, config: ResolvedConfig): IndicatorColor {
  return config.notifyColor ?? config.colors[state]
}

/** Herdr labels can carry newlines and runs of spaces; a panel shows neither. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}
