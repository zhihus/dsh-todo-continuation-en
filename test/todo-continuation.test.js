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

import { apply, DEFAULTS as HOST_DEFAULTS } from '../index.js'

const signal = { throwIfAborted() {} }

const UNFINISHED = [{ content: 'Ship the fix', status: 'pending' }]
const COMPLETED = [{ content: 'Tracked task', status: 'completed' }]
/** A list with a completed, an active and a pending item: exercises {todos}/{unfinished}/{total}. */
const MIXED = [
  { content: 'Step one', status: 'completed' },
  { content: 'Step two', status: 'in_progress' },
  { content: 'Step three', status: 'pending' },
]

/**
 * Builds a fake context. Without `scopeValue` registration throws (degraded mode).
 * With `duplicate: true` the namespace registration itself throws as "already
 * registered", but `settings.get(ns)` serves the live section — the P4b recovery.
 * The live section is modeled the way the real host serves it: the stored user
 * section merged over the base and RESOLVED through the schema (the raw stored
 * object is never handed out), so a recovery test cannot pass by accident of a
 * hand-complete fixture value.
 * @param {{ scopeValue?: object, duplicate?: boolean }} [options]
 */
function makeCtx({ scopeValue, duplicate } = {}) {
  const handlers = {}
  const logs = []
  let liveSection
  const logger = {
    error: (fmt, ...args) => logs.push(`error ${format(fmt, args)}`),
    warn: (fmt, ...args) => logs.push(`warn ${format(fmt, args)}`),
    info: (fmt, ...args) => logs.push(`info ${format(fmt, args)}`),
    debug: (fmt, ...args) => logs.push(`debug ${format(fmt, args)}`),
  }
  const settings = scopeValue === undefined
    ? { register() { throw new Error('schemastery unavailable (test)') } }
    : {
        register(ns, schema, options = {}) {
          const resolved = schema({ ...(options.base ?? {}), ...scopeValue })
          if (duplicate) {
            // Like the host: the SECOND registration is rejected, the first one's
            // resolved section keeps being served through `settings.get(ns)`.
            liveSection = resolved
            throw new Error(`settings.${ns} is already registered (test)`)
          }
          return { get: () => resolved }
        },
        get: () => liveSection,
      }
  const ctx = {
    get: () => ({}),
    settings,
    root: { logger: () => logger },
    // A listener array per event, like the real Cordis: several plugins may
    // attach to the same event and every handler is kept, not overwritten.
    on: (event, handler) => {
      (handlers[event] ??= []).push(handler)
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

/**
 * Mounts the plugin and returns the listeners plus helpers.
 * @param {{ scopeValue?: object, duplicate?: boolean }} [options]
 */
async function setup({ scopeValue, duplicate } = {}) {
  const { ctx, handlers, logs } = makeCtx({ scopeValue, duplicate })
  await apply(ctx)
  const fire = (event, ...args) => {
    for (const handler of handlers[event] ?? []) handler(...args)
  }
  const gate = (agent, turn) => fire('agent/turn-stopping', { agent, turn, signal })
  /** Fires the mid-turn listener the way the tool registry does: (exec, result, next). */
  const postExecute = (agent, decision = { kind: 'accept' }) =>
    handlers['tools/post-execute'].at(-1).call({}, { agent, name: 'read' }, { isError: false, content: [] }, async () => decision)
  const texts = (agent) => agent.steered.map(m => m.content[0].text)
  const contexts = (decision) => (decision.additionalContexts ?? []).map(m => m.content[0].text)
  return { gate, postExecute, fire, handlers, logs, texts, contexts }
}

/** Sets up a plugin instance that sees an existing log (simulates a fresh process). */
async function remount(scopeValue) {
  return setup({ scopeValue })
}

// ---------------------------------------------------------------- listeners

test('registers turn-stopping and session-disposed listeners', async () => {
  const { handlers } = await setup({ scopeValue: {} })
  assert.equal(handlers['agent/turn-stopping'].length, 1)
  assert.equal(typeof handlers['agent/turn-stopping'][0], 'function')
  assert.equal(handlers['session/disposed'].length, 1)
  assert.equal(typeof handlers['session/disposed'][0], 'function')
})

test('steers are attributed to the plugin source', async () => {
  const { gate } = await setup({ scopeValue: {} })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  gate(agent, 1)
  assert.equal(agent.steered[0].source.kind, 'plugin')
  assert.equal(agent.steered[0].source.plugin, 'todo-continuation')
  assert.match(agent.steered[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'every steer carries a valid UUID v4 message id (randomUUID), not just any string')
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
  // `some()` would stay green while the cap is re-warned at every later boundary;
  // the contract (state.capReported) is once per turn, like the W9 count-style asserts.
  assert.equal(lines(logs, /veto cap/).length, 1, 'hitting the cap is logged exactly once per turn')
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

test('an over-long todo line is clipped to the width bound, not just bound in count', async () => {
  // The docstring promises the rendered list is "bounded in count and width";
  // without this assert, MAX_TODO_LINE_CHARS could be deleted with the suite green.
  const { gate, texts } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1 } })
  const session = makeSession('width').startTurn(1).writeTodos([
    { content: 'x'.repeat(350), status: 'pending' },
    { content: 'short and folded\ninto one line', status: 'pending' },
  ])
  const agent = makeAgent(session)
  session.startTurn(2)
  gate(agent, 2)
  const rendered = texts(agent)[0].split('\n').filter(l => l.startsWith('- [pending]'))
  assert.equal(rendered[0], `- [pending] ${'x'.repeat(200)}...`, 'clipped at MAX_TODO_LINE_CHARS with an ellipsis')
  assert.equal(rendered[1], '- [pending] short and folded into one line', 'newlines are flattened, not passed through')
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

test('a negative interval setting is invalid and falls back to the built-in default', async () => {
  // A negative interval is neither "disabled" (that is 0) nor usable: idle > negative
  // would either always remind or trip the too-old horizon. It must read as invalid.
  const { gate, logs } = await setup({
    scopeValue: { ...GATE_OFF, logDecisions: true, staleTodoPromptEveryNTurns: -3 },
  })
  const agent = makeAgent(makeSession('neg').startTurn(1).writeTodos(UNFINISHED).startTurn(2))
  gate(agent, 2)
  assert.equal(agent.steered.length, 0)
  assert.equal(lines(logs, /skip:idle 1<5$/).length, 1, 'the reason names the fallback default 5, not -3')
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
  const { gate, fire } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 2 } })
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  session.startTurn(2)
  gate(agent, 2)
  session.startTurn(3)
  gate(agent, 3)
  assert.equal(agent.steered.length, 1)
  fire('session/disposed', { id: session.id })
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

test('the compaction hand-back reserves the stale interval it was delivered inside', async () => {
  // One boundary, one reminder: the hand-back must restart the idle clock, or the
  // stale path immediately double-nags the same list at the next interval.
  const { gate, logs } = await setup({ scopeValue: { ...GATE_OFF, logDecisions: true, staleTodoPromptEveryNTurns: 2 } })
  const session = makeSession('clock').startTurn(1).writeTodos(UNFINISHED).startTurn(2).compact('cmp-1')
  const agent = makeAgent(session)
  gate(agent, 2)
  assert.equal(agent.steered.length, 1, 'the hand-back')
  session.startTurn(3)
  gate(agent, 3)
  assert.equal(agent.steered.length, 1, 'idle is 2 now, but the clock counts from the hand-back turn')
  assert.equal(lines(logs, /skip:cooldown 1<2$/).length, 1)
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
  const { postExecute, contexts, logs } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1 } })
  assert.deepEqual(await postExecute({}), { kind: 'accept' }, 'an execution with no agent is passed through')
  // Same trap as the W1 malformed-record test: with the !agent?.session guard
  // deleted, reading `.session` throws, the catch reports and passes the decision
  // through — the deepEqual above cannot tell. A skipped branch must be silent.
  assert.equal(lines(logs, /^error/).length, 0, 'a guard skip, not a swallowed TypeError')
  const completed = makeAgent(makeSession().startTurn(1).writeTodos(COMPLETED).startTurn(2).compact('c'))
  assert.equal(contexts(await postExecute(completed)).length, 0)
  const empty = makeAgent(makeSession().startTurn(2))
  assert.equal(contexts(await postExecute(empty)).length, 0)
})

test('contexts a listener did not attach survive the plugin’s own append', async () => {
  const { postExecute, contexts } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 } })
  // The compaction is what makes the advisory actually fire at this point: the
  // idle interval (9) is far off, and without a firing advisory the listener
  // returns the settled decision untouched — the append path below never runs
  // and dropping foreign contexts would be invisible. With `fire` true the
  // listener rebuilds `additionalContexts` from `decision.additionalContexts`,
  // which is exactly the line that can lose someone else's message.
  const session = makeSession().startTurn(1).writeTodos(UNFINISHED).startTurn(2).compact('cmp-1')
  const agent = makeAgent(session)
  const other = { id: 'x', role: 'user', content: [{ type: 'text', text: 'someone else' }] }
  const decision = await postExecute(agent, { kind: 'accept', additionalContexts: [other] })
  const texts = contexts(decision)
  assert.equal(texts.length, 2, 'the plugin appended its context instead of replacing the list')
  assert.equal(texts[0], 'someone else', "a context this listener did not create is preserved, first and unmodified")
  assert.match(texts[1], /context was just condensed/, 'the plugin advisory is the appended one')
  assert.equal(decision.additionalContexts[0], other, 'the foreign message object itself is passed through by reference')
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
  assert.equal(lines(logs, /goes quiet about the list t1:/).length, 1)
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

