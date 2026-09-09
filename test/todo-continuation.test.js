/**
 * Black-box tests for @doiiarx/dsh-todo-continuation.
 *
 * They exercise the public `apply()` export against a fake Cordis-like context,
 * so no internal functions are exported just for testing. The fake settings
 * registration mirrors the real dsh-settings host behavior: the stored user
 * section is merged over the composition base and resolved through the schema
 * the plugin registers — an invalid section throws at registration time and the
 * plugin degrades to its built-in defaults (loudly).
 *
 * The fake session log is the point of the v0.5.0 contract: staleness is read
 * from the durable event log (`turn/start` + `todo/write`), so tests drive a
 * realistic append-only log and can re-mount the plugin mid-session to simulate
 * a host restart. Advisory tests disable the stop gate (`gateMaxSteersPerTurn:
 * 0`) so a veto never masks the prompt under test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'

const signal = { throwIfAborted() {} }

const UNFINISHED = [{ content: 'Ship the fix', status: 'pending' }]
const COMPLETED = [{ content: 'Tracked task', status: 'completed' }]
/** A list with a completed, an active and a pending item: exercises {todos}/{unfinished}/{total}. */
const MIXED = [
  { content: 'Step one', status: 'completed' },
  { content: 'Step two', status: 'in_progress' },
  { content: 'Step three', status: 'pending' },
]

/** Builds a fake context. Without `scopeValue` registration throws (degraded mode). */
function makeCtx({ scopeValue } = {}) {
  const handlers = {}
  const logs = []
  const logger = {
    error: (fmt, ...args) => logs.push(`error ${format(fmt, args)}`),
    warn: (fmt, ...args) => logs.push(`warn ${format(fmt, args)}`),
    info: (fmt, ...args) => logs.push(`info ${format(fmt, args)}`),
    debug: (fmt, ...args) => logs.push(`debug ${format(fmt, args)}`),
  }
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
    root: { logger: () => logger },
    on: (event, handler) => {
      handlers[event] = handler
    },
  }
  return { ctx, handlers, logs }
}

function format(fmt, args) {
  return args.length ? String(fmt).replace('%s', args[0]) : String(fmt)
}

/** An append-only fake session log. */
function makeSession(id = 'session-1') {
  const events = []
  return {
    id,
    events,
    startTurn(turn) {
      events.push({ type: 'turn/start', data: { turn } })
      return this
    },
    writeTodos(todos) {
      events.push({ type: 'todo/write', data: { todos } })
      return this
    },
    /**
     * A landed compaction. The durable marker the plugin keys on is the
     * `compaction/summary` record — an unsuccessful attempt never writes one (it
     * only closes with an errored `compaction/end`), which is exactly the case the
     * plugin must ignore.
     */
    compact(compactionId = 'cmp-1') {
      events.push({ type: 'compaction/summary', data: { compactionId } })
      return this
    },
  }
}

function makeAgent(session) {
  return {
    session,
    steered: [],
    steer(message) {
      this.steered.push(message)
    },
  }
}

const GATE_OFF = { gateMaxSteersPerTurn: 0 }

async function setup({ scopeValue } = {}) {
  const { ctx, handlers, logs } = makeCtx({ scopeValue })
  await apply(ctx)
  const gate = (agent, turn) => handlers['agent/turn-stopping']({ agent, turn, signal })
  /** Fires the mid-turn listener the way the tool registry does: (exec, result, next). */
  const postExecute = (agent, decision = { kind: 'accept' }) =>
    handlers['tools/post-execute'].call({}, { agent, name: 'read' }, { isError: false, content: [] }, async () => decision)
  const texts = (agent) => agent.steered.map(m => m.content[0].text)
  const contexts = (decision) => (decision.additionalContexts ?? []).map(m => m.content[0].text)
  return { gate, postExecute, handlers, logs, texts, contexts }
}

/** Sets up a plugin instance that sees an existing log (simulates a fresh process). */
async function remount(scopeValue) {
  return setup({ scopeValue })
}

// ---------------------------------------------------------------- listeners

test('registers turn-stopping and session-disposed listeners', async () => {
  const { handlers } = await setup({ scopeValue: {} })
  assert.equal(typeof handlers['agent/turn-stopping'], 'function')
  assert.equal(typeof handlers['session/disposed'], 'function')
})

test('steers are attributed to the plugin source', async () => {
  const { gate } = await setup({ scopeValue: {} })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  gate(agent, 1)
  assert.equal(agent.steered[0].source.kind, 'plugin')
  assert.equal(agent.steered[0].source.plugin, 'todo-continuation')
  assert.match(agent.steered[0].id, /.*/)
})

// ------------------------------------------------------------------ stop gate

