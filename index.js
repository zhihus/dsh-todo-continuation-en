/**
 * @doiiarx/dsh-todo-continuation — Todo stop gate + prompt plugin (host level).
 *
 * Two-sided package (same working pattern as @doiiarx/dsh-user-language):
 *   - Host side (this file): registers the `todo-continuation` settings namespace
 *     (the stale-todo interval, the per-turn stop-gate cap and the advisory text),
 *     listens for `agent/turn-stopping` (the stop boundary) and for
 *     `tools/post-execute` (mid-turn delivery), and implements:
 *       1) Stop gate: keeps the turn going while THIS turn's latest todo/write
 *          snapshot still contains unfinished todos. The gate stays deliberately
 *          turn-local: DSH clears the standing plan at every `turn/start`, so a
 *          gate that read the durable list would veto every later turn forever.
 *          `gateMaxSteersPerTurn` caps how many vetoes one turn may collect, so a
 *          model that cannot finish the plan ends its turn instead of looping.
 *       2) Stale-todo prompt: when the session's standing todo list (the last
 *          `todo/write` in the durable session log) still has unfinished items
 *          and has not been rewritten for N turns, injects the advisory —
 *          carrying the list itself, so the model can pick it back up after a
 *          compaction or a host restart.
 *       3) Compaction prompt (v0.6.0): when a compaction summary lands in the log
 *          AFTER the standing list was last written, the model has just lost its
 *          own copy of the plan — hand the list straight back, without waiting
 *          for the stale interval. At most one prompt per `compactionId`.
 *       4) Per-list reminder cap (v0.6.0, opt-in): `maxPromptsPerList` advisories
 *          for one unchanged list are the last ones. A plan that was ignored that
 *          many times will not be read on the next hand-back either, so the plugin
 *          goes quiet until the model rewrites the list or a new compaction lands
 *          — and says so once in the log. The default (0) never goes quiet: the
 *          reminder repeats every interval, like the original plugin.
 *       5) Visible notices (v0.6.0): every injection carries `form: 'notice'` and a
 *          one-line summary, so the client renders it in the transcript as a
 *          collapsed row instead of opaque content only the model ever saw.
 *     The advisory reaches the model on two seams: at the stop boundary and, from
 *     v0.6.0, mid-turn as additional context on a tool result, because a turn that
 *     dies on a provider error, a cancellation or a message typed while it is still
 *     open never reaches a stop boundary at all. The mid-turn channel only adds
 *     context: it calls `next()` first, never vetoes, and swallows its own failures.
 *     `gateSubagents` (default true) decides whether a delegated session is vetoed
 *     as well; context reminders reach a subagent either way.
 *     Everything the advisory needs is derived from the session log at check
 *     time, never from a per-process memory of what the plugin happened to see:
 *     a resumed or forked session, or a host restart mid-plan, is judged exactly
 *     like a session that stayed up. Only rate limiting (how often one stale list
 *     may re-prompt) and the per-turn veto count live in memory, and losing them
 *     costs at most one extra reminder.
 *     The model alone decides whether to plan with todos: a session that has
 *     never written a `todo/write` is never prompted (v0.4.0 removed the no-todo
 *     advisory), and a list whose items are all completed is not nagged either —
 *     there is nothing left to restore.
 *     Thresholds and templates are read live from settings, so a change in the
 *     settings page takes effect on the next turn. A template must contain the
 *     required `{n}` placeholder (schema-enforced: a template without it is
 *     rejected before it can be persisted); unknown placeholders are rendered
 *     verbatim.
 *   - Browser side (client.js): renders the "Todo Gate" section in the settings
 *     page for editing the interval, the veto cap and the prompt template.
 *
 * Failure isolation (same as user-language): this file keeps zero external
 * dependencies; schemastery is imported dynamically in apply() and any failure
 * degrades to built-in defaults — but LOUDLY, because a silently degraded
 * interval is indistinguishable from "the plugin does nothing".
 */

import { randomUUID } from 'node:crypto'

export const name = 'todo-continuation-supervisor'
export const inject = ['settings']