test('the notice summary is sliced to its bound even when the reason carries a huge id', async () => {
  // The `<= 120` above cannot kill the removal of `.slice(0, 120)` because ordinary
  // summaries never reach the bound. A compaction id is host-chosen text, so the
  // built summary can exceed 120 — this is the case that pins the truncation.
  const { postExecute } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 } })
  const hugeId = 'cmp-' + 'z'.repeat(200)
  const session = makeSession('wide-summary').startTurn(1).writeTodos(UNFINISHED).startTurn(2).compact(hugeId)
  const decision = await postExecute(makeAgent(session))
  const [advisory] = decision.additionalContexts
  assert.match(advisory.content[0].text, /context was just condensed/)
  assert.equal(advisory.source.summary.length, 120, 'the collapsed summary is clipped at the 120-char bound')
  assert.match(advisory.source.summary, /^todo-continuation: the model was reminded of its todo list — 1 of 1 unfinished \(compaction id=cmp-zzz/)
})

// ------------------------------------------------------- P6: delegated sessions

/**
 * A session whose header marks it as a subagent child (durable `origin`, or a
 * `delegationDepth` > 0 — isDelegated accepts either).
 * @param {string} id
 * @param {{ id?: string, origin?: string, delegationDepth?: number }} [header]
 */
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

