# dsh-todo-continuation

[English](README.md) | [Русский](README.ru.md) | [简体中文](README.zh.md)

A todo-backed turn-stop gate and prompt plugin for DeepSeek Harness (DSH). At the
`agent/turn-stopping` boundary it reads the current turn's latest `todo/write`
snapshot and decides whether the turn may stop, plus one advisory prompt for an
existing todo list that goes too long without an update. The model alone decides
when to create a todo list — the plugin never pushes it to plan; once a list
exists, the plugin keeps it alive. The interval and the advisory text are
editable in the web settings page and take effect on the next turn.

> Part of the [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) collection —
> see that repository for the full index of self-built plugins.

## Verify it in two minutes

1. Restart DSH — the running process keeps the old plugin code in memory, so without
   a restart nothing new appears.
2. Open **Settings → Todo Gate** and switch on **Log every decision** (nothing else
   needs touching).
3. In the chat, say: "Make a todo list of three items for task X. Mark only the
   first one completed. Do nothing else."
4. What should happen, and what it means:
   - the model is not allowed to end the turn and receives a message about the
     unfinished items — that is the **stop gate**;
   - when the context is condensed (or the list goes un-updated for several turns),
     the model receives an "Automated note: …" carrying the list itself — that is
     the **reminder**;
   - the host log gains one line per decision,
     `[todo-continuation] … at=stop-boundary …`, with the reason: `prompt:…`,
     `skip:…` or `gate:…`. No line → the plugin is not mounted; a line → it says
     exactly why anything stayed silent.
5. Done experimenting? Set **Stale-todo prompt interval** = 0 and **Stop-gate
   vetoes per turn** = 0 and both go away.

Automatic check over the real session logs (no model, no chat needed):

    node test/verify-live.mjs --since "2026-09-09T11:05:00"

reads your `~/.dsh/sessions`, counts delivered reminders, vetoes and compactions,
and enforces the contract on events after the given moment; `--explain` prints the
decision per turn, `--id <part-of-id>` limits the run to one session.

## Every setting (Settings → Todo Gate)

| Field | Default | What it does |
| --- | --- | --- |
| Stale-todo prompt interval | 5 | remind about a list un-updated for this many turns; 0 = off |
| Stop-gate vetoes per turn | 2 | how often one turn may be sent back over unfinished items; 0 = off; max 10 |
| Gate subagents too | on | veto delegated sessions as well |
| Hand the list back after a compaction | on | return the list right after the context is condensed |
| Post-compaction prompt text | built-in | text of that hand-back |
| Stale-todo prompt text | built-in | reminder text (`{n}` required) |
| Log every decision | off | one host-log line per plugin decision |
| Per-list reminder cap | 0 | after N reminders about one unchanged list, go quiet until it is rewritten; 0 = remind indefinitely |

## Features

1. **Stop gate (bounded)**: while the current turn has unfinished todos, the turn
   cannot stop — a blocked stop attempt injects a continuation message and the
   model keeps working inside the same turn. Since v0.2.0 there are **no
   marker exceptions**: a todo that starts with `[WAITING_USER]`, `[INFO_NEEDED]`
   or any other prefix is still unfinished and still blocks the stop. A stop is
   allowed when every todo in the turn's snapshot is completed — or once the turn
   has spent its `gateMaxSteersPerTurn` vetoes (v0.5.0). The cap is what keeps a
   plan the model cannot finish from spinning the turn: without it, one stop
   boundary can be vetoed hundreds of times inside a single turn.
2. **Stale-todo prompt** (advisory): when the session's **standing** todo list —
   the last `todo/write` in the durable session log — still has unfinished items
   and has not been rewritten for `staleTodoPromptEveryNTurns` (default 5)
   turns, the plugin injects the advisory **with the list rendered into it**, so
   the model can pick the plan back up after a compaction, a resume, or a host
   restart. `{n}` is the actual number of idle turns. `0` disables it.
