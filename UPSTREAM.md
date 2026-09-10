# Upstream note: the standing plan should survive `turn/start`

Proposal for DSH core (`@deepseek-ai/dsh-tool-todo` / the `todos` projection).
This is not a bug report against a documented behavior: it is the one host-side
gap that forces `@doiiarx/dsh-todo-continuation` to be as roundabout as it is.

## The observation

`todo/write` stores a **full snapshot** of the plan, and the durable session log
keeps every one of them. At `turn/start` the host clears the `todos` projection.
So from the model's point of view the standing plan is destroyed at the beginning
of every turn, while the fact that it exists — and its exact content — is sitting
one line away in the log.

What the plugin has to do about it, in v0.6.0:

| Need | How it is satisfied today |
| --- | --- |
| is there a standing list? | walk `session.events` for the last `todo/write` |
| how long has it been idle? | count `turn/start` records after that write |
| did the model lose its copy? | look for a `compaction/summary` after that write |
| hand the list back | re-inject it as a plugin-sourced user message |
| keep the veto honest | limit it to the current turn, because the projection is gone |

None of this is expensive at runtime (the walk is memoized on log size), but all of
it is a reimplementation of state the host already has and chose to drop.

## Why the host-side clearing is costly

1. **A turn boundary silently destroys the working set.** A model that planned a
   9-step job, worked for three turns and got interrupted no longer sees its own
   plan — the UI is empty and the context may not contain it either. Measured on 25
   real sessions of this author's host: 267 stop boundaries, of which the largest
   gap without a `todo/write` was 4 turns; the list had to be reconstructed from the
   log on every one of them.
2. **It forces the veto to be turn-local.** The plugin may block a stop only while
   *this* turn wrote the list, because a durable unfinished list would veto every
   later turn forever — with no bound, one runaway session collected ~150 vetoes in
   72 minutes (measured, `session-5f285234`, turn 56). If the standing plan were
   still materialized at `turn/start`, "unfinished work remains" would be a
   meaningful, non-looping condition.
3. **Compaction makes it worse, not better.** A compaction replaces a range of
   history with a summary; whether the plan survives in the model's context
   afterwards depends on the summarizer. The host knows the list is still standing
   and does not carry it across.

## The proposal

Re-materialize the last plan instead of clearing it:

* **Option A (smallest).** At `turn/start`, keep the projection but mark it
  *carried over*, and render it in the todo section of the system prompt as
  "standing plan from earlier turns" rather than "this turn's list". Nothing else
  changes; the model stops losing a plan it wrote itself.
* **Option B.** Store the latest snapshot in session metadata (next to
  `header.parentSession`, `header.origin`) as a durable `plan` projection, and let
  the prompt assembly read it. This also makes a resumed or forked session start
  with its plan visible, which today only a plugin reading the log can do.
* **Option C (explicit non-choice).** Keep clearing, and add a documented
  `ctx.todos.standing(sessionId)` accessor for plugins, so consumers that need the
  durable view stop walking the event log themselves. Even this alone would let
  `todo-continuation` drop `readStandingTodos()` (~60 lines of log archaeology).

The invariant worth preserving in every variant: the **author of the list stays the
model**. Re-materializing is not re-inventing, and no host-side policy should
create or complete items on its own — a plugin that writes todos would be worse
than the gap it fixes.

## What gets simpler in the plugin afterwards

* The stop gate can veto on "the standing list has unfinished items" instead of
  "this turn wrote it", and the per-turn cap becomes a safety belt rather than the
  main brake.
* The compaction trigger shrinks to "the projection is empty and the list is
  standing" instead of a `compaction/summary` position comparison.
* The `{todos}` payload can reference the plan instead of pasting it (though pasting
  is what makes the reminder survive a summarizer that drops the reference).

None of the above is a reason to wait: v0.6.0 works around the gap completely, and
this note only records which part of the workaround belongs to the host.

## Verified host contracts (audit 2026-09-09/10, against the installed host checkout)

The plugin's behavior was re-derived from the installed host code (never from docs)
during the v0.7.0 audit. The contracts below are the ones the plugin depends on.
If the host changes any of them, the plugin needs a release, not a patch.