// ---------------------------------------------------- v0.7.0 fixes (wave 0/1)

test('W1: a throwing events getter at the stop boundary fails open', async () => {
  const { gate, logs } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 } })
  const session = makeSession('w1-a').startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  Object.defineProperty(session, 'events', { get() { throw new Error('log IO exploded') } })
  assert.doesNotThrow(() => gate(agent, 1), 'the turn must not be destroyed by a plugin read failure')
  assert.ok(lines(logs, /stop gate unavailable/).length === 1, 'the failure is reported loudly, once per boundary')
})

test('W1: a malformed todo/write is ignored, a later valid one wins', async () => {
  const { gate, logs } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1 } })
  const session = makeSession('w1-b').startTurn(1)
  session.events.push({ type: 'todo/write', data: { todos: 'not-an-array' } })
  session.startTurn(2)
  const agent = makeAgent(session)
  gate(agent, 2)
  assert.equal(agent.steered.length, 0, 'a malformed record is not a list')
  // Without the Array.isArray guard in readStandingTodos, the same silence is
  // produced by a swallowed TypeError landing in the fail-open catch — an
  // observable-identical but WRONG world. The error line is what separates them.
  assert.equal(lines(logs, /^error/).length, 0,
    'the malformed record was ignored by the guard, not by the failure-isolation catch')
  session.writeTodos(UNFINISHED)
  session.startTurn(3)
  gate(agent, 3)
  assert.equal(agent.steered.length, 1, 'the next valid write is picked up')
})