3. **Post-compaction hand-back** (v0.6.0): when a `compaction/summary` lands in
   the session log after the standing list was last written, the model has just
   lost the copy of the plan it was working from — so the list is re-injected
   immediately instead of waiting out the stale interval. One reminder per
   `compactionId`, and a compaction that failed (no summary was ever written) is
   not a trigger.
4. **Mid-turn delivery** (v0.6.0): the same advisory is attached to the next tool
   result as additional context, so it no longer depends on the turn reaching its
   stop boundary. A turn that dies on a provider error (429), a cancellation, or a
   message typed while it is still open never reaches that boundary — which is why
   a stop-boundary-only reminder stays silent for whole sessions. The mid-turn
   channel only adds context: it never vetoes, and any failure inside it passes the
   settled tool decision through untouched.
5. **Visible notices** (v0.6.0): every injection is declared as a `notice` with a
   one-line summary, so the web client shows it in the transcript as a collapsed
   row ("todo-continuation: …") — the plugin's work is visible to you, not only
   to the model.
6. **Per-list cap is opt-in** (v0.6.0): by default the reminder repeats every
   interval for as long as the list stands unchanged — the original plugin's
   behavior. If it ever gets noisy, set "Per-list reminder cap": after N reminders
   about one and the same list the plugin goes quiet until the list is rewritten or
   a new compaction lands (the transition is announced once in the host log, at
   `info`, not `debug`).

Staleness is measured from the session log at check time, never from what the
plugin happened to observe in this process: a session reopened after a restart is
judged exactly like one that stayed up. (Before v0.5.0 the "does a list exist"
answer came from an in-memory counter that reset on every restart, so the
reminder was disabled in most real sessions.) Only the reminder rate limit and
the per-turn veto count stay in memory, and losing them costs at most one extra
reminder.
The plugin never creates, removes, completes, or rewrites todos — the model stays
the sole author, and it never pushes the model to start planning: a session
without any `todo_write` gets no advisory at all (the no-todo advisory was
removed in v0.4.0), and neither does a standing list whose items are all
completed — there is nothing left to restore. The advisory is soft (it never
blocks a stop by itself) and fires at most once per interval, so the model is not
nagged every turn.

## Stop-gate invariant

> On every `agent/turn-stopping` event the gate either finds zero unfinished
> todos in the current turn's `todo/write` snapshot, or injects a continuation
> steer — until the turn's veto budget (`gateMaxSteersPerTurn`, 0 = the gate
> never vetoes) is spent, after which the stop is allowed and hitting the cap is
> logged. The
> gate never throws, never acts across a user cancellation (abort bypasses the
> stop boundary by design), and only reads its own session's todos.

When the gate blocks a stop, the model is told to either finish the todos or
call `ask_user_question` — a pending question pauses the turn *inside* the
current step, so it never trips the gate. Runtime-owned subagents cannot ask
the user (`DELEGATED_CALLER`); a blocked subagent must include the unresolved
question in its final result. The user's cancel remains the hard escape hatch:
cancellation never passes through the gate.

## Composition

- `index.js` (host): registers the `todo-continuation` settings namespace and
  implements the bounded stop gate plus the standing-list advisory, derived from the
  session log, delivered at `agent/turn-stopping` **and** mid-turn via
  `tools/post-execute` additional contexts. Zero external dependencies;
  `schemastery` is imported dynamically in `apply()` and any failure degrades to
  built-in defaults — announced loudly, because a silently degraded interval is
  indistinguishable from a plugin that does nothing.
- `client.js` (browser): renders the "Todo Gate" section in the settings page for
  the interval, the veto cap, the post-compaction switch and its text, the stale
  advisory text, and the decision-log switch — plus the always-visible status chip
  in the conversation input row (see "The status chip").
- `cordis.patch.yml`: declares the `dsh-todo-continuation` plugin row.
- `package.json`: the `@doiiarx/dsh-todo-continuation` manifest with the
  `dsh.client` injection and the `schemastery` dependency.

## Installation

Install dependencies in the plugin directory (the host side `import('schemastery')`
in `index.js`):

```sh
cd <this-plugin-directory>
pnpm install
```

### 1. Mount into the web profile