const SETTINGS_NS = 'todo-continuation'
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'todo-continuation' }
const DEFAULT_STALE_EVERY = 5
const DEFAULT_GATE_MAX_STEERS = 2
const DEFAULT_PROMPT_AFTER_COMPACTION = true
// Off by default: per-boundary decision lines are for diagnosis, not for the
// steady-state log.
const DEFAULT_LOG_DECISIONS = false
// Delegated agents keep the veto by default (same contract as a top-level turn);
// the switch exists for users who want a subagent to finish "good enough" and
// report, rather than be pushed to close every item.
const DEFAULT_GATE_SUBAGENTS = true
// The veto cap is deliberately bounded: a typo that sets it to a huge number
// restores the exact failure v0.5.0 removed (one stop boundary vetoed ~150 times).
const MAX_GATE_STEERS = 10
// Settings the plugin no longer reads. An inert key is as confusing as a broken
// plugin, so it is named once at startup instead of being silently ignored.
const REMOVED_KEYS = ['noTodoPromptEveryNTurns', 'noTodoPromptTemplate', 'waitingTodoPrefixes']
// Bounds on the rendered list: the advisory is injected into a live turn, so a
// pathological list must not turn one reminder into a context flood.
const MAX_LISTED_TODOS = 30
const MAX_TODO_LINE_CHARS = 200
// A standing list the model has ignored for this many intervals in a row is
// abandoned work, not a live plan: keep re-injecting it past this horizon and the
// reminder becomes background noise the model has learned to skip (`{n}` keeps
// growing forever). The compaction hand-back is deliberately NOT subject to this
// horizon — a condensation is a fresh "you lost the plan" event. Not a setting:
// an unbounded reminder is a defect, not a preference.
const MAX_STALE_HORIZON_FACTOR = 20

// `{n}` is the ACTUAL number of turns the standing list has been untouched (it
// used to be the configured interval, which made the reminder state a number it
// could not know). `{todos}` renders the standing list itself.
const DEFAULT_STALE_TEMPLATE = `Automated note: the standing todo list has {unfinished} unfinished of {total} item(s) and has not been updated for the last {n} turn(s).

The list as recorded in this session (newest todo_write wins; it may have left your context after a compaction):
{todos}

Do exactly one of these, then continue with the user's request:
1. The plan still stands: take one concrete step on the oldest unfinished item and record the new statuses with \`todo_write\` (send the ENTIRE list).
2. The list no longer matches the work (done, abandoned, or superseded): rewrite it to the true state, or clear it with an empty list.
Do not invent items nobody asked for.`

// A compaction replaces earlier turns with one summary node, and the model's own
// copy of the plan usually goes with them. This advisory names that moment, so it
// requires no placeholder of its own.
const DEFAULT_COMPACTION_TEMPLATE = `Automated note: this session's context was just condensed, so the standing todo list may no longer be in view. {unfinished} of {total} item(s) are still unfinished.

{todos}

Do exactly one of these, then continue with the user's request:
1. The plan still stands: take one concrete step on the oldest unfinished item and restore the list with \`todo_write\` (send the ENTIRE list with real statuses).
2. The list no longer matches the work: rewrite it to the true state, or clear it with an empty list.
Do not invent items nobody asked for.`

function report(ctx, scope, error) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const message = `[todo-continuation] ${scope} unavailable: ${detail}`
  emit(ctx, 'error', message)
  return message
}

function warn(ctx, message) {
  emit(ctx, 'warn', message)
}

/**
 * Reads the standing todo list from the durable session log: the LAST `todo/write`
 * snapshot and the turn number that wrote it (turns are tracked from `turn/start`,
 * which is what makes the answer survive a restart — the log is the source of
 * truth, not the plugin's memory). A `compaction/summary` record is a landed
 * compaction (its failed attempts never produce one, only an errored
 * `compaction/end`), so it is the durable marker of "the model lost its copy".
 * @param session - the agent's session, read through its append-only event log.
 * @returns {{ todos: object[] | undefined, writtenTurn: number, size: number,
 *   currentTurn: number, compactionId: string | null, compactedAfterWrite: boolean,
 *   writePosition: number, compactionPosition: number, firstEvent: object | undefined }}
 *   the standing list (undefined when this session never wrote one), the turn that
 *   wrote it, the log size at read time (used to memoize the walk), the newest
 *   `turn/start` in the log (the mid-turn channel has no turn in its payload and
 *   reads this instead), the newest landed compaction with whether it came after
 *   that last write, the log positions of both records plus the log's first event
 *   (fold bookkeeping for the incremental scan in {@link standingTodos}).
 */