test('a turn/start record with a missing or non-numeric turn is ignored, keeping the last known turn', async () => {
  // Replayed logs may hold records from builds with other payloads (see the guard's
  // comment in readStandingTodos). Without the numeric check the malformed record
  // erases the current turn: `writtenTurn` later compares against `undefined`, the
  // gate silently never fires, and the advisory renders a NaN idle count.
  const { gate, logs, texts } = await setup({ scopeValue: { logDecisions: true } })
  const session = makeSession('bad-turn')
  session.events.push({ type: 'turn/start', data: { turn: 1 } })
  session.events.push({ type: 'turn/start', data: {} })
  session.events.push({ type: 'todo/write', data: { todos: UNFINISHED } })
  const agent = makeAgent(session)
  gate(agent, 1)
  assert.equal(agent.steered.length, 1)
  assert.match(texts(agent)[0], /cannot stop/, 'a real stop-gate veto — not an advisory built on a NaN idle count')
  assert.equal(lines(logs, /at=stop-boundary gate:block unfinished=1\/1 vetoes=1\/2$/).length, 1)
})

test('a list written before any turn/start has no idle clock and is never nagged', async () => {
  // `writtenTurn === 0` means "the write belongs to no recorded turn": counting idle
  // from 0 would age every reminder and eventually trip the too-old horizon wrongly.
  const { gate, logs } = await setup({ scopeValue: { ...GATE_OFF, logDecisions: true, staleTodoPromptEveryNTurns: 1 } })
  const session = makeSession('zero-turn')
  session.events.push({ type: 'todo/write', data: { todos: UNFINISHED } })
  const agent = makeAgent(session)
  gate(agent, 2)
  assert.equal(agent.steered.length, 0)
  assert.equal(lines(logs, /skip:no-write-turn$/).length, 1, 'the reason is recorded, not guessed at')
})

test('W2: placeholders inside todo content survive the substitution verbatim', async () => {
  const { gate, texts } = await setup({
    scopeValue: {
      ...GATE_OFF,
      staleTodoPromptEveryNTurns: 1,
      staleTodoPromptTemplate: 'Plan so far:\n{todos}\n\n{unfinished} of {total} unfinished for {n} turn(s).',
    },
  })
  const tricky = [{ content: 'Fix {total} and {unfinished} and {n}', status: 'pending' }]
  const session = makeSession('w2').startTurn(1).writeTodos(tricky)
  const agent = makeAgent(session)
  session.startTurn(2)
  gate(agent, 2)
  const text = texts(agent)[0]
  assert.equal(text, 'Plan so far:\n- [pending] Fix {total} and {unfinished} and {n}\n\n1 of 1 unfinished for 1 turn(s).',
    'todo content is model text: it is data, not a template — and no duplicate list is appended')
})

test('W6: a duplicate registration reads the live namespace instead of degrading', async () => {
  const { gate, logs } = await setup({
    duplicate: true,
    scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1 },
  })
  const session = makeSession('w6').startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  session.startTurn(2)
  gate(agent, 2)
  assert.equal(agent.steered.length, 1, 'the recovered scope still drives the advisory')
  assert.ok(lines(logs, /already registered/).length >= 1, 'the recovery is announced')
  assert.equal(lines(logs, /DEGRADED/).length, 0, 'no degradation while the live namespace is reachable')
})

test('W8: a list ignored for 21+ intervals is abandoned work, not a plan', async () => {
  const { gate, logs } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1, ...DECIDE } })
  const session = makeSession('w8').startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  session.startTurn(2)
  gate(agent, 2) // idle 1: fires
  assert.equal(agent.steered.length, 1)
  session.startTurn(23)
  gate(agent, 23) // idle 22 > 1 * 20: past the horizon
  assert.equal(agent.steered.length, 1, 'past the horizon the list is not re-injected')
  assert.equal(lines(logs, /skip:too-old idle 22$/).length, 1)
})

test('W8: the horizon never mutes a post-compaction hand-back', async () => {
  const { gate, texts } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1 } })
  const session = makeSession('w8-b').startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  session.startTurn(50).compact('cmp-h')
  gate(agent, 50)
  assert.equal(agent.steered.length, 1, 'a condensation is a fresh "you lost the plan" event')
  assert.match(texts(agent)[0], /context was just condensed/)
})