In `$HOME/.dsh/profiles/web/package.json`:

```json
{
  "dependencies": {
    "@doiiarx/dsh-todo-continuation": "github:zhihus/dsh-todo-continuation-en"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@doiiarx/dsh-todo-continuation"
      ]
    }
  }
}
```

Then run `pnpm install` in that profile directory.

> **A `git push` does not update the running host.** The profile installs from a
> GitHub ref and `pnpm-lock.yaml` pins one exact commit, so after tagging a release
> the profile has to be refreshed to that tag. Until it is, the host keeps serving
> the previously pinned build — silently, with no error anywhere, because nothing is
> actually *broken*, just old. Refresh:
>
> ```sh
> pnpm --dir "$HOME/.dsh/profiles/web" add \
>   "@doiiarx/dsh-todo-continuation@github:zhihus/dsh-todo-continuation-en#vX.Y.Z"
> ```
>
> Then restart the web process. Two different things are measured here, and conflating
> them wastes hours:
>
> - **The content of an already-mounted client file is re-read per page load.** After the
>   profile was refreshed under a running host, the served `rev` changed and the browser
>   got the new bytes with no restart, while the process kept running.
> - **Which bundles exist is resolved at startup.** Installing a plugin, removing it, or
>   moving it to another tag changes the bundle list and therefore the client module
>   graph: nothing shows until the host restarts, and a reload alone then shows nothing
>   at all, because the plugin is not in the manifest the page is handed.
>
> `index.js` is imported into memory at startup too, so server-side changes need the same
> restart. Two ways to see the truth rather than assume it:
>
> - the version the host will load: `$HOME/.dsh/profiles/web/node_modules/@doiiarx/dsh-todo-continuation/package.json`
>   (compare its `client.js` against the working copy; a CRLF/LF difference alone is
>   not a content difference — normalize line endings before hashing);
> - `node test/verify-live.mjs`, whose whole point is separating «the logic said no»
>   from «the logic would have said yes, but the running host predates this build».
>
> For a development loop, prefer a local link in the profile instead of the GitHub
> ref — `"@doiiarx/dsh-todo-continuation": "link:C:/path/to/TodoContinuation"` — then
> working-copy edits reach the browser on a page reload and the server on a restart,
> without a push per iteration.

### 2. Expose the namespace to the browser settings page

The browser settings page can only read the `todo-continuation` namespace if it is
listed in the host apiproxy settings allowlist `WEB_SETTINGS_NAMESPACES`
(`packages/host/apiproxy/src/api-proxy.ts`); otherwise the settings page keeps
showing "Loading configuration…" (the namespace is not exposed to the client).

```ts
const WEB_SETTINGS_NAMESPACES = [
  'agent-loop', 'shell', 'locale', 'permission', 'ui-conversation', 'ui-theme', 'web-search-deepseek',
  // ...local-plugin namespaces...
  'todo-continuation',
] as const
```

Then rebuild the apiproxy (`pnpm run build:lib:host`) and restart the web process.

> **Note**: in the installed DSH v0.1.1-rc.2 (npm) the compiled apiproxy has no
> hardcoded allowlist — it dynamically exposes all registered namespaces via
> `settings.describe()`. Step 2 may not be needed.

## Configuration

Editable in the settings page's "Todo Gate" section:

| Field | Default | Meaning |
| --- | --- | --- |
| `staleTodoPromptEveryNTurns` | 5 | turns the standing todo list may go without a rewrite before the model is handed the list back; 0 = disabled. A list idle for more than 20 × the interval is abandoned work: the stale reminder stops on its own (`skip:too-old`), while a compaction still hands the list back |
| `gateMaxSteersPerTurn` | 2 | how many times one turn may be sent back for unfinished todos before the stop is allowed; 0 = the gate never vetoes; clamped to 10 |
| `gateSubagents` | true | whether a delegated (subagent) session is vetoed the same way; with `false` a child is never sent back, but still receives the list as context |
| `maxPromptsPerList` | 0 (no cap) | after this many advisories for one unchanged list the plugin goes quiet about it until the list is rewritten or a fresh compaction lands; the entry is logged once at `info` |
| `promptAfterCompaction` | true | hand the standing list back as soon as a compaction has landed, without waiting for the interval |
| `compactionPromptTemplate` | built-in default | text of the post-compaction hand-back; no placeholder is required |
| `staleTodoPromptTemplate` | built-in default | text of the stale-todo advisory; must contain `{n}` |
| `logDecisions` | false | log one line per boundary and per tool result saying what the plugin did, or why it stayed silent |

