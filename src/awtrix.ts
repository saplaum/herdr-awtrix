// Writing one pixel on an AWTRIX indicator.
//
// Two device generations speak two different APIs and neither announces which
// it is, so "auto" probes once and caches the answer:
//
//   AWTRIX NG  PUT  /api/v1/indicators/<n>   { on, color, blinkMs, fadeMs }
//   AWTRIX 3   POST /api/indicator<n>        { color, fade? } (or a bare string)
//
// The three indicators are single pixels on the right edge. On a 32x8 matrix
// indicator 1 sits top right, 2 middle right, 3 bottom right.

import type { IndicatorApi, IndicatorColor, ResolvedConfig, Rgb } from "./config"
import type { State } from "./state"

export type NgPayload = {
  on: boolean
  color: string
  blinkMs: number
  fadeMs: number
}

export type V3Payload = {
  color: IndicatorColor
  fade?: number
}

/** An `[r, g, b]` triple or a bare hex string as `#rrggbb`. */
export function toHex(color: IndicatorColor): string {
  if (typeof color === "string") {
    if (isOff(color)) return "#000000"
    const value = color.trim()
    return value.startsWith("#") ? value : `#${value}`
  }

  const channels = (color as Rgb).map((channel) =>
    Math.max(0, Math.min(255, Math.round(channel))),
  )

  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}

/** Whether a configured color means "dark". */
export function isOff(color: IndicatorColor): boolean {
  if (typeof color !== "string") return color.every((channel) => channel === 0)

  const value = color.trim().toLowerCase()

  return value === "0" || value === "off" || value === "#000000" || value === "#000"
}

/**
 * The fade-in the state deserves, or undefined for a state that should simply
 * appear. Blocked and done are the two that are asking for attention.
 */
export function fadeFor(state: State, config: ResolvedConfig): number | undefined {
  return state === "blocked" || state === "done" ? config.fadeMs : undefined
}

export function ngPayload(state: State, config: ResolvedConfig): NgPayload {
  const color = config.colors[state]
  const off = state === "idle" || isOff(color)

  return {
    on: !off,
    color: off ? "#000000" : toHex(color),
    blinkMs: 0,
    fadeMs: off ? 0 : (fadeFor(state, config) ?? 0),
  }
}

export function v3Payload(state: State, config: ResolvedConfig): V3Payload {
  if (state === "idle" || isOff(config.colors[state])) return { color: "0" }
  const fade = fadeFor(state, config)

  return fade === undefined ? { color: config.colors[state] } : { color: config.colors[state], fade }
}

export type Device = {
  /** Detect the device API once, so the first write is not delayed. */
  warmUp(): Promise<void>
  /** Paints the indicator pixel. */
  set(state: State): Promise<void>
  /** Clear only the last attempted target, not a newly edited configuration. */
  clear(): Promise<void>
  /** Shows a scrolling message over whatever the clock is displaying. */
  notify(text: string, color: IndicatorColor): Promise<void>
}

export function createDevice(
  getConfig: () => ResolvedConfig,
  fetchImpl: typeof fetch = fetch,
): Device {
  const probes = new Map<string, Promise<"ng" | "v3">>()
  let previous: ResolvedConfig | undefined

  /**
   * AWTRIX NG answers `GET /api/v1/device`; AWTRIX 3 does not, so an answered
   * probe with HTTP 404 means the older API. A probe that fails means the
   * device is unreachable, which is not an answer at all: nothing is written
   * and the next poll tries again.
   *
   * The probe is memoized because the warm-up at startup and the first write
   * race, and a cold mDNS lookup for a `.local` hostname measured 5 s — two of
   * those in parallel is two times the wait for the same answer. The probe gets
   * a longer timeout than the writes so that a slow lookup cannot make the
   * plugin settle on the wrong API.
   */
  function resolveApi(baseUrl: string, config: ResolvedConfig): Promise<"ng" | "v3"> {
    if (config.api !== "auto") return Promise.resolve(config.api)
    const cached = probes.get(baseUrl)
    if (cached) return cached
    const probe = (async (): Promise<"ng" | "v3"> => {
      const response = await fetchImpl(`${baseUrl}/api/v1/device`, {
        signal: AbortSignal.timeout(Math.max(config.timeoutMs, 10_000)),
      })
      if (response.ok) return "ng"
      if (response.status === 404) return "v3"
      throw new Error(`device probe: ${response.status} ${response.statusText}`)
    })()
    probes.set(baseUrl, probe)
    void probe.catch(() => {
      if (probes.get(baseUrl) === probe) probes.delete(baseUrl)
    })
    return probe
  }

  async function send(
    url: string,
    method: "POST" | "PUT",
    body: unknown,
    config: ResolvedConfig,
  ): Promise<void> {
    const response = await fetchImpl(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    })

    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  }

  function baseUrl(config: ResolvedConfig): string {
    return config.awtrixUrl.replace(/\/+$/, "")
  }

  async function paint(state: State, config: ResolvedConfig, rememberTarget = false): Promise<void> {
    const url = baseUrl(config)
    const api = await resolveApi(url, config)
    // A probe cannot light a pixel. Once a write starts, remember the target
    // even if its response fails: the device might still have applied it.
    if (rememberTarget) previous = config
    try {
      if (api === "ng") {
        await send(`${url}/api/v1/indicators/${config.indicator}`, "PUT", ngPayload(state, config), config)
      } else {
        await send(`${url}/api/indicator${config.indicator}`, "POST", v3Payload(state, config), config)
      }
    } catch (error) {
      probes.delete(url)
      throw error
    }
  }

  return {
    async clear(): Promise<void> {
      if (!previous) return
      await paint("idle", previous)
      previous = undefined
    },
    async warmUp(): Promise<void> {
      const config = getConfig()
      if (config.awtrixUrl) await resolveApi(baseUrl(config), config)
    },

    async set(state: State): Promise<void> {
      const config = getConfig()
      const url = baseUrl(config)
      if (previous && (baseUrl(previous) !== url || previous.indicator !== config.indicator)) {
        // Never leave a lit pixel behind when changing or disabling the target.
        // A failed cleanup prevents claiming that the migration succeeded.
        await paint("idle", previous)
        previous = undefined
      }
      if (!url) return
      await paint(state, config, true)
    },

    async notify(text: string, color: IndicatorColor): Promise<void> {
      const config = getConfig()
      const url = baseUrl(config)
      if (!url || !text) return

      const api = await resolveApi(url, config)

      // NG takes one body for apps and notifications; AWTRIX 3 has a route of
      // its own and spells the colour `color` rather than `textColor`.
      if (api === "ng") {
        await send(`${url}/api/v1/notifications`, "POST", { text, textColor: toHex(color) }, config)
        return
      }

      await send(`${url}/api/notify`, "POST", { text, color }, config)
    },
  }
}

export type { IndicatorApi }
