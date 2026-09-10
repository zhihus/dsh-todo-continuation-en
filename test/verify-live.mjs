#!/usr/bin/env node
/**
 * Live-data audit for @doiiarx/dsh-todo-continuation — the real test.
 *
 * The unit suite drives a fake session log. This one drives the SHIPPED plugin over
 * the real logs the host has already written under `$DSH_HOME/sessions`, and asks
 * two different questions of them:
 *
 *   REPLAY — feed the plugin EVERY tool result of every turn first, then that
 *            turn's stop boundary (the END of the turn: its todo writes,
 *            compactions and tool results are already in the log there) — in
 *            the order the host really ran the two seams, on the prefix of
 *            durable events as it looked at each moment, and see what it
 *            decides now. Anchoring the
 *            replay on `turn/start` instead made the gate provably unreachable
 *            (a write always lands after its turn starts) — that bug lived here
 *            from v0.5.0 to v0.6.x and reported 0 gate vetoes against logs with
 *            295 of them.
 *   LOG    — read what the host actually delivered at the time: every steer and
 *            every mid-turn context of this plugin is a `user/message` record
 *            whose source is `todo-continuation` and whose one-line summary names
 *            the channel ("turn sent back …" = gate veto, "the model was reminded
 *            of its todo list …" = advisory), so delivery is observable, not
 *            assumed, and the two channels are distinguishable in the log.
 *
 * Comparing the two separates the failures users actually hit: «the logic says no»
 * (nothing was due) versus «the logic would say yes, but the log has nothing» (the
 * running host predates this build, or the plugin is not mounted in that profile).
 *
 * Contract checks enforced on every session, straight from the shipped contract.
 * The horizon defaults to the session's first CLASSIFIED plugin delivery (a record
 * whose summary matches the current channel wording): gaps before it predate the
 * build that served this session and are not violations. Pass
 * `--all-history` to check everything anyway, or `--since <time>` for one fixed
 * horizon.
 *
 *   A. every advisory delivered to a model carried the rendered list;
 *   B. no unchanged list was handed back more than twice (P5 backoff);
 *   C. no turn collected more vetoes than the cap;
 *   D. a compaction that landed while an unfinished list was standing was followed
 *      by the plan reaching the model before the turn ends — a hand-back or the
 *      model's own rewrite of the list (P1) — pass `--no-p1` when the
 *      logs were written by a build that predates P1.
 *
 * Usage:
 *   node test/verify-live.mjs                    audit every session found
 *   node test/verify-live.mjs --id <substr>      only sessions whose id contains it
 *   node test/verify-live.mjs --cwd <dir>        only sessions created under <dir>
 *   node test/verify-live.mjs --explain          one decision line per replayed boundary
 *   node test/verify-live.mjs --expect-prompt    also fail if nothing was ever sent
 *   node test/verify-live.mjs --no-p1            skip the post-compaction hand-back check
 *   node test/verify-live.mjs --all-history      enforce checks on the whole history
 *   node test/verify-live.mjs --since <time>     one fixed horizon for every session
 *   node test/verify-live.mjs --selftest         replay a synthetic session (no live logs)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { apply } from '../index.js'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const LIST_MARKER = /\n- \[[a-z_]+\] /
/** Works for both a log record (`data.content`) and a bare steer message (`content`). */
const textOf = (thing) => ((thing?.content ?? thing?.data?.content) ?? []).map(part => part?.text ?? '').join('\n')
const isPluginMessage = (record) => record.type === 'user/message' && record.data?.source?.plugin === 'todo-continuation'
const carriesList = (text) => LIST_MARKER.test(text)
/** The identity of "the same unchanged list": the item block, without the sentence. */
const listBlock = (text) => text.slice(text.search(LIST_MARKER))
const timeOf = (record) => (typeof record?.time === 'number' ? record.time : Date.parse(record?.time))