The eight settings-page fields are labeled **"Stale-todo prompt interval"**,
**"Stop-gate vetoes per turn"**, **"Gate subagents too"**, **"Hand the list back after
a compaction"**, **"Post-compaction prompt text"**, **"Stale-todo prompt text"**,
**"Per-list reminder cap"** and **"Log every decision"**

Every threshold is read live from the settings document, so saving a value in the
settings page changes the next boundary without a restart — except
`logDecisions`, which takes effect from the next decision anyway, and the veto
cap, which is also clamped to 10 at read time. One threshold stays a constant on
purpose: the abandoned-work horizon. A list the model has ignored for more than
20 × `staleTodoPromptEveryNTurns` consecutive turns is no longer re-injected by
the interval (`skip:too-old idle N` in the decision log) — past that point the
reminder is background noise the model has learned to skip, and only a compaction
(a genuine "you lost the plan" event) or a rewrite reopens it.

## What the decision log says

With `logDecisions` on, each boundary and each tool result produces one line:

```
[todo-continuation] session "…" turn 12 at=stop-boundary skip:idle 2<5
[todo-continuation] session "…" turn 12 at=mid-tool-result prompt:compaction id=9458… idle=1
[todo-continuation] session "…" turn 12 at=stop-boundary gate:block unfinished=1/3 vetoes=1/2
[todo-continuation] session "…" turn 12 at=stop-boundary gate:cap-reached unfinished=1 vetoes=2/2 allow-stop
```

Reasons you will see: `prompt:compaction`, `prompt:stale`, `gate:block`,
`gate:cap-reached`, `gate:off`, `gate:allow`, `gate:skipped subagent` and the skips
`no-list`, `no-unfinished`, `interval-off`, `no-write-turn`, `idle N<cfg`,
`cooldown N<cfg`, `too-old idle N` (the horizon above), `quiet` (the per-list cap
above). This is the
difference between "the plugin is dead" and "nothing was due", which otherwise
takes a compressed session log to answer.

## The status chip

The host's todo panel follows the turn-local `todos` projection and empties at
every `turn/start` (and stays empty after an app restart until the model's next
`todo_write` — see `UPSTREAM.md` for why that is a host-side gap). The plugin
ships its own always-visible answer: a **"Todo Gate" chip** in the conversation
input row, next to the composer.

The chip shows, for the active session:

- the standing list counts — `2/3 unfinished`, or `3/3 done` when everything is
  completed;
- the idle span in turns (`idle 1t`) — how many turn boundaries passed since the
  list was last rewritten;
- the last thing the plugin did — `reminded 10:38`, `restored after compaction
  11:03`, `restored after resume 09:32`, or `gate sent the turn back 10:37`.

"Restored" is the visible proof of the recovery loop: a compaction hand-back by
its summary wording, or a reminder that landed in a turn opened after a long
silence (a shutdown/resume gap of 3+ minutes). The chip derives everything from
the durable session log tail via the public `session.history` wire — a durable
backscan that deliberately ignores `turn/start`, unlike the panel. It is
read-only and fails open: any fetch or parse problem simply hides the chip, it
never blocks the conversation. Point fixes to the panel itself live in
`UPSTREAM.md`.

## Prompt templates and placeholders

The stale advisory has one editable template. Its default tells the model to take
one concrete step on the oldest unfinished item, or to rewrite/clear a list that
no longer matches the work — and it carries the list itself, because DSH clears
the standing plan at every `turn/start` and a compacted context may hold no copy
of it.

