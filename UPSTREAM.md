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
