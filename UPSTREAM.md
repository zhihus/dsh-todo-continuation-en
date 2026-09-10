# Upstream: three core primitives that would retire the todo-discipline plugins

A proposal for DSH core (`@deepseek-ai/dsh-tool-todo`, `@deepseek-ai/dsh-compaction`, the agent
loop). This is not a bug report about documented behavior: it is the set of host-side primitives
whose absence forces every todo-discipline plugin to reimplement the same state. All three parts
are already implemented and production-proven by one client-side plugin,
`@doiiarx/dsh-todo-continuation` (reference implementation: `github:zhihus/dsh-todo-continuation-en`,
tag `v0.7.0`): 94 unit tests, a mutation-hardened suite (57 of 60 single-source mutants killed), and
a live audit over real logs — 76 sessions with todo activity out of 142 scanned, 1642 stop
boundaries, 24 248 tool results, all contract checks PASS.

The parts are proposed **as a set on purpose**. Every one of them rests on the same primitive —
a durable standing-plan projection — and a partial adoption only moves the log archaeology into
whichever plugin still needs the rest.

## Part 1: the standing plan should survive `turn/start`

### The observation

`todo/write` stores a **full snapshot** of the plan, and the durable session log keeps every one of
them. At `turn/start` the host clears the `todos` projection. So from the model's point of view the
standing plan is destroyed at the beginning of every turn, while the fact that it exists — and its
exact content — is sitting one line away in the log.

What the plugin has to do about it, in v0.7.0:

| Need | How it is satisfied today |
| --- | --- |
| is there a standing list? | walk `session.events` for the last `todo/write` |
| how long has it been idle? | count `turn/start` records after that write |
| did the model lose its copy? | look for a `compaction/summary` after that write |
| hand the list back | re-inject it as a plugin-sourced user message |
| keep the veto honest | limit it to the current turn, because the projection is gone |

None of this is expensive at runtime (the walk is memoized on log size, incremental since v0.7.0),
but all of it is a reimplementation of state the host already has and chose to drop.

### Why the host-side clearing is costly

1. **A turn boundary silently destroys the working set.** A model that planned a 9-step job, worked
   for three turns and got interrupted no longer sees its own plan — the UI is empty and the context
   may not contain it either. Measured on 25 real sessions of this author's host: 267 stop
   boundaries, of which the largest gap without a `todo/write` was 4 turns; the list had to be
   reconstructed from the log on every one of them.
2. **It forces the veto to be turn-local.** The plugin may block a stop only while *this* turn wrote
   the list, because a durable unfinished list would veto every later turn forever — with no bound,
   one runaway session collected ~150 vetoes in 72 minutes (measured, `session-5f285234`, turn 56).
   If the standing plan were still materialized at `turn/start`, "unfinished work remains" would be a
   meaningful, non-looping condition.
3. **Compaction makes it worse, not better.** A compaction replaces a range of history with a
   summary; whether the plan survives in the model's context afterwards depends on the summarizer.
   The host knows the list is still standing and does not carry it across (this is Part 2).

### The proposal

Re-materialize the last plan instead of clearing it:

* **Option A (smallest).** At `turn/start`, keep the projection but mark it *carried over*, and
  render it in the todo section of the system prompt as "standing plan from earlier turns" rather
  than "this turn's list". Nothing else changes; the model stops losing a plan it wrote itself.
* **Option B.** Store the latest snapshot in session metadata (next to `header.parentSession`,
  `header.origin`) as a durable `plan` projection, and let the prompt assembly read it. This also
  makes a resumed or forked session start with its plan visible, which today only a plugin reading
  the log can do.
* **Option C (explicit non-choice).** Keep clearing, and add a documented
  `ctx.todos.standing(sessionId)` accessor for plugins, so consumers that need the durable view stop
  walking the event log themselves. Even this alone would let `todo-continuation` drop
  `readStandingTodos()` (~60 lines of log archaeology).

The invariant worth preserving in every variant: the **author of the list stays the model**.
Re-materializing is not re-inventing, and no host-side policy should create or complete items on its
own — a plugin (or a core) that writes todos would be worse than the gap it fixes.

### The UI pays the same tax: the todo panel empties on resume

The clearing above was derived from what the *model* sees. The GUI's todo panel pays the same tax,
and there the semantics are simply wrong for the consumer: a panel is not a turn.

The authoritative fold is the host-side projection unit
(`@deepseek-ai/dsh-tool-todo/lib/index.js`, the `todos` session projection):

```js
apply: (state, event) => {
    if (event.type === "todo/write") return event.data.todos;
    if (event.type === "turn/start") return null;   // ← the panel empties here
    return state;
}
```

The browser mirror (`@deepseek-ai/dsh-client-connection/lib/client.js`, `backscanTodos`) stops at
the most recent `turn/start` the same way, and `projectionFramesOf` re-emits the `todos` key on every
`todo/write` **and every `turn/start`** — so the panel clears at the start of any turn in which the
model has not rewritten the list yet, and stays empty after an app restart until the model's next
`todo_write`. Measured on 2026-09-10 (session `0d23a151`, local time): the PC was shut down mid-turn
at 23:51 the previous evening; the session resumed at 09:31; the todo-continuation plugin handed the
full 19-item plan back to the *model* at 09:32 (delivery in the log); the *panel* showed nothing
until the model rewrote the list at 10:01 — thirty minutes of "the todo list is gone" in the UI while
the model was actively working from it.