| Template | Placeholder | Substituted value | Required |
| --- | --- | --- | --- |
| `staleTodoPromptTemplate` | `{n}` | the ACTUAL number of turns the standing list went without an update | yes |
| `staleTodoPromptTemplate` | `{todos}` | the standing list, one `- [status] content` line per item (max 30 items, 200 chars each) | no |
| `staleTodoPromptTemplate` | `{total}` | number of items in the standing list | no |
| `staleTodoPromptTemplate` | `{unfinished}` | number of items that are not `completed` | no |

Contract:

- Substitution is literal: every occurrence of a placeholder is replaced with its
  value (repeated placeholders are all replaced). No template engine involved.
- **A template without `{n}` cannot be saved.** The settings schema enforces it
  (`Schema.string().pattern(/\{n\}/)`): the settings page pre-validates your
  draft and only writes valid templates; any write through the settings
  infrastructure is validated against the schema before persistence. An
  unknown placeholder such as `{foo}` is allowed and rendered verbatim.
- Write a placeholder exactly as `{name}` — `{ n }` (with spaces) does not match
  the pattern and is rejected; `{{n}}` passes the schema and renders through
  plain literal substitution with no special handling (e.g. with `{n}` = 5 it
  renders as `{5}`).
- When the interval is `0` (advisory disabled) the template is not used at all.
- The default text changed in v0.5.0, so a config that never overrode the
  template now sends the new wording with the list included.
- If a `settings.yaml` section contains an invalid template, schemastery rejects
  it at registration, the namespace is never created, and the plugin runs on
  every built-in default — announcing `DEGRADED` in the host log. Until the line
  is fixed or removed, the "Todo Gate" settings page has nothing to edit.

### Upgrade notes (0.1.0 → 0.2.0)

- The marker-based waiting protocol (`waitingTodoPrefixes`, `[INFO_NEEDED]`,
  `[WAITING_USER]`) was **removed**. The field is gone from the schema and the
  UI; a stale value kept in a user settings file is simply ignored at runtime
  (unknown keys pass through schemastery resolution) and can be deleted at will.
- The no-todo advisory default changed from 5 to **0 (disabled)**. If your user
  settings file pins `noTodoPromptEveryNTurns`, the user layer overrides the new
  default — set it to `0` (or remove the line) to adopt the new behavior.
- The stop gate no longer honors waiting prefixes: with unfinished todos present,
  the only model-side way out is finishing them or asking via
  `ask_user_question`.

### Upgrade notes (0.2.0 → 0.3.0)

- Advisory prompt texts became editable settings (`noTodoPromptTemplate`,
  `staleTodoPromptTemplate`). **Nothing to migrate**: configs without the new
  keys get the defaults, which reproduce the v0.2.0 texts exactly.

### Upgrade notes (0.3.0 → 0.3.1)

- Settings-page labels renamed to trigger-condition wording: "No-todo prompt
  interval/template" → "If there is no todo list: interval (turns) / prompt
  text"; "Stale-todo prompt interval/template" → "If the todo list is not
  updated: interval (turns) / prompt text". **UI-only change**: configuration
  keys, defaults, and the schema are unchanged — nothing to migrate.

### Upgrade notes (0.3.1 → 0.4.0)

- The **no-todo advisory was removed** together with its settings
  (`noTodoPromptEveryNTurns`, `noTodoPromptTemplate`) and UI fields. The plugin
  no longer pushes the model to create a todo list: a session without any
  `todo_write` gets no advisory at all. **Nothing to migrate**: stale keys left
  in a user settings file are simply ignored at runtime (same as the removed
  `waitingTodoPrefixes` in 0.2.0) and can be deleted at will — since 0.6.0 they
  are also named once in the host log at mount.
- The stale-todo advisory is unchanged — trigger, counter, reset on
  `todo_write`, turn dedup, cooldown, and the default text. Its settings-page
  labels are now **"Stale-todo prompt interval"** / **"Stale-todo prompt
  text"**.

### Upgrade notes (0.4.0 → 0.5.0)

