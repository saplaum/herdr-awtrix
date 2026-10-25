import { describe, expect, test } from "bun:test"

import { createDevice, isOff, ngPayload, toHex, v3Payload } from "./awtrix"
import { resolveConfig, type ResolvedConfig } from "./config"

const CONFIG: ResolvedConfig = resolveConfig({})

describe("toHex", () => {
  test("renders a triple as #rrggbb", () => {
    expect(toHex([0, 255, 0])).toBe("#00ff00")
    expect(toHex([255, 191, 0])).toBe("#ffbf00")
  })

  test("clamps and rounds a triple", () => {
    expect(toHex([-10, 300, 127.6])).toBe("#00ff80")
  })

  test("leaves a string alone, prefixing a bare hex", () => {
    expect(toHex("0")).toBe("#000000")
    expect(toHex(" OFF ")).toBe("#000000")
    expect(toHex("#00ff00")).toBe("#00ff00")
  })
})

describe("isOff", () => {
  test("recognises a black triple", () => {
    expect(isOff([0, 0, 0])).toBe(true)
    expect(isOff([0, 0, 1])).toBe(false)
  })

  test("recognises the string forms", () => {
    expect(isOff("0")).toBe(true)
    expect(isOff(" OFF ")).toBe(true)
    expect(isOff("#000000")).toBe(true)
    expect(isOff("#000")).toBe(true)
    expect(isOff("#ffbf00")).toBe(false)
  })
})

describe("payloads", () => {
  test("a busy agent is a solid green light", () => {
    expect(ngPayload("working", CONFIG)).toEqual({
      on: true,
      color: "#00ff00",
      blinkMs: 0,
      fadeMs: 0,
    })
    expect(v3Payload("working", CONFIG)).toEqual({ color: [0, 255, 0] })
  })

  test("blocked and done fade in", () => {
    expect(ngPayload("blocked", CONFIG).fadeMs).toBe(1500)
    expect(v3Payload("blocked", CONFIG)).toEqual({ color: [255, 191, 0], fade: 1500 })
    expect(v3Payload("done", CONFIG)).toEqual({ color: [0, 128, 255], fade: 1500 })
  })

  test("idle turns the pixel off", () => {
    expect(ngPayload("idle", CONFIG)).toEqual({
      on: false,
      color: "#000000",
      blinkMs: 0,
      fadeMs: 0,
    })
    expect(v3Payload("idle", CONFIG)).toEqual({ color: "0" })
  })

  test("a color configured to black is off, whatever the state", () => {
    const dark: ResolvedConfig = {
      ...CONFIG,
      colors: { ...CONFIG.colors, working: [0, 0, 0] },
    }

    expect(ngPayload("working", dark).on).toBe(false)
  })
})

describe("notifications", () => {
  test("NG shows a message in the state's colour", async () => {
    const calls: Array<{ method: string; url: string; body: string }> = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(url), body: String(init?.body) })
      if (String(url).endsWith("/api/v1/device")) return new Response("{}", { status: 200 })
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch

    const device = createDevice(() => ({ ...CONFIG, awtrixUrl: "http://clock.local" }), fetchImpl)
    await device.notify("opencode STS Test", [255, 191, 0])

    expect(calls[1]).toEqual({
      method: "POST",
      url: "http://clock.local/api/v1/notifications",
      body: JSON.stringify({ text: "opencode STS Test", textColor: "#ffbf00" }),
    })
  })

  test("AWTRIX 3 has a route of its own and calls the colour color", async () => {
    const calls: Array<{ method: string; url: string; body: string }> = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(url), body: String(init?.body) })
      if (String(url).endsWith("/api/v1/device")) return new Response("", { status: 404 })
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch

    const device = createDevice(() => ({ ...CONFIG, awtrixUrl: "http://clock.local" }), fetchImpl)
    await device.notify("opencode", [0, 128, 255])

    expect(calls[1]).toEqual({
      method: "POST",
      url: "http://clock.local/api/notify",
      body: JSON.stringify({ text: "opencode", color: [0, 128, 255] }),
    })
  })

  test("an empty message is no request at all", async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch

    await createDevice(() => ({ ...CONFIG, awtrixUrl: "http://clock.local" }), fetchImpl).notify("", "0")

    expect(called).toBe(false)
  })
})

describe("api detection", () => {
  test("detects AWTRIX NG and writes its indicator endpoint", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body })
      if (String(url).endsWith("/api/v1/device")) return new Response("{}", { status: 200 })
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch

    const indicator = createDevice(() => ({ ...CONFIG, awtrixUrl: "http://clock.local/" }), fetchImpl)
    await indicator.set("working")

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET http://clock.local/api/v1/device",
      "PUT http://clock.local/api/v1/indicators/3",
    ])
    expect(JSON.parse(String(calls[1]!.body))).toEqual({
      on: true,
      color: "#00ff00",
      blinkMs: 0,
      fadeMs: 0,
    })
    // The probe is cached, so a second write still makes two requests, not three.
    await indicator.set("idle")
    expect(calls).toHaveLength(3)
  })

  test("falls back to AWTRIX 3 when the probe is answered, but not by NG", async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`)
      if (String(url).endsWith("/api/v1/device")) return new Response("", { status: 404 })
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch

    await createDevice(() => ({ ...CONFIG, awtrixUrl: "http://clock.local" }), fetchImpl).set("done")

    expect(calls).toEqual([
      "GET http://clock.local/api/v1/device",
      "POST http://clock.local/api/indicator3",
    ])
  })

  test("an unreachable device is written to on no API at all", async () => {
    // A failed probe means the device is unreachable, not that it is old. The
    // write would fail too, so nothing is attempted and the next poll retries.
    const calls: string[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`)
      throw new Error("connection refused")
    }) as unknown as typeof fetch

    await expect(
      createDevice(() => ({ ...CONFIG, awtrixUrl: "http://clock.local" }), fetchImpl).set("done"),
    ).rejects.toThrow("connection refused")

    expect(calls).toEqual(["GET http://clock.local/api/v1/device"])
  })

  test("the warm-up and the first write share one probe", async () => {
    // A cold mDNS lookup for a `.local` hostname measured 5 s. Two of those in
    // parallel is two times the wait for the same answer.
    const probes: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith("/api/v1/device")) {
        probes.push(String(url))
        await new Promise((resolve) => setTimeout(resolve, 5))
        return new Response("{}", { status: 200 })
      }
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch

    const indicator = createDevice(() => ({ ...CONFIG, awtrixUrl: "http://clock.local" }), fetchImpl)
    await Promise.all([indicator.warmUp(), indicator.set("working")])

    expect(probes).toHaveLength(1)
  })

  test("a failed write is reported", async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith("/api/v1/device")) return new Response("", { status: 404 })
      return new Response("nope", { status: 500, statusText: "Internal Server Error" })
    }) as unknown as typeof fetch

    const indicator = createDevice(() => ({ ...CONFIG, awtrixUrl: "http://clock.local" }), fetchImpl)

    await expect(indicator.set("working")).rejects.toThrow("500 Internal Server Error")
  })

  test("without a URL nothing is written at all", async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch

    await createDevice(() => ({ ...CONFIG, awtrixUrl: "" }), fetchImpl).set("working")

    expect(called).toBe(false)
  })
})
