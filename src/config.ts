// Configuration, read from a file the user owns.
//
// A plugin the Herdr server starts inherits the server's environment, not the
// shell it was installed from, so settings reach it through a file rather than
// through exported variables. Environment variables are still honoured for
// running the plugin by hand.

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { State } from "./state"

export type Rgb = readonly [number, number, number]
/** A `#rrggbb` string, a bare hex string, or `"0"` / `"off"` for dark. */
export type IndicatorColor = Rgb | string
export type IndicatorApi = "auto" | "ng" | "v3"

export type AwtrixConfig = {
  /** If set, only this Herdr socket may drive the clock. Requires restart. */
  sessionSocketPath?: string
  awtrixUrl?: string
  indicator?: number
  timeoutMs?: number
  pollMs?: number
  fadeMs?: number
  api?: IndicatorApi
  colors?: Partial<Record<State, IndicatorColor>>
  /** Whether an agent needing attention is announced on the panel. */
  notify?: boolean
  /** Include the harness name before the workspace in notifications. */
  notifyShowAgent?: boolean
  /** Notification text color; null follows the triggering state's color. */
  notifyColor?: IndicatorColor | null
  /** Which states are worth a notification. */
  notifyStates?: State[]
  /** The shortest gap between two notifications, so a flapping agent is one event. */
  notifyMinIntervalMs?: number
}

export type ResolvedConfig = {
  sessionSocketPath: string
  awtrixUrl: string
  indicator: number
  timeoutMs: number
  pollMs: number
  fadeMs: number
  api: IndicatorApi
  colors: Record<State, IndicatorColor>
  notify: boolean
  notifyShowAgent: boolean
  notifyColor: IndicatorColor | null
  notifyStates: State[]
  notifyMinIntervalMs: number
}

const DEFAULT_CONFIG: ResolvedConfig = {
  sessionSocketPath: "",
  // No default device: the indicator stays dark until a URL is configured,
  // rather than guessing at a hostname on the network.
  awtrixUrl: "",
  indicator: 3,
  // Generous: a cold or expired mDNS lookup for a `.local` hostname can take
  // seconds on macOS. Use the device IP to avoid that delay entirely. The poll
  // interval does not wait on this — a slow AWTRIX write never blocks reading
  // Herdr.
  timeoutMs: 6000,
  pollMs: 500,
  // The two states that want your attention fade in rather than appear.
  fadeMs: 1500,
  api: "auto",
  colors: {
    working: [0, 255, 0],
    blocked: [255, 191, 0],
    done: [0, 128, 255],
    idle: "0",
  },
  notify: true,
  notifyShowAgent: false,
  notifyColor: null,
  // `done` fires every time an agent finishes a turn, which is useful when the
  // clock is across the room and noise when it is not. Narrow this to
  // `["blocked"]` if it talks too much.
  notifyStates: ["blocked", "done"],
  notifyMinIntervalMs: 15_000,
}

/** Where a config file may live, most specific first. */
export function configPaths(): string[] {
  const paths: string[] = []
  const overlay = process.env.HERDR_AWTRIX_CONFIG_PATH
  if (overlay) paths.push(overlay)
  const pluginDir = process.env.HERDR_PLUGIN_CONFIG_DIR
  if (pluginDir) paths.push(join(pluginDir, "awtrix.json"))
  paths.push(join(homedir(), ".config", "herdr", "awtrix.json"))

  return paths
}

/** The path to write the config to, which is the one Herdr gives the plugin. */
export function defaultConfigPath(): string {
  const pluginDir = process.env.HERDR_PLUGIN_CONFIG_DIR

  return pluginDir
    ? join(pluginDir, "awtrix.json")
    : join(homedir(), ".config", "herdr", "awtrix.json")
}

