# Herdr AWTRIX Plugin

A Herdr plugin that shows your session's agent activity on an AWTRIX status
pixel, directly over HTTP. Optional scrolling notifications name the workspace
that needs attention.

<img src="screenshots/awtrix-green-dot.png" width="450" alt="AWTRIX display with a green status indicator at the bottom right">

Herdr already tracks what each of its agents is doing — opencode, pi, agy,
claude, codex, and the rest — so one pixel can speak for the whole terminal.
The plugin reads `session.snapshot` twice a second and paints the
highest-priority state it finds.

## Behavior

By default the plugin uses indicator 3 on the AWTRIX endpoint configured
locally:

| Herdr state | Meaning | Color | Effect |
| --- | --- | --- | --- |
| Blocked | An agent is waiting for approval or an answer | Amber | 1500 ms fade |
| Working | An agent is running | Green | Solid |
| Done | An agent finished and you have not looked yet | Blue | 1500 ms fade |
| Idle | Nothing needs you | Off | — |

[STATES.md](STATES.md) explains all five Herdr statuses, their limitations, and
how to check them yourself.

When several agents disagree, the loudest one wins: `blocked` beats `working`,
and `working` beats `done`. A session where an agent is waiting for you and
another is still thinking shows amber.

One pixel cannot identify an agent. Scrolling notifications name the workspace,
optionally including the harness (such as `opencode` or `claude`), and the
`status` action lists active agents on demand.

### Scrolling notifications

By default, when an agent becomes `blocked` or `done`, the plugin shows its
workspace name over whatever the clock is displaying:

```text
STS Test +2
```

`+2` means two additional agents entered a notification state in the same poll.
The text defaults to the triggering state's color, which can differ from the
aggregate status dot. Existing states are not announced on startup, and an
unchanged state is not announced again on every poll.

`notifyMinIntervalMs` (default 15000) is the minimum gap between announcements.
Events during that interval or an in-flight notification request are skipped,
not queued.

`done` fires every time an agent finishes a turn, which is useful when the clock
is across the room and noise when it is not. Narrow it if it talks too much:

```json
{ "notifyStates": ["blocked"] }
```

To disable all agent/workspace text announcements without changing the indicator
pixel, set `"notify": false`. To use a separate text color, set `notifyColor`:

```json
{ "notify": true, "notifyColor": "#ffffff" }
```

By default, announcements show only the workspace name (`STS Test`). Set
`"notifyShowAgent": true` to include the harness name (`opencode STS Test`).
If the workspace has no name, the harness name is used as a fallback.

`notifyColor` accepts the same color formats as `colors`. Omit it or set it to
`null` to follow the triggering state's color. These settings are hot-reloaded
and apply to future announcements; they do not replay an existing event.

### Asking on demand

The `status` action reports the aggregate state and lists active agents,
highest-priority first, with their workspace and terminal title:

```sh
herdr plugin action invoke saplaum.herdr-awtrix.status
# ... "sessions": [{ "agent": "opencode", "status": "working",
#                    "workspace": "STS Test", "pane_id": "wA:p9",
#                    "title": "OC | AWTRIX-Plugin-Prinzip…" }]
```

Two differences from a single-agent view are worth knowing:

- **A pane with no agent does not count.** Herdr reports `unknown` both for an
  agent it cannot classify and for a plain shell, so the plugin counts a pane
  only when Herdr recognized an agent in it. An unclassified agent stays dark.
- **`blocked` does not distinguish a permission prompt from a question.** Herdr
  reports one state for both, so both are amber.

AWTRIX draws the three indicators as single pixels on the right edge. On a 32×8
matrix they sit at these positions. This is a status dot, not an app icon:

| `indicator` | Position |
| --- | --- |
| `1` | top right |
| `2` | middle right |
| `3` | bottom right (default) |

Set `indicator` to whichever pixel you want to use.

## Install

Requires Bun **1.4.2 or newer** (the plugin runs TypeScript directly) and
Herdr **0.9.1 or newer**. Supported platforms are macOS and Linux; Windows is
not declared. Device writes use HTTP(S), so use a trusted local network.

**Live-tested with AWTRIX NG 1.2.2 only.** AWTRIX 3 support has fixture tests,
but has not been verified on a real AWTRIX 3 device.

```sh
herdr plugin install saplaum/herdr-awtrix
```

Then create `awtrix.json` in the directory printed by:

```sh
herdr plugin config-dir saplaum.herdr-awtrix
```

For example, use your clock's address and choose whether agent/workspace names
should scroll across the display:

```json
{
  "awtrixUrl": "http://clock.local",
  "indicator": 3,
  "notify": true,
  "notifyShowAgent": false,
  "notifyColor": "#ffffff"
}
```

This enables white text announcements alongside the status dot. Set
`"notify": false` for the dot only. `notifyShowAgent` defaults to `false` (workspace name
only); set it to `true` to also show the harness name, such as `opencode`.
Omit `notifyColor` or set it to `null` to match the text to the triggering
state's color instead. The [Configuration](#configuration)
section covers all options.

**Installing does not start the plugin.** After writing the configuration,
start its background process in the Herdr session you want to observe:

```sh
herdr plugin action invoke saplaum.herdr-awtrix.start
```

This process is called the **writer** below: it reads Herdr's state and updates
the clock. Herdr records its output in the plugin log. A `running` action means
the process has launched, not that the device has received a write yet; the
first update can take several seconds with a `.local` hostname.

Future server starts also launch the writer through the startup hook. Attaching
another client does not launch it again. The writer stays alive itself; Herdr
does not supervise or automatically restart it after a failure. You do not need
to stop your Herdr server to activate the plugin.

### Stop and restart

Before updating, disabling or uninstalling, stop the existing writer:

```sh
herdr plugin action invoke saplaum.herdr-awtrix.stop
```

The stop action waits up to 30 seconds for the writer to finish pending requests,
attempt to clear the dot, and release ownership. Inspect its log for reset errors
if the clock is unreachable. Disabling or uninstalling does not replace this step.
If another start action is waiting for ownership, let its 30-second wait expire
before stopping the owner if you intend to leave the dot off.

After updating plugin code, stop the old process and start a new one:

```sh
herdr plugin action invoke saplaum.herdr-awtrix.stop
# Update the installed plugin or edit your locally linked checkout here.
herdr plugin action invoke saplaum.herdr-awtrix.start
```

Updating Herdr itself does not require reinstalling this plugin. Changes to
`awtrix.json` are hot-reloaded, except `sessionSocketPath`; they do not require
restarting the writer.

## Configuration

The plugin reads one JSON file. Write it where Herdr keeps this plugin's config,
which `herdr plugin config-dir saplaum.herdr-awtrix` prints:

```sh
herdr plugin config-dir saplaum.herdr-awtrix
# ~/.config/herdr/plugins/config/saplaum.herdr-awtrix
```

```text
~/.config/herdr/plugins/config/saplaum.herdr-awtrix/awtrix.json
```

All settings are optional, but no device writes occur until `awtrixUrl` is set.
See [awtrix.json.example](awtrix.json.example) for a complete starting point.

| Key | Default | What it does |
| --- | --- | --- |
| `sessionSocketPath` | `""` | Optional exact `HERDR_SOCKET_PATH` of the session allowed to run the writer. Requires restart. |
| `awtrixUrl` | `""` | HTTP(S) device URL without credentials, query or fragment. Empty means no new writes; removing it clears the previous target. |
| `indicator` | `3` | Which of the three indicator pixels to use. |
| `timeoutMs` | `6000` | Request timeout. Generous, because a cold mDNS lookup for a `.local` host can take seconds. |
| `pollMs` | `500` | How often the session is read, in ms. Hot-reloaded; allowed range 50–60000. |
| `fadeMs` | `1500` | Fade-in for `blocked` and `done`. |
| `api` | `"auto"` | `auto`, `ng` or `v3`. See below. |
| `colors` | see above | Per-state color: `[r, g, b]`, `#rrggbb`, a bare hex string, or `"0"` / `"off"` for dark. |
| `notify` | `true` | Enable scrolling text for transitions into `notifyStates`. Independent of the dot. |
| `notifyShowAgent` | `false` | Include the harness name before the workspace name. Without a workspace name, the harness name is always used. |
| `notifyColor` | `null` | Separate notification text color; `null` follows the triggering state's color. Does not change the indicator. |
| `notifyStates` | `["blocked", "done"]` | Which states are worth announcing. Narrow to `["blocked"]` if `done` is too chatty. |
| `notifyMinIntervalMs` | `15000` | The shortest gap between two announcements. |

The file is validated and re-read on every poll. Colors, URL, indicator, API and
fade changes repaint even if the agent state stays the same. A target change
first clears the old indicator; if that cleanup fails, migration is retried
rather than silently leaving a stale pixel behind. If the old device is
permanently unavailable, stop the writer, inspect/reset the old pixel separately,
then start again with the new target.

