/**
 * @doiiarx/dsh-todo-continuation — Todo stop gate + prompt plugin (host level).
 *
 * Two-sided package (same working pattern as @doiiarx/dsh-user-language):
 *   - Host side (this file): registers the `todo-continuation` settings namespace
 *     (`noTodoPromptEveryNTurns` / `staleTodoPromptEveryNTurns` intervals plus
 *     the `noTodoPromptTemplate` / `staleTodoPromptTemplate` advisory texts),
 *     listens for `agent/turn-stopping`, and implements:
 *       1) Stop gate: keeps the turn going while the current turn's latest
 *          todo/write snapshot contains unfinished todos. There are no prefix
 *          exceptions — a stop is allowed only when every todo is completed
 *          (v0.2.0 removed the marker-based waiting protocol).
 *       2) No-todo prompt: after N consecutive turns without any todo snapshot,
 *          sends the no-todo advisory template with `{n}` = N (`0` disables).
 *       3) Stale-todo prompt: when todos exist but go M consecutive turns
 *          without an update, sends the stale-todo advisory template with
 *          `{n}` = M (`0` disables).
 *     All thresholds and templates are read live from settings, so a change in
 *     the settings page takes effect on the next turn. A template must contain
 *     the required `{n}` placeholder (schema-enforced: a template without it is
 *     rejected before it can be persisted); unknown placeholders are rendered
 *     verbatim.
 *   - Browser side (client.js): renders a "Todo Gate" section in the settings
 *     page for editing the two interval fields and the two prompt templates.
 *
 * Failure isolation (same as user-language): this file keeps zero external
 * dependencies; schemastery is imported dynamically in apply() and any failure
 * degrades to a diagnostic log without taking down the whole profile.
 */

export const name = 'todo-continuation-supervisor'
export const inject = ['settings']

const SETTINGS_NS = 'todo-continuation'
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'todo-continuation' }
const DEFAULT_NO_TODO_EVERY = 0
const DEFAULT_STALE_EVERY = 20
// Built-in defaults reproduce the v0.2.0 hardcoded advisory texts byte-for-byte
// (only the interval moved into the `{n}` placeholder).
const DEFAULT_NO_TODO_TEMPLATE = 'No todo list has been created for the last {n} turns. '
  + 'For work that spans multiple steps or continues across turns, use the `todo_write` tool to plan and track it: '
  + 'create actionable todos, update their status as you finish, and complete the list before the work is done. '
  + 'A trivial single-step answer does not need a todo list.'
const DEFAULT_STALE_TEMPLATE = `Automated note: the todo list has not been updated for the last {n} turns.

Don't create or start new work because of this note. Check the current todo list in your context and do exactly one of the following:

1. No list, empty, or all completed: remove it (if present) and continue with the user's request. Do not invent new items.
2. Unfinished items remain: update only statuses that no longer match the real state. Do not add items not requested.

If neither applies, ignore this note and continue with the user's actual request.`

function report(ctx, scope, error) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const message = `[todo-continuation] ${scope} unavailable: ${detail}`
  const logger = ctx.root?.logger?.('todo-continuation')
  if (logger?.error) logger.error('%s', message)
  console.error(message)
}

/** Reads the latest todo snapshot within a turn; returns undefined when no todo/write happened in that turn. */
function currentTurnTodos(session, turn) {
  let insideTurn = false
  let latest
  for (const event of session.events ?? []) {
    if (event.type === 'turn/start') {
      insideTurn = event.data?.turn === turn
      if (insideTurn) latest = undefined
      continue
    }
    if (insideTurn && event.type === 'todo/write') latest = event.data?.todos
  }
  return latest
}

function continuationMessage() {
  return 'You cannot stop this turn while unfinished todos remain. '
    + 'Continue working and complete every unfinished todo, updating the list with `todo_write` as work finishes. '
    + 'If further progress requires user input, call `ask_user_question` instead of ending the turn.'
}

/** Renders the only supported placeholder: `{n}` → the effective interval; unknown placeholders stay verbatim. */
function renderTemplate(template, everyNTurns) {
  return template.split('{n}').join(String(everyNTurns))
}

/** Builds a flagged user message (without depending on @deepseek-ai/dsh-llm). */
function steerMessage(text) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: PLUGIN_SOURCE,
  }
}