test('W9: a fresh list written in the same turn escapes the old list quiet flag', async () => {
  const { postExecute, contexts, logs } = await setup({
    scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1, maxPromptsPerList: 1 },
  })
  const session = makeSession('w9-a').startTurn(1)
  const agent = makeAgent(session)
  session.writeTodos(UNFINISHED).compact('cmp-w9') // list A, then a condensation
  assert.equal(contexts(await postExecute(agent)).length, 1, 'fire 1 for list A → cap 1 → quiet')
  session.writeTodos(MIXED) // the model answers with a NEW list, still in turn 1
  session.startTurn(2)
  assert.equal(contexts(await postExecute(agent)).length, 1, 'the fresh list must not inherit the old list quiet flag')
  assert.equal(lines(logs, /skip:quiet$/).length, 0)
})

test('W9: a rewritten list, even with identical content, restarts the per-list cap', async () => {
  const { postExecute, contexts } = await setup({
    scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 1, maxPromptsPerList: 1 },
  })
  const session = makeSession('w9-b').startTurn(1).writeTodos(UNFINISHED)
  const agent = makeAgent(session)
  session.startTurn(2)
  assert.equal(contexts(await postExecute(agent)).length, 1, 'fire 1 → quiet about list A')
  session.startTurn(3)
  assert.equal(contexts(await postExecute(agent)).length, 0, 'still quiet: the list did not change')
  session.writeTodos(UNFINISHED) // a verbatim rewrite is still a fresh write at turn 3
  session.startTurn(4)
  assert.equal(contexts(await postExecute(agent)).length, 1, 'a fresh write is a fresh list: the cap starts over')
})

test('W10: a log that shrank is re-read from scratch, not resumed', async () => {
  const { gate } = await setup({ scopeValue: { ...GATE_OFF, staleTodoPromptEveryNTurns: 9 } })
  const session = makeSession('w10').startTurn(1).writeTodos(UNFINISHED).startTurn(2).compact('cmp-1')
  const agent = makeAgent(session)
  gate(agent, 2)
  assert.equal(agent.steered.length, 1, 'the compaction hand-back fires')
  session.events.length = 0 // a replaced/truncated log: the fold must be dropped
  session.startTurn(1).writeTodos(UNFINISHED).startTurn(2)
  gate(agent, 2)
  assert.equal(agent.steered.length, 1, 'the truncated log has no compaction: no second hand-back')
})

test('W10: a tail truncation that keeps the log head drops the records that were cut', async () => {
  // The scenario above replaces the whole log, so it invalidates the fold through
  // the `firstEvent` identity check — the `events.length < cached.size` disjunct
  // never decides anything there. A tail truncation keeps `events[0]`: if the fold
  // is not dropped on shrink, its incremental loop runs zero iterations and hands
  // back a list that no longer exists in the log — a veto (or a prompt) from a
  // resurrected record. The stop gate stays ON here because the resurrected list
  // would veto: the observable difference is exactly the extra steer.
  const { gate } = await setup({ scopeValue: { staleTodoPromptEveryNTurns: 9 } })
  const session = makeSession('w10-tail')
  session.events.push({ type: 'turn/start', data: { turn: 1 } })
  session.events.push({ type: 'turn/start', data: { turn: 2 } })
  session.events.push({ type: 'todo/write', data: { todos: UNFINISHED } })
  const agent = makeAgent(session)
  gate(agent, 3) // folds the whole log: the list stands from turn 2, nothing is due yet
  session.events.length = 2 // the write record is cut; events[0] identity is PRESERVED
  gate(agent, 2)
  assert.equal(agent.steered.length, 0, 'a truncated-away list neither vetoes nor reminds')
})

// --------------------------------------------- client chip: pure status functions

/**
 * Loads the browser module in node the way the browser really does: `client.js`
 * registers itself through `window.__ModuleLoader__.load`, so a window shim on
 * globalThis plus a real `import()` captures the registration. Loading it with
 * `new Function(code)` also "works" but folds every client line into this file's
 * coverage totals — the coverage report then cannot see client.js at all and the
 * project number is an artifact of the measurement, not of the tests.
 */
