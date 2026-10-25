# Working on this plugin

Measured facts about Herdr and the AWTRIX device, followed by explicitly labelled
fixture-tested plugin behavior. **Probe before assuming anything not listed here,
and record what a probe teaches you in this file.** Fixture tests are not evidence
of live firmware or Herdr lifecycle behavior.

Verified against Herdr 0.9.1 (protocol 22) on macOS and AWTRIX NG 1.2.2.

## Herdr

- **`session.snapshot` is one request per connection.** Herdr closes the
  connection after answering, so `src/herdr.ts` dials its own every time. There
  is no connection to lose and no reconnect logic anywhere.
- **`params` is required even for methods that take none.** `{}` works; omitting
  it does not.
- **`snapshot.panes[]` carries `agent` and `agent_status`.** `agent` is absent
  for a pane with no recognized agent, and `agent_status` is `unknown` for those
  panes — the same value an agent Herdr cannot classify reports. **`agent` being
  present is what tells the two apart**, and `src/state.ts` relies on it.
- **`agent_status` is `idle | working | blocked | done | unknown`.** `done` means
  idle and not yet seen; `blocked` covers an approval prompt and a question
  alike, so the two cannot be distinguished from the snapshot.
- **`pane.agent_status_changed` subscriptions are per pane.** The subscription
  list requires a `pane_id`, so a subscriber has to subscribe and unsubscribe as
  panes come and go, and reconcile with `session.snapshot` on `events_lost`. This
  plugin polls instead; see the README.
- **A plugin process is given `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`,
  `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR` and `HERDR_PLUGIN_STATE_DIR`.**
  It inherits the **server's** environment, not the shell it was installed from,
  which is why configuration lives in a file.
- **`[[startup]]` runs once when the server restores a session** — not on
  install, not on enable, not when a client attaches, not on config reload. A
  long-lived process started from a startup hook is the established pattern
  (`herdr-auto-title` does it), even though the hook itself is one-shot.
- **`herdr plugin link` runs no build commands.** `herdr plugin install` does.
- **`bun` resolves in the server's environment.** The server already starts
  another plugin's `bun` process, so the manifest can name `bun` plainly.

## AWTRIX

- **Two generations, two APIs, neither announces itself.**

  | | Endpoint | Body |
  | --- | --- | --- |
  | AWTRIX NG | `PUT /api/v1/indicators/<id>` | `{on, color, blinkMs, fadeMs}` |
  | AWTRIX 3 | `POST /api/indicator<n>` | `{color, fade?}` |

- **`GET /api/v1/device` answers only on NG.** A 404 means the older API; a
  *failed* request means the device is unreachable, which is not an answer.
- **An indicator is read back from the `indicators` array in
  `GET /api/v1/device`.** `GET /api/v1/indicators` is 404 and a per-indicator GET
  is 405, but the device's own array carries `{on, color, blinkMs, fadeMs}` for
  all three — which is how a stale pixel left by an earlier run is spotted. An
  earlier version of this file claimed no read-back existed; it was wrong.
- **`id` is a single character, `1`, `2` or `3`**, and the three are real pixels
  on the right edge: **1 top, 2 middle, 3 bottom**. Confirmed against the
  official NG HTTP reference and corroborated by watching which pixel lit.
- **`on: false` in the PUT body does turn the pixel off** on NG 1.2.2, and the
  read-back confirms it, even though the reference describes clearing as a
  `DELETE /api/v1/indicators/{id}`. `PUT` with an unparseable color is 422 and
  leaves the stored color alone.
- **`POST /api/v1/notifications` with `{"text": "..."}` scrolls a message over
  the current app** and answers `{"ok": true}`. `PUT /api/v1/apps/pushed/<name>`
  instead adds a permanent app to the rotation, replaced or removed by
  `DELETE /api/v1/apps/<name>`. Notification-only keys include `textColor`,
  `textBlinkMs`, `hold`, `soundRtttl`.
- **AWTRIX 3 shows a notification at `POST /api/notify`**, and spells the colour
  `color` rather than `textColor`. Not probed live — no AWTRIX 3 device here —
  so treat it as the documented shape rather than a measured one.
- **The read-back keeps the stored colour when an indicator is off.** After a
  write of `{on: false, color: "#000000"}` the device still reported the previous
  colour with `on: false`, so `on` is the field that means dark, not `color`.
- **A cold mDNS lookup for a `.local` hostname measured 5051 ms** on macOS, and
  the same device by IP measured **41 ms**. A warm write measured 48 ms. This is
  why the first write after a server start can lag, why `timeoutMs` defaults to
  `6000` rather than something tight, and why the README recommends the IP.
- **The resolved address is cached by the OS after the first lookup**, so the
  delay appears once rather than per request.

## The defect a live run found

The first version queued a write per poll while the first write was still open.
A cold mDNS lookup held the first write for five seconds and **ten duplicate
writes went out for one colour**. `src/painter.ts` exists to make that
impossible, and `src/painter.test.ts` is the regression test. Do not replace the
single-writer loop with a promise chain.

## Things that are easy to get wrong

- **Uncoordinated writers corrupt each other's view of the device.** This was
  measured before this plugin had ownership locking. The current lock coordinates
  this plugin's processes for one OS user, not other plugins or users. Use separate
  indicator pixels and reset the pixel after any live test involving another writer.
- **The plugin's own config directory is separate from the OpenCode plugin's.**
  `~/.config/herdr/plugins/config/saplaum.herdr-awtrix/awtrix.json` here, and
  whatever `opencode.json` passes as plugin options there. They share the device,
  not the configuration.
- **`notifyStates` defaults include `done`, which fires at the end of every
  agent turn.** That is a deliberate default and the first thing to narrow if the
  clock talks too much.

## Fixture-tested plugin contracts (not new live Herdr measurements)

- `src/regression.test.ts` connects the real Device and Painter: a failed API
  probe rejects, so an unchanged state is retried. Only HTTP 404 selects v3;
  cache entries and concurrent probes are scoped to the URL.
- `src/painter.test.ts` checks configuration identity as well as state, including
  edits during an in-flight write. Preserve the single-writer loop.
- `src/daemon.test.ts` uses separate Bun processes, temporary HOME directories,
  Unix sockets and loopback HTTP. It checks exclusive ownership, old-target cleanup,
  socket removal/replacement, launcher-parent death with an unchanged socket,
  failed snapshots, invalid reloads and draining indicator/notification requests
  before handoff. Cooperative stop is checked with `pollMs: 60000`; the separate
  lifecycle interval must keep it responsive.
- The canonical per-user lock is `~/.cache/herdr-awtrix/writer.lock`, independent
  of Herdr's invocation environment. It fails closed after uncatchable crashes;
  stale-lock removal requires a human to verify that all writers have stopped.
  `--stop` requests a token-bound cooperative stop; it never signals a stored PID.

Run this before believing anything works (the last two commands are live probes):

```sh
bun test                                     # isolated fixtures; no live Herdr/device
bun run typecheck
bun run index.ts --once                      # what the plugin sees right now
HERDR_AWTRIX_URL=http://clock.local bun run index.ts    # in the foreground
```