function readStandingTodos(session) {
  const events = session.events ?? []
  let turn = 0
  let todos
  let writtenTurn = 0
  let writePosition = -1
  let compactionId = null
  let compactionPosition = -1
  for (let position = 0; position < events.length; position++) {
    const event = events[position]
    if (event.type === 'turn/start') {
      if (typeof event.data?.turn === 'number') turn = event.data.turn
      continue
    }
    if (event.type === 'todo/write') {
      // A record of the wrong shape is not a list: ignore it and keep the last
      // valid one. The host invariant (`dsh-tool-todo`) only guards records this
      // host appended — replayed logs from other builds may not comply, and a
      // non-array here used to be a TypeError on `.filter` further down.
      const list = event.data?.todos
      if (Array.isArray(list)) {
        todos = list
        writtenTurn = turn
        writePosition = position
      }
      continue
    }
    if (event.type === 'compaction/summary') {
      compactionId = event.data?.compactionId ?? `(unnamed-${position})`
      compactionPosition = position
    }
  }
  return {
    todos,
    writtenTurn,
    // The newest `turn/start` the log holds: the mid-turn listener has no turn in
    // its payload, so this is how it knows which turn it is inside.
    currentTurn: turn,
    compactionId,
    compactedAfterWrite: compactionPosition > writePosition && compactionPosition >= 0,
    size: events.length,
    writePosition,
    compactionPosition,
    firstEvent: events[0],
  }
}

/**
 * The standing list is append-only and its records are frozen, so an already
 * folded prefix never changes: only the records appended since the last check
 * are folded (the host itself costs O(new events) per read the same way). The
 * fold is dropped and redone from scratch when the log shrank or its first event
 * changed identity — a different session object answering under the same id, or
 * a replaced replay log, must not inherit another log's fold.
 */
function standingTodos(session, state) {
  const events = session.events ?? []
  const cached = state.standing
  if (cached !== undefined
    && cached.size === events.length
    && cached.firstEvent === events[0]) return cached
  if (cached === undefined || events.length < cached.size || cached.firstEvent !== events[0]) {
    const fresh = readStandingTodos(session)
    state.standing = fresh
    return fresh
  }
  const fold = { ...cached }
  for (let position = cached.size; position < events.length; position++) {
    const event = events[position]
    if (event.type === 'turn/start') {
      if (typeof event.data?.turn === 'number') fold.currentTurn = event.data.turn
      continue
    }
    if (event.type === 'todo/write') {
      const list = event.data?.todos
      if (Array.isArray(list)) {
        fold.todos = list
        fold.writtenTurn = fold.currentTurn
        fold.writePosition = position
      }
      continue
    }
    if (event.type === 'compaction/summary') {
      fold.compactionId = event.data?.compactionId ?? `(unnamed-${position})`
      fold.compactionPosition = position
    }
  }
  fold.compactedAfterWrite = fold.compactionPosition > fold.writePosition && fold.compactionPosition >= 0
  fold.size = events.length
  state.standing = fold
  return fold
}

function unfinishedCount(todos) {
  return (todos ?? []).filter(todo => todo.status !== 'completed').length
}

function clipText(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > MAX_TODO_LINE_CHARS ? `${flat.slice(0, MAX_TODO_LINE_CHARS)}...` : flat
}

/** Renders the standing list for the advisory: status-tagged lines, capped in count and width. */
function renderTodos(todos) {
  const items = todos ?? []
  const shown = items.slice(0, MAX_LISTED_TODOS).map(todo => `- [${todo.status}] ${clipText(todo.content)}`)
  const omitted = items.length - Math.min(items.length, MAX_LISTED_TODOS)
  if (omitted > 0) shown.push(`- (+${omitted} more item(s) not shown)`)
  return shown.join('\n')
}

function continuationMessage(unfinished, total) {
  return `You cannot stop this turn while unfinished todos remain (${unfinished} of ${total}). `
    + 'Continue working and complete every unfinished todo, updating the list with `todo_write` as work finishes. '
    + 'If further progress requires user input, call `ask_user_question` instead of ending the turn. '
    + 'If the plan no longer matches the work, rewrite it or clear it with an empty `todo_write`.'
}

/**
 * Whether this session is a delegated (subagent) child rather than a
 * human-addressed top-level agent. DSH records that three ways, and a plugin that
 * decides whether to veto a stop should not bet on just one: the durable session
 * header (`origin: 'subagent'`, `delegationDepth` > 0) and — for sessions whose
 * header was written before those fields existed — the `subagent/descriptor` event
 * the subagent seam appends to every session-backed child. Unknown shapes count
 * as top-level, which is the behavior a missing field should not silently change.
 */