let clientRecord
const installWindow = () => Object.defineProperty(globalThis, 'window', {
  value: { __ModuleLoader__: { load: (record) => { clientRecord = record } } },
  configurable: true,
  writable: true,
})
const uninstallWindow = () => Object.defineProperty(globalThis, 'window', {
  value: undefined, configurable: true, writable: true,
})

/**
 * A minimal stateful React: hook state survives re-renders of the same component
 * function, effects run synchronously, createElement only records the tree. That
 * is enough to exercise the slot wiring and the TemplateField save contract
 * without a DOM. The async chip fetch deliberately stays out of node's scope —
 * it is fail-open by design and the pure derivation behind it is fully tested.
 */
function makeReactShim() {
  const react = {
    __hooks: null,
    __cursor: 0,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) {
      const slot = react.__hooks[react.__cursor] ??= { value: typeof initial === 'function' ? initial() : initial }
      react.__cursor += 1
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useEffect: (fn) => { fn() },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    /** Renders one component instance; hook state persists on the component function. */
    render(type, props) {
      type.__hooks ??= []
      react.__hooks = type.__hooks
      react.__cursor = 0
      return type(props)
    },
  }
  return react
}

const reactShim = makeReactShim()
installWindow()
try {
  await import('../client.js')
} finally {
  uninstallWindow()
}
assert.ok(clientRecord, 'client.js must register itself through window.__ModuleLoader__.load')
assert.equal(clientRecord.id, '@doiiarx/dsh-todo-continuation')
const client = clientRecord.factory(() => reactShim)
const { computeTodoGateStatus, statusText, deliveryKind, durableStandingTodos, lastDelivery } = client

/** Event builders shaped like the real session log records (time = epoch ms). */
const T0 = 1789000000000
const at = (minutes) => T0 + minutes * 60_000
const turnStart = (minutes) => ({ type: 'turn/start', data: { turn: 1 }, time: at(minutes) })
const write = (todos, minutes) => ({ type: 'todo/write', data: { todos }, time: at(minutes) })
const delivery = (summary, minutes) => ({
  type: 'user/message',
  data: { source: { kind: 'plugin', plugin: 'todo-continuation', form: 'notice', summary } },
  time: at(minutes),
})
const toolResult = (minutes) => ({ type: 'tool/result', data: {}, time: at(minutes) })

test('chip: the standing list is DURABLE — found across turn/start (unlike the host panel projection)', () => {
  const events = [turnStart(0), write(MIXED, 1), turnStart(2), toolResult(3), turnStart(4)]
  const standing = durableStandingTodos(events)
  assert.ok(standing, 'the last todo/write is found even with later turn/start records')
  assert.equal(standing.todos, MIXED)
  assert.equal(computeTodoGateStatus(events)?.total, 3)
  assert.equal(computeTodoGateStatus(events)?.unfinished, 2)
})

test('chip: idle turns count only turn/start records after the last write', () => {
  const events = [turnStart(0), write(MIXED, 1), toolResult(2), turnStart(3), turnStart(4)]
  assert.equal(computeTodoGateStatus(events)?.idleTurns, 2)
})

test('chip: deliveries are classified by their one-line summary wording', () => {
  assert.equal(deliveryKind('todo-continuation: the model was reminded of its todo list — 4 of 5 unfinished (stale idle=3)'), 'stale')
  assert.equal(deliveryKind('todo-continuation: the model was reminded of its todo list — 4 of 5 unfinished (compaction id=abc)'), 'compaction')
  assert.equal(deliveryKind('todo-continuation: turn sent back — 1 of 6 todo item(s) unfinished'), 'veto')
  assert.equal(deliveryKind(''), null)
})

test('chip: a compaction hand-back is flagged as a restore', () => {
  const events = [
    turnStart(0), write(UNFINISHED, 1), turnStart(2),
    delivery('todo-continuation: the model was reminded of its todo list — 1 of 1 unfinished (compaction id=abc)', 3),
  ]
  const restored = lastDelivery(events)
  assert.equal(restored?.restored, 'compaction')
})

test('chip: a stale reminder that bridges a long silence is flagged as a resume restore', () => {
  // turn 2 opens ~10 minutes after the previous event: a restart/reopen gap.
  const events = [
    turnStart(0), write(UNFINISHED, 1), turnStart(2), toolResult(3),
    turnStart(13),
    delivery('todo-continuation: the model was reminded of its todo list — 1 of 1 unfinished (stale idle=2)', 14),
  ]
  const restored = lastDelivery(events)
  assert.equal(restored?.restored, 'resume')
})