/** Reads one interval setting; `0` is a valid "disabled" value, anything invalid falls back. */
function readDisabledableNumber(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

/** Reads one prompt template; it must be a string containing the required `{n}` placeholder, otherwise the built-in default is used. */
function readTemplate(value, fallback) {
  return typeof value === 'string' && value.includes('{n}') ? value : fallback
}

/** Reads and normalizes the config values from settings. */
function readConfig(scope) {
  const value = scope?.get?.() ?? {}
  return {
    noTodoEvery: readDisabledableNumber(value.noTodoPromptEveryNTurns, DEFAULT_NO_TODO_EVERY),
    staleEvery: readDisabledableNumber(value.staleTodoPromptEveryNTurns, DEFAULT_STALE_EVERY),
    noTodoTemplate: readTemplate(value.noTodoPromptTemplate, DEFAULT_NO_TODO_TEMPLATE),
    staleTemplate: readTemplate(value.staleTodoPromptTemplate, DEFAULT_STALE_TEMPLATE),
  }
}

export async function apply(ctx, config = {}) {
  console.log('[todo-continuation] apply() invoked, inject settings =', ctx.get('settings') !== undefined)
  // 1) Register the persistable settings namespace (edited in the settings page).
  //    Templates are schema-validated: a template without the required `{n}`
  //    placeholder is rejected before it can ever be persisted.
  let scope
  try {
    const { default: Schema } = await import('schemastery')
    const base = {
      noTodoPromptEveryNTurns: config.noTodoPromptEveryNTurns ?? DEFAULT_NO_TODO_EVERY,
      staleTodoPromptEveryNTurns: config.staleTodoPromptEveryNTurns ?? DEFAULT_STALE_EVERY,
      noTodoPromptTemplate: config.noTodoPromptTemplate ?? DEFAULT_NO_TODO_TEMPLATE,
      staleTodoPromptTemplate: config.staleTodoPromptTemplate ?? DEFAULT_STALE_TEMPLATE,
    }
    scope = ctx.settings.register(SETTINGS_NS, Schema.object({
      noTodoPromptEveryNTurns: Schema.number().default(base.noTodoPromptEveryNTurns),
      staleTodoPromptEveryNTurns: Schema.number().default(base.staleTodoPromptEveryNTurns),
      noTodoPromptTemplate: Schema.string().default(base.noTodoPromptTemplate).pattern(/\{n\}/),
      staleTodoPromptTemplate: Schema.string().default(base.staleTodoPromptTemplate).pattern(/\{n\}/),
    }), { base })
    console.log('[todo-continuation] settings namespace registered OK, scope =', scope !== undefined)
  } catch (error) {
    report(ctx, 'settings', error)
    scope = null
  }

  // 2) Per-session prompt state (turn dedup + two independent counters + per-counter cooldown).
  const states = new Map()

  ctx.on('session/disposed', (session) => {
    states.delete(session.id)
  }, { global: true })

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    signal.throwIfAborted()
    const cfg = readConfig(scope)
    const todos = currentTurnTodos(agent.session, turn)
    if (todos !== undefined) {
      // Todos written this turn: reset both counters and gate the stop.
      const state = states.get(agent.session.id) ?? emptyState()
      state.noTodoCount = 0
      state.staleCount = 0
      state.lastTodoWriteTurn = turn
      states.set(agent.session.id, state)
      const unfinished = todos.filter(todo => todo.status !== 'completed')
      if (unfinished.length === 0) return
      // Hard gate: no prefix exceptions and no per-turn dedup. Every blocked
      // stop attempt gets a continuation steer, so the turn never ends with
      // open todos while the gate sees them.
      agent.steer(steerMessage(continuationMessage()))
      return
    }
    const state = states.get(agent.session.id) ?? emptyState()
    if (state.lastCountedTurn === turn) return
    state.lastCountedTurn = turn
    if (state.lastTodoWriteTurn === 0) {
      // No list yet: accumulate the "no todo" turn count (0 disables the advisory).
      if (cfg.noTodoEvery > 0) {
        state.noTodoCount += 1
        if (state.noTodoCount >= cfg.noTodoEvery
          && (state.lastNoTodoPromptTurn === 0 || turn - state.lastNoTodoPromptTurn > cfg.noTodoEvery)) {
          agent.steer(steerMessage(renderTemplate(cfg.noTodoTemplate, cfg.noTodoEvery)))
          state.lastNoTodoPromptTurn = turn
          state.noTodoCount = 0
        }
      }
    } else {
      // List exists but nothing written this turn: accumulate the "stale" turn count (0 disables the advisory).
      if (cfg.staleEvery > 0) {
        state.staleCount += 1
        if (state.staleCount >= cfg.staleEvery
          && (state.lastStalePromptTurn === 0 || turn - state.lastStalePromptTurn > cfg.staleEvery)) {
          agent.steer(steerMessage(renderTemplate(cfg.staleTemplate, cfg.staleEvery)))
          state.lastStalePromptTurn = turn
          state.staleCount = 0
        }
      }
    }
    states.set(agent.session.id, state)
  })

  return undefined
}

function emptyState() {
  return {
    noTodoCount: 0,
    staleCount: 0,
    lastTodoWriteTurn: 0,
    lastCountedTurn: 0,
    lastNoTodoPromptTurn: 0,
    lastStalePromptTurn: 0,
  }
}
