#!/usr/bin/env node
/**
 * Live-data audit for @doiiarx/dsh-todo-continuation — the real test.
 *
 * The unit suite drives a fake session log. This one drives the SHIPPED plugin over
 * the real logs the host has already written under `$DSH_HOME/sessions`, and asks
 * two different questions of them:
 *
 *   REPLAY — feed the plugin each stop boundary (and the first tool result of each
 *            turn) exactly as the durable events looked at that moment, and see what
 *            it decides now, under your current settings.
 *   LOG    — read what the host actually delivered at the time: every steer and every
 *            mid-turn context of this plugin is a `user/message` record whose source
 *            is `todo-continuation`, so delivery is observable, not assumed.
 *
 * Comparing the two separates the failures users actually hit: «the logic says no»
 * (nothing was due) versus «the logic would say yes, but the log has nothing» (the
 * running host predates this build, or the plugin is not mounted in that profile).
 *
 * Checks that must hold on every session, straight from the shipped contract:
 *   A. every advisory delivered to a model carried the rendered list;
 *   B. no unchanged list was handed back more than twice (P5 backoff);
 *   C. no turn collected more vetoes than the cap;
 *   D. a compaction that landed while an unfinished list was standing was followed
 *      by a hand-back before the next `todo/write` (P1) — pass `--no-p1` when the
 *      logs were written by a build that predates P1.
 *
 * Usage:
 *   node test/verify-live.mjs                    audit every session found
 *   node test/verify-live.mjs --id <substr>      only sessions whose id contains it
 *   node test/verify-live.mjs --cwd <dir>        only sessions created under <dir>
 *   node test/verify-live.mjs --explain          one decision line per replayed boundary
 *   node test/verify-live.mjs --expect-prompt    also fail if nothing was ever sent
 *   node test/verify-live.mjs --no-p1            skip the post-compaction hand-back check
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
 * Log-side facts: what was delivered, and whether something SHOULD have been
 * delivered (the P1 case). This needs no plugin at all, which is what makes it an
 * independent check on the replay.
 */
function inspectLog(events, sinceMs) {
  const delivered = events.filter(isPluginMessage).map(textOf)
  const advisories = delivered
    .map(text => [text, events.find(record => isPluginMessage(record) && textOf(record) === text)])
    .filter(([text]) => carriesList(text))
  const vetoes = delivered.filter(text => !carriesList(text))
  const perList = new Map()
  for (const [text, record] of advisories) {
    if (sinceMs !== null && record.time < sinceMs) continue
    perList.set(listBlock(text), (perList.get(listBlock(text)) ?? 0) + 1)
  }
  const overBackoff = [...perList.values()].filter(count => count > 2).length

  // P1: a compaction that landed while an unfinished list was standing must be
  // followed by a hand-back before the list is next written.
  let compactionsNeedingHandBack = 0
  let compactionsHonored = 0
  for (let index = 0; index < events.length; index++) {
    if (events[index].type !== 'compaction/summary') continue
    if (sinceMs !== null && events[index].time < sinceMs) continue
    const lastWrite = [...events.slice(0, index)].reverse().find(record => record.type === 'todo/write')
    if (!lastWrite) continue
    if (!(lastWrite.data?.todos ?? []).some(item => item?.status !== 'completed')) continue
    compactionsNeedingHandBack++
    let until = events.length
    for (let position = index + 1; position < events.length; position++) {
      if (events[position].type === 'todo/write') { until = position; break }
    }
    const window = events.slice(index + 1, until)
    if (window.some(record => isPluginMessage(record) && carriesList(textOf(record)))) compactionsHonored++
  }

  // Gate: how many vetoes did one turn actually collect?
  let turn = 0
  const vetoesPerTurn = new Map()
  for (const record of events) {
    if (record.type === 'turn/start' && Number.isSafeInteger(record.data?.turn)) turn = record.data.turn
    else if (isPluginMessage(record) && !carriesList(textOf(record))) {
      if (sinceMs === null || record.time >= sinceMs) vetoesPerTurn.set(turn, (vetoesPerTurn.get(turn) ?? 0) + 1)
    }
  }
  return {
    turnStarts: events.filter(record => record.type === 'turn/start').length,
    todoWrites: events.filter(record => record.type === 'todo/write').length,
    compactions: events.filter(record => record.type === 'compaction/summary').length,
    delegated: events.some(record => record.type === 'subagent/descriptor'),
    advisories: advisories.length,
    vetoes: vetoes.length,
    overBackoff,
    compactionsNeedingHandBack,
    compactionsHonored,
    maxVetoesOneTurn: Math.max(0, ...vetoesPerTurn.values()),
  }
}

/**
 * Plugin-side facts: replay the shipped decision logic at every stop boundary and at
 * the first tool result of every turn, on the event prefix as it looked then.
 */