test('chip: a stale reminder inside continuous work is NOT a restore', () => {
  const events = [
    turnStart(0), write(UNFINISHED, 1), turnStart(1.5),
    delivery('todo-continuation: the model was reminded of its todo list — 1 of 1 unfinished (stale idle=2)', 2),
  ]
  assert.equal(lastDelivery(events)?.restored, false)
  // The discriminating path for the backscan's `todo/write → break`: the delivery's
  // turn opens after a LONG silence (it looks exactly like the resume case above),
  // but the model rewrote the list inside that turn before the delivery — the walk
  // backwards must stop at that write, not reach the gap and call this a restore.
  const answeredThisTurn = [
    turnStart(0), toolResult(1), turnStart(10),
    write(UNFINISHED, 11),
    delivery('todo-continuation: the model was reminded of its todo list — 1 of 1 unfinished (stale idle=2)', 12),
  ]
  assert.equal(lastDelivery(answeredThisTurn)?.restored, false,
    'a same-turn todo/write proves the model already had the list — a gap before the turn is not a restore')
})

test('chip: the veto wording is never a restore', () => {
  const events = [
    turnStart(0), write(UNFINISHED, 1), turnStart(1.5),
    delivery('todo-continuation: turn sent back — 1 of 1 todo item(s) unfinished', 2),
  ]
  assert.equal(lastDelivery(events)?.kind, 'veto')
  assert.equal(lastDelivery(events)?.restored, false)
})

test('chip: status text carries the counts, the idle span and the last action', () => {
  const events = [
    turnStart(0), write(MIXED, 1), turnStart(2),
    delivery('todo-continuation: the model was reminded of its todo list — 2 of 3 unfinished (compaction id=abc)', 3),
  ]
  const status = computeTodoGateStatus(events)
  const text = statusText(status)
  assert.match(text, /Todo Gate · 2\/3 unfinished · idle 1t/)
  assert.match(text, /restored after compaction \d{2}:\d{2}/)
})

test('chip: a fully completed list reads as done, a session without lists renders nothing', () => {
  const done = [turnStart(0), write(COMPLETED, 1)]
  assert.match(statusText(computeTodoGateStatus(done)), /Todo Gate · 1\/1 done/)
  assert.equal(computeTodoGateStatus([turnStart(0), toolResult(1)]), null, 'no todo/write — no chip')
  assert.equal(statusText(null), null)
  assert.equal(statusText(computeTodoGateStatus([{ type: 'todo/write', data: { todos: [] }, time: at(1) }])), null, 'an empty list is not a standing plan')
})

// ------------------------------------------------ browser wiring (defaults / slots / UX)

test('host and client ship identical settings defaults (duplication drift guard)', () => {
  // Two-sided packages cannot share a module, so client.js mirrors the host's
  // defaults for fallback rendering. Without this pin, a default changed only in
  // index.js silently desyncs the settings page from real behavior.
  const norm = (v) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n') : v)
  assert.deepEqual(Object.keys(client.DEFAULTS).sort(), Object.keys(HOST_DEFAULTS).sort())
  for (const key of Object.keys(HOST_DEFAULTS)) {
    assert.equal(norm(client.DEFAULTS[key]), norm(HOST_DEFAULTS[key]),
      `client.js default "${key}" drifted from index.js — mirror the change in both files`)
  }
})