/**
 * Delivery-channel classification, two layers:
 *   1. the one-line `source.summary` the current build always sets (wording
 *      prefixes come from the `steerMessage` call sites in index.js) — precise,
 *      and the only falsifiable basis for check A;
 *   2. the message shape — a plugin delivery that carries the rendered list is an
 *      advisory, one that does not is a gate veto. That fallback is what makes
 *      300+ historical deliveries (older builds, no summary) classifiable at all;
 *      the live logs confirmed only the newest build writes summaries.
 * A summary that matches NEITHER current wording is counted as `unknownWording`
 * and reported, never silently folded into a verdict. A record with NO summary
 * at all (the failure mode that would otherwise hide the drift: `unknownWording`
 * only sees strings, and `kindOf` silently shape-classifies the rest) is counted
 * separately as `missingSummary` once the current-wording horizon has begun.
 */
const SUMMARY_ADVISORY = /^todo-continuation: the model was reminded of its todo list/
const SUMMARY_VETO = /^todo-continuation: turn sent back/
const summaryOf = (thing) => thing?.data?.source?.summary ?? thing?.source?.summary
const summaryKind = (thing) => {
  const summary = summaryOf(thing)
  if (typeof summary !== 'string') return null
  if (SUMMARY_ADVISORY.test(summary)) return 'advisory'
  if (SUMMARY_VETO.test(summary)) return 'veto'
  return null
}
const kindOf = (thing) => summaryKind(thing) ?? (carriesList(textOf(thing)) ? 'advisory' : 'veto')

/**
 * The host appends one small zstd frame per write, so the file is a multi-frame
 * stream. The magic is 28 B5 2F FD, and scanning for the next frame has to be
 * byte-exact: stepping by 4 finds only aligned magics, merges frames, and leaves a
 * decompressor that stops after the first frame of each span — the log then reads
 * several times shorter with no error anywhere. That bug was caught by this audit.
 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decodeSessionFile(file) {
  const buffer = fs.readFileSync(file)
  let text = ''
  let offset = 0
  while (offset + 4 <= buffer.length) {
    if (buffer.readUInt32BE(offset) === 0x28b52ffd) {
      const found = buffer.indexOf(ZSTD_MAGIC, offset + 4)
      const end = found < 0 ? buffer.length : found
      try {
        text += zlib.zstdDecompressSync(buffer.subarray(offset, end)).toString('utf8')
      } catch {
        /* a partially written trailing frame; everything before it is usable */
      }
      offset = end
    } else {
      offset += 1
    }
  }
  const records = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch { /* a torn last line is not a verdict */ }
  }
  return records
}

function cwdSlug(dir) {
  return path.resolve(dir).replace(/[\\/]+/g, '-').replace(/:/g, '')
}

