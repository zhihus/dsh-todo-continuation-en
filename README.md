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

## Features

1. **Stop gate (hard)**: while the current turn has unfinished todos, the turn
   cannot stop — every blocked stop attempt injects a continuation message and
   the model keeps working inside the same turn. Since v0.2.0 there are **no
   marker exceptions**: a todo that starts with `[WAITING_USER]`, `[INFO_NEEDED]`
   or any other prefix is still unfinished and still blocks the stop. A stop is
   allowed only when every todo in the turn's snapshot is completed.
2. **Stale-todo prompt** (advisory): when a todo list exists (the model has
   written todos at least once) but goes `staleTodoPromptEveryNTurns`
   (default 20) consecutive turns without an update, it sends the stale-todo
   advisory template with `{n}` replaced by the interval. `0` disables it.

The plugin never creates, removes, completes, or rewrites todos — the model stays
the sole author, and it never pushes the model to start planning: a session
without any `todo_write` gets no advisory at all (the no-todo advisory was
removed in v0.4.0). The advisory is soft (it does not block a stop by itself)
and fires at most once per interval so the model is not nagged every turn.

## Stop-gate invariant

> On every `agent/turn-stopping` event the gate either finds zero unfinished
> todos in the current turn's `todo/write` snapshot, or injects a continuation
> steer — and never contributes to ending a turn with unfinished todos. The
> gate never throws, never acts across a user cancellation (abort bypasses the
> stop boundary by design), and only reads its own session's todos.

When the gate blocks a stop, the model is told to either finish the todos or
call `ask_user_question` — a pending question pauses the turn *inside* the
current step, so it never trips the gate. Runtime-owned subagents cannot ask
the user (`DELEGATED_CALLER`); a blocked subagent must include the unresolved
question in its final result. The user's cancel remains the hard escape hatch:
cancellation never passes through the gate.

## Composition

- `index.js` (host): registers the `todo-continuation` settings namespace, listens
  to `agent/turn-stopping`, and implements the gate plus the stale-todo advisory.
  Zero external dependencies; `schemastery` is imported dynamically in `apply()`
  and any failure degrades to a diagnostic log.
- `client.js` (browser): renders a "Todo Gate" section in the settings page for
  editing the stale-todo interval and prompt template.
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
| `staleTodoPromptEveryNTurns` | 20 | consecutive turns without an update to an existing list before prompting to refresh it; 0 = disabled |
| `staleTodoPromptTemplate` | built-in default | text of the stale-todo advisory; must contain `{n}` |

The two settings-page fields are labeled **"Stale-todo prompt interval"** and
**"Stale-todo prompt text"**.

## Prompt template (placeholder contract)

The stale advisory has one editable template. Its default carries deliberately
defensive instructions ("do not start new work, only refresh statuses") so that
the reminder never pushes the model into inventing new todos.

| Template | Placeholder | Substituted value | Required |
| --- | --- | --- | --- |
| `staleTodoPromptTemplate` | `{n}` | the effective `staleTodoPromptEveryNTurns` interval | yes |

Contract:

- Substitution is literal: every occurrence of `{n}` is replaced with the
  interval (repeated `{n}` are all replaced). No template engine involved.
- **A template without `{n}` cannot be saved.** The settings schema enforces it
  (`Schema.string().pattern(/\{n\}/)`): the settings page pre-validates your
  draft and only writes valid templates; any write through the settings
  infrastructure is validated against the schema before persistence. An
  unknown placeholder such as `{foo}` is allowed and rendered verbatim.
- Write the placeholder exactly as `{n}` — `{ n }` (with spaces) does not match
  and is rejected; `{{n}}` passes schema and renders through plain literal
  substitution with no special handling (e.g. `{{n}}` renders as `{5}`).
- When the interval is `0` (advisory disabled) the template is not used at all.
- The default reproduces the pre-v0.3.0 hardcoded text byte-for-byte; if you
  never edit the template, the sent message is unchanged.
- If a hand-edited `settings.yaml` contains an invalid template, the namespace
  registration fails and the plugin degrades to all built-in defaults (including
  the intervals) with a diagnostic log — fix or remove the line to restore
  overrides.

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
  `waitingTodoPrefixes` in 0.2.0) and can be deleted at will.
- The stale-todo advisory is unchanged — trigger, counter, reset on
  `todo_write`, turn dedup, cooldown, and the default text. Its settings-page
  labels are now **"Stale-todo prompt interval"** / **"Stale-todo prompt
  text"**.

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
