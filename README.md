# dsh-todo-continuation

[简体中文](README.zh.md) | [English](README.md)

A todo-backed turn-stop gate and prompt plugin for DeepSeek Harness (DSH). At the
`agent/turn-stopping` boundary it reads the current turn's latest `todo/write`
snapshot and decides whether the turn may stop, plus two advisory prompts for
"no todo for a while" and "todo not updated for a while". All three thresholds
are editable in the web settings page and take effect on the next turn.

> Part of the [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) collection —
> see that repository for the full index of self-built plugins.

## Features

1. **Stop gate**: when the current turn has unfinished todos that do not start
   with a configured user-wait prefix, it injects a continuation message so the
   model keeps working instead of ending with unfinished items.
2. **No-todo prompt**: after `noTodoPromptEveryNTurns` (default 5) consecutive
   turns with no todo snapshot, it prompts the model to plan with `todo_write`.
3. **Stale-todo prompt**: when a todo list exists but goes
   `staleTodoPromptEveryNTurns` (default 20) consecutive turns without an update,
   it prompts the model to keep the list current.

The plugin never creates, removes, completes, or rewrites todos — the model stays
the sole author. The gate only guards whether a stop is allowed; the two prompts
are advisory (they do not block a stop by themselves) and fire at most once per
interval so the model is not nagged every turn.

## Composition

- `index.js` (host): registers the `todo-continuation` settings namespace, listens
  to `agent/turn-stopping`, and implements the gate plus both prompts. Zero external
  dependencies; `schemastery` is imported dynamically in `apply()` and any failure
  degrades to a diagnostic log.
- `client.js` (browser): renders a "Todo gate" section in the settings page for
  editing the three fields.
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

## Configuration

Editable in the settings page's "Todo gate" section:

| Field | Default | Meaning |
| --- | --- | --- |
| `waitingTodoPrefixes` | `[INFO_NEEDED]`, `[WAITING_USER]` | unfinished items with these prefixes count as "waiting for the user" and allow a stop |
| `noTodoPromptEveryNTurns` | 5 | consecutive turns without a todo before prompting to start one |
| `staleTodoPromptEveryNTurns` | 20 | consecutive turns without an update to an existing list before prompting to refresh it |

## Notes

- The gate message source is `{ kind: 'plugin', plugin: 'todo-continuation' }`,
  so the injected `user/message` is reconstructable from the session log.
- The user's cancel (`agent.cancel`) and terminal turn errors abort before the
  stop boundary and are never overridden — cancellation stays the escape hatch.
- Mounting the plugin through multiple rows (e.g. base bundle plus an agent
  preset) registers several listeners and can enqueue several messages at one
  stop boundary; mount it once per composition.