| Contract | Where it lives in the host |
| --- | --- |
| `agent/turn-stopping` payload `{ agent, turn, signal }`; a throw from the listener surfaces as `turn/end { kind: 'error' }` — why the boundary must fail open | `@deepseek-ai/dsh-agent-loop/lib/index.js` |
| `tools/post-execute` waterfall `(exec, result, next)`; `additionalContexts` is the mid-turn injection channel | `@deepseek-ai/dsh-tools` (tool registry waterfall) |
| `todo/write` appends a full snapshot; the `todos` projection is cleared at `turn/start` | `@deepseek-ai/dsh-tool-todo/lib/index.js` |
| `compaction/summary` with `compactionId` is the only durable marker of a landed compaction (a failed attempt ends as errored `compaction/end`, no summary) | `@deepseek-ai/dsh-compaction` |
| delegated sessions: `SessionHeader.origin === 'subagent'`, `delegationDepth > 0`, plus the `subagent/descriptor` log event as a fallback | `@deepseek-ai/dsh-session/lib/types/types.d.ts` |
| plugin-sourced `user/message` with `source: { kind: 'plugin', form: 'notice', summary }`; `CONTEXT_SUMMARY_MAX_CHARS = 120` | `@deepseek-ai/dsh-llm/lib/types/message.d.ts` |
| `Session.events` returns a cached deep-frozen snapshot; a previously returned array does not grow later (the basis of the incremental standing-list fold) | `@deepseek-ai/dsh-session/lib/types/index.d.ts` |
| `settings.register` throws on a duplicate namespace; `ctx.settings.get(ns)` reads the live registration (the P4b recovery path) | `@deepseek-ai/dsh-settings/lib/index.js` |
| the client settings scope exposes `status: 'unavailable'` when the namespace is not bound (the read-only UI state) | `@deepseek-ai/dsh-client-runtime` (settings-scope types) |

Empirical floor measured in the same audit: 129 sessions / ~1.9 M events under
`$DSH_HOME/sessions`; one full log walk ≈ 5 ms and the largest session holds
3229 tool results — the reason the standing-list fold is incremental since v0.7.0.
Deliveries are classifiable by `source.summary` wording only for builds that write
notices (this plugin's v0.6.0+ wording); older logs carry shape-only evidence,
which is why `test/verify-live.mjs` classifies by summary with shape as fallback
and anchors each contract check at the horizon where its feature provably exists.

## Removed client registration: `__DSH_SETTINGS_SEARCH__`

v0.6.0's client page registered a settings-search index on
`globalThis.__DSH_SETTINGS_SEARCH__`. The installed host build has no consumer for
that global (verified by grep over the host checkout on 2026-09-09), so v0.7.0
removed the registration together with the unused `connection`/`remote` client
injects. **Restore it only if** the host ships a settings-search consumer that
reads exactly this global shape (`{ sections: Map, register(sectionId, spec) }`);
the original registration block lives in git history (`client.js` at the v0.6.0
tag).

## The UI pays the same tax: the todo panel empties on resume

The turn-local clearing above was derived from what the *model* sees. The GUI's
todo panel pays the same tax, and there the semantics are simply wrong for the
consumer: a panel is not a turn.

The authoritative fold is the host-side projection unit
(`@deepseek-ai/dsh-tool-todo/lib/index.js`, the `todos` session projection):

```js
apply: (state, event) => {
    if (event.type === "todo/write") return event.data.todos;
    if (event.type === "turn/start") return null;   // ← the panel empties here
    return state;
}
```

The browser mirror (`@deepseek-ai/dsh-client-connection/lib/client.js`,
`backscanTodos`) stops at the most recent `turn/start` the same way, and
`projectionFramesOf` re-emits the `todos` key on every `todo/write` **and every
`turn/start`** — so the panel clears at the start of any turn in which the model
has not rewritten the list yet, and stays empty after an app restart until the
model's next `todo_write`. Measured on 2026-09-10 (session `0d23a151`, local
time): the PC was shut down mid-turn at 23:51 the previous evening; the session
resumed at 09:31; the todo-continuation plugin handed the full 19-item plan back
to the *model* at 09:32 (delivery in the log); the *panel* showed nothing until
the model rewrote the list at 10:01 — thirty minutes of "the todo list is gone"
in the UI while the model was actively working from it.

The fix is one semantic decision, not a feature: **the UI projection of `todos`
must be durable (last-write-wins over the whole log), because its consumer is
the user, not the model.** Either drop the `turn/start → null` branch (and the
mirror's stop) for the wire view, or keep the model-facing turn-local state and
add a separate durable key (`standingTodos`) for the panel. The plugin cannot
compensate for this by design: writing the projection would mean writing todos,
which plugins must not do.