test('blocks stop when this turn wrote an unfinished todo', async () => {
  const { gate, texts } = await setup({ scopeValue: {} })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  gate(agent, 1)
  const [text] = texts(agent)
  assert.match(text, /cannot stop/)
  assert.match(text, /1 of 1/)
  assert.match(text, /todo_write/)
  assert.match(text, /ask_user_question/)
})

test('allows stop when this turn wrote only completed todos', async () => {
  const { gate } = await setup({ scopeValue: {} })
  const session = makeSession().startTurn(1).writeTodos(COMPLETED)
  const agent = makeAgent(session)
  gate(agent, 1)
  assert.equal(agent.steered.length, 0)
})

test('ignores the legacy waitingTodoPrefixes setting and still blocks', async () => {
  const { gate } = await setup({ scopeValue: { waitingTodoPrefixes: ['[NEED_USER]'] } })
  const session = makeSession().startTurn(1).writeTodos([{ content: '[NEED_USER] waiting', status: 'pending' }])
  const agent = makeAgent(session)
  gate(agent, 1)
  assert.equal(agent.steered.length, 1)
})

test('gate is turn-local: a list left from an earlier turn does not veto later stops', async () => {
  const { gate } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 0 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  gate(agent, 1)
  session.startTurn(2)
  gate(agent, 2)
  assert.equal(agent.steered.length, 0, 'the veto only applies to the turn that wrote the list')
})

test('allows stop as soon as the turn completes the list', async () => {
  const { gate } = await setup({ scopeValue: {} })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  gate(agent, 1)
  session.writeTodos(COMPLETED)
  gate(agent, 1)
  assert.equal(agent.steered.length, 1, 'the completed rewrite lifts the veto without another steer')
})

test('per-turn veto cap bounds repeated stop attempts (default 2)', async () => {
  const { gate, logs } = await setup({ scopeValue: {} })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  for (let attempt = 0; attempt < 6; attempt++) gate(agent, 1)
  assert.equal(agent.steered.length, 2, 'exactly gateMaxSteersPerTurn vetoes per turn')
  assert.ok(logs.some(l => /veto cap/.test(l)), 'hitting the cap is logged once')
})

test('gateMaxSteersPerTurn is configurable', async () => {
  const { gate } = await setup({ scopeValue: { gateMaxSteersPerTurn: 4 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  for (let attempt = 0; attempt < 9; attempt++) gate(agent, 1)
  assert.equal(agent.steered.length, 4)
})

test('gateMaxSteersPerTurn = 0 disables the gate', async () => {
  const { gate } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 0 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  for (let attempt = 0; attempt < 4; attempt++) gate(agent, 1)
  assert.equal(agent.steered.length, 0)
})

test('the veto budget resets on the next turn', async () => {
  const { gate } = await setup({ scopeValue: { gateMaxSteersPerTurn: 1 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  gate(agent, 1)
  gate(agent, 1)
  session.startTurn(2).writeTodos(UNFINISHED)
  gate(agent, 2)
  assert.equal(agent.steered.length, 2, 'turn 2 gets its own single veto')
})

// ------------------------------------------------------------- stale advisory

test('advisory fires N turns after the last write of an unfinished list', async () => {
  const { gate, texts } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 3 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  const fired = []
  for (let turn = 1; turn <= 7; turn++) {
    if (turn > 1) session.startTurn(turn)
    const before = agent.steered.length
    gate(agent, turn)
    if (agent.steered.length > before) fired.push(turn)
  }
  assert.deepEqual(fired, [4, 7], 'first prompt at turn 1+3, the next one a full interval later')
  assert.match(texts(agent)[0], /has not been updated for the last 3 turn\(s\)/)
})

test('THE BUG: a stale list survives a host restart and prompts at once', async () => {
  // The list was written long before this process existed: staleness comes from
  // the session log, so a fresh plugin instance must prompt on its first check.
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  for (let turn = 2; turn <= 12; turn++) session.startTurn(turn)
  const { gate, texts } = await remount({ ...GATE_OFF, staleTodoPromptEveryNTurns: 5 })
  const agent = makeAgent(session)
  gate(agent, 12)
  assert.equal(agent.steered.length, 1)
  assert.match(texts(agent)[0], /last 11 turn\(s\)/, '{n} is the real idle span, not the interval')
})

test('advisory carries the standing list so the model can restore it', async () => {
  const { gate, texts } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1 } })
  const session = makeSession().startTurn(1).writeTodos(MIXED)
  const agent = makeAgent(session)
  session.startTurn(2)
  gate(agent, 2)
  const [text] = texts(agent)
  assert.match(text, /- \[completed\] Step one/)
  assert.match(text, /- \[in_progress\] Step two/)
  assert.match(text, /- \[pending\] Step three/)
  assert.match(text, /2 unfinished of 3 item\(s\)/)
})

test('a rewritten list restarts the idle clock', async () => {
  const { gate } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 2 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  session.startTurn(2)
  gate(agent, 2)
  assert.equal(agent.steered.length, 0)
  session.writeTodos([{ content: 'Ship the fix', status: 'in_progress' }])
  session.startTurn(3)
  gate(agent, 3)
  session.startTurn(4)
  gate(agent, 4)
  assert.equal(agent.steered.length, 1, 'counted from the newest write (turn 2), not the first one')
})

test('a fully completed list is never nagged', async () => {
  const { gate } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 2 } })
  const session = makeSession().startTurn(1).writeTodos(COMPLETED)
  const agent = makeAgent(session)
  for (let turn = 1; turn <= 30; turn++) {
    if (turn > 1) session.startTurn(turn)
    gate(agent, turn)
  }
  assert.equal(agent.steered.length, 0)
})

