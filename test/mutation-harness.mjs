#!/usr/bin/env node
/**
 * Mutation harness for the audit. Copies index.js/client.js/test into .audit/sandbox,
 * applies ONE literal mutation, runs the suite, reports killed/survived.
 * A test that passes with the source deliberately broken is not testing that behaviour.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SB = path.join(ROOT, '.audit', 'sandbox')

// ---- client slot contract: the class of defect that made the plugin refuse to load on
// 2026-09-12. A registration the host SlotCore rejects takes the WHOLE loader entry down,
// so the settings page disappears together with the composer chip. Any of these surviving
// means the contract test is decoration.
  // M14 'readTemplate drops {n}' is an EQUIVALENT mutant, not a coverage gap: the
  // settings schema itself declares .pattern(/\{n\}/) on staleTodoPromptTemplate, so an
  // invalid stored value fails at registration and the plugin falls back to defaults
  // (asserted by the DEGRADED test). The reader's own check is defence-in-depth and is
  // unreachable through the public surface; killing it would need an export that exists
  // for no other reason. Do not spend an afternoon on it.
  // ---- 8< ---- 8< ----
const CLIENT_CONTRACT_MUTANTS = [
  { id: 'M61', file: 'client.js', label: 'chip registration loses its slot id',
    from: `name: "conversation.input.left",\n          id: NAMESPACE,`,
    to: `name: "conversation.input.left",` },
  { id: 'M62', file: 'client.js', label: 'settings section loses its slot id',
    from: `name: "settings.section",\n          id: NAMESPACE,`,
    to: `name: "settings.section",` },
  { id: 'M63', file: 'client.js', label: 'chip drops its explicit order',
    from: `id: NAMESPACE,\n          order: 40,`,
    to: `id: NAMESPACE,` },
  { id: 'M64', file: 'client.js', label: 'chip clobbers sessionId with undefined',
    from: `inject: (sessionId) => sessionId === undefined || sessionId === null || sessionId === ""\n            ? { connection: ctx.connection }\n            : { sessionId, connection: ctx.connection },`,
    to: `inject: (sessionId) => ({ sessionId, connection: ctx.connection }),` },
  { id: 'M65', file: 'client.js', label: 'chip registers into a slot nobody documented',
    from: `name: "conversation.input.left",\n          id: NAMESPACE,`,
    to: `name: "conversation.input.right",\n          id: NAMESPACE,` },
]
const MUTATIONS = [ ...CLIENT_CONTRACT_MUTANTS,
  // ---- unfinishedCount / status semantics
  { id: 'M01', file: 'index.js', label: 'unfinishedCount always 0',
    from: "return (todos ?? []).filter(todo => todo.status !== 'completed').length",
    to: "return 0" },
  { id: 'M02', file: 'index.js', label: 'unfinishedCount counts everything',
    from: "return (todos ?? []).filter(todo => todo.status !== 'completed').length",
    to: "return (todos ?? []).length" },

  // ---- durable log read
  { id: 'M03', file: 'index.js', label: 'drop malformed-record guard (Array.isArray)',
    from: "      if (Array.isArray(list)) {\n        todos = list\n        writtenTurn = turn\n        writePosition = position\n      }",
    to: "      todos = list\n      writtenTurn = turn\n      writePosition = position" },
  { id: 'M04', file: 'index.js', label: 'compactedAfterWrite always false',
    from: "    compactedAfterWrite: compactionPosition > writePosition && compactionPosition >= 0,",
    to: "    compactedAfterWrite: false," },
  { id: 'M05', file: 'index.js', label: 'compactedAfterWrite ignores ordering',
    from: "    compactedAfterWrite: compactionPosition > writePosition && compactionPosition >= 0,",
    to: "    compactedAfterWrite: compactionPosition >= 0," },
  { id: 'M06', file: 'index.js', label: 'turn/start number guard dropped',
    from: "      if (typeof event.data?.turn === 'number') turn = event.data.turn",
    to: "      turn = event.data?.turn" },

  // ---- memoized fold
  { id: 'M07', file: 'index.js', label: 'fold: no re-read on shrunken log',
    from: "  if (cached === undefined || events.length < cached.size || cached.firstEvent !== events[0]) {",
    to: "  if (cached === undefined || cached.firstEvent !== events[0]) {" },
  { id: 'M08', file: 'index.js', label: 'fold: recompactedAfterWrite not recomputed',
    from: "  fold.compactedAfterWrite = fold.compactionPosition > fold.writePosition && fold.compactionPosition >= 0",
    to: "  // mutated: fold keeps cached compactedAfterWrite" },
  { id: 'M09', file: 'index.js', label: 'fold: cache never invalidated (always reuse)',
    from: "  if (cached !== undefined\n    && cached.size === events.length\n    && cached.firstEvent === events[0]) return cached",
    to: "  if (cached !== undefined) return cached" },

  // ---- constants / limits
  { id: 'M10', file: 'index.js', label: 'MAX_STALE_HORIZON_FACTOR 20 -> 1e9',
    from: "const MAX_STALE_HORIZON_FACTOR = 20", to: "const MAX_STALE_HORIZON_FACTOR = 1e9" },
  { id: 'M11', file: 'index.js', label: 'MAX_LISTED_TODOS 30 -> 1e9',
    from: "const MAX_LISTED_TODOS = 30", to: "const MAX_LISTED_TODOS = 1e9" },
  { id: 'M12', file: 'index.js', label: 'MAX_GATE_STEERS 10 -> 1e9 (no clamp)',
    from: "const MAX_GATE_STEERS = 10", to: "const MAX_GATE_STEERS = 1e9" },

  // ---- config readers
  { id: 'M13', file: 'index.js', label: 'readCap does not clamp',
    from: "  return parsed > MAX_GATE_STEERS ? MAX_GATE_STEERS : parsed",
    to: "  return parsed" },
  { id: 'M14', file: 'index.js', label: 'readTemplate drops {n} requirement',
    from: "  return typeof value === 'string' && value.includes('{n}') ? value : fallback",
    to: "  return typeof value === 'string' ? value : fallback" },
  { id: 'M15', file: 'index.js', label: 'readDisabledableNumber accepts 0-less (no >=0)',
    from: "  return Number.isSafeInteger(value) && value >= 0 ? value : fallback",
    to: "  return Number.isSafeInteger(value) ? value : fallback" },
  { id: 'M16', file: 'index.js', label: 'readFlag accepts truthiness',
    from: "  return typeof value === 'boolean' ? value : fallback",
    to: "  return value ? true : fallback" },

  // ---- templates / rendering
  { id: 'M17', file: 'index.js', label: 'renderTemplate: sequential per-key replace',
    from: "  return template.replace(/\\{(\\w+)\\}/g, (match, key) => (key in vars ? String(vars[key]) : match))",
    to: "  let out = template\n  for (const key of Object.keys(vars)) out = out.replaceAll(`{${key}}`, String(vars[key]))\n  return out" },
  { id: 'M18', file: 'index.js', label: 'renderAdvisory: no guaranteed list append',
    from: "  return text.includes(list) ? text : `${text}\\n\\n${list}`",
    to: "  return text" },
  { id: 'M19', file: 'index.js', label: 'renderTodos: no omission line',
    from: "  if (omitted > 0) shown.push(`- (+${omitted} more item(s) not shown)`)",
    to: "  // mutated: omission not reported" },
  { id: 'M20', file: 'index.js', label: 'clipText: no truncation',
    from: "  return flat.length > MAX_TODO_LINE_CHARS ? `${flat.slice(0, MAX_TODO_LINE_CHARS)}...` : flat",
    to: "  return flat" },

  // ---- stop gate
  { id: 'M21', file: 'index.js', label: 'gate not turn-local (<= instead of ===)',
    from: "    if (standing.todos !== undefined && standing.writtenTurn === turn) {",
    to: "    if (standing.todos !== undefined && standing.writtenTurn <= turn) {" },
  { id: 'M22', file: 'index.js', label: 'veto cap off-by-one (> instead of >=)',
    from: "      } else if (state.gateSteers >= cfg.gateMaxSteers) {",
    to: "      } else if (state.gateSteers > cfg.gateMaxSteers) {" },
  { id: 'M23', file: 'index.js', label: 'gateMaxSteers === 0 not honoured',
    from: "      if (cfg.gateMaxSteers === 0) {\n        decide('gate:off')\n        return\n      }",
    to: "      // mutated: no off switch" },
  { id: 'M24', file: 'index.js', label: 'veto budget not reset per turn',
    from: "    if (state.turn !== turn) {\n      state.turn = turn\n      state.gateSteers = 0\n      state.capReported = false\n    }",
    to: "    state.turn = turn" },
  { id: 'M25', file: 'index.js', label: 'stop-gate listener: no try/catch (fail closed)',
    from: "    try {\n      runStopGate(agent, turn)\n    } catch (error) {\n      report(ctx, 'stop gate', error)\n    }",
    to: "    runStopGate(agent, turn)" },
  { id: 'M26', file: 'index.js', label: 'cap warning emitted every boundary',
    from: "        if (!state.capReported) {\n          state.capReported = true\n",
    to: "        if (true) {\n          state.capReported = true\n" },

  // ---- delegation
  { id: 'M27', file: 'index.js', label: 'isDelegated always false',
    from: "  if (header?.origin === 'subagent') return true",
    to: "  if (false) return true" },
  { id: 'M28', file: 'index.js', label: 'isDelegated ignores descriptor scan',
    from: "    if (record?.type === 'subagent/descriptor') return true",
    to: "    if (false) return true" },
  { id: 'M29', file: 'index.js', label: 'delegationDepth branch dropped',
    from: "  if (Number.isSafeInteger(header?.delegationDepth) && header.delegationDepth > 0) return true",
    to: "  // mutated: delegationDepth ignored" },
  { id: 'M30', file: 'index.js', label: 'gateSubagents inverted',
    from: "      const skipGateForSession = cfg.gateSubagents ? false : (state.delegated ??= isDelegated(agent.session))",
    to: "      const skipGateForSession = cfg.gateSubagents ? (state.delegated ??= isDelegated(agent.session)) : false" },

  // ---- advisory rate limiting
  { id: 'M31', file: 'index.js', label: 'stale cooldown check removed',
    from: "  if (state.lastStalePromptTurn !== 0 && turn - state.lastStalePromptTurn < cfg.staleEvery) {\n    return skipped(`cooldown ${turn - state.lastStalePromptTurn}<${cfg.staleEvery}`)\n  }",
    to: "  // mutated: cooldown removed" },
  { id: 'M32', file: 'index.js', label: 'idle interval comparison flipped',
    from: "  if (idle < cfg.staleEvery) return skipped(`idle ${idle}<${cfg.staleEvery}`)",
    to: "  if (idle <= cfg.staleEvery) return skipped(`idle ${idle}<${cfg.staleEvery}`)" },
  { id: 'M33', file: 'index.js', label: 'writtenTurn===0 guard removed',
    from: "  if (standing.writtenTurn === 0) return skipped('no-write-turn')",
    to: "  // mutated: no-write-turn guard removed" },
  { id: 'M34', file: 'index.js', label: 'per-list cap never engages',
    from: "    if (cfg.maxPromptsPerList > 0 && state.promptsForList >= cfg.maxPromptsPerList && state.quietListId === null) {",
    to: "    if (false) {" },
  { id: 'M35', file: 'index.js', label: 'per-list cap off-by-one (> instead of >=)',
    from: "    if (cfg.maxPromptsPerList > 0 && state.promptsForList >= cfg.maxPromptsPerList && state.quietListId === null) {",
    to: "    if (cfg.maxPromptsPerList > 0 && state.promptsForList > cfg.maxPromptsPerList && state.quietListId === null) {" },
  { id: 'M36', file: 'index.js', label: 'listIdentity drops writtenTurn prefix',
    from: "  return `t${writtenTurn}:${hash >>> 0}`", to: "  return `${hash >>> 0}`" },
  { id: 'M37', file: 'index.js', label: 'listIdentity ignores content (turn only)',
    from: "  const source = JSON.stringify(items)", to: "  const source = ''" },
  { id: 'M38', file: 'index.js', label: 'quiet flag not cleared on list change',
    from: "    state.quietListId = null\n    state.promptListId = null\n    state.promptsForList = 0",
    to: "    state.promptListId = null\n    state.promptsForList = 0" },
  { id: 'M39', file: 'index.js', label: 'compaction prompt dedupe removed',
    from: "    && standing.compactionId !== null && state.lastCompactionPromptId !== standing.compactionId",
    to: "     && standing.compactionId !== null" },
  { id: 'M40', file: 'index.js', label: 'compaction hand-back resets stale clock: no',
    from: "    state.lastStalePromptTurn = turn\n    return deliver(`compaction id=",
    to: "    return deliver(`compaction id=" },
  { id: 'M41', file: 'index.js', label: 'promptAfterCompaction switch ignored',
    from: "  const newCompaction = cfg.afterCompaction && standing.compactedAfterWrite",
    to: "  const newCompaction = standing.compactedAfterWrite" },
  { id: 'M42', file: 'index.js', label: 'staleEvery === 0 does not disable',
    from: "  if (cfg.staleEvery === 0) return skipped('interval-off')",
    to: "  // mutated: interval-off removed" },

  // ---- notices / logging / mount
  { id: 'M43', file: 'index.js', label: "steerMessage: drop form:'notice'",
    from: "      form: 'notice',\n", to: "" },
  { id: 'M44', file: 'index.js', label: 'steerMessage: no summary truncation',
    from: "      summary: String(summary ?? text).replace(/\\s+/g, ' ').trim().slice(0, 120),",
    to: "      summary: String(summary ?? text)," },
  { id: 'M45', file: 'index.js', label: 'note() logs unconditionally',
    from: "  if (cfg.logDecisions) emit(ctx, 'debug', message)",
    to: "  emit(ctx, 'debug', message)" },
  { id: 'M46', file: 'index.js', label: 'removed-key warning every boundary',
    from: "    if (removed.length > 0) {", to: "    if (false) {" },
  { id: 'M47', file: 'index.js', label: 'duplicate-registration recovery removed',
    from: "    const live = ctx.settings?.get?.(SETTINGS_NS)\n    if (live !== undefined) {",
    to: "    const live = undefined\n    if (live !== undefined) {" },
  { id: 'M48', file: 'index.js', label: 'session/disposed handler removed',
    from: "  ctx.on('session/disposed', (session) => {\n    states.delete(session.id)\n  }, { global: true })",
    to: "  // mutated: no disposal handler" },
  { id: 'M49', file: 'index.js', label: 'mid-turn listener swallows next() result',
    from: "        additionalContexts: [...(decision.additionalContexts ?? []), steerMessage(advisory.text, advisory.summary)],",
    to: "        additionalContexts: [steerMessage(advisory.text, advisory.summary)]," },
  { id: 'M50', file: 'index.js', label: 'mid-turn listener reads exec outside its guard',
    from: "    try {\n      const agent = exec?.agent\n      if (!agent?.session) return decision",
    to: "    const agent = exec?.agent\n    if (!agent?.session) return decision\n    try {" },
  { id: 'M51', file: 'index.js', label: 'mid-turn failure not isolated',
    from: "    } catch (error) {\n      report(ctx, 'mid-turn context', error)\n      return decision\n    }",
    to: "    } catch (error) {\n      throw error\n    }" },
  { id: 'M52', file: 'index.js', label: 'no-agent exec not short-circuited',
    from: "    if (!agent?.session) return decision",
    to: "    // mutated: no guard" },

  // ---- client.js chip logic
  { id: 'M53', file: 'client.js', label: 'chip: backscan stops at turn/start',
    from: '        if (event?.type === "todo/write" && Array.isArray(event?.data?.todos)) {\n          return { todos: event.data.todos, index: i };\n        }',
    to: '        if (event?.type === "turn/start") return null;\n        if (event?.type === "todo/write" && Array.isArray(event?.data?.todos)) {\n          return { todos: event.data.todos, index: i };\n        }' },
  { id: 'M54', file: 'client.js', label: 'chip: turnsAfter counts every event',
    from: '        if (events[i]?.type === "turn/start") count += 1;',
    to: '        count += 1;' },
  { id: 'M55', file: 'client.js', label: 'chip: deliveryKind loses veto wording',
    from: '      if (/turn sent back/.test(text)) return "veto";',
    to: '        // mutated: veto wording gone' },
  { id: 'M56', file: 'client.js', label: 'chip: resume gap threshold 0',
    from: '    const RESUME_GAP_MS = 3 * 60 * 1000;',
    to: '        const RESUME_GAP_MS = 0;' },
  { id: 'M57', file: 'client.js', label: 'chip: completed head uses unfinished count',
    from: '        ? `Todo Gate · ${status.total}/${status.total} done`',
    to: '        ? `Todo Gate · ${status.unfinished}/${status.total} done`' },
  { id: 'M58', file: 'client.js', label: 'chip: empty list still renders',
    from: '      if (status === null || status.total === 0) return null;',
    to: '        if (status === null) return null;' },
  { id: 'M59', file: 'client.js', label: 'chip: todo/write break removed in lastDelivery',
    from: '            if (events[j]?.type === "todo/write") break; // the model already had the list this turn',
    to: '            // mutated: no break on same-turn write' },
  { id: 'M60', file: 'client.js', label: 'chip: unfinished filter inverted',
    from: '      const unfinished = todos.filter((item) => item?.status !== "completed").length;',
    to: '        const unfinished = todos.filter((item) => item?.status === "completed").length;' },
]

function runSuite() {
  // stdio: 'pipe' is blocked by the file sandbox (EPERM), so redirect the child's
  // output through real file descriptors and read them back.
  const out = path.join(ROOT, '.audit', 'last-out.txt')
  const err = path.join(ROOT, '.audit', 'last-err.txt')
  for (const f of [out, err]) fs.rmSync(f, { force: true })
  const fo = fs.openSync(out, 'w')
  const fe = fs.openSync(err, 'w')
  const r = spawnSync(process.execPath, [path.join(SB, 'test', 'todo-continuation.test.js')], {
    cwd: ROOT, timeout: 120000, stdio: ['ignore', fo, fe],
  })
  for (const fd of [fo, fe]) fs.closeSync(fd)
  const text = (fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '') + (fs.existsSync(err) ? fs.readFileSync(err, 'utf8') : '')
  if (r.error) return { code: -1, out: `${text}\nSPAWN_ERROR ${r.error.message}` }
  return { code: r.status === null ? -1 : r.status, out: text }
}

/** Files are CRLF; anchors are written with \n. Normalise both to LF, mutate, write LF. */
function load(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n')
}