function findSessions(root, { onlyCwd, onlyId }) {
  const out = []
  if (!fs.existsSync(root)) return out
  for (const slug of fs.readdirSync(root)) {
    const slugDir = path.join(root, slug)
    if (!fs.statSync(slugDir).isDirectory()) continue
    if (onlyCwd && !slug.includes(cwdSlug(onlyCwd))) continue
    for (const id of fs.readdirSync(slugDir)) {
      if (onlyId && !id.includes(onlyId)) continue
      const file = path.join(slugDir, id, 'session.jsonl.zstd')
      if (!fs.existsSync(file)) continue
      out.push({ id, slug, file, mtime: fs.statSync(file).mtimeMs })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** The live settings the host itself uses (a naive read of one YAML section). */
function readLiveSettings(home) {
  const file = path.join(home, 'settings.yaml')
  const result = {}
  if (!fs.existsSync(file)) return { file, result }
  let inside = false
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^todo-continuation:\s*$/.test(line)) { inside = true; continue }
    if (!inside) continue
    if (/^\S/.test(line)) { inside = false; continue }
    const match = /^\s+([\w]+):\s*(.+?)\s*$/.exec(line)
    if (!match) continue
    const raw = match[2].replace(/^"|"$/g, '')
    result[match[1]] = raw === 'true' ? true : raw === 'false' ? false
      : (raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw)
  }
  return { file, result }
}

/** A minimal Cordis-shaped context: enough for `apply()` and nothing more. */
async function mountPlugin(settings, decisions) {
  const handlers = {}
  await apply({
    get: (key) => (key === 'settings' ? {} : undefined),
    settings: {
      register(namespace, schema, options = {}) {
        const merged = { ...(options.base ?? {}), ...settings }
        return { get: () => schema(merged) }
      },
    },
    root: {
      logger: () => ({
        error() {}, warn() {}, info() {},
        debug: (fmt, ...args) => decisions?.push(String(fmt).replace('%s', args[0] ?? '')),
      }),
    },
    on: (event, handler) => { handlers[event] = handler },
  })
  return handlers
}

const signal = { throwIfAborted() {} }

/**
 * Log-side facts: what was delivered, on which channel, and whether something
 * SHOULD have been delivered (the P1 case). This needs no plugin at all, which is
 * what makes it an independent check on the replay.
 *
 * Two horizons, because the checks are enforceable from different moments:
 *   `sinceMs` (strict) — the first current-wording delivery: gates the P5 cap (B)
 *     and the P1 hand-back check (D), whose features only newer builds have.
 *   `allFrom` (shape)  — the first plugin delivery of ANY build: gates check A
 *     (advisories carry the list — falsifiable only through summary wording) and
 *     check C (the veto cap, enforced on shape-classified vetoes).
 */
function inspectLog(events, { sinceMs, allFrom }) {
  const after = (record, horizon) => horizon === null || timeOf(record) >= horizon
  const pluginRecords = events.filter(isPluginMessage)
  const advisoryRecords = pluginRecords.filter(record => kindOf(record) === 'advisory')
  const vetoRecords = pluginRecords.filter(record => kindOf(record) === 'veto')
  const unknownWording = pluginRecords
    .filter(record => typeof summaryOf(record) === 'string' && summaryKind(record) === null).length
  // A build that stopped writing summaries entirely must NOT look like "no drift":
  // those records are the second half of the attribution-loss story, visible only
  // after the horizon where the current wording demonstrably started.
  const missingSummary = sinceMs === null ? 0 : pluginRecords
    .filter(record => typeof summaryOf(record) !== 'string' && after(record, sinceMs)).length
  // Check A: an advisory whose own summary names the advisory channel but that
  // does not carry the rendered list is a contract violation (P3-A).
  const advisoriesWithoutList = advisoryRecords
    .filter(record => summaryKind(record) === 'advisory' && after(record, allFrom)
      && !carriesList(textOf(record))).length

  const perList = new Map()
  for (const record of advisoryRecords) {
    if (!after(record, sinceMs)) continue
    const block = listBlock(textOf(record))
    perList.set(block, (perList.get(block) ?? 0) + 1)
  }
  const overBackoff = [...perList.values()].filter(count => count > 2).length

  // P1: a compaction that landed while an unfinished list was standing must be
  // followed by the plan reaching the model again before the turn ends — by the
  // plugin's hand-back OR by the model itself rewriting the list (a verbatim
  // self-restore is proof the plan survived; the hand-back then lands on the
  // write's own tool result, one record too late for a strict window).
  let compactionsNeedingHandBack = 0
  let compactionsHonored = 0
  for (let index = 0; index < events.length; index++) {
    if (events[index].type !== 'compaction/summary') continue
    if (!after(events[index], sinceMs)) continue
    const lastWrite = [...events.slice(0, index)].reverse().find(record => record.type === 'todo/write')
    if (!lastWrite) continue
    if (!(lastWrite.data?.todos ?? []).some(item => item?.status !== 'completed')) continue
    compactionsNeedingHandBack++
    let until = events.length
    for (let position = index + 1; position < events.length; position++) {
      if (events[position].type === 'turn/end') { until = position; break }
    }
    const window = events.slice(index + 1, until)
    const handBack = window.some(record => isPluginMessage(record) && carriesList(textOf(record)))
    const selfRestored = window.some(record => record.type === 'todo/write'
      && (record.data?.todos ?? []).some(item => item?.status !== 'completed'))
    if (handBack || selfRestored) compactionsHonored++
  }

  // Check C: gate vetoes per turn. Enforced only from the strict horizon (the
  // first current-wording delivery): the veto cap shipped in v0.6.0 — turns with
  // 6..1000+ vetoes before that are a no-cap build's history, not violations.
  // The isPluginMessage guard is load-bearing: kindOf's shape fallback must never
  // classify a non-plugin record (assistant chunks, tool results — anything
  // without the rendered list) as a gate veto.
  let turn = 0
  const vetoesPerTurn = new Map()
  for (const record of events) {
    if (record.type === 'turn/start' && Number.isSafeInteger(record.data?.turn)) turn = record.data.turn
    else if (isPluginMessage(record) && kindOf(record) === 'veto' && after(record, sinceMs)) {
      vetoesPerTurn.set(turn, (vetoesPerTurn.get(turn) ?? 0) + 1)
    }
  }
  return {
    turnStarts: events.filter(record => record.type === 'turn/start').length,
    todoWrites: events.filter(record => record.type === 'todo/write').length,
    compactions: events.filter(record => record.type === 'compaction/summary').length,
    delegated: events.some(record => record.type === 'subagent/descriptor'),
    advisories: advisoryRecords.length,
    vetoes: vetoRecords.length,
    unknownWording,
    missingSummary,
    advisoriesWithoutList,
    overBackoff,
    compactionsNeedingHandBack,
    compactionsHonored,
    maxVetoesOneTurn: Math.max(0, ...vetoesPerTurn.values()),
  }
}

/**
 * Plugin-side facts: replay the shipped decision logic at EVERY tool result of
 * every turn (the mid-turn channel) and then at the turn's stop boundary (its
 * todo writes, compactions and tool results are all in the log by then), on the
 * event prefix as it looked at that moment. The order is the host's real order:
 * replaying the boundary first would let it reserve the dedupe budget that a
 * running host had already spent mid-turn — and would leave a dead mid-turn
 * listener undetectable by `--selftest` (the compaction hand-back the selftest
 * comment promised, in fact never came from that channel).
 */
async function replay(handlers, session, events, { explain, collect = null }) {
  let prompts = 0
  let vetoes = 0
  let boundaryPrompts = 0
  let midTurnPrompts = 0
  let boundaries = 0
  let toolResults = 0
  const delegated = events.some(record => record.type === 'subagent/descriptor')
  const header = { id: session.id, ...(delegated ? { origin: 'subagent' } : {}) }

  const count = (message, channel) => {
    if (kindOf(message) === 'advisory') {
      prompts += 1
      if (channel === 'mid-turn') midTurnPrompts += 1
      else boundaryPrompts += 1
    } else {
      vetoes += 1
    }
    collect?.push({ channel, message, kind: kindOf(message) })
  }
  const driveBoundary = async (turn, prefix) => {
    const agent = {
      session: { id: session.id, events: prefix, header },
      steered: [],
      steer(message) { this.steered.push(message) },
    }
    const mark = explain?.length ?? 0
    await handlers['agent/turn-stopping']({ agent, turn, signal })
    if (explain) for (const line of explain.slice(mark)) console.log('    ', line)
    for (const message of agent.steered) count(message, 'stop-boundary')
  }
  const driveToolResult = async (prefix) => {
    const agent = { session: { id: session.id, events: prefix, header }, steered: [], steer() {} }
    const decision = await handlers['tools/post-execute'].call({},
      { agent, name: 'read' }, { isError: false, content: [] }, async () => ({ kind: 'accept' }))
    for (const context of decision?.additionalContexts ?? []) count(context, 'mid-turn')
  }

  const starts = events
    .map((record, index) => ({ record, index }))
    .filter(entry => entry.record.type === 'turn/start' && Number.isSafeInteger(entry.record.data?.turn))
  for (let s = 0; s < starts.length; s++) {
    const { record, index } = starts[s]
    // The boundary of turn N sits at its LAST event: everything the turn wrote
    // (todo writes, compactions, tool results) is in the prefix there.
    const boundaryIndex = (s + 1 < starts.length ? starts[s + 1].index : events.length) - 1
    for (let position = index + 1; position <= boundaryIndex; position++) {
      if (events[position].type !== 'tool/result') continue
      toolResults++
      await driveToolResult(events.slice(0, position + 1))
    }
    boundaries++
    await driveBoundary(record.data.turn, events.slice(0, boundaryIndex + 1))
  }
  return { prompts, vetoes, boundaryPrompts, midTurnPrompts, boundaries, toolResults }
}

// --selftest: a synthetic session (no live logs needed) that FORCES both delivery
// seams and checks their output, not just that "something happened":
//   turn 1 wrote an unfinished list  → exactly 1 gate veto at its stop boundary;
//   turn 2's compaction              → the hand-back must arrive as MID-TURN tool
//     context (the tool result of the turn runs before its boundary — the host's
//     order), and must not be repeated at that turn's boundary;
//   turn 3                            → the next stale reminder, again mid-turn;
//   turn 4 (no tool result)           → one more reminder from the stop boundary.
// Every delivered message must be a visible notice with plugin attribution and a
// bounded one-line summary, and every advisory must carry the rendered list.
// A `>= 1` over the total would stay true with a dead mid-turn channel (v0.6.0's
// key feature) or with summaries deleted — none of that survives these asserts.
if (flag('selftest')) {
  const synthetic = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'todo/write', data: { todos: [{ content: 'Ship the fix', status: 'pending' }] } },
    { type: 'tool/result', data: {} },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'compaction/summary', data: { compactionId: 'cmp-selftest' } },
    { type: 'tool/result', data: {} },
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'tool/result', data: {} },
    { type: 'turn/start', data: { turn: 4 } },
  ]
  const selfHandlers = await mountPlugin({
    gateMaxSteersPerTurn: 2,
    staleTodoPromptEveryNTurns: 1,
    promptAfterCompaction: true,
  }, null)
  const deliveries = []
  const result = await replay(selfHandlers, { id: 'selftest' }, synthetic, { explain: null, collect: deliveries })
  const problems = []
  if (result.vetoes !== 1) problems.push(`expected exactly 1 gate veto (turn 1's unfinished list), got ${result.vetoes}`)
  if (result.midTurnPrompts !== 2) {
    problems.push(`expected 2 advisories delivered as mid-turn tool context (compaction hand-back + next interval), got ${result.midTurnPrompts} — a dead mid-turn channel lands here`)
  }
  if (result.boundaryPrompts !== 1) problems.push(`expected 1 advisory delivered at a stop boundary (turn 4), got ${result.boundaryPrompts}`)
  for (const d of deliveries) {
    const summary = d.message?.source?.summary
    if (d.message?.source?.plugin !== 'todo-continuation') problems.push(`${d.channel}: delivery lost its plugin attribution`)
    if (d.message?.source?.form !== 'notice') problems.push(`${d.channel}: delivery is not a visible notice`)
    if (typeof summary !== 'string' || summary === '' || summary.length > 120) {
      problems.push(`${d.channel}: ${d.kind} delivery has no bounded one-line summary (chip and transcript attribution lost)`)
    }
    if (d.kind === 'advisory' && !carriesList(textOf(d.message))) problems.push(`${d.channel}: advisory carried no rendered list (contract A)`)
  }
  const ok = problems.length === 0
  console.log(`selftest: boundaries ${result.boundaries}, tool results ${result.toolResults}`
    + ` → vetoes ${result.vetoes}, advisories ${result.prompts} (mid-turn ${result.midTurnPrompts}, boundary ${result.boundaryPrompts})`
    + `: ${ok ? 'PASS' : 'FAIL'}`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(ok ? 0 : 1)
}

