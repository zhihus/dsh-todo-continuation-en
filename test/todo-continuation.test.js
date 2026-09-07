/**
 * Black-box tests for @doiiarx/dsh-todo-continuation.
 *
 * They exercise the public `apply()` export against a fake Cordis-like context,
 * so no internal functions are exported just for testing. The fake settings
 * registration mirrors the real dsh-settings host behavior: the stored user
 * section is merged over the composition base and resolved through the schema
 * the plugin registers — an invalid section throws at registration time and
 * the plugin degrades to its built-in defaults. When the settings namespace is
 * unavailable entirely, the same degradation path applies (same failure
 * isolation as production without `schemastery`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'

const signal = { throwIfAborted() {} }

/** The exact legacy stale-todo advisory text (v0.2.0 builder output). */
function legacyStaleText(n) {
  return `Automated note: the todo list has not been updated for the last ${n} turns.

Don't create or start new work because of this note. Check the current todo list in your context and do exactly one of the following:

1. No list, empty, or all completed: remove it (if present) and continue with the user's request. Do not invent new items.
2. Unfinished items remain: update only statuses that no longer match the real state. Do not add items not requested.

If neither applies, ignore this note and continue with the user's actual request.`
}

/**
 * Builds a fake context. Without `scopeValue` the settings namespace
 * registration throws, so the plugin falls back to its built-in defaults.
 * With `scopeValue`, registration resolves the merged section through the
 * plugin's schema exactly like dsh-settings does; a schema rejection throws
 * out of `register` (the plugin then degrades to defaults).
 */
function makeCtx({ scopeValue } = {}) {
  const handlers = {}
  const ctx = {
    get: () => ({}),
    settings: scopeValue !== undefined
      ? {
          register(ns, schema, options = {}) {
            const merged = { ...(options.base ?? {}), ...scopeValue }
            const resolved = schema(merged)
            return { get: () => resolved }
          },
        }
      : { register() { throw new Error('schemastery unavailable (test)') } },
    root: undefined,
    on: (event, handler) => {
      handlers[event] = handler
    },
  }
  return { ctx, handlers }
}

/** A fake agent whose session log is one turn with an optional todo/write. */
function makeAgent(turn, todos) {
  const events = [{ type: 'turn/start', data: { turn } }]
  if (todos !== undefined) {
    events.push({ type: 'todo/write', data: { todos } })
  }
  return {
    session: { id: 'session-1', events },
    steered: [],
    steer(message) {
      this.steered.push(message)
    },
  }
}

async function setup({ scopeValue } = {}) {
  const { ctx, handlers } = makeCtx({ scopeValue })
  await apply(ctx)
  const gate = (agent, turn) => handlers['agent/turn-stopping']({ agent, turn, signal })
  return { gate, handlers }
}

/**
 * Runs the gate for turns `from..to`; the first turn carries `todos` (stale
 * pattern: an existing list, then turns without updates). Returns the last
 * agent so assertions can inspect its steers.
 */
function runTurns(gate, from, to, todos) {
  let agent
  for (let turn = from; turn <= to; turn++) {
    agent = makeAgent(turn, turn === from ? todos : undefined)
    gate(agent, turn)
  }
  return agent
}

const COMPLETED = [{ content: 'Tracked task', status: 'completed' }]

test('registers turn-stopping and session-disposed listeners', async () => {
  const { handlers } = await setup()
  assert.equal(typeof handlers['agent/turn-stopping'], 'function')
  assert.equal(typeof handlers['session/disposed'], 'function')
})

test('blocks stop when a todo is unfinished', async () => {
  const { gate } = await setup()
  const agent = makeAgent(1, [{ content: 'Implement the feature', status: 'pending' }])
  gate(agent, 1)
  assert.equal(agent.steered.length, 1)
  const text = agent.steered[0].content[0].text
  assert.match(text, /cannot stop/)
  assert.match(text, /todo_write/)
  assert.match(text, /ask_user_question/)
})