Invalid reloads retain the last good settings and are logged with backoff. An
invalid initial configuration exits with an error. RGB channels must be integers
0–255; `indicator` is 1–3; `timeoutMs` is 1–60000; `fadeMs` is 0–60000; and
`notifyMinIntervalMs` is 0–86400000. Unknown keys and invalid state names are
rejected. `sessionSocketPath` changes require stopping and starting the writer.

**Use the device IP rather than a `.local` hostname** if you can. Herdr starts
the plugin at server startup, when the mDNS cache is empty: a cold lookup for
`clock.local` measured **5051 ms**, and the same device by IP measured **41 ms**.
`timeoutMs` has to absorb that delay. A `.local` name survives DHCP changing the
address, which is the reason to keep one if the address is not fixed.

### Device generations

Two AWTRIX generations speak two APIs, and neither announces which it is:

| | Endpoint | Body |
| --- | --- | --- |
| AWTRIX NG | `PUT /api/v1/indicators/<n>` | `{on, color, blinkMs, fadeMs}` |
| AWTRIX 3 | `POST /api/indicator<n>` | `{color, fade?}` |

`api: "auto"` probes with `GET /api/v1/device` and caches by device URL. A 2xx
response selects NG; only HTTP 404 selects AWTRIX 3. Network errors and other
HTTP failures remain errors and are retried. Failed indicator writes invalidate
the cached detection. Changing URLs gets a separate probe, including when an
older probe is still in flight. Detection allows at least 10 seconds for cold
DNS. Set the API explicitly to skip detection.

### Multiple sessions and writer ownership

One writer per OS user may run, even across different sessions and foreground
invocations. The first eligible process acquires the atomic lock at
`~/.cache/herdr-awtrix/writer.lock`; contenders wait up to 30 seconds, then exit
without writing. This intentionally selects **one session**, not an aggregate
of all servers. To make the choice deterministic, set `sessionSocketPath` to
the desired session's `HERDR_SOCKET_PATH` value before starting the plugin.

The old writer finishes in-flight indicator/notification requests and attempts
to clear its last target **before** releasing ownership. Socket removal or
replacement retires it; three consecutive snapshot failures also stop it.
It also retires if its launcher parent exits, including when a replacement
server retains the same socket. Lifecycle checks run every 250 ms independently
of `pollMs`. This avoids relying solely on Herdr forwarding termination signals.
An existing standby can acquire the released lock and become the next writer.

After an uncatchable crash (`SIGKILL`, power loss), the lock is deliberately
not stolen automatically. Inspect `writer.lock/owner.json` and verify that no
plugin writer, test action or foreground instance is still running. Only then
remove the stale lock directory manually, reset/inspect the device, and start
again. A PID alone is not proof of ownership because PIDs can be reused.
Different OS users or other plugins are not covered by this lock.

### Running beside other indicator plugins

AWTRIX has three pixels, and more than one plugin can share the device as long
as each takes its own. The OpenCode counterpart this plugin was ported from is
configured with its own `indicator` option; give the two different values and
they never write over each other.

## Actions

| Action | What it does |
| --- | --- |
| `saplaum.herdr-awtrix.status` | Prints the aggregate state, the per-state counts, the color it would use, and which agents are behind it. Writes nothing. |
| `saplaum.herdr-awtrix.start` | Starts the long-lived writer in this session; waits up to 30 seconds if ownership is busy. |
| `saplaum.herdr-awtrix.stop` | Cooperatively stops the current owner, attempts to clear its pixel, and waits for ownership release. |
| `saplaum.herdr-awtrix.test` | Exclusively cycles colors and a sample notification; clears the pixel on completion/interruption. Refuses while another writer owns the lock. |
| `saplaum.herdr-awtrix.off` | Exclusively turns the configured indicator off. Refuses while a writer owns the lock; stop it first. |

```sh
herdr plugin action list --plugin saplaum.herdr-awtrix
herdr plugin action invoke saplaum.herdr-awtrix.stop
herdr plugin action invoke saplaum.herdr-awtrix.test
herdr plugin action invoke saplaum.herdr-awtrix.start
```

