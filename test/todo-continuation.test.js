/**
 * Black-box tests for @doiiarx/dsh-todo-continuation.
 *
 * They exercise the public `apply()` export against a fake Cordis-like context,
 * so no internal functions are exported just for testing. When the settings
 * namespace is unavailable, the plugin deliberately degrades to its built-in
 * defaults (same failure-isolation path as production without `schemastery`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'

const signal = { throwIfAborted() {} }

/**
 * Builds a fake context. Without `scopeValue` the settings namespace
 * registration throws, so the plugin falls back to its built-in defaults.
 */
function makeCtx({ scopeValue } = {}) {
  const handlers = {}
  const ctx = {
    get: () => ({}),
    settings: scopeValue !== undefined
      ? { register: () => ({ get: () => scopeValue }) }
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

test('no-todo advisory fires after N turns when explicitly enabled', async () => {
  const { gate } = await setup({ scopeValue: { noTodoPromptEveryNTurns: 5 } })
  let agent
  for (let turn = 1; turn <= 5; turn++) {
    agent = makeAgent(turn)
    gate(agent, turn)
  }
  assert.equal(agent.steered.length, 1)
  assert.match(agent.steered[0].content[0].text, /No todo list has been created/)
})

test('no-todo advisory does not re-fire within the same interval', async () => {
  const { gate } = await setup({ scopeValue: { noTodoPromptEveryNTurns: 5 } })
  let agent
  for (let turn = 1; turn <= 10; turn++) {
    agent = makeAgent(turn)
    gate(agent, turn)
  }
  // First prompt fired at turn 5; the cooldown requires turn - lastPrompt > 5.
  assert.equal(agent.steered.length, 0)
})

test('noTodoPromptEveryNTurns = 0 disables the no-todo advisory', async () => {
  const { gate } = await setup({ scopeValue: { noTodoPromptEveryNTurns: 0 } })
  let agent
  for (let turn = 1; turn <= 25; turn++) {
    agent = makeAgent(turn)
    gate(agent, turn)
  }
  assert.equal(agent.steered.length, 0)
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