test('a session that never wrote todos is never prompted', async () => {
  const { gate } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1 } })
  const session = makeSession()
  const agent = makeAgent(session)
  for (let turn = 1; turn <= 30; turn++) {
    session.startTurn(turn)
    gate(agent, turn)
  }
  assert.equal(agent.steered.length, 0)
})

test('an empty (cleared) list ends the reminders', async () => {
  const { gate } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 2 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  session.startTurn(2).writeTodos([])
  gate(agent, 2)
  for (let turn = 3; turn <= 12; turn++) {
    session.startTurn(turn)
    gate(agent, turn)
  }
  assert.equal(agent.steered.length, 0, 'clearing the list is a valid answer and is respected')
})

test('staleTodoPromptEveryNTurns = 0 disables the advisory', async () => {
  const { gate } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 0 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  for (let turn = 2; turn <= 40; turn++) {
    session.startTurn(turn)
    gate(agent, turn)
  }
  assert.equal(agent.steered.length, 0)
})

test('an idle list is reminded once per interval, for as long as it stays stale', async () => {
  const { gate, texts } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 2, staleTodoPromptTemplate: 'Idle {n}t' } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  for (let turn = 2; turn <= 12; turn++) {
    session.startTurn(turn)
    gate(agent, turn)
  }
  // The default has no per-list cap: the reminder repeats every interval while the
  // list stands unchanged — the original plugin's behavior.
  assert.deepEqual(texts(agent).map(text => text.split('\n')[0]), ['Idle 2t', 'Idle 4t', 'Idle 6t', 'Idle 8t', 'Idle 10t'])
  // The custom template has no {todos}, so the list is appended below the text.
  assert.match(texts(agent)[0], /\n\n- \[pending\] Ship the fix$/)
})

// ------------------------------------------------------------------ templates

test('{n} renders the real idle turns and {todos} the rendered list', async () => {
  const { gate, texts } = await setup({
    scopeValue: {
      ...GATE_OFF,
      staleTodoPromptEveryNTurns: 4,
      staleTodoPromptTemplate: 'idle={n} unfinished={unfinished}/{total}\n{todos}',
    },
  })
  const session = makeSession().startTurn(1).writeTodos(MIXED)
  const agent = makeAgent(session)
  for (let turn = 2; turn <= 6; turn++) {
    session.startTurn(turn)
    gate(agent, turn)
  }
  assert.equal(texts(agent).length, 1)
  assert.equal(texts(agent)[0], 'idle=4 unfinished=2/3\n- [completed] Step one\n- [in_progress] Step two\n- [pending] Step three')
})

test('an unknown placeholder stays verbatim and the message is still sent', async () => {
  const { gate, texts } = await setup({
    scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1, staleTodoPromptTemplate: 'No {foo} here: {n}' },
  })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  session.startTurn(2)
  gate(agent, 2)
  assert.equal(texts(agent)[0], 'No {foo} here: 1\n\n- [pending] Ship the fix')
})

test('the rendered list is bounded in item count', async () => {
  const { gate, texts } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1 } })
  const many = Array.from({ length: 45 }, (_, i) => ({ content: `Task ${i}`, status: 'pending' }))
  const session = makeSession().startTurn(1).writeTodos(many)
  const agent = makeAgent(session)
  session.startTurn(2)
  gate(agent, 2)
  const body = texts(agent)[0]
  assert.match(body, /- \[pending\] Task 29/)
  assert.doesNotMatch(body, /- \[pending\] Task 30/)
  assert.match(body, /\(\+15 more item\(s\) not shown\)/)
})

test('a template without the required placeholder cannot be resolved and degrades loudly', async () => {
  const { gate, logs, texts } = await setup({
    scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1, staleTodoPromptTemplate: 'missing placeholder' },
  })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  session.startTurn(2)
  gate(agent, 2)
  // schemastery.pattern() rejects the stored section, so registration throws and
  // the plugin runs on defaults — announcing it.
  assert.ok(logs.some(l => /unavailable/.test(l)), 'registration failure is logged as an error')
  assert.ok(logs.some(l => /DEGRADED/.test(l)), 'degraded mode is announced')
  // Default interval is 5, so one idle turn is not enough to prompt.
  assert.equal(agent.steered.length, 0)
  session.startTurn(6)
  gate(agent, 6)
  assert.equal(texts(agent).length, 1)
  assert.match(texts(agent)[0], /Automated note: the standing todo list/)
})

