import { describe, expect, test } from "bun:test"

import { createDevice, v3Payload } from "./awtrix"
import { resolveConfig } from "./config"
import { createPainter } from "./painter"

const defaults = resolveConfig({})

describe("publication regressions", () => {
  test("the painter retries the same state after a failed device probe", async () => {
    let online = false
    const requests: string[] = []
    const device = createDevice(
      () => ({ ...defaults, awtrixUrl: "http://fixture.invalid", api: "auto" }),
      (async (url, init) => {
        requests.push(`${init?.method ?? "GET"} ${url}`)
        if (!online) throw new Error("offline")
        return new Response("{}")
      }) as typeof fetch,
    )
    const painter = createPainter({ write: device.set, enabled: () => true, retryMs: 0 })
    painter.want("working")
    await painter.settled()
    expect(painter.applied()).toBeUndefined()
    online = true
    painter.want("working")
    await painter.settled()
    expect(requests).toEqual([
      "GET http://fixture.invalid/api/v1/device",
      "GET http://fixture.invalid/api/v1/device",
      "PUT http://fixture.invalid/api/v1/indicators/3",
    ])
  })

  test.each([401, 429, 503])("a %s probe does not select the v3 API", async (status) => {
    const requests: string[] = []
    const device = createDevice(
      () => ({ ...defaults, awtrixUrl: "http://fixture.invalid", api: "auto" }),
      (async (url, init) => {
        requests.push(`${init?.method ?? "GET"} ${url}`)
        return new Response("", { status: init?.method ? 200 : status })
      }) as typeof fetch,
    )
    await expect(device.set("working")).rejects.toThrow(String(status))
    expect(requests).toHaveLength(1)
  })

  test("a different URL gets its own API probe", async () => {
    let config = { ...defaults, awtrixUrl: "http://ng.invalid", api: "auto" as const }
    const requests: string[] = []
    const device = createDevice(() => config, (async (url, init) => {
      requests.push(`${init?.method ?? "GET"} ${url}`)
      return new Response("{}", {
        status: !init?.method && String(url).includes("v3.invalid") ? 404 : 200,
      })
    }) as typeof fetch)
    await device.set("working")
    config = { ...config, awtrixUrl: "http://v3.invalid" }
    await device.set("blocked")
    expect(requests).toContain("GET http://v3.invalid/api/v1/device")
    expect(requests.at(-1)).toBe("POST http://v3.invalid/api/indicator3")
  })

  test("v3 idle is always off, even with a custom idle color", () => {
    expect(v3Payload("idle", {
      ...defaults, colors: { ...defaults.colors, idle: [255, 0, 0] },
    })).toEqual({ color: "0" })
  })

  test("moving or disabling an indicator clears the previous target first", async () => {
    let config = { ...defaults, awtrixUrl: "http://fixture.invalid", api: "ng" as const }
    const requests: Array<{ url: string; on: boolean }> = []
    const device = createDevice(() => config, (async (url, init) => {
      requests.push({ url: String(url), on: JSON.parse(String(init?.body)).on })
      return new Response("")
    }) as typeof fetch)
    await device.set("working")
    config = { ...config, indicator: 2 }
    await device.set("working")
    config = { ...config, awtrixUrl: "" }
    await device.set("working")
    expect(requests).toEqual([
      { url: "http://fixture.invalid/api/v1/indicators/3", on: true },
      { url: "http://fixture.invalid/api/v1/indicators/3", on: false },
      { url: "http://fixture.invalid/api/v1/indicators/2", on: true },
      { url: "http://fixture.invalid/api/v1/indicators/2", on: false },
    ])
  })

  test("an old in-flight probe cannot determine a new URL's API", async () => {
    let config = { ...defaults, awtrixUrl: "http://ng.invalid", api: "auto" as const }
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const requests: string[] = []
    const device = createDevice(() => config, (async (url, init) => {
      requests.push(`${init?.method ?? "GET"} ${url}`)
      if (!init?.method && String(url).includes("ng.invalid")) await pending
      return new Response("{}", { status: !init?.method && String(url).includes("v3.invalid") ? 404 : 200 })
    }) as typeof fetch)
    const warmUp = device.warmUp()
    config = { ...config, awtrixUrl: "http://v3.invalid" }
    try {
      await device.set("working")
      expect(requests.at(-1)).toBe("POST http://v3.invalid/api/indicator3")
    } finally {
      release()
      await warmUp
    }
  })

  test("failed old-target cleanup blocks migration and is retried", async () => {
    let config = { ...defaults, awtrixUrl: "http://fixture.invalid", api: "ng" as const }
    let failCleanup = false
    const calls: string[] = []
    const device = createDevice(() => config, (async (url, init) => {
      calls.push(String(url))
      const off = JSON.parse(String(init?.body)).on === false
      return new Response("", { status: off && failCleanup ? 503 : 200 })
    }) as typeof fetch)
    await device.set("working")
    config = { ...config, indicator: 2 }
    failCleanup = true
    await expect(device.set("working")).rejects.toThrow("503")
    expect(calls.some((url) => url.endsWith("/2"))).toBe(false)
    failCleanup = false
    await device.set("working")
    expect(calls.map((url) => url.slice(-1))).toEqual(["3", "3", "3", "2"])
  })

  test("a failed read-only probe does not block correcting the device URL", async () => {
    let config = { ...defaults, awtrixUrl: "http://offline.invalid", api: "auto" as const }
    const calls: string[] = []
    const device = createDevice(() => config, (async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`)
      if (String(url).includes("offline.invalid")) throw new Error("offline")
      return new Response("{}")
    }) as typeof fetch)
    await expect(device.set("working")).rejects.toThrow("offline")
    config = { ...config, awtrixUrl: "http://online.invalid" }
    await device.set("working")
    expect(calls).toEqual([
      "GET http://offline.invalid/api/v1/device",
      "GET http://online.invalid/api/v1/device",
      "PUT http://online.invalid/api/v1/indicators/3",
    ])
  })
})
