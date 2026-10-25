import { describe, expect, test } from "bun:test"

import { resolveConfig } from "./config"
import { attentionColor, attentionText } from "./notify"
import type { NotableAgent } from "./state"

function agent(overrides: Partial<NotableAgent> = {}): NotableAgent {
  return {
    agent: "opencode",
    status: "blocked",
    pane_id: "w1:p1",
    workspace: "Herdr-AWTRIX",
    title: "OC | do a thing",
    ...overrides,
  }
}

describe("attentionText", () => {
  test("names only the workspace by default", () => {
    expect(resolveConfig({}).notifyShowAgent).toBe(false)
    expect(attentionText([agent()])).toBe("Herdr-AWTRIX")
  })

  test("preserves the workspace's original capitalization", () => {
    expect(attentionText([agent({ workspace: "Herdr-AWTRIX" })])).toBe("Herdr-AWTRIX")
  })

  test("optionally includes the harness name", () => {
    const config = resolveConfig({ notifyShowAgent: true })
    expect(attentionText([agent()], config.notifyShowAgent)).toBe("opencode Herdr-AWTRIX")
  })

  test("a whitespace-only workspace falls back to the harness", () => {
    expect(attentionText([agent({ workspace: " \n " })])).toBe("opencode")
  })

  test("a workspace Herdr does not name leaves the agent alone", () => {
    expect(attentionText([agent({ workspace: "" })])).toBe("opencode")
  })

  test("counts the others rather than listing them", () => {
    // On a 32-pixel panel, three names is three screens of scrolling.
    expect(attentionText([agent(), agent(), agent()])).toBe("Herdr-AWTRIX +2")
  })

  test("collapses what a panel cannot render", () => {
    expect(attentionText([agent({ workspace: "\n  Herdr-AWTRIX  \n" })])).toBe("Herdr-AWTRIX")
  })

  test("keeps a long workspace label from pushing the agent off the screen", () => {
    const text = attentionText([agent({ workspace: "a-very-long-workspace-name-that-goes-on" })], true)

    expect(text.length).toBeLessThanOrEqual(48)
    expect(text.startsWith("opencode ")).toBe(true)
  })

  test("says nothing when nobody is asking", () => {
    expect(attentionText([])).toBe("")
  })
})

describe("attentionColor", () => {
  test("uses a separate text color without changing indicator colors", () => {
    const config = resolveConfig({ notifyColor: "ffffff" })
    expect(attentionColor("blocked", config)).toBe("#ffffff")
    expect(attentionColor("done", config)).toBe("#ffffff")
    expect(config.colors.done).toEqual([0, 128, 255])
  })

  test("null keeps state-based text colors", () => {
    const config = resolveConfig({ notifyColor: null })
    expect(attentionColor("done", config)).toEqual([0, 128, 255])
  })

  test("accepts an RGB text color", () => {
    const config = resolveConfig({ notifyColor: [255, 100, 50] })
    expect(attentionColor("blocked", config)).toEqual([255, 100, 50])
  })

  test("wears the colour of the state that caused it", () => {
    const config = resolveConfig({})

    expect(attentionColor("blocked", config)).toEqual([255, 191, 0])
    expect(attentionColor("done", config)).toEqual([0, 128, 255])
  })
})