test('an old config without the new keys gets the built-in defaults', async () => {
  const { gate, texts } = await setup({ scopeValue: { staleTodoPromptEveryNTurns: 2 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  session.startTurn(2)
  session.startTurn(3)
  gate(agent, 3)
  assert.equal(texts(agent).length, 1)
  assert.match(texts(agent)[0], /- \[pending\] Ship the fix/)
})

test('a leftover legacy key does not break the namespace', async () => {
  const { gate } = await setup({
    scopeValue: { noTodoPromptEveryNTurns: 5, staleTodoPromptEveryNTurns: 1 },
  })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  session.startTurn(2)
  gate(agent, 2)
  assert.equal(agent.steered.length, 1)
})

// ---------------------------------------------------------------- session map

test('sessions are tracked independently', async () => {
  const { gate } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 2 } })
  const first = makeAgent(makeSession('a').startTurn(1).writeTodos(UNFINISHED))
  const second = makeAgent(makeSession('b').startTurn(1).writeTodos(UNFINISHED))
  first.session.startTurn(2)
  second.session.startTurn(2)
  gate(first, 2)
  gate(second, 2)
  first.session.startTurn(3)
  second.session.startTurn(3)
  gate(first, 3)
  gate(second, 3)
  assert.equal(first.steered.length, 1)
  assert.equal(second.steered.length, 1)
})

test('disposing a session drops only its rate-limit state, not the prompt ability', async () => {
  const { gate, handlers } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 2 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  session.startTurn(2)
  gate(agent, 2)
  session.startTurn(3)
  gate(agent, 3)
  assert.equal(agent.steered.length, 1)
  handlers['session/disposed']({ id: session.id })
  // A disposed-then-resumed session still re-prompts from the log, not from memory.
  session.startTurn(9)
  gate(agent, 9)
  assert.equal(agent.steered.length, 2)
})

// ---------------------------------------------------------- compaction trigger

/** Turns 2..`through` with no `todo/write`, so nothing but a compaction can prompt. */
function idleTurns(session, agent, gate, from = 2, through = 4) {
  for (let turn = from; turn <= through; turn++) {
    session.startTurn(turn)
    gate(agent, turn)
  }
}

test('a landed compaction hands the list back at once, without waiting for the interval', async () => {
  const { gate, texts } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 } })
  const session = makeSession().startTurn(1).writeTodos(MIXED)
  const agent = makeAgent(session)
  session.startTurn(2)
  session.compact('cmp-1')
  gate(agent, 2)
  assert.equal(texts(agent).length, 1)
  assert.match(texts(agent)[0], /context was just condensed/)
  assert.match(texts(agent)[0], /2 of 3 item\(s\) are still unfinished/)
  assert.match(texts(agent)[0], /- \[in_progress\] Step two/, 'the reminder carries the plan itself')
})

test('one compaction prompts once, however many stop boundaries it crosses', async () => {
  const { gate } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  session.startTurn(2)
  session.compact('cmp-1')
  gate(agent, 2)
  gate(agent, 2)
  session.startTurn(3)
  gate(agent, 3)
  assert.equal(agent.steered.length, 1, 'deduped by compactionId, not by turn')
})

test('the next compaction prompts again', async () => {
  const { gate, texts } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  session.startTurn(2)
  session.compact('cmp-1')
  gate(agent, 2)
  session.startTurn(3)
  session.compact('cmp-2')
  gate(agent, 3)
  assert.equal(texts(agent).length, 2)
})

test('a compaction that happened before the last write does not prompt', async () => {
  const { gate } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 } })
  const session = makeSession().startTurn(1).compact('cmp-1')
  session.startTurn(2).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  idleTurns(session, agent, gate, 3, 4)
  assert.equal(agent.steered.length, 0, 'the model already has a fresher copy than the summary')
})

test('a compaction of an all-completed list stays silent', async () => {
  const { gate } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 } })
  const session = makeSession().startTurn(1).writeTodos(COMPLETED).startTurn(2).compact('cmp-1')
  const agent = makeAgent(session)
  gate(agent, 2)
  assert.equal(agent.steered.length, 0)
})

test('a session that never wrote todos is not prompted by a compaction', async () => {
  const { gate } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 } })
  const session = makeSession().startTurn(1).compact('cmp-1')
  const agent = makeAgent(session)
  gate(agent, 1)
  assert.equal(agent.steered.length, 0)
})