const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const sessionsRoot = option('sessions', path.join(home, 'sessions'))
const { file: settingsFile, result: settings } = readLiveSettings(home)
const onlyCwd = option('cwd', null)
const onlyId = option('id', null)
const EXPLAIN = flag('explain')
const sinceRaw = option('since', null)
const sinceMs = sinceRaw ? Date.parse(sinceRaw) : null
if (sinceRaw && Number.isNaN(sinceMs)) {
  console.error(`--since "${sinceRaw}" is not a parseable time`)
  process.exit(2)
}

console.log(`DSH home      : ${home}`)
console.log(`settings      : ${settingsFile} → ${JSON.stringify(settings)}`)
console.log(`sessions root : ${sessionsRoot}${onlyCwd ? ` (cwd ${onlyCwd})` : ''}${onlyId ? ` (id ~ ${onlyId})` : ''}`)
console.log(`horizon       : ${sinceRaw ? `--since ${sinceRaw}` : flag('all-history') ? '--all-history' : 'first delivery (strict checks: first current-wording delivery)'}`)

const sessions = findSessions(sessionsRoot, { onlyCwd, onlyId })
if (sessions.length === 0) {
  console.error('\nNO SESSIONS FOUND — this audit needs real host logs to audit.')
  process.exit(2)
}
const explain = EXPLAIN ? [] : null
const handlers = await mountPlugin({ ...settings, logDecisions: EXPLAIN }, explain)
console.log(`handlers mounted: ${Object.keys(handlers).join(', ')}`)
console.log(`auditing ${sessions.length} session(s)\n`)