test('client apply() registers the settings section and the status-chip slot the host consumes', () => {
  const registrations = []
  const scope = { bound: null }
  const connection = {}
  client.apply({
    settingsScope: { bind: (opts) => { scope.bound = opts; return scope } },
    connection,
    slots: {
      inject: (slotName, provider) => { registrations.push({ slotName, built: provider() }) },
      register: (spec, component) => ({ spec, component }),
    },
  })
  assert.deepEqual(client.inject, ['slots', 'settingsScope', 'connection'])
  assert.deepEqual(scope.bound, { namespace: 'todo-continuation' }, 'the namespace the host binds for the page')
  assert.deepEqual(registrations.map(r => r.slotName), ['settings.section', 'conversation.input.left'])
  const settings = registrations[0].built
  assert.equal(settings.spec.name, 'settings.section')
  assert.equal(settings.spec.id, 'todo-continuation')
  assert.equal(settings.spec.order, 140)
  assert.equal(settings.spec.label, 'Todo Gate')
  assert.equal(typeof settings.component, 'function')
  assert.equal(settings.spec.inject().scope, scope, 'the settings component receives the bound scope')
  const chip = registrations[1].built
  assert.equal(chip.spec.name, 'conversation.input.left')
  assert.deepEqual(chip.spec.inject('session-7'), { sessionId: 'session-7', connection },
    'the chip receives the live sessionId and the connection it reads the durable log through')
})

test('client TemplateField: an invalid draft is shown inline and never written; a valid one saves on blur', () => {
  const saved = 'Plan for {n}: {todos}'
  const sets = []
  const scope = {
    subscribe: () => () => {},
    getSnapshot: () => ({
      status: 'ready',
      writable: true,
      value: { staleTodoPromptTemplate: saved, compactionPromptTemplate: 'condensed text', promptAfterCompaction: true },
    }),
    set: (field, value) => { sets.push([field, value]) },
  }
  const components = {}
  client.apply({
    settingsScope: { bind: () => scope },
    connection: {},
    slots: {
      inject: (_slot, provider) => { const built = provider(); components[built.spec.name] = built },
      register: (spec, component) => ({ spec, component }),
    },
  })
  const Settings = components['settings.section'].component
  const tree = reactShim.render(Settings, { scope })
  const items = [...JSON.stringify(tree).matchAll(/"data-settings-item":"(\w+)"/g)].map(m => m[1])
  // The two template fields carry their marker inside the TemplateField component,
  // which createElement only records (child components render when invoked).
  assert.deepEqual(items, [
    'staleTodoPromptEveryNTurns', 'gateMaxSteersPerTurn', 'gateSubagents',
    'promptAfterCompaction', 'logDecisions', 'maxPromptsPerList',
  ], 'every inline setting renders its host-visible item marker, in page order')

  const findElement = (node, predicate) => {
    if (node === null || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    for (const child of node.children ?? []) {
      const found = findElement(child, predicate)
      if (found) return found
    }
    return undefined
  }
  const fieldElement = findElement(tree, (n) => n.props?.field === 'staleTodoPromptTemplate')
  assert.ok(fieldElement, 'the settings section renders the stale-template field')
  assert.equal(fieldElement.props.savedValue, saved, 'the field starts from the resolved stored template')
  const renderTextarea = () => {
    const fieldTree = reactShim.render(fieldElement.type, fieldElement.props)
    // Rendered, the TemplateField carries its own marker too, in its page slot.
    assert.ok(JSON.stringify(fieldTree).includes('"data-settings-item":"staleTodoPromptTemplate"'))
    return findElement(fieldTree, (n) => n.type === 'textarea')
  }

  // 1) Someone edits {n} out: the field goes invalid inline, and NO path writes it.
  let textarea = renderTextarea()
  textarea.props.onChange({ target: { value: 'placeholder deleted' } })
  const invalid = reactShim.render(fieldElement.type, fieldElement.props)
  textarea = findElement(invalid, (n) => n.type === 'textarea')
  assert.equal(textarea.props.value, 'placeholder deleted', 'the draft survives the re-render as local state')
  assert.ok(JSON.stringify(invalid).includes('will not be saved until the placeholder is restored'),
    'the invalidity is explained to the user, not just colored')
  textarea.props.onBlur()
  assert.deepEqual(sets, [], 'an invalid draft is NEVER persisted — blur or anything else')

  // 2) A valid draft saves exactly once, on blur.
  textarea.props.onChange({ target: { value: 'Plan v2 {n}' } })
  const valid = reactShim.render(fieldElement.type, fieldElement.props)
  textarea = findElement(valid, (n) => n.type === 'textarea')
  assert.ok(JSON.stringify(valid).includes('Valid — saved when you leave the field.'))
  textarea.props.onBlur()
  assert.deepEqual(sets, [['staleTodoPromptTemplate', 'Plan v2 {n}']], 'the valid draft is persisted once on blur')
})