The fix is one semantic decision, not a feature: **the UI projection of `todos` must be durable
(last-write-wins over the whole log), because its consumer is the user, not the model.** Either drop
the `turn/start → null` branch (and the mirror's stop) for the wire view, or keep the model-facing
turn-local state and add a separate durable key (`standingTodos`) for the panel. The plugin cannot
compensate for this by design: writing the projection would mean writing todos, which plugins must
not do.

## Part 2: a landed compaction must restore the standing plan

### The gap

A compaction replaces a range of history with a summarizer's output; the standing plan survives in
the log and may not survive in the context. At the moment a compaction lands, the host knows two
things nobody else can cheaply re-derive: *that* it landed (the `compactionId` is its, and the failed
attempt ends as an errored `compaction/end` without a summary) and — with Part 1 — *what* the standing
plan is. Today the plugin joins these facts by walking the log for a `compaction/summary` positioned
after the last `todo/write`.

### The proposal

* **Option R-A (recommended).** When prompt assembly builds the post-compaction context, append the
  standing-plan section (Part 1's projection, unfinished items) as a first-class part of that
  context. The restoration then happens before the model's first turn after the compaction, not at
  some later boundary, and it cannot be lost by the summarizer.
* **Option R-B (accessor version).** Keep restoration to consumers, but give them the durable
  marker: document `compaction/summary { compactionId }` as *the* signal of a landed compaction and
  expose the last landed `compactionId` next to Part 1's accessor, so restoring plugins stop
  comparing event positions in a 3000-record log.

Three properties the plugin proved the hard way and any core version should keep:

1. **Once per compaction, not once per boundary.** Dedupe by `compactionId`: a compaction that
   crosses several stop boundaries hands the list back at the first of them and never again.
2. **A restoration reserves the periodic reminder** it was delivered inside — otherwise the model
   receives the same list twice in one turn through two channels (the plugin tests this: the stale
   interval is consumed by the hand-back).
3. **A failed compaction is not a trigger.** Only the landed summary (with its durable `compactionId`)
   justifies a restore.

Current implementation, for reference: the plugin delivers the restore at the next stop boundary and
— since v0.6.0 — mid-turn through the `tools/post-execute` `additionalContexts` channel; replayed
over real logs, the mid-turn channel is where most advisories actually land (114 of 157 in the
v0.7.0 audit). Every delivery is a transcript-visible notice with a bounded one-line summary.

## Part 3: the turn-stop gate over the standing plan

### The gap

The host lets a model end a turn while its own list says the work is unfinished, and the plugin can
veto only from outside, only turn-locally (see Part 1, cost 2), and only as a listener whose thrown
error would surface as a `turn/end { kind: 'error' }` — which is why every path in it fails open.

### The proposal

Make the gate a first-class host policy over the standing-plan projection, **off by default** (a
setting like `todos.enforce: 'off' | 'standing'`), and let the safety properties that the plugin had
to learn from real incidents be core guarantees:

* **Bounded per turn.** The plugin caps vetoes at a configurable 2 per turn, hard-clamped to 10:
  a gate without a cap is how one boundary spins for an hour.
* **Fail-open.** A gate that cannot read its own state must not trap the turn. Every internal throw
  allows the stop and logs the failure.
* **Cancellation always wins.** `agent.cancel` and terminal turn errors abort before the boundary
  and are never overridden — cancellation is the escape hatch, not the gate's opponent.
* **Plan mode is exempt.** Ending a turn with open todos is legitimate while a plan review is
  pending; the gate sees the executing agent's own session, and delegated children's lists are a
  user-visible opt-in (the plugin ships `gateSubagents` default-on with durable-header detection).
* **Every veto is attributed and visible.** The injected message is a `notice` with
  `source: { kind: 'plugin', plugin }` (in core: with a core source), reconstructed from the log by
  the client — silence is what makes a gate feel like a hang.
* **Decisions are explainable.** One machine-readable log line per boundary (`block` / `cap` /
  `off` / skip-with-reason) turns "why did it not continue?" into a grep. The plugin's
  `logDecisions` setting is the working model.

## Why one proposal and not three

Part 2 and Part 3 both read what Part 1 refuses to keep. Shipping Part 1 alone leaves two plugins
walking the log for compaction position and turn boundaries; shipping 2 or 3 without 1 ships the
runaway-veto loop and the summarizer coin-flip by construction. The set is small — it is the
projection the host already folds, no longer deleted at the boundary — and every part already has a
running client-side proof.

## What this proposal deliberately does not change

* **The model stays the only author of todos.** No part here lets the host create, complete or
  rewrite list items; restoration is re-materialization, not re-invention.
* **The personality stays out of core.** Template texts, nag cadence, per-list reminder caps, the
  quiet horizon, the 20-interval abandoned-work threshold — these remain plugin/user choices. Core
  provides the primitives (standing projection, compaction restore, bounded gate), not opinions.
* **No new durable event types.** The log already contains `todo/write`, `turn/start` and
  `compaction/summary`; every part above consumes exactly these.
* **Nothing forces a host-side default on.** All three parts are opt-in behavior or accessor-level
  plumbing; the status quo (clear the projection, end the turn freely) remains one setting away.

## What gets simpler in the plugin afterwards

* `readStandingTodos()` (~60 lines of log archaeology) collapses to Part 1's accessor; the
  incremental fold, its size-drift reload and its tail-truncation reload go with it.
* The compaction trigger shrinks from a `compaction/summary` position comparison to "the projection
  is non-empty and a compaction just landed" (Part 2), and the per-`compactionId` dedupe table
  disappears — the host dedupes by construction.
* The stop gate's turn-locality and its per-turn cap become a safety belt rather than the main
  brake (Part 3), and `listIdentity` / quiet flags / mid-turn-vs-boundary reservation collapse to
  cadence choices instead of correctness machinery.
* If the core ships all three as policies with settings, this plugin retires to nothing but its
  templates — see the next section for what happens if it ships even more.

## The retirement path

The day these primitives ship, **both** marketplace todo plugins can retire: `@doiiarx/dsh-todo-gate`
— the project this plugin was forked from, whose entire contribution was the veto that Part 3 absorbs
— and this plugin, whose remaining surface is cadence and text over Parts 1–3. The user deletes the
lines from the profile, the host's own durable projection shows the plan, the landed compaction
restores it, and the gate becomes one settings line — the install gets strictly simpler. Until then
this plugin is a workaround, and this document is the ledger of exactly where it is one: the fork
relationship stops mattering the moment the primitives land upstream, because there is nothing left
to fork.

## Verified host contracts (audit 2026-09-09/10, against the installed host checkout)

The plugin's behavior was re-derived from the installed host code (never from docs) during the
v0.7.0 audit. The contracts below are the ones the plugin depends on. If the host changes any of
them, the plugin needs a release, not a patch.

| Contract | Where it lives in the host |
| --- | --- |
| `agent/turn-stopping` payload `{ agent, turn, signal }`; a throw from the listener surfaces as `turn/end { kind: 'error' }` — why the boundary must fail open | `@deepseek-ai/dsh-agent-loop/lib/index.js` |
| `tools/post-execute` waterfall `(exec, result, next)`; `additionalContexts` is the mid-turn injection channel | `@deepseek-ai/dsh-tools` (tool registry waterfall) |
| `todo/write` appends a full snapshot; the `todos` projection is cleared at `turn/start` | `@deepseek-ai/dsh-tool-todo/lib/index.js` |
| `compaction/summary` with `compactionId` is the only durable marker of a landed compaction (a failed attempt ends as errored `compaction/end`, no summary) | `@deepseek-ai/dsh-compaction` |
| delegated sessions: `SessionHeader.origin === 'subagent'`, `delegationDepth > 0`, plus the `subagent/descriptor` log event as a fallback | `@deepseek-ai/dsh-session/lib/types/types.d.ts` |
| plugin-sourced `user/message` with `source: { kind: 'plugin', form: 'notice', summary }`; `CONTEXT_SUMMARY_MAX_CHARS = 120` | `@deepseek-ai/dsh-llm/lib/types/message.d.ts` |
| `Session.events` returns a cached deep-frozen snapshot; a previously returned array does not grow later (the basis of the incremental standing-list fold) | `@deepseek-ai/dsh-session/lib/types/index.d.ts` |
| `settings.register` throws on a duplicate namespace; `ctx.settings.get(ns)` reads the live registration (the duplicate-registration recovery path) | `@deepseek-ai/dsh-settings/lib/index.js` |
| the client settings scope exposes `status: 'unavailable'` when the namespace is not bound (the read-only UI state) | `@deepseek-ai/dsh-client-runtime` (settings-scope types) |

Empirical floor measured in the same audit: 129 sessions / ~1.9 M events under `$DSH_HOME/sessions`;
one full log walk ≈ 5 ms and the largest session holds 3229 tool results — the reason the
standing-list fold is incremental since v0.7.0. Deliveries are classifiable by `source.summary`
wording only for builds that write notices (this plugin's v0.6.0+ wording); older logs carry
shape-only evidence, which is why `test/verify-live.mjs` classifies by summary with shape as fallback
and anchors each contract check at the horizon where its feature provably exists.

## Removed client registration: `__DSH_SETTINGS_SEARCH__`

v0.6.0's client page registered a settings-search index on `globalThis.__DSH_SETTINGS_SEARCH__`. The
installed host build has no consumer for that global (verified by grep over the host checkout on
2026-09-09), so v0.7.0 removed the registration together with the unused `connection`/`remote` client
injects. **Restore it only if** the host ships a settings-search consumer that reads exactly this
global shape (`{ sections: Map, register(sectionId, spec) }`); the original registration block lives
in git history (`client.js` at the v0.6.0 tag).