- **The stale-todo reminder became restart-safe.** "Does this session have a
  standing list, and how long has it been idle?" is answered from the session's
  `turn/start` / `todo/write` history instead of an in-memory counter, so a
  resumed session or a host restart no longer resets the plugin to "never planned
  here" — the reason the reminder almost never fired in practice.
- **The advisory now carries the list** through the new `{todos}` / `{total}` /
  `{unfinished}` placeholders, and `{n}` renders the real idle span instead of
  the configured interval. A custom template you saved keeps working unchanged —
  it just does not show the list; clear the field to get the new default text.
- **A completed list is never nagged.** The advisory requires at least one item
  that is not `completed`; clearing the list (an empty `todo_write`) also ends it.
- **The stop gate is bounded** by the new `gateMaxSteersPerTurn` (default 2,
  0 = gate off). Raise it if you want the old unbounded veto loop back; the logs
  of real sessions show where that leads (~150 vetoes in one turn, over an hour
  of tokens).
- `DEFAULT_STALE_EVERY` dropped from 20 to 5, and a failed settings registration is
  reported loudly instead of silently degrading to defaults.
- Nothing to migrate: a leftover `noTodoPromptEveryNTurns` in your settings file
  is ignored (delete it whenever you like).

### Upgrade notes (0.5.0 → 0.6.0)

- **Two new triggers for the standing list.** A landed compaction hands the list
  back at once (`promptAfterCompaction`, on by default, own editable text), and
  the advisory is now also delivered mid-turn as additional context on a tool
  result, so it no longer requires the turn to reach a stop boundary.
- **`logDecisions`** (off by default) prints one reason per boundary and per tool
  result — see "What the decision log says". Turn it on before reporting silence.
- **`gateMaxSteersPerTurn` is clamped to 10**, and settings keys removed in
  earlier versions (`noTodoPromptEveryNTurns`, `noTodoPromptTemplate`,
  `waitingTodoPrefixes`) are now named in the log once instead of being silently
  ignored.
- **A template that omits `{todos}` gets the list appended**, so an edited
  reminder cannot lose the plan.
- **Two unanswered advisories about the same list can be the last two** (adaptive
  backoff via `maxPromptsPerList`, shipped here undocumented with the default `0`
  = off — see the 0.7.0 notes). The entry into quiet mode is logged once at `info`.
- **`gateSubagents`** (default `true`) chooses whether delegated sessions are vetoed
  too. Delegation is read from the durable session header (`origin`,
  `delegationDepth`) with the `subagent/descriptor` log event as fallback; an
  unrecognized shape is treated as a top-level session, so a missing field cannot
  disarm the gate.
- **`UPSTREAM.md`** is the proposal to DSH core, submitted as a complete set: a durable
  standing-plan projection that survives `turn/start`, a compaction-landed restore of that plan,
  and a bounded fail-open stop-gate over it. Every part is already proven by this plugin against
  real logs, so the document proposes absorbing the whole, after which both marketplace todo
  plugins retire.
- **Dev workflow**: `npm run verify` = parse-check both sides + the full suite. The
  plugin can be mounted as `link:<path>` in the profile's `cordis.patch.yml` instead of
  copying files into `node_modules`, which removes the "did I sync?" question entirely.
- Nothing to migrate: existing configs keep working and gain the new defaults.

### Upgrade notes (0.6.0 → 0.7.0)

- **`maxPromptsPerList` is documented, and the reminder is no longer unbounded.**
  The per-list cap shipped in 0.6.0 but was missing from every README and defaulted
  to `0` (never go quiet — remind on every interval forever). It is now in the
  settings table. **The abandoned-work horizon** bounds the default behavior
  without taking the knob away: a list the model has ignored for more than
  20 × `staleTodoPromptEveryNTurns` consecutive turns stops being reminded by the
  stale channel (`skip:too-old idle N`); the compaction hand-back is deliberately
  exempt. The horizon is a constant, not a setting.
- **A duplicate settings registration no longer degrades.** If another mount of
  the plugin already owns the namespace (a hot reload, a double bundle entry), the
  second mount reads the live registration via `settings.get(ns)` instead of
  falling back to built-in defaults.