Bind one to a key in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+t"
type = "plugin_action"
command = "saplaum.herdr-awtrix.test"
description = "cycle the AWTRIX indicator"
```

## Local development

```sh
bun install --frozen-lockfile              # development dependencies only
bun test                                  # unit + isolated process/socket/HTTP tests
bun run typecheck
bun run index.ts --once                   # what the plugin sees right now
HERDR_AWTRIX_URL=http://clock.local bun run index.ts   # run it in the foreground
herdr plugin link /path/to/herdr-awtrix   # register this checkout, instead of a GitHub install
```

`herdr plugin link` runs no build commands, so nothing needs building first.
`herdr plugin log list --plugin saplaum.herdr-awtrix` lists command log records
and their status.

Run the daemon in the foreground in a tab of its own, so `Ctrl+C` always stops
it. Stop an existing plugin writer first; foreground runs use the same lock.
The tests use temporary HOME directories and loopback fixtures; they do not
control your real Herdr session or AWTRIX. CI is configured for macOS and Linux.

Foreground commands do not automatically use Herdr's per-plugin config directory.
Set `HERDR_AWTRIX_CONFIG_PATH` to your `awtrix.json` path to use the same settings;
otherwise the fallback is `~/.config/herdr/awtrix.json`. These commands must run
inside Herdr when reading a session.

## Troubleshooting

- **No dot:** Check the bottom-right indicator (3 by default), not the main
  display. `idle` and `unknown` intentionally leave it dark. Run the `status`
  action to check the expected state, configured URL, and indicator; it reports
  intent, not a read-back from the clock. A missing URL disables device writes.
- **Start says `running`, but nothing appears:** Allow time for device detection
  and DNS. The action may also be waiting up to 30 seconds for another writer.
  Avoid repeatedly invoking `start`; check the plugin's command log records.
- **No scrolling text:** Existing states are not announced on startup. Check
  `notify`, `notifyStates`, and `notifyMinIntervalMs`. Configuration edits apply
  to future events, not text already displayed.
- **Changes to code have no effect:** Use the stop/start sequence above. Config
  edits alone do not need a restart.
- **An example pane ID is not found:** Pane IDs vary by session. Use
  `herdr agent list` to find a current ID before running `herdr agent explain`.
- **Writer busy after a crash:** Follow the stale-lock recovery instructions in
  [Multiple sessions and writer ownership](#multiple-sessions-and-writer-ownership).

## How it works

One process, polling, no event subscription:

```
                    every 500 ms
                          │
                          ▼
                  session.snapshot          the whole session, one request
                          │
                          ▼
       per pane: is there an agent, and what state is it in?
                          │
                          ▼
              blocked > working > done > idle
                          │
           state/config changed? ──no──► nothing
                          │
                         yes
                          ▼
              PUT/POST one indicator pixel
```

Four decisions shape it:

- **A snapshot, not a subscription.** `events.subscribe` delivers
  `pane.agent_status_changed` only per pane, so a plugin using it has to
  subscribe and unsubscribe as panes come and go, and reconcile with
  `session.snapshot` whenever it falls behind. A snapshot describes the present
  in one request and needs no reconciliation. The same reasoning is why the
  community `herdr-auto-title` plugin polls.
- **The device never blocks the session.** A slow or unreachable AWTRIX write
  can take `timeoutMs`; the poll loop does not wait for it. The two are joined
  by a single value — the state the session is in — and one write in flight.
- **Nothing is written until state or config changes.** Identical polls write
  nothing, so a quiet session costs one small request per poll and no traffic to
  the clock. The first write of a run always paints the current state, clearing
  a stale pixel if the session is idle. Failed writes are retried after backoff.
- **A notification is an event, not a state.** The device is told which agent is
  asking when an agent *starts* asking — a `pane:status` pair that was not in the
  previous poll — so a session that sits blocked all afternoon announces once. A
  state that flaps is collapsed by `notifyMinIntervalMs`, and the first poll
  after startup announces nothing at all.

Device failures are retried, including an unreachable first probe. Reload
failures keep the last good configuration. Errors are logged on a doubling
backoff instead of twice a second. Session loss retires the writer rather than
polling a dead server forever. SIGINT, SIGTERM and cooperative stop all drain
pending work and attempt to turn the pixel off while still owning the lock.
An unreachable clock, forced kill or power loss can prevent that reset; inspect
the device rather than treating a lit pixel as proof of a live writer.

## Publication

Herdr's marketplace is an automatic, unreviewed **community** index, not an
official certification. Listing requires a public, non-fork, non-archived GitHub
repository with topic `herdr-plugin` and a parseable manifest on its default
branch. It refreshes approximately every 30 minutes. See
[Herdr's marketplace documentation](https://herdr.dev/docs/marketplace/).

## Credits

The AWTRIX HTTP details and the state-to-color mapping come from
[opencode-awtrix](https://github.com/saplaum/opencode-awtrix), the OpenCode 2
plugin this one is the Herdr counterpart to. The plugin shape follows
[herdr-auto-title](https://github.com/kryptamine/herdr-auto-title).

## License

MIT