test('a failed compaction is not a trigger', async () => {
  // dsh-compaction records an unsuccessful attempt only as an errored
  // `compaction/end` — no summary, so nothing was ever replaced.
  const { gate } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED).startTurn(2)
  session.events.push({ type: 'compaction/start', data: { compactionId: 'cmp-x', turn: 2 } })
  session.events.push({ type: 'compaction/end', data: { compactionId: 'cmp-x', turn: 2, error: '429 status code (no body)' } })
  const agent = makeAgent(session)
  gate(agent, 2)
  assert.equal(agent.steered.length, 0)
})

test('promptAfterCompaction = false leaves only the stale interval', async () => {
  const { gate } = await setup({
    scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 9, promptAfterCompaction: false },
  })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED).startTurn(2).compact('cmp-1')
  const agent = makeAgent(session)
  gate(agent, 2)
  assert.equal(agent.steered.length, 0)
})

test('a compaction with the interval off still prompts, and its own text is editable', async () => {
  const { gate, texts } = await setup({
    scopeValue: {
      ...GATE_OFF,
      staleTodoPromptEveryNTurns: 0,
      compactionPromptTemplate: 'Condensed at idle {n}: {unfinished}/{total}',
    },
  })
  const session = makeSession().startTurn(1).writeTodos(MIXED).startTurn(4).compact('cmp-1')
  const agent = makeAgent(session)
  gate(agent, 4)
  assert.equal(texts(agent)[0], 'Condensed at idle 3: 2/3\n\n- [completed] Step one\n- [in_progress] Step two\n- [pending] Step three')
})

test('P1 regression: a compaction that landed before a host restart still hands the list back', async () => {
  const scopeValue = { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 }
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED).startTurn(2).compact('cmp-1')
  const agent = makeAgent(session)
  // The plugin is mounted after the summary already sat in the log (fresh process).
  const { gate } = await setup({ scopeValue })
  gate(agent, 2)
  assert.equal(agent.steered.length, 1, 'derived from the log, not from what this process saw')
})

test('P1 regression: a reminder that is ignored still does not repeat per boundary', async () => {
  const scopeValue = { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 }
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED).startTurn(2).compact('cmp-1')
  const agent = makeAgent(session)
  const { gate } = await setup({ scopeValue })
  gate(agent, 2)
  for (let turn = 3; turn <= 8; turn++) {
    session.startTurn(turn)
    gate(agent, turn)
  }
  assert.equal(agent.steered.length, 1)
})

// ------------------------------------------------------------ mid-turn delivery

test('a landed compaction reaches the model on the next tool result', async () => {
  const { postExecute, contexts } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED).startTurn(2).compact('cmp-1')
  const agent = makeAgent(session)
  const decision = await postExecute(agent)
  assert.equal(decision.kind, 'accept', 'the settled decision is passed through')
  assert.equal(contexts(decision).length, 1)
  assert.match(contexts(decision)[0], /context was just condensed/)
  assert.match(contexts(decision)[0], /- \[pending\] Ship the fix/)
})

test('the idle interval works mid-turn too, without any stop boundary', async () => {
  // The P2 point: a turn that dies on a provider error or that never stops still
  // gets the reminder, because it does not have to reach `agent/turn-stopping`.
  const { postExecute, contexts } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 2 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  session.startTurn(2)
  assert.equal(contexts(await postExecute(agent)).length, 0, 'one idle turn is not enough')
  session.startTurn(3)
  assert.match(contexts(await postExecute(agent))[0], /has not been updated for the last 2 turn\(s\)/)
})

test('mid-turn delivery happens once per turn, and reserves the reminder for this interval', async () => {
  const { gate, postExecute, contexts } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED).startTurn(2).compact('cmp-1')
  const agent = makeAgent(session)
  assert.equal(contexts(await postExecute(agent)).length, 1)
  assert.equal(contexts(await postExecute(agent)).length, 0, 'one context per turn')
  gate(agent, 2)
  assert.equal(agent.steered.length, 0, 'the stop boundary does not repeat it')
})

test('the stop boundary keeps its own reminder when nothing ran mid-turn', async () => {
  const { gate, postExecute, contexts } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED).startTurn(2).compact('cmp-1')
  const agent = makeAgent(session)
  gate(agent, 2)
  assert.equal(agent.steered.length, 1)
  assert.equal(contexts(await postExecute(agent)).length, 0, 'already delivered by the boundary')
})

test('mid-turn delivery never vetoes: an unfinished list written this turn only passes through', async () => {
  const { postExecute, contexts } = await setup({ scopeValue: { staleTodoPromptEveryNTurns: 9 } })
  const session = makeSession().startTurn(2).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  const decision = await postExecute(agent)
  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal(contexts(decision).length, 0)
})

test('an execution without an agent, a completed list or no list is left alone', async () => {
  const { postExecute, contexts } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1 } })
  assert.deepEqual(await postExecute({}), { kind: 'accept' }, 'an execution with no agent is passed through')
  const completed = makeAgent(makeSession().startTurn(1).writeTodos(COMPLETED).startTurn(2).compact('c'))
  assert.equal(contexts(await postExecute(completed)).length, 0)
  const empty = makeAgent(makeSession().startTurn(2))
  assert.equal(contexts(await postExecute(empty)).length, 0)
})