/**
 * The check horizons for one session. An explicit `--since` wins over both;
 * `--all-history` checks everything. Otherwise:
 *   allFrom — the session's FIRST plugin delivery of any build (check A, C);
 *   sinceMs — the first CLASSIFIED delivery (summary matches current wording):
 *     gaps before it were produced by an older build, so they are history, not
 *     violations (checks B, D — the per-list cap and the P1 hand-back are newer
 *     features).
 */
const horizonOf = (events) => {
  if (sinceMs !== null) return { allFrom: sinceMs, sinceMs }
  if (flag('all-history')) return { allFrom: 0, sinceMs: 0 }
  const times = events.filter(isPluginMessage).map(timeOf).filter(Number.isFinite)
  const allFrom = times.length ? Math.min(...times) : null
  const wording = events
    .filter(record => isPluginMessage(record) && summaryKind(record) !== null)
    .map(timeOf)
    .filter(Number.isFinite)
  return { allFrom, sinceMs: wording.length ? Math.min(...wording) : null }
}

const problems = []
const totals = {
  logAdvisories: 0, logVetoes: 0, replayPrompts: 0, replayVetoes: 0,
  replayMidTurn: 0, replayBoundary: 0,
  needing: 0, honored: 0, unknownWording: 0, missingSummary: 0, boundaries: 0, toolResults: 0,
}
let active = 0
let withoutDeliveries = 0
for (const session of sessions) {
  const events = decodeSessionFile(session.file)
    .filter(record => record.type !== 'session/created' && record.type !== 'session/header')
  const horizon = horizonOf(events)
  if (horizon.allFrom === null) withoutDeliveries++
  const log = inspectLog(events, horizon)
  const replayed = await replay(handlers, session, events, { explain })
  totals.logAdvisories += log.advisories
  totals.logVetoes += log.vetoes
  totals.replayPrompts += replayed.prompts
  totals.replayVetoes += replayed.vetoes
  totals.replayMidTurn += replayed.midTurnPrompts
  totals.replayBoundary += replayed.boundaryPrompts
  totals.needing += log.compactionsNeedingHandBack
  totals.honored += log.compactionsHonored
  totals.unknownWording += log.unknownWording
  totals.missingSummary += log.missingSummary
  totals.boundaries += replayed.boundaries
  totals.toolResults += replayed.toolResults
  if (log.advisories || log.todoWrites) active++

  const shortId = session.id.replace(/^session-/, '').slice(0, 8)
  if (EXPLAIN || log.advisories || log.todoWrites) {
    console.log(
      `${shortId}${log.delegated ? '[sub]' : '     '} turns ${String(log.turnStarts).padStart(4)}`
      + ` writes ${String(log.todoWrites).padStart(3)} cmp ${String(log.compactions).padStart(2)}`
      + ` | log adv ${String(log.advisories).padStart(3)} veto ${String(log.vetoes).padStart(3)}`
      + ` | replay adv ${String(replayed.prompts).padStart(3)} veto ${String(replayed.vetoes).padStart(3)}`,
    )
  }
  // Check horizons: A and C are enforceable from the session's first plugin
  // delivery of any build; B (per-list cap) and D (P1 hand-back) only from the
  // first delivery that carries the current channel wording.
  if (horizon.allFrom !== null && log.advisoriesWithoutList > 0) {
    problems.push(`${shortId}: ${log.advisoriesWithoutList} advisory delivery(ies) carried no rendered list (check A)`)
  }
  if (horizon.sinceMs !== null) {
    // Check C, same strict horizon as B and D: the veto cap shipped in v0.6.0,
    // and only its wording marks the build that enforces it. The host clamps the
    // cap at 10 (MAX_GATE_STEERS); mirror that here.
    const cap = Math.min(10, Math.max(Number(settings.gateMaxSteersPerTurn ?? 2), 2))
    if (log.maxVetoesOneTurn > cap) {
      problems.push(`${shortId}: ${log.maxVetoesOneTurn} vetoes in one turn exceeds the cap (${cap}) — the `
        + `current settings say no turn may be sent back more than ${cap} time(s)`)
    }
  }
  if (horizon.sinceMs !== null && log.overBackoff > 0) {
    problems.push(`${shortId}: ${log.overBackoff} list(s) handed back more than twice (P5 violated in the real log)`)
  }
  if (horizon.sinceMs !== null && !flag('no-p1') && log.compactionsNeedingHandBack > log.compactionsHonored) {
    problems.push(`${shortId}: ${log.compactionsNeedingHandBack - log.compactionsHonored} compaction(s) landed on an `
      + `unfinished list with no hand-back or self-restore before the turn ended (P1) — an older build may have served this `
      + `session; pass --no-p1 to skip that check`)
  }
}

