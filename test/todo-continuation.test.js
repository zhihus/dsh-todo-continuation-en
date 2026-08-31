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

test('default waiting prefixes are the English markers', async () => {
  const { gate } = await setup()
  const agent = makeAgent(1, [{ content: '[INFO_NEEDED] get details', status: 'pending' }])
  gate(agent, 1)
  assert.equal(agent.steered.length, 0, 'a todo starting with a waiting marker must allow a stop')
})

test('blocks stop when an unfinished todo has no waiting marker', async () => {
  const { gate } = await setup()
  const agent = makeAgent(1, [{ content: 'Implement the feature', status: 'pending' }])
  gate(agent, 1)
  assert.equal(agent.steered.length, 1)
  const text = agent.steered[0].content[0].text
  assert.match(text, /cannot stop/)
  assert.match(text, /\[INFO_NEEDED\]/)
  assert.match(text, /\[WAITING_USER\]/)
})

test('allows stop when every unfinished todo starts with a waiting marker', async () => {
  const { gate } = await setup()
  const agent = makeAgent(1, [
    { content: '[INFO_NEEDED] ask for the API key', status: 'pending' },
    { content: '[WAITING_USER] confirm the plan', status: 'pending' },
  ])
  gate(agent, 1)
  assert.equal(agent.steered.length, 0)
})

test('allows stop when all todos are completed', async () => {
  const { gate } = await setup()
  const agent = makeAgent(1, [{ content: 'Finished task', status: 'completed' }])
  gate(agent, 1)
  assert.equal(agent.steered.length, 0)
})

test('respects custom prefixes from the settings scope', async () => {
  const { gate } = await setup({ scopeValue: { waitingTodoPrefixes: ['[NEED_USER]'] } })
  const agent = makeAgent(1, [{ content: '[NEED_USER] waiting for input', status: 'pending' }])
  gate(agent, 1)
  assert.equal(agent.steered.length, 0)
})

test('prompts to start using todos after N turns without any todo', async () => {
  const { gate } = await setup()
  let agent
  for (let turn = 1; turn <= 5; turn++) {
    agent = makeAgent(turn)
    gate(agent, turn)
  }
  assert.equal(agent.steered.length, 1)
  assert.match(agent.steered[0].content[0].text, /No todo list has been created/)
})

test('does not re-prompt for the no-todo case within the same interval', async () => {
  const { gate } = await setup()
  let agent
  for (let turn = 1; turn <= 10; turn++) {
    agent = makeAgent(turn)
    gate(agent, turn)
  }
  // First prompt fired at turn 5; the cooldown requires turn - lastPrompt > 5.
  assert.equal(agent.steered.length, 0)
})

test('prompts to refresh a stale todo list after N turns without an update', async () => {
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