test('continuation message carries no waiting markers', async () => {
  const { gate } = await setup()
  const agent = makeAgent(1, [{ content: 'Implement the feature', status: 'pending' }])
  gate(agent, 1)
  const text = agent.steered[0].content[0].text
  assert.doesNotMatch(text, /INFO_NEEDED|WAITING_USER/)
})

test('blocks stop even when a todo starts with the legacy [WAITING_USER] marker', async () => {
  const { gate } = await setup()
  const agent = makeAgent(1, [{ content: '[WAITING_USER] confirm the plan', status: 'pending' }])
  gate(agent, 1)
  assert.equal(agent.steered.length, 1)
})

test('blocks stop even when a todo starts with the legacy [INFO_NEEDED] marker', async () => {
  const { gate } = await setup()
  const agent = makeAgent(1, [{ content: '[INFO_NEEDED] get details', status: 'pending' }])
  gate(agent, 1)
  assert.equal(agent.steered.length, 1)
})

test('allows stop when all todos are completed', async () => {
  const { gate } = await setup()
  const agent = makeAgent(1, [{ content: 'Finished task', status: 'completed' }])
  gate(agent, 1)
  assert.equal(agent.steered.length, 0)
})

test('ignores the legacy waitingTodoPrefixes setting and still blocks', async () => {
  const { gate } = await setup({ scopeValue: { waitingTodoPrefixes: ['[NEED_USER]'] } })
  const agent = makeAgent(1, [{ content: '[NEED_USER] waiting for input', status: 'pending' }])
  gate(agent, 1)
  assert.equal(agent.steered.length, 1)
})

test('steers on every repeated stop event in the same turn (no dedup)', async () => {
  const { gate } = await setup()
  const todos = [{ content: 'Implement the feature', status: 'pending' }]
  const agent = makeAgent(1, todos)
  gate(agent, 1)
  gate(agent, 1)
  assert.equal(agent.steered.length, 2)
})

test('allows stop after the todo list is completed in the same turn', async () => {
  const { gate } = await setup()
  const agent = makeAgent(1, [{ content: 'Implement the feature', status: 'pending' }])
  gate(agent, 1)
  agent.session.events.push({
    type: 'todo/write',
    data: { todos: [{ content: 'Implement the feature', status: 'completed' }] },
  })
  gate(agent, 1)
  assert.equal(agent.steered.length, 1)
})

test('stale advisory fires after N turns without an update (default 20)', async () => {
  const { gate } = await setup()
  let agent = makeAgent(1, [{ content: 'Tracked task', status: 'completed' }])
  gate(agent, 1)
  for (let turn = 2; turn <= 21; turn++) {
    agent = makeAgent(turn)
    gate(agent, turn)
  }
  assert.equal(agent.steered.length, 1)
  assert.match(agent.steered[0].content[0].text, /has not been updated/)
})

test('staleTodoPromptEveryNTurns = 0 disables the stale advisory', async () => {
  const { gate } = await setup({ scopeValue: { staleTodoPromptEveryNTurns: 0 } })
  let agent = makeAgent(1, [{ content: 'Tracked task', status: 'completed' }])
  gate(agent, 1)
  for (let turn = 2; turn <= 25; turn++) {
    agent = makeAgent(turn)
    gate(agent, turn)
  }
  assert.equal(agent.steered.length, 0)
})

// --- v0.3.0: editable advisory templates (PLAN-v0.3.0-advisory-templates.md §7); v0.4.0 removed the no-todo advisory ---

test('T2: default stale template reproduces the legacy text exactly', async () => {
  const { gate } = await setup({ scopeValue: {} })
  const agent = runTurns(gate, 1, 21, COMPLETED)
  assert.equal(agent.steered.length, 1)
  assert.equal(agent.steered[0].content[0].text, legacyStaleText(20))
})

test('T4: custom stale template is used with {n} substituted', async () => {
  const { gate } = await setup({
    scopeValue: { staleTodoPromptEveryNTurns: 4, staleTodoPromptTemplate: 'Stale for {n} turns - refresh statuses' },
  })
  const agent = runTurns(gate, 1, 5, COMPLETED)
  assert.equal(agent.steered.length, 1)
  assert.equal(agent.steered[0].content[0].text, 'Stale for 4 turns - refresh statuses')
})