test('contexts a listener did not attach stay untouched', async () => {
  const { postExecute, contexts } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED).startTurn(2)
  const agent = makeAgent(session)
  const other = { id: 'x', role: 'user', content: [{ type: 'text', text: 'someone else' }] }
  const decision = await postExecute(agent, { kind: 'accept', additionalContexts: [other] })
  assert.deepEqual(decision.additionalContexts.map(m => m.content[0].text), ['someone else'])
})

test('a plugin failure inside the mid-turn listener cannot break tool dispatch', async () => {
  const { postExecute, contexts } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 } })
  // An agent whose session log throws when read: the listener must swallow it.
  const agent = makeAgent({ id: 'broken', get events() { throw new Error('log exploded') } })
  const decision = await postExecute(agent)
  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal(contexts(decision).length, 0)
})

// -------------------------------------------------------------- decision logging

/** All P3 tests: the same decisions, but made visible in the host log. */
const DECIDE = { logDecisions: true }
const lines = (logs, pattern) => logs.filter(entry => pattern.test(entry))

test('the decision log stays silent unless logDecisions is on', async () => {
  const { gate, logs } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 5 } })
  const agent = makeAgent(makeSession().startTurn(1).startTurn(2))
  gate(agent, 2)
  assert.deepEqual(lines(logs, /at=stop-boundary/), [])
})

test('every silent branch is explained with its reason', async () => {
  const noList = await setup({ scopeValue: { ...GATE_OFF, ...DECIDE } })
  noList.gate(makeAgent(makeSession().startTurn(1)), 1)
  assert.equal(lines(noList.logs, /at=stop-boundary skip:no-list$/).length, 1)

  const done = await setup({ scopeValue: { ...GATE_OFF, ...DECIDE } })
  done.gate(makeAgent(makeSession().startTurn(1).writeTodos(COMPLETED).startTurn(2)), 2)
  assert.equal(lines(done.logs, /skip:no-unfinished$/).length, 1)

  const off = await setup({ scopeValue: { ...GATE_OFF, ...DECIDE, staleTodoPromptEveryNTurns: 0, promptAfterCompaction: false } })
  off.gate(makeAgent(makeSession().startTurn(1).writeTodos(UNFINISHED).startTurn(2)), 2)
  assert.equal(lines(off.logs, /skip:interval-off$/).length, 1)

  const early = await setup({ scopeValue: { ...GATE_OFF, ...DECIDE, staleTodoPromptEveryNTurns: 5 } })
  early.gate(makeAgent(makeSession().startTurn(1).writeTodos(UNFINISHED).startTurn(2)), 2)
  assert.equal(lines(early.logs, /skip:idle 1<5$/).length, 1)
})