const results = []
const filter = process.argv[2]
for (const m of MUTATIONS) {
  if (filter && !m.id.startsWith(filter)) continue
  fs.rmSync(SB, { recursive: true, force: true })
  fs.mkdirSync(path.join(SB, 'test'), { recursive: true })
  const original = load(m.file)
  const from = m.from.replace(/\r\n/g, '\n')
  const to = m.to.replace(/\r\n/g, '\n')
  const occurrences = original.split(from).length - 1
  if (occurrences !== 1) {
    results.push({ ...m, status: 'BAD_PATCH', detail: `anchor occurs ${occurrences}x` })
    continue
  }
  const other = m.file === 'index.js' ? 'client.js' : 'index.js'
  fs.writeFileSync(path.join(SB, m.file), original)
  fs.writeFileSync(path.join(SB, other), load(other))
  fs.copyFileSync(path.join(ROOT, 'test', 'todo-continuation.test.js'), path.join(SB, 'test', 'todo-continuation.test.js'))

  // TRUE baseline: the clean, unmutated sandbox must be green before mutating.
  const baseline = runSuite()
  if (baseline.code !== 0) {
    results.push({ ...m, status: 'SANDBOX_BROKEN', detail: `clean baseline fails: ${baseline.out.slice(-400)}` })
    continue
  }
  fs.writeFileSync(path.join(SB, m.file), original.replace(from, to))

  const mut = runSuite()
  const failed = [...mut.out.matchAll(/^# (pass|fail) (\d+)$/gm)].map(x => `${x[1]}=${x[2]}`).join(' ')
  const names = [...mut.out.matchAll(/^not ok \d+ - (.+)$/gm)].map(x => x[1].trim())
  results.push({
    ...m,
    status: mut.code === 0 ? 'SURVIVED' : 'KILLED',
    detail: mut.code === 0 ? 'suite fully green with this defect injected' : `${failed} :: ${names.length} failing: ${names.slice(0, 8).join(' | ')}`,
    killers: names,
  })
  console.log(`${results[results.length - 1].status.padEnd(9)} ${m.id} ${m.file} — ${m.label}`)
}
fs.rmSync(SB, { recursive: true, force: true })
fs.writeFileSync(path.join(ROOT, '.audit', 'mutation-results.json'), JSON.stringify(results, null, 2))
const survived = results.filter(r => r.status === 'SURVIVED')
const killed = results.filter(r => r.status === 'KILLED')
const other = results.filter(r => r.status !== 'SURVIVED' && r.status !== 'KILLED')
console.log(`\n=== ${results.length} mutants | KILLED ${killed.length} | SURVIVED ${survived.length} | PATCH/BASELINE PROBLEMS ${other.length}`)
for (const s of survived) console.log(`SURVIVED ${s.id} ${s.file} — ${s.label}`)
for (const o of other) console.log(`${o.status} ${o.id} ${o.file} — ${o.label} :: ${o.detail}`)

// A harness that always exits 0 turns CI into theatre: it would stay green even if every
// single mutant survived. Verdict semantics, with exactly one escape hatch ? mutants
// annotated above as provably equivalent.
const EQUIVALENT_SURVIVORS = {
  // The settings schema declares .pattern(/\{n\}/) on the same field, so an invalid
  // stored template fails at registration and the plugin degrades to defaults; the
  // reader's copy of the check is unreachable from the public surface.
  M14: 'schema rejects the value upstream; the reader guard is defence-in-depth',
}
const unexpected = survived.filter(r => !Object.keys(EQUIVALENT_SURVIVORS).includes(r.id))
for (const id of Object.keys(EQUIVALENT_SURVIVORS)) {
  if (!survived.some(r => r.id === id)) {
    console.log(`STALE-ANNOTATION ${id} was excused as equivalent but is now killed ? drop the excuse`)
  }
}
const verdict = unexpected.length || other.length
console.log(verdict ? '\nFAIL ? the suite did not catch everything it claims to' : '\nPASS ? every mutant is accounted for')
for (const u of unexpected) console.log(`UNCAUGHT ${u.id} ${u.file} ? ${u.label}`)
for (const o of other) console.log(`UNAPPLIED ${o.id} ${o.file} ? ${o.label}: ${o.detail}`)
for (const [id, why] of Object.entries(EQUIVALENT_SURVIVORS)) if (survived.some(r => r.id === id)) console.log(`EXCUSED ${id}: ${why}`)
process.exit(verdict ? 1 : 0)
