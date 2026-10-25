# The states, explained

The pixel shows one of four things. None of them is decided by this plugin: it
reads what **Herdr** already believes about every agent in the session and paints
the loudest answer. So understanding the pixel means understanding Herdr's five
agent states.

Every claim below was checked against a live Herdr 0.9.1 / AWTRIX NG 1.2.2
install, and the commands to check it again yourself are at the end.

## The four things the pixel can show

| Pixel | Colour | Herdr statuses behind it | Meaning |
| --- | --- | --- | --- |
| **Amber**, 1500 ms fade | `#ffbf00` | `blocked` | An agent is waiting for you — an approval or a question |
| **Green**, solid | `#00ff00` | `working` | An agent is running |
| **Blue**, 1500 ms fade | `#0080ff` | `done` | An agent finished and you have not looked at it yet |
| **Dark** | — | `idle`, `unknown` | Nothing needs you |

The fade is a breathe on the indicator itself. It is not a blink: a state that
persists keeps breathing.

## Herdr's five statuses

Herdr puts an `agent_status` on **every** pane. Five values, and the ones that
matter most are the ones that behave unexpectedly.

### `working` — an agent is running

Detected by a **rule** matched against the pane's recent output. Ask for the rule
and Herdr shows you the rule *and the text that matched*:

```console
$ herdr agent explain w1:p1
agent: opencode
state: working
manifest: remote:.../herdr/agent-detection/remote/opencode.toml 2026.06.10.1
rule: progress_bar_working (region=whole_recent priority=100)
evidence: "     ┃ Let me do that. ..."
```

This is the answer to "why is the pixel green?" in one command. Rules are
downloaded manifests that Herdr refreshes in the background, so a rule can change
under you after an update — `herdr server agent-manifests` lists what is active.

**Green means at least one agent matched a working rule.** If several are
running, the pixel is still just green; `status` names them.

### `idle` — an agent is waiting for input

**`idle` is a fallback, not a detection.** This is the single most useful thing
in this document. The same pane, explained when it was quiet:

```console
$ herdr agent explain w1:p1
agent: opencode
state: idle
rule: none
fallback_reason: default_known_agent_idle_fallback
```

`rule: none`. Herdr did not *see* idleness; nothing else matched, so a known
agent falls back to idle. The error direction is therefore: an agent that is
busy but whose output no rule recognises looks idle, and the pixel goes **dark**.
That is the safe direction for an indicator — a missing light costs you a glance,
a lying light costs you trust — but it is why "the pixel is off and something is
clearly happening" is possible.

### `blocked` — an agent is waiting for you

A rule matched an approval UI or a question. This is the loudest state, and the
reason the pixel has an amber colour at all.

**Herdr does not tell you which it is.** There is no field, and no rule
distinction the plugin can read, between a permission prompt and a question. Both
are `blocked`, both are amber. The OpenCode plugin this one was ported from *can*
distinguish them (permission amber, question blue) because it sits inside OpenCode
and sees its event stream; a Herdr plugin sees one aggregated state and cannot.

If you want that distinction, keep the OpenCode plugin on its own indicator pixel
for OpenCode sessions — see the README's "Running beside other indicator plugins".

### `done` — finished, and you have not looked yet

Herdr's own description: *the agent is ready for input, and the server's seen
state says you have not seen it.* Two consequences:

- **`done` fires at the end of every turn.** An agent that answers a prompt and
  goes quiet is `done`, not `idle`, until you look at it.
- **Only you clear it.** `done` turns into `idle` when the pane is explicitly
  focused by a client. *Reading* a pane does not mark it seen — which is why this
  plugin's polling can never clear a `done` badge for you: it observes, it does
  not look. That is deliberate, and it is what makes `done` worth showing.

So the blue pixel is a small inbox: an agent finished something while you were
somewhere else. It goes away when you go there.

Because `done` is a per-turn event, it is the noisiest state to announce on the
panel. `notifyStates` defaults to both `blocked` and `done`; narrow it to
`["blocked"]` if the clock talks too much.

### `unknown` — two different things

This is the loaded one, and the plugin has to disambiguate it:

| What | `agent` field | Counted as an agent? | Pixel |
| --- | --- | --- | --- |
| A plain shell pane | absent | no | dark |
| An agent Herdr detected but cannot classify | present | yes | dark |

Every pane in the session carries `agent_status`, and a pane with nothing running
in it reports `unknown` exactly like an agent nobody can classify. The presence
of the `agent` field is the only thing that tells them apart, and `src/state.ts`
keys on it:

```ts
for (const pane of panes) {
  if (!pane.agent) continue   // a shell, not an agent
  ...
}
```

In one measured session that was most of the panes: 22 panes, 2 of them holding a
recognised agent.

Both cases paint the pixel **dark**. An unclassifiable agent is worth knowing
about, which is why `status` counts it, but it is not worth a light — the light
means "someone wants you", and an agent nobody can read has not asked for
anything.

## When several agents disagree

The pixel is single-valued, so the loudest state wins:

```
blocked  >  working  >  done  >  idle
```

- **`blocked` beats everything.** An agent waiting for you is the only thing that
  cannot wait.
- **`working` beats `done`.** While work is still in flight the light should say
  "busy"; a finished agent only matters once the machine is quiet.
- **`unknown` does not compete.** It is not a state an agent is in, it is the
  absence of an answer.

`herdr plugin action invoke saplaum.herdr-awtrix.status` prints the counts behind
the decision, so "green" becomes "one working agent out of seven, the other six
idle".

## Where Herdr gets the states

Two mechanisms, and which one is in play changes how much you should trust a
state.

**1. Lifecycle hooks — an integration reports its own state.** Herdr ships a hook
for a long list of agents:

```sh
herdr integration status              # what is installed, current, or outdated
herdr integration install <agent>     # install the hook
```

A hook reports semantic state directly, which makes it authoritative: Herdr then
**skips screen detection entirely** for that pane. It is visible in the session
snapshot as `screen_detection_skipped: true` alongside a stored `agent_session` —
the field is only present when it is true, which is why a pane using a screen rule
does not show it as `false`, it does not show it at all. Measured on a `pi` pane,
whose integration is current.

**2. Screen rules — Herdr reads the pane.** Downloaded manifests matched against
the bottom of the pane's output. This is the path for every agent without an
installed integration, and the path the `working` example above came from.
Measured here on the `opencode` panes: no `screen_detection_skipped`, no
`agent_session`, and `explain` answering with a matched rule.

Screen rules can be wrong. A rule that does not match makes a busy agent look
`idle`; a rule that matches a leftover spinner makes a finished agent look
`working`. When a state surprises you, `explain` is the way to find out which it
was, and `herdr integration install` is the fix when it exists for your agent.

**This plugin only reads.** It never calls `pane.report_agent`, so it cannot
influence what Herdr itself shows — the agent list, the sidebar badges, the waits
that `herdr agent wait` performs. It is a consumer of those states, not a
contributor to them. (The OpenCode plugin in the same session *is* a contributor:
it reports OpenCode's state to Herdr, which is how the pixel can see it at all.)

## Checking a state yourself

```sh
# Why does Herdr think this? The rule, the priority, and the text that matched.
herdr agent explain w1:p1
herdr agent explain w1:p1 --json

# Every agent and its status, right now.
herdr agent list

# What the plugin would paint, and which agents are behind it.
herdr plugin action invoke saplaum.herdr-awtrix.status

# What the panel actually shows. The indicators array covers all three pixels,
# so this is also how a stale dot from another plugin is spotted.
curl -s http://clock.local/api/v1/device | jq .indicators
```

## Known limits, in one place

- **`blocked` is one state.** Permission prompt and question are indistinguishable
  from Herdr.
- **`unknown` is overloaded.** An agentless pane and an unreadable agent share
  one value, told apart only by the presence of `agent`.
- **`idle` is the fallback.** It means "no rule matched", not "positively quiet".
  Unexpected darkness is the failure mode to expect, not unexpected colour.
- **`done` needs you to look.** Only explicit focus clears it, so a blue pixel
  hangs around until you visit, which is the point.
- **One pixel, four states.** Only the loudest is visible; `status` is the way to
  see the whole picture.
- **The pixel only says that, never who.** The panel notification names the agent
  when one *starts* asking; the pixel never does.