- **The stop boundary fails open.** A plugin bug at the stop boundary is now
  contained like a mid-turn one: it is reported to the host log and the turn ends
  ungated, instead of surfacing as a `turn/end` error and costing the user's turn.
  A malformed `todo/write` record in a replayed log is ignored instead of crashing
  the read.
- **Template substitution is single-pass**: a `{placeholder}` inside
  model-authored todo content is never rewritten by a later key's pass, and the
  list is no longer duplicated when a custom template embeds `{todos}` before the
  other placeholders.
- **Schema dep moved to the host's fork** (`@deepseek-ai/schemastery`), so the
  settings schema is resolved by the exact code the host runs — no more two
  divergent copies of schemastery in one profile.
- **`engines: node >=22.3`** declared (the live-log audit uses
  `zlib.zstdDecompressSync`); `crypto.randomUUID` is imported from `node:crypto`
  instead of assumed.
- **Client page**: the veto input is bounded to the host clamp (10) and the stored
  value is clamped for display; an unavailable namespace shows an explicit
  read-only state instead of an eternal "Loading configuration…"; the dead
  `__DSH_SETTINGS_SEARCH__` registration (no consumer in the host build) and the
  unused `connection`/`remote` injects are gone.
- **Faster on long sessions**: the standing-list fold over the session log is
  incremental (only new events are scanned per check) instead of a full O(log)
  walk on every tool result.
- **CI + types**: `pnpm run types` (tsc checkJs over both sides and the tests) and
  a GitHub Actions workflow running `verify` + `types` + the audit self-test on
  Node 22.
- **The live audit (`npm run verify:live`) enforces its contract checks by
  default** — advisory carries list (A), per-list cap (B), veto cap (C),
  post-compaction hand-back (D) — with each check starting at the horizon where
  its feature provably exists (delivery wording for B/C/D), classifying deliveries
  by the one-line `source.summary` with message shape as fallback, and a
  `--selftest` mode that needs no live logs.
- Nothing to migrate: existing configs keep working; set `maxPromptsPerList: 2`
  if you want the strictest backoff the schema has always supported.

### Upgrade notes (0.7.0 → 0.7.1)

- **No code change: the upstream proposal was resubmitted as a complete set.**
  `UPSTREAM.md` used to propose one host-side gap (the `turn/start` clearing); it now proposes
  all three primitives the plugin already implements and proves on live logs — the durable
  standing-plan projection, the compaction-landed restore, and the bounded fail-open stop-gate —
  together with the explicit retirement path: both marketplace todo plugins, including the
  `dsh-todo-gate` this project was forked from, are obsolete the day core absorbs them.

## Release policy

Starting with the **next** release, every release is tagged:

1. Bump `version` in `package.json` (semver: UI/docs-only changes → patch, new
   settings or behavior changes → minor).
2. Commit with a `release:`-prefixed message summarizing the change.
3. Put an annotated tag on the release commit and push it explicitly:
   `git tag -a vX.Y.Z -m "vX.Y.Z: summary"`, then `git push en vX.Y.Z` —
   `git push` alone never transfers tags.
4. The tag pins the release to an installable ref
   (`github:zhihus/dsh-todo-continuation-en#vX.Y.Z`) and lists it on the
   GitHub Releases page.

Releases up to and including v0.3.1 are versioned only in `package.json` and
carry no tags.

## Notes

- The gate message source is `{ kind: 'plugin', plugin: 'todo-continuation' }`,
  so the injected `user/message` is reconstructable from the session log.
- The user's cancel (`agent.cancel`) and terminal turn errors abort before the
  stop boundary and are never overridden — cancellation stays the escape hatch.
- Plan mode can legitimately end a turn with open todos; `exit_plan_mode` blocks
  inside the tool call (waiting for the user), so plan review never trips the
  gate. The gate only sees the executing agent's own session — subagent todo
  lists are invisible to it.
- Mounting the plugin through multiple rows (e.g. base bundle plus an agent
  preset) registers several listeners and can enqueue several messages at one
  stop boundary; mount it once per composition.