function isDelegated(session) {
  const header = session?.header
  if (header?.origin === 'subagent') return true
  if (Number.isSafeInteger(header?.delegationDepth) && header.delegationDepth > 0) return true
  for (const record of session?.events ?? []) {
    if (record?.type === 'subagent/descriptor') return true
  }
  return false
}

/**
 * Literal placeholder substitution in ONE pass: a value that itself contains a
 * placeholder-looking token (todo content is model-authored text!) must never be
 * re-substituted by a later key's pass, and unknown placeholders stay verbatim
 * (no template engine).
 */
function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match))
}

/**
 * Renders an advisory and guarantees the list itself is in the message: a reminder
 * that cannot show the plan is pointless, even when someone edited `{todos}` out
 * of the template.
 */
function renderAdvisory(template, vars, list) {
  const text = renderTemplate(template, vars)
  return text.includes(list) ? text : `${text}\n\n${list}`
}

/** An advisory outcome: either a text to deliver, or the reason there is none. */
function skipped(reason) {
  return { fire: false, reason }
}

function fired(reason, text, summary) {
  return { fire: true, reason, text, summary }
}

/** Writes one line through the host logger, falling back to the console. */
function emit(ctx, level, message) {
  const line = `[todo-continuation] ${message}`
  const logger = ctx.root?.logger?.('todo-continuation')
  if (typeof logger?.[level] === 'function') logger[level]('%s', line)
  else console.log(line)
}

/**
 * One decision line per boundary — but only with `logDecisions` on. The question
 * «is the plugin dead, or did the trigger simply not fire?» should not cost a
 * session-log forensics run to answer.
 */
function note(ctx, cfg, message) {
  if (cfg.logDecisions) emit(ctx, 'debug', message)
}

/**
 * Default cap on consecutive advisories for one and the same list state. `0` means
 * no cap: the reminder repeats every interval for as long as the list stands
 * unchanged — the original plugin's behavior. A plan ignored N times in a row will
 * not be read on the next hand-back either, which is why a cap exists at all, but
 * it is opt-in noise control, not a default: silence must never be a surprise.
 */
const DEFAULT_MAX_PROMPTS_PER_LIST = 0

/**
 * The settings defaults this side ships. `client.js` keeps a mirrored copy for
 * defensive fallback rendering — host and browser cannot share a module in this
 * package layout — and the suite pins the two copies together with a drift test
 * so a default changed here can never silently desync the settings page.
 * Exported for that contract; the plugin's behavior reads the constants above.
 */
export const DEFAULTS = Object.freeze({
  staleEvery: DEFAULT_STALE_EVERY,
  gateMaxSteers: DEFAULT_GATE_MAX_STEERS,
  maxGateSteers: MAX_GATE_STEERS,
  promptAfterCompaction: DEFAULT_PROMPT_AFTER_COMPACTION,
  logDecisions: DEFAULT_LOG_DECISIONS,
  gateSubagents: DEFAULT_GATE_SUBAGENTS,
  maxPromptsPerList: DEFAULT_MAX_PROMPTS_PER_LIST,
  staleTemplate: DEFAULT_STALE_TEMPLATE,
  compactionTemplate: DEFAULT_COMPACTION_TEMPLATE,
})

/**
 * The identity of "one and the same unchanged list" for the per-list cap and the
 * quiet period. The turn that wrote a list is NOT its identity: two different
 * lists written in one turn would share it, and a fresh plan would inherit the
 * old plan's quiet flag. The identity hashes the rendered form — that is already
 * the plugin's contract of "the list as the model saw it" — and prefixes the
 * writing turn so that a later todo_write (an answer, even a verbatim one)
 * counts as a new list and restarts the clock.
 */
function listIdentity(items, writtenTurn) {
  const source = JSON.stringify(items)
  let hash = 0
  for (let index = 0; index < source.length; index++) hash = (hash * 31 + source.charCodeAt(index)) | 0
  return `t${writtenTurn}:${hash >>> 0}`
}