test('the cooldown is reported as a reason, not as silence', async () => {
  const { gate, logs } = await setup({ scopeValue: { ...GATE_OFF, ...DECIDE, staleTodoPromptEveryNTurns: 2 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  session.startTurn(3)
  gate(agent, 3)
  session.startTurn(4)
  gate(agent, 4)
  assert.equal(lines(logs, /prompt:stale idle=2$/).length, 1)
  assert.equal(lines(logs, /skip:cooldown 1<2$/).length, 1)
})

test('a fired prompt says which channel delivered it and why', async () => {
  const { gate, postExecute, logs } = await setup({ scopeValue: { ...GATE_OFF, ...DECIDE, staleTodoPromptEveryNTurns: 9 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED).startTurn(2).compact('cmp-1')
  const agent = makeAgent(session)
  await postExecute(agent)
  gate(agent, 2)
  assert.equal(lines(logs, /at=mid-tool-result prompt:compaction id=cmp-1 idle=1$/).length, 1)
  // The boundary then has nothing left to say: the mid-turn channel took this turn.
  assert.equal(lines(logs, /at=stop-boundary skip:idle 1<9$/).length, 1)
})

test('the gate reports block, cap, allow and off', async () => {
  const { gate, logs } = await setup({ scopeValue: { ...DECIDE, staleTodoPromptEveryNTurns: 9, gateMaxSteersPerTurn: 1 } })
  const agent = makeAgent(makeSession().startTurn(1).writeTodos(UNFINISHED))
  gate(agent, 1)
  gate(agent, 1)
  assert.equal(lines(logs, /at=stop-boundary gate:block unfinished=1\/1 vetoes=1\/1$/).length, 1)
  assert.equal(lines(logs, /gate:cap-reached unfinished=1 vetoes=1\/1 allow-stop$/).length, 1)

  gate(makeAgent(makeSession('completed-1').startTurn(1).writeTodos(COMPLETED)), 1)
  assert.equal(lines(logs, /at=stop-boundary gate:allow list-complete$/).length, 1)

  const off = await setup({ scopeValue: { ...GATE_OFF, ...DECIDE } })
  off.gate(agent, 1)
  assert.equal(lines(off.logs, /at=stop-boundary gate:off$/).length, 1)
})

// ------------------------------------------------------------------ hard limits

test('an unreachably high veto cap is clamped to 10 and said out loud', async () => {
  const { gate, logs } = await setup({ scopeValue: { gateMaxSteersPerTurn: 1000, staleTodoPromptEveryNTurns: 9 } })
  assert.equal(lines(logs, /clamped to 10/).length, 1)
  const agent = makeAgent(makeSession('clamped').startTurn(1).writeTodos(UNFINISHED))
  for (let attempt = 0; attempt < 25; attempt++) gate(agent, 1)
  assert.equal(agent.steered.length, 10, 'the turn is let go after 10 vetoes, not 1000')
})

test('a setting removed in an earlier version is named once, not silently ignored', async () => {
  const { gate, logs } = await setup({
    scopeValue: { noTodoPromptEveryNTurns: 5, waitingTodoPrefixes: ['[WAITING_USER]'], ...GATE_OFF, staleTodoPromptEveryNTurns: 9 },
  })
  assert.equal(lines(logs, /ignoring removed setting\(s\) noTodoPromptEveryNTurns, waitingTodoPrefixes/).length, 1)
  const agent = makeAgent(makeSession('deadkey').startTurn(1).writeTodos(UNFINISHED))
  gate(agent, 2)
  gate(agent, 3)
  assert.equal(lines(logs, /ignoring removed setting/).length, 1, 'once per mount, not once per boundary')
})

// --------------------------------------------------- P5: adaptive backoff (quiet)

test('with maxPromptsPerList=2, two advisories for an unchanged list are the last two', async () => {
  const { gate, logs } = await setup({
    scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1, maxPromptsPerList: 2, logDecisions: true },
  })
  const session = makeSession('p5-a').startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  for (const turn of [2, 3, 4]) {
    session.startTurn(turn)
    gate(agent, turn)
  }
  assert.equal(agent.steered.length, 2, 'the third boundary is silence')
  assert.equal(lines(logs, /skip:quiet$/).length, 1)
  // The model answers with a rewrite: the clock restarts from the new list.
  session.startTurn(5).writeTodos(MIXED).startTurn(6)
  gate(agent, 6)
  assert.equal(agent.steered.length, 3)
  assert.equal(lines(logs, /prompt:stale idle=1$/).length, 2)
})

test('with maxPromptsPerList=0 (default), the reminder never goes quiet on its own', async () => {
  const { gate, logs } = await setup({
    scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1, logDecisions: true },
  })
  const session = makeSession('p5-b0').startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  for (const turn of [2, 3, 4, 5, 6]) {
    session.startTurn(turn)
    gate(agent, turn)
  }
  assert.equal(agent.steered.length, 5, 'one reminder per interval, indefinitely')
  assert.equal(lines(logs, /goes quiet/).length, 0)
  assert.equal(lines(logs, /skip:quiet$/).length, 0)
})

test('entering quiet mode is announced exactly once, and without logDecisions', async () => {
  const { gate, logs } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1, maxPromptsPerList: 2 } })
  const session = makeSession('p5-b').startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  for (const turn of [2, 3, 4, 5]) {
    session.startTurn(turn)
    gate(agent, turn)
  }
  assert.equal(lines(logs, /goes quiet about the list written at turn 1/).length, 1)
  assert.ok(lines(logs, /goes quiet/)[0].startsWith('info '), 'a state change is not a debug detail')
  assert.ok(lines(logs, /goes quiet/)[0].includes('until the list changes or a compaction lands'))
})

test('a fresh compaction escapes quiet mode without a rewrite', async () => {
  const { gate, logs } = await setup({
    scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1, maxPromptsPerList: 2, promptAfterCompaction: true, logDecisions: true },
  })
  const session = makeSession('p5-c').startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  session.startTurn(2); gate(agent, 2)
  session.startTurn(3); gate(agent, 3)          // quiet from here
  const before = agent.steered.length
  session.compact('cmp-late').startTurn(4)
  gate(agent, 4)
  assert.equal(agent.steered.length, before + 1, 'the plan really did leave the context again')
  assert.equal(lines(logs, /prompt:compaction id=cmp-late/).length, 1)
})