function envOverrides(): AwtrixConfig {
  const overrides: AwtrixConfig = {}
  const { HERDR_AWTRIX_URL, HERDR_AWTRIX_INDICATOR, HERDR_AWTRIX_POLL_MS, HERDR_AWTRIX_API } =
    process.env

  if (HERDR_AWTRIX_URL) overrides.awtrixUrl = HERDR_AWTRIX_URL
  if (HERDR_AWTRIX_INDICATOR) overrides.indicator = Number(HERDR_AWTRIX_INDICATOR)
  if (HERDR_AWTRIX_POLL_MS) overrides.pollMs = Number(HERDR_AWTRIX_POLL_MS)
  if (HERDR_AWTRIX_API) overrides.api = HERDR_AWTRIX_API as IndicatorApi

  return overrides
}

function readConfigFile(): unknown {
  for (const path of configPaths()) {
    if (!existsSync(path)) continue

    try {
      return JSON.parse(readFileSync(path, "utf8"))
    } catch {
      // Do not log file contents: a user may have accidentally pasted a secret.
      throw new Error(`could not read valid JSON from ${path}`)
    }
  }

  return {}
}

/**
 * Merge the defaults, the config file and the environment. Called again on
 * every poll. Callers retain their last good configuration on a reload error.
 */
export function loadConfig(): ResolvedConfig {
  return resolveConfig(readConfigFile(), envOverrides())
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function color(value: unknown, name: string): IndicatorColor {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase()
    if (trimmed === "0" || trimmed === "off") return "0"
    if (/^#?[0-9a-f]{6}$/.test(trimmed)) return `#${trimmed.replace(/^#/, "")}`
    if (/^#[0-9a-f]{3}$/.test(trimmed)) {
      return `#${trimmed.slice(1).split("").map((c) => c + c).join("")}`
    }
  }
  if (Array.isArray(value) && value.length === 3 && value.every(
    (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255,
  )) return [value[0], value[1], value[2]] as Rgb
  throw new Error(`${name} must be an RGB triple, hex color, or off`)
}

/** Pure validation, also used by tests without reading a user's real config. */
export function resolveConfig(input: unknown, fromEnv: AwtrixConfig = {}): ResolvedConfig {
  const fromFile = object(input, "configuration")
  for (const key of Object.keys(fromFile)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`unknown configuration key: ${key}`)
  }
  const picked = { ...DEFAULT_CONFIG, ...fromFile, ...fromEnv }
  const states: State[] = ["working", "blocked", "done", "idle"]
  if (typeof picked.awtrixUrl !== "string") throw new Error("awtrixUrl must be a string")
  if (picked.awtrixUrl) {
    let url: URL
    try { url = new URL(picked.awtrixUrl) } catch { throw new Error("awtrixUrl must be an HTTP(S) URL") }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("awtrixUrl must be HTTP(S), without credentials, query or fragment")
    }
    picked.awtrixUrl = url.toString().replace(/\/+$/, "")
  }
  for (const [key, min, max] of [
    ["indicator", 1, 3], ["pollMs", 50, 60_000], ["timeoutMs", 1, 60_000],
    ["fadeMs", 0, 60_000], ["notifyMinIntervalMs", 0, 86_400_000],
  ] as const) {
    const value = picked[key]
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}`)
    }
  }
  if (!["auto", "ng", "v3"].includes(picked.api)) throw new Error("api must be auto, ng or v3")
  if (typeof picked.notify !== "boolean") throw new Error("notify must be a boolean")
  if (typeof picked.notifyShowAgent !== "boolean") throw new Error("notifyShowAgent must be a boolean")
  const notifyColor = picked.notifyColor === null ? null : color(picked.notifyColor, "notifyColor")
  if (typeof picked.sessionSocketPath !== "string") throw new Error("sessionSocketPath must be a string")
  if (!Array.isArray(picked.notifyStates) || !picked.notifyStates.every((s) => states.includes(s))) {
    throw new Error("notifyStates must contain only working, blocked, done or idle")
  }
  const rawColors = object(picked.colors, "colors")
  for (const key of Object.keys(rawColors)) {
    if (!states.includes(key as State)) throw new Error(`unknown color state: ${key}`)
  }
  const colors = { ...DEFAULT_CONFIG.colors }
  for (const state of states) {
    if (state in rawColors) colors[state] = color(rawColors[state], `colors.${state}`)
  }
  return {
    ...picked,
    notifyColor,
    colors,
    notifyStates: [...picked.notifyStates],
  }
}