/**
 * The standing-list advisory for one boundary, shared by both delivery channels
 * (the stop boundary and a mid-turn tool result). Post-compaction wins over the
 * idle interval — it is the reason the list is needed at all — and either one
 * records its rate limit in `state`, so a reminder never doubles across channels.
 *
 * `state` also carries the per-list cap: after `maxPromptsPerList` advisories for
 * the same unchanged list the plugin goes quiet, until the list itself changes or
 * a fresh compaction lands. `0` (the default) disables the cap entirely. Both
 * exits belong to the model, which is the point — silence must be escapable
 * without a restart.
 * @returns {{ fire: boolean, reason: string, text?: string, summary?: string }} the
 *   decision, with a machine-readable reason either way (that is what `logDecisions`
 *   prints); a fired decision also carries the one-line `summary` for the notice.
 */
function standingAdvisory(standing, turn, cfg, state, onQuiet) {
  const items = standing.todos
  if (items === undefined) return skipped('no-list')
  const unfinished = unfinishedCount(items)
  // Nothing to restore: an empty or fully completed list must not be nagged.
  if (unfinished === 0) return skipped('no-unfinished')
  const total = items.length
  const list = renderTodos(items)
  const idle = turn - standing.writtenTurn
  const listId = listIdentity(items, standing.writtenTurn)
  const newCompaction = cfg.afterCompaction && standing.compactedAfterWrite
    && standing.compactionId !== null && state.lastCompactionPromptId !== standing.compactionId
  if (state.quietListId === listId && !newCompaction) return skipped('quiet')
  if (state.quietListId !== null && state.quietListId !== listId) {
    // The list moved: the model did answer, so the quiet period is over by itself.
    state.quietListId = null
    state.promptListId = null
    state.promptsForList = 0
  }
  const deliver = (reason, text) => {
    if (state.promptListId !== listId) {
      state.promptListId = listId
      state.promptsForList = 1
    } else {
      state.promptsForList += 1
    }
    if (cfg.maxPromptsPerList > 0 && state.promptsForList >= cfg.maxPromptsPerList && state.quietListId === null) {
      state.quietListId = listId
      onQuiet?.(listId, cfg.maxPromptsPerList)
    }
    return fired(reason, text,
      `todo-continuation: the model was reminded of its todo list — ${unfinished} of ${total} unfinished (${reason})`)
  }
  if (newCompaction) {
    state.lastCompactionPromptId = standing.compactionId
    // The idle clock starts over here too: one boundary, one reminder.
    state.lastStalePromptTurn = turn
    return deliver(`compaction id=${standing.compactionId} idle=${idle}`,
      renderAdvisory(cfg.compactionTemplate, { n: idle, todos: list, total, unfinished }, list))
  }
  if (cfg.staleEvery === 0) return skipped('interval-off')
  if (standing.writtenTurn === 0) return skipped('no-write-turn')
  // Abandoned-work horizon: past this many idle intervals the plan is noise, not
  // a plan (see MAX_STALE_HORIZON_FACTOR). The compaction branch above is
  // deliberately exempt — a condensation is a fresh "you lost the plan" event.
  if (idle > cfg.staleEvery * MAX_STALE_HORIZON_FACTOR) return skipped(`too-old idle ${idle}`)
  if (idle < cfg.staleEvery) return skipped(`idle ${idle}<${cfg.staleEvery}`)
  // At most one reminder per interval for the same unchanged list.
  if (state.lastStalePromptTurn !== 0 && turn - state.lastStalePromptTurn < cfg.staleEvery) {
    return skipped(`cooldown ${turn - state.lastStalePromptTurn}<${cfg.staleEvery}`)
  }
  state.lastStalePromptTurn = turn
  return deliver(`stale idle=${idle}`,
    renderAdvisory(cfg.staleTemplate, { n: idle, todos: list, total, unfinished }, list))
}

/**
 * Builds a flagged user message (without depending on @deepseek-ai/dsh-llm).
 * `form: 'notice'` + a one-line `summary` are what make the injection VISIBLE to
 * the human: the client renders plugin notices as a collapsed transcript row with
 * the summary on it. Without them the content is opaque and only the model sees it.
 */
function steerMessage(text, summary) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      ...PLUGIN_SOURCE,
      form: 'notice',
      summary: String(summary ?? text).replace(/\s+/g, ' ').trim().slice(0, 120),
    },
  }
}

