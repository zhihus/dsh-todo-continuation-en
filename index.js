/**
 * @doiiarx/dsh-todo-continuation — Todo stop gate + prompt plugin (host level).
 *
 * Two-sided package (same working pattern as @doiiarx/dsh-user-language):
 *   - Host side (this file): registers the `todo-continuation` settings namespace
 *     (`waitingTodoPrefixes` / `noTodoPromptEveryNTurns` /
 *     `staleTodoPromptEveryNTurns`), listens for `agent/turn-stopping`, and
 *     implements:
 *       1) Stop gate: keeps the turn going when it has unfinished, non
 *          "waiting-for-user" todos;
 *       2) No-todo prompt: after N consecutive turns without any todo snapshot,
 *          reminds the model to start using todos;
 *       3) Stale-todo prompt: when todos exist but go M consecutive turns
 *          without an update, reminds the model to keep them current.
 *     All three thresholds are read live from settings, so a change in the
 *     settings page takes effect on the next turn.
 *   - Browser side (client.js): renders a "Todo Gate" section in the settings
 *     page for editing the three fields.
 *
 * Failure isolation (same as user-language): this file keeps zero external
 * dependencies; schemastery is imported dynamically in apply() and any failure
 * degrades to a diagnostic log without taking down the whole profile.
 */

export const name = 'todo-continuation-supervisor'
export const inject = ['settings']

const SETTINGS_NS = 'todo-continuation'
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'todo-continuation' }
const DEFAULT_WAITING_PREFIXES = ['[INFO_NEEDED]', '[WAITING_USER]']
const DEFAULT_NO_TODO_EVERY = 5
const DEFAULT_STALE_EVERY = 20

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

function isWaitingTodo(todo, prefixes) {
  return prefixes.some(prefix => todo.content?.startsWith(prefix))
}

function continuationMessage(prefixes) {
  const markers = prefixes.map(prefix => JSON.stringify(`${prefix}...`)).join(', ')
  return 'The current todo list still contains unfinished work, so this turn cannot stop. '
    + 'Continue executing the remaining actionable todos now; do not only summarize progress or describe future work. '
    + 'Update the complete todo list with `todo_write` as work finishes. '
    + `A stop is allowed only after every todo is completed, or when every remaining unfinished todo starts with one of these user-wait markers: ${markers}. `
    + 'Do not use a waiting todo for work you can complete with the available context and tools.'
}

function noTodoPromptMessage(everyNTurns) {
  return `No todo list has been created for the last ${everyNTurns} turns. `
    + 'For work that spans multiple steps or continues across turns, use the `todo_write` tool to plan and track it: '
    + 'create actionable todos, update their status as you finish, and complete the list before the work is done. '
    + 'A trivial single-step answer does not need a todo list.'
}

function staleTodoPromptMessage(everyNTurns) {
  return `The todo list has not been updated for the last ${everyNTurns} turns. `
    + 'Keep the `todo_write` list current as the work progresses: update statuses, add new actionable todos, '
    + 'and complete finished items. A stale list does not reflect the remaining work.'
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

/** Reads and normalizes the three config values from settings. */
function readConfig(scope) {
  const value = scope?.get?.() ?? {}
  const prefixes = Array.isArray(value.waitingTodoPrefixes) && value.waitingTodoPrefixes.length > 0
    ? value.waitingTodoPrefixes.map(prefix => String(prefix))
    : [...DEFAULT_WAITING_PREFIXES]
  const noTodoEvery = Number.isSafeInteger(value.noTodoPromptEveryNTurns) && value.noTodoPromptEveryNTurns >= 1
    ? value.noTodoPromptEveryNTurns
    : DEFAULT_NO_TODO_EVERY
  const staleEvery = Number.isSafeInteger(value.staleTodoPromptEveryNTurns) && value.staleTodoPromptEveryNTurns >= 1
    ? value.staleTodoPromptEveryNTurns
    : DEFAULT_STALE_EVERY
  return { prefixes, noTodoEvery, staleEvery }
}

export async function apply(ctx, config = {}) {
  console.log('[todo-continuation] apply() invoked, inject settings =', ctx.get('settings') !== undefined)
  // 1) Register the persistable settings namespace (edited in the settings page).
  let scope
  try {
    const { default: Schema } = await import('schemastery')
    const base = {
      waitingTodoPrefixes: config.waitingTodoPrefixes ?? DEFAULT_WAITING_PREFIXES,
      noTodoPromptEveryNTurns: config.noTodoPromptEveryNTurns ?? DEFAULT_NO_TODO_EVERY,
      staleTodoPromptEveryNTurns: config.staleTodoPromptEveryNTurns ?? DEFAULT_STALE_EVERY,
    }
    scope = ctx.settings.register(SETTINGS_NS, Schema.object({
      waitingTodoPrefixes: Schema.array(Schema.string()).default(base.waitingTodoPrefixes),
      noTodoPromptEveryNTurns: Schema.number().default(base.noTodoPromptEveryNTurns),
      staleTodoPromptEveryNTurns: Schema.number().default(base.staleTodoPromptEveryNTurns),
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
      // Todos written this turn: reset both counters and record the latest write turn.
      const state = states.get(agent.session.id) ?? emptyState()
      state.noTodoCount = 0
      state.staleCount = 0
      state.lastTodoWriteTurn = turn
      states.set(agent.session.id, state)
      const unfinished = todos.filter(todo => todo.status !== 'completed')
      if (unfinished.length === 0 || unfinished.every(todo => isWaitingTodo(todo, cfg.prefixes))) return
      agent.steer(steerMessage(continuationMessage(cfg.prefixes)))
      return
    }
    const state = states.get(agent.session.id) ?? emptyState()
    if (state.lastCountedTurn === turn) return
    state.lastCountedTurn = turn
    if (state.lastTodoWriteTurn === 0) {
      // No list yet: accumulate the "no todo" turn count.
      state.noTodoCount += 1
      if (state.noTodoCount >= cfg.noTodoEvery
        && (state.lastNoTodoPromptTurn === 0 || turn - state.lastNoTodoPromptTurn > cfg.noTodoEvery)) {
        agent.steer(steerMessage(noTodoPromptMessage(cfg.noTodoEvery)))
        state.lastNoTodoPromptTurn = turn
        state.noTodoCount = 0
      }
    } else {
      // List exists but nothing written this turn: accumulate the "stale" turn count.
      state.staleCount += 1
      if (state.staleCount >= cfg.staleEvery
        && (state.lastStalePromptTurn === 0 || turn - state.lastStalePromptTurn > cfg.staleEvery)) {
        agent.steer(steerMessage(staleTodoPromptMessage(cfg.staleEvery)))
        state.lastStalePromptTurn = turn
        state.staleCount = 0
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