test('T5: {n} receives the effective interval (stale override 7)', async () => {
  const { gate } = await setup({
    scopeValue: { staleTodoPromptEveryNTurns: 7, staleTodoPromptTemplate: 'Stale {n}' },
  })
  const agent = runTurns(gate, 1, 8, COMPLETED)
  assert.equal(agent.steered.length, 1)
  assert.equal(agent.steered[0].content[0].text, 'Stale 7')
})

test('T7: an unknown placeholder stays verbatim and the message is still sent', async () => {
  const { gate } = await setup({
    scopeValue: { staleTodoPromptEveryNTurns: 2, staleTodoPromptTemplate: 'No {foo} here {n}' },
  })
  const agent = runTurns(gate, 1, 3, COMPLETED)
  assert.equal(agent.steered.length, 1)
  assert.equal(agent.steered[0].content[0].text, 'No {foo} here 2')
})

test('T8: a stored template without {n} fails schema at registration and degrades to defaults', async () => {
  // If the schema did not reject the section, the 5-turn override would fire
  // repeatedly; degradation must instead yield one default-text steer at turn 21.
  const { gate } = await setup({
    scopeValue: { staleTodoPromptEveryNTurns: 5, staleTodoPromptTemplate: 'missing placeholder' },
  })
  const agent = runTurns(gate, 1, 21, COMPLETED)
  assert.equal(agent.steered.length, 1)
  assert.equal(agent.steered[0].content[0].text, legacyStaleText(20))
})

test('T9: an old config without template keys gets the stale default text', async () => {
  const { gate } = await setup({ scopeValue: { staleTodoPromptEveryNTurns: 15 } })
  const agent = runTurns(gate, 1, 16, COMPLETED)
  assert.equal(agent.steered.length, 1)
  assert.equal(agent.steered[0].content[0].text, legacyStaleText(15))
})

test('T11: staleTodoPromptEveryNTurns = 0 disables the advisory even with a custom template', async () => {
  const { gate } = await setup({
    scopeValue: { staleTodoPromptEveryNTurns: 0, staleTodoPromptTemplate: 'Custom stale {n}' },
  })
  const agent = runTurns(gate, 1, 25, COMPLETED)
  assert.equal(agent.steered.length, 0)
})

// --- v0.4.0: the model decides whether to plan; the plugin only tracks an existing list ---

test('stale advisory never fires when the model has never written todos', async () => {
  const { gate } = await setup({ scopeValue: { staleTodoPromptEveryNTurns: 2 } })
  const agent = runTurns(gate, 1, 25)
  assert.equal(agent.steered.length, 0)
})

test('first todo/write starts stale tracking without an immediate advisory', async () => {
  const { gate } = await setup({ scopeValue: { staleTodoPromptEveryNTurns: 2 } })
  const first = makeAgent(1, COMPLETED)
  gate(first, 1)
  assert.equal(first.steered.length, 0)
  const second = makeAgent(2)
  gate(second, 2)
  assert.equal(second.steered.length, 0)
})

test('stale advisory resets after a new todo/write and fires again after the interval', async () => {
  const { gate } = await setup({
    scopeValue: { staleTodoPromptEveryNTurns: 2, staleTodoPromptTemplate: 'Refresh {n}' },
  })
  const steered = []
  const run = (turn, todos) => {
    const agent = makeAgent(turn, todos)
    gate(agent, turn)
    steered.push(...agent.steered)
  }
  run(1, COMPLETED) // first todo/write: tracking starts, no advisory
  run(2) // no update: stale count 1
  run(3) // stale count 2 -> fires with the user template
  assert.equal(steered.length, 1)
  assert.equal(steered[0].content[0].text, 'Refresh 2')
  run(4, COMPLETED) // new update: resets the counter
  run(5) // stale count 1, below the interval
  assert.equal(steered.length, 1)
  run(6) // stale count 2 and past the cooldown -> fires again
  assert.equal(steered.length, 2)
  assert.equal(steered[1].content[0].text, 'Refresh 2')
})