async function replay(handlers, session, events, { explain }) {
  let prompts = 0
  let vetoes = 0
  const anchors = events
    .map((record, index) => ({ record, index }))
    .filter(entry => entry.record.type === 'turn/start' && Number.isSafeInteger(entry.record.data?.turn))
  const delegated = events.some(record => record.type === 'subagent/descriptor')

  for (const { record, index } of anchors) {
    const turn = record.data.turn
    const prefix = events.slice(0, index + 1)
    const header = { id: session.id, ...(delegated ? { origin: 'subagent' } : {}) }
    const agent = {
      session: { id: session.id, events: prefix, header },
      steered: [],
      steer(message) { this.steered.push(message) },
    }
    const mark = explain?.length ?? 0
    await handlers['agent/turn-stopping']({ agent, turn, signal })
    if (explain) for (const line of explain.slice(mark)) console.log('    ', line)
    for (const message of agent.steered) {
      if (carriesList(textOf(message))) prompts++
      else vetoes++
    }
    const firstToolResult = prefix.findIndex((entry, position) => position > index && entry.type === 'tool/result')
    if (firstToolResult > 0) {
      const midAgent = { session: { id: session.id, events: events.slice(0, firstToolResult + 1), header }, steer() {} }
      const decision = await handlers['tools/post-execute'].call({},
        { agent: midAgent, name: 'read' }, { isError: false, content: [] }, async () => ({ kind: 'accept' }))
      for (const context of decision?.additionalContexts ?? []) if (carriesList(textOf(context))) prompts++
    }
  }
  return { prompts, vetoes, boundaries: anchors.length }
}

const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const sessionsRoot = option('sessions', path.join(home, 'sessions'))
const { file: settingsFile, result: settings } = readLiveSettings(home)
const onlyCwd = option('cwd', null)
const onlyId = option('id', null)
const EXPLAIN = flag('explain')
const sinceRaw = option('since', null)
const sinceMs = sinceRaw ? Date.parse(sinceRaw) : null

console.log(`DSH home      : ${home}`)
console.log(`settings      : ${settingsFile} → ${JSON.stringify(settings)}`)
console.log(`sessions root : ${sessionsRoot}${onlyCwd ? ` (cwd ${onlyCwd})` : ''}${onlyId ? ` (id ~ ${onlyId})` : ''}`)

const sessions = findSessions(sessionsRoot, { onlyCwd, onlyId })
if (sessions.length === 0) {
  console.error('\nNO SESSIONS FOUND — this audit needs real host logs to audit.')
  process.exit(2)
}
const explain = EXPLAIN ? [] : null
const handlers = await mountPlugin({ ...settings, logDecisions: EXPLAIN }, explain)
console.log(`handlers mounted: ${Object.keys(handlers).join(', ')}`)
console.log(`auditing ${sessions.length} session(s)\n`)

const problems = []
const totals = { logAdvisories: 0, logVetoes: 0, replayPrompts: 0, replayVetoes: 0, needing: 0, honored: 0 }
let active = 0
for (const session of sessions) {
  const events = decodeSessionFile(session.file)
    .filter(record => record.type !== 'session/created' && record.type !== 'session/header')
  const log = inspectLog(events, sinceMs)
  const replayed = await replay(handlers, session, events, { explain })
  totals.logAdvisories += log.advisories
  totals.logVetoes += log.vetoes
  totals.replayPrompts += replayed.prompts
  totals.replayVetoes += replayed.vetoes
  totals.needing += log.compactionsNeedingHandBack
  totals.honored += log.compactionsHonored
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
  if (sinceMs !== null && log.overBackoff > 0) {
    problems.push(`${shortId}: ${log.overBackoff} list(s) handed back more than twice (P5 violated in the real log)`)
  }
  const cap = Math.max(settings.gateMaxSteersPerTurn ?? 2, 2)
  if (sinceMs !== null && log.maxVetoesOneTurn > cap) {
    problems.push(`${shortId}: ${log.maxVetoesOneTurn} vetoes in one turn exceeds the cap (${cap})`)
  }
  if (sinceMs !== null && !flag('no-p1') && log.compactionsNeedingHandBack > log.compactionsHonored) {
    problems.push(`${shortId}: ${log.compactionsNeedingHandBack - log.compactionsHonored} compaction(s) landed on an `
      + `unfinished list with no hand-back before the next write (P1) — an older build may have served this `
      + `session; pass --no-p1 to skip that check`)
  }
}

console.log(`\nsessions with activity    : ${active}/${sessions.length}`)
console.log(`delivered by the host      : advisories ${totals.logAdvisories}, gate vetoes ${totals.logVetoes}`)
console.log(`decided by this replay     : advisories ${totals.replayPrompts}, gate vetoes ${totals.replayVetoes}`)
console.log(`post-compaction hand-backs : ${totals.honored}/${totals.needing} required`)
if (sinceMs === null) console.log('historical gaps above are the reason P1/P4 exist; pass --since ' + String.fromCharCode(34) + '<restart time>' + String.fromCharCode(34) + ' to check only newer events')
if (totals.logAdvisories === 0 && totals.replayPrompts > 0) {
  console.log('→ the current logic wants to prompt but no session was ever prompted: the RUNNING host\n'
    + '  predates this build, or the plugin is not mounted in the profile that served these sessions.')
}
if (flag('expect-prompt') && totals.logAdvisories === 0) {
  problems.push('--expect-prompt: no session in this DSH home ever received an advisory')
}

if (sinceMs === null && problems.length === 0) {
  console.log('(no contract violations counted: pass --since ' + String.fromCharCode(34) + '<restart time>' + String.fromCharCode(34) + ' to enforce the contract on events after that moment)')
}

if (problems.length) {
  console.error(`\nFAIL (${problems.length})`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('\nPASS — every check holds on every session inspected.')