console.log(`\nsessions with activity    : ${active}/${sessions.length}`)
console.log(`replay points             : ${totals.boundaries} turn boundaries, ${totals.toolResults} tool results`)
console.log(`delivered by the host      : advisories ${totals.logAdvisories}, gate vetoes ${totals.logVetoes}`)
console.log(`decided by this replay     : advisories ${totals.replayPrompts} (mid-turn ${totals.replayMidTurn}, boundary ${totals.replayBoundary}), gate vetoes ${totals.replayVetoes}`)
console.log(`post-compaction hand-backs : ${totals.honored}/${totals.needing} required`)
if (totals.unknownWording > 0) {
  console.log(`unknown summaries          : ${totals.unknownWording} (a summary, but neither current wording — wording drift?)`)
}
if (totals.missingSummary > 0) {
  console.log(`no-summary deliveries      : ${totals.missingSummary} (plugin records AFTER the current-wording horizon carry no `
    + `summary at all: a build stopped writing them — the shape fallback still classifies them, but channel attribution is lost)`)
}
if (totals.logAdvisories === 0 && totals.replayPrompts > 0) {
  console.log('→ the current logic wants to prompt but no session was ever prompted: the RUNNING host\n'
    + '  predates this build, or the plugin is not mounted in the profile that served these sessions.')
}
if (flag('expect-prompt') && totals.logAdvisories === 0) {
  problems.push('--expect-prompt: no session in this DSH home ever received an advisory')
}
if (withoutDeliveries > 0) {
  console.log(`(${withoutDeliveries} session(s) have no plugin deliveries at all: no horizon, checks skipped there)`)
}

if (problems.length) {
  console.error(`\nFAIL (${problems.length})`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('\nPASS — every check holds on every session inspected.')