/** Reads one interval setting; `0` is a valid "disabled" value, anything invalid falls back. */
function readDisabledableNumber(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

/** Reads the veto cap, clamped to {@link MAX_GATE_STEERS} so a typo cannot loop a turn. */
function readCap(value) {
  const parsed = readDisabledableNumber(value, DEFAULT_GATE_MAX_STEERS)
  return parsed > MAX_GATE_STEERS ? MAX_GATE_STEERS : parsed
}

/** Reads one prompt template; it must be a string containing the required `{n}` placeholder, otherwise the built-in default is used. */
function readTemplate(value, fallback) {
  return typeof value === 'string' && value.includes('{n}') ? value : fallback
}

/** Reads a prompt template that must not contain any placeholder to be usable. */
function readPlainText(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

/** Reads a boolean switch; anything that is not a boolean keeps the default. */
function readFlag(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Reads and normalizes the config values from settings. */
function readConfig(scope) {
  const value = scope?.get?.() ?? {}
  return {
    staleEvery: readDisabledableNumber(value.staleTodoPromptEveryNTurns, DEFAULT_STALE_EVERY),
    gateMaxSteers: readCap(value.gateMaxSteersPerTurn),
    staleTemplate: readTemplate(value.staleTodoPromptTemplate, DEFAULT_STALE_TEMPLATE),
    afterCompaction: readFlag(value.promptAfterCompaction, DEFAULT_PROMPT_AFTER_COMPACTION),
    compactionTemplate: readPlainText(value.compactionPromptTemplate, DEFAULT_COMPACTION_TEMPLATE),
    logDecisions: readFlag(value.logDecisions, DEFAULT_LOG_DECISIONS),
    gateSubagents: readFlag(value.gateSubagents, DEFAULT_GATE_SUBAGENTS),
    maxPromptsPerList: readDisabledableNumber(value.maxPromptsPerList, DEFAULT_MAX_PROMPTS_PER_LIST),
  }
}

export async function apply(ctx, config = {}) {
  // 1) Register the persistable settings namespace (edited in the settings page).
  //    Templates are schema-validated: a template without the required `{n}`
  //    placeholder is rejected before it can ever be persisted.
  let scope
  try {
    const { default: Schema } = await import('@deepseek-ai/schemastery')
    const base = {
      staleTodoPromptEveryNTurns: config.staleTodoPromptEveryNTurns ?? DEFAULT_STALE_EVERY,
      gateMaxSteersPerTurn: config.gateMaxSteersPerTurn ?? DEFAULT_GATE_MAX_STEERS,
      staleTodoPromptTemplate: config.staleTodoPromptTemplate ?? DEFAULT_STALE_TEMPLATE,
      promptAfterCompaction: config.promptAfterCompaction ?? DEFAULT_PROMPT_AFTER_COMPACTION,
      compactionPromptTemplate: config.compactionPromptTemplate ?? DEFAULT_COMPACTION_TEMPLATE,
      logDecisions: config.logDecisions ?? DEFAULT_LOG_DECISIONS,
      gateSubagents: config.gateSubagents ?? DEFAULT_GATE_SUBAGENTS,
      maxPromptsPerList: readDisabledableNumber(config.maxPromptsPerList, DEFAULT_MAX_PROMPTS_PER_LIST),
    }
    scope = ctx.settings.register(SETTINGS_NS, Schema.object({
      staleTodoPromptEveryNTurns: Schema.number().default(base.staleTodoPromptEveryNTurns),
      gateMaxSteersPerTurn: Schema.number().default(base.gateMaxSteersPerTurn),
      staleTodoPromptTemplate: Schema.string().default(base.staleTodoPromptTemplate).pattern(/\{n\}/),
      promptAfterCompaction: Schema.boolean().default(base.promptAfterCompaction),
      compactionPromptTemplate: Schema.string().default(base.compactionPromptTemplate),
      logDecisions: Schema.boolean().default(base.logDecisions),
      gateSubagents: Schema.boolean().default(base.gateSubagents),
      maxPromptsPerList: Schema.number().default(base.maxPromptsPerList),
    }), { base, applies: 'live' })
  } catch (error) {
    // Degradation is deliberate (a broken namespace must not take the profile
    // down) but it must never be silent: with no namespace the plugin still
    // gates and still reminds, just on built-in thresholds nobody can see.
    // One degradation is recoverable without a restart: the namespace may already
    // be registered by another mount of this plugin (a hot reload, a double entry
    // in the bundle) — the host rejects the SECOND registration but keeps serving
    // the first one, and `settings.get(ns)` reads that live registration.
    const live = ctx.settings?.get?.(SETTINGS_NS)
    if (live !== undefined) {
      warn(ctx, `[todo-continuation] settings namespace "${SETTINGS_NS}" is already registered — reading the `
        + `live registration instead of degrading to built-in defaults.`)
      scope = { get: () => live }
    } else {
      report(ctx, 'settings', error)
      warn(ctx, `[todo-continuation] DEGRADED: settings namespace is unavailable, using built-in defaults `
        + `(stale every ${DEFAULT_STALE_EVERY} turns, gate cap ${DEFAULT_GATE_MAX_STEERS} vetoes/turn). `
        + `The "Todo Gate" settings section will not work until this is fixed.`)
      scope = null
    }
  }

  // Config hygiene, announced once per mount: an inert key and an unreachably high
  // cap both look exactly like "the plugin stopped working" from the outside.
  if (scope) {
    const stored = scope.get() ?? {}
    const removed = REMOVED_KEYS.filter(key => key in stored)
    if (removed.length > 0) {
      warn(ctx, `[todo-continuation] ignoring removed setting(s) ${removed.join(', ')} — they do nothing since `
        + `v0.4.0 and can be deleted from your settings file.`)
    }
    if (Number.isSafeInteger(stored.gateMaxSteersPerTurn) && stored.gateMaxSteersPerTurn > MAX_GATE_STEERS) {
      warn(ctx, `[todo-continuation] "Stop-gate vetoes per turn" = ${stored.gateMaxSteersPerTurn} is clamped to `
        + `${MAX_GATE_STEERS} — an unbounded veto is how one stop boundary spins for an hour.`)
    }
  }

  // 2) Per-session rate limiting only: how often one stale list re-prompts, and
  //    how many vetoes the current turn has already collected. Losing it (host
  //    restart, session disposal) costs at most one extra reminder — never the
  //    feature, because staleness itself comes from the session log.
  //    Entries live until `session/disposed`; each holds one standing-list fold
  //    (references into the frozen log) and a handful of counters, so a long-lived
  //    host accumulates one small object per session seen, not per turn.
  const states = new Map()

  ctx.on('session/disposed', (session) => {
    states.delete(session.id)
  }, { global: true })

  // One logger line per mount with the effective policy — the console.log debug
  // leftovers this replaces bypassed log levels entirely.
  const boot = readConfig(scope)
  emit(ctx, 'info', `mounted: stop-gate cap ${boot.gateMaxSteers} veto(es)/turn, stale advisory every `
    + `${boot.staleEvery} turn(s), per-list cap ${boot.maxPromptsPerList} `
    + `(${scope ? 'namespace "todo-continuation" live' : 'DEGRADED: built-in defaults'})`)

  // The whole stop-boundary decision, in one place so the listener can fail open.
  // The host awaits this event before the boundary commits and turns a throw from
  // it into `turn/end {kind:'error'}` — a plugin bug must never cost the user's
  // turn, so the one listener with veto power fails open: the turn simply ends
  // ungated (the mid-turn channel below has had this isolation since v0.6.0).
  const runStopGate = (agent, turn) => {
    const cfg = readConfig(scope)
    const sessionId = agent.session.id
    const state = states.get(sessionId) ?? emptyState()
    states.set(sessionId, state)
    // One turn-stopping dispatch per closing step, so a turn that is vetoed and
    // re-closed counts its vetoes until the turn number moves on.
    if (state.turn !== turn) {
      state.turn = turn
      state.gateSteers = 0
      state.capReported = false
    }
    const standing = standingTodos(agent.session, state)

    const decide = (outcome) => note(ctx, cfg,
      `session "${sessionId}" turn ${turn} at=stop-boundary ${outcome}`)
    const tellQuiet = (listId, count) => emit(ctx, 'info',
      `session "${sessionId}" goes quiet about the list ${listId}: ${count} advisories in a row `
      + `went out without a single todo/write. No more hand-backs until the list changes or a compaction lands.`)

    // --- 1) Stop gate: this turn wrote the list and left items unfinished.
    if (standing.todos !== undefined && standing.writtenTurn === turn) {
      const unfinished = unfinishedCount(standing.todos)
      if (unfinished === 0) {
        decide('gate:allow list-complete')
        return
      }
      if (cfg.gateMaxSteers === 0) {
        decide('gate:off')
        return
      }
      const skipGateForSession = cfg.gateSubagents ? false : (state.delegated ??= isDelegated(agent.session))
      if (skipGateForSession) {
        // A delegated agent has no user to answer it, which is an argument for both
        // policies; `gateSubagents: false` drops the veto and keeps the context, so
        // a child can report "good enough" instead of burning its budget on tidying
        // up a list nobody will read.
        decide(`gate:skipped subagent unfinished=${unfinished}/${standing.todos.length} gateSubagents=off`)
      } else if (state.gateSteers >= cfg.gateMaxSteers) {
        decide(`gate:cap-reached unfinished=${unfinished} vetoes=${state.gateSteers}/${cfg.gateMaxSteers} allow-stop`)
        if (!state.capReported) {
          state.capReported = true
          warn(ctx, `[todo-continuation] session "${sessionId}" turn ${turn}: ${unfinished} unfinished todo(s) `
            + `but the per-turn veto cap (${cfg.gateMaxSteers}) is reached — letting the turn end. `
            + `Raise "Stop-gate vetoes per turn" or finish/clear the list.`)
        }
        return
      } else {
        state.gateSteers += 1
        decide(`gate:block unfinished=${unfinished}/${standing.todos.length} vetoes=${state.gateSteers}/${cfg.gateMaxSteers}`)
        agent.steer(steerMessage(continuationMessage(unfinished, standing.todos.length),
          `todo-continuation: turn sent back — ${unfinished} of ${standing.todos.length} todo item(s) unfinished`))
        return
      }
    }

    // --- 2) Advisory: hand the standing list back — post-compaction first, then
    //      the idle interval. `standingAdvisory` records the rate limit itself, so
    //      the mid-turn channel below cannot double-book this reminder.
    const advisory = standingAdvisory(standing, turn, cfg, state, tellQuiet)
    decide(advisory.fire ? `prompt:${advisory.reason}` : `skip:${advisory.reason}`)
    if (advisory.fire) agent.steer(steerMessage(advisory.text, advisory.summary))
  }

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    signal.throwIfAborted()
    try {
      runStopGate(agent, turn)
    } catch (error) {
      report(ctx, 'stop gate', error)
    }
  })

  // Mid-turn delivery (v0.6.0). The stop boundary is unreachable for a turn that
  // dies on a provider error, is cancelled, or simply never stops — and even when
  // it is reached, the model only learns the plan after it tried to end. Attach the
  // same advisory to a tool result as additional context instead. This listener
  // never vetoes and never throws: `next()` always runs first, and any failure of
  // ours passes the settled decision through untouched.
  ctx.on('tools/post-execute', async function (exec, result, next) {
    // next() first and unconditionally: the tool's own decision is settled before this
    // plugin reads anything at all, so nothing here can delay or veto it. Everything
    // after it — even the argument access — is inside the guard, because an unreadable
    // `exec` must still leave the settled decision untouched.
    const decision = await next()
    try {
      const agent = exec?.agent
      if (!agent?.session) return decision
      const cfg = readConfig(scope)
      const state = states.get(agent.session.id) ?? emptyState()
      states.set(agent.session.id, state)
      const standing = standingTodos(agent.session, state)
      // Inside a turn the log's newest `turn/start` is the current turn.
      const advisory = standingAdvisory(standing, standing.currentTurn, cfg, state,
        (listId, count) => emit(ctx, 'info', `session "${agent.session.id}" goes quiet about the list ${listId}: `
          + `${count} advisories in a row went out without a single todo/write. No more `
          + `hand-backs until the list changes or a compaction lands.`))
      note(ctx, cfg, `session "${agent.session.id}" turn ${standing.currentTurn} at=mid-tool-result `
        + (advisory.fire ? `prompt:${advisory.reason}` : `skip:${advisory.reason}`))
      if (!advisory.fire) return decision
      return {
        ...decision,
        additionalContexts: [...(decision.additionalContexts ?? []), steerMessage(advisory.text, advisory.summary)],
      }
    } catch (error) {
      report(ctx, 'mid-turn context', error)
      return decision
    }
  })

  return undefined
}

function emptyState() {
  return {
    turn: 0,
    gateSteers: 0,
    capReported: false,
    lastStalePromptTurn: 0,
    lastCompactionPromptId: null,
    // Per-list cap: which list state the advisories so far were about, how many
    // of them it took, and whether that state has been declared quiet.
    promptListId: null,
    promptsForList: 0,
    quietListId: null,
    // Whether this session is a delegated child; resolved once, it cannot change.
    delegated: undefined,
    standing: undefined,
  }
}