test('the per-list cap counts both delivery channels, not each on its own', async () => {
  const { gate, postExecute, logs, contexts } = await setup({
    scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1, maxPromptsPerList: 2, logDecisions: true },
  })
  const session = makeSession('p5-d').startTurn(1).writeTodos(UNFINISHED).startTurn(2)
  const agent = makeAgent(session)
  assert.equal(contexts(await postExecute(agent)).length, 1, 'fire 1: mid-turn')
  gate(agent, 2)                                 // same turn: cooldown, no fire
  session.startTurn(3)
  gate(agent, 3)                                 // fire 2: boundary → quiet
  session.startTurn(4)
  assert.equal(contexts(await postExecute(agent)).length, 0, 'the mid-turn channel is quiet too')
  gate(agent, 4)
  assert.equal(agent.steered.length, 1, 'one fire at a boundary; the other went out mid-turn')
  assert.equal(lines(logs, /skip:quiet$/).length, 2)
})

test('every injected message is a visible notice with a one-line summary', async () => {
  const { gate } = await setup({ scopeValue: { staleTodoPromptEveryNTurns: 1 } })
  const session = makeSession('notice').startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  gate(agent, 1)                                  // the stop gate vetoes this turn
  assert.equal(agent.steered.length, 1)
  const veto = agent.steered[0]
  assert.equal(veto.source.plugin, 'todo-continuation')
  assert.equal(veto.source.form, 'notice', 'the client can only show what is declared')
  assert.match(veto.source.summary, /turn sent back — 1 of 1/)
  session.startTurn(2)
  gate(agent, 2)                                  // now the standing-list advisory
  const advisory = agent.steered[1]
  assert.equal(advisory.source.form, 'notice')
  assert.match(advisory.source.summary, /reminded of its todo list — 1 of 1 unfinished \(stale idle=1\)/)
  assert.ok(advisory.source.summary.length <= 120)
})

// ------------------------------------------------------- P6: delegated sessions

/** A session whose header marks it as a subagent child (durable `origin`). */
function subagentSession(id, header = { id, origin: 'subagent' }) {
  const session = makeSession(id)
  session.header = header
  return session
}

test('gateSubagents: false lets a delegated turn end, but keeps its context', async () => {
  const { gate, logs } = await setup({
    scopeValue: { gateSubagents: false, gateMaxSteersPerTurn: 2, staleTodoPromptEveryNTurns: 5, logDecisions: true },
  })
  const session = subagentSession('p6-off').startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  gate(agent, 1)
  assert.equal(agent.steered.length, 0, 'no veto on a delegated agent')
  assert.equal(lines(logs, /gate:skipped subagent unfinished=1\/1 gateSubagents=off/).length, 1)
})

test('a delegated agent is gated like any other turn by default', async () => {
  const { gate } = await setup({ scopeValue: { gateMaxSteersPerTurn: 2, staleTodoPromptEveryNTurns: 5 } })
  const session = subagentSession('p6-on').startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  gate(agent, 1)
  assert.equal(agent.steered.length, 1, 'the default keeps v0.5.0 behavior')
})

test('delegation is detected from the durable descriptor when the header lacks it', async () => {
  const { gate, logs } = await setup({
    scopeValue: { gateSubagents: false, gateMaxSteersPerTurn: 2, staleTodoPromptEveryNTurns: 5, logDecisions: true },
  })
  const session = makeSession('p6-desc')
  session.startTurn(1)
  session.events.push({ type: 'subagent/descriptor', data: { mode: 'one-shot', label: 'child' } })
  session.writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  gate(agent, 1)
  assert.equal(agent.steered.length, 0)
  assert.equal(lines(logs, /gate:skipped subagent/).length, 1)
})

test('delegationDepth counts as delegated too', async () => {
  const { gate, logs } = await setup({
    scopeValue: { gateSubagents: false, gateMaxSteersPerTurn: 2, staleTodoPromptEveryNTurns: 5, logDecisions: true },
  })
  const session = subagentSession('p6-depth', { id: 'p6-depth', delegationDepth: 2 }).startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  gate(agent, 1)
  assert.equal(agent.steered.length, 0)
  assert.equal(lines(logs, /gate:skipped subagent/).length, 1)
})

test('a subagent with the veto off still receives the standing list mid-turn', async () => {
  const { postExecute, contexts } = await setup({
    scopeValue: { gateSubagents: false, gateMaxSteersPerTurn: 2, staleTodoPromptEveryNTurns: 1 },
  })
  const session = subagentSession('p6-ctx').startTurn(1).writeTodos(UNFINISHED).startTurn(2)
  const decision = await postExecute(makeAgent(session))
  const [text] = contexts(decision)
  assert.ok(text.includes('- [pending] Ship the fix'), text)
})

test('an unknown session shape is treated as top-level, not as a subagent', async () => {
  const { gate } = await setup({ scopeValue: { gateSubagents: false, gateMaxSteersPerTurn: 2, staleTodoPromptEveryNTurns: 5 } })
  const session = makeSession('p6-unknown').startTurn(1).writeTodos(UNFINISHED)
  session.header = { id: 'p6-unknown', weird: true }
  const agent = makeAgent(session)
  gate(agent, 1)
  assert.equal(agent.steered.length, 1, 'a header the plugin cannot read must not disarm the gate')
})
