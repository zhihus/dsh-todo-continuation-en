#!/usr/bin/env node
// NOT A TEST — a one-off manual probe (it asserts nothing; it always exits 0).
// What actually happened in the last 36h across sessions: decompresses
// session.jsonl.zstd logs and prints per-session header, todo/writes, plugin
// deliveries, compactions. Needs live host logs under ~/.dsh/sessions; run it
// by hand, never from CI. Read-only.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const root = join(homedir(), '.dsh', 'sessions')
const now = Date.now()
const WINDOW = 36 * 3600e3
const FORCE = ['3fd96952', '0d23a151'] // user's morning session + the audit session (2026-09 probe)

const fmt = (t) => t == null ? '??' : new Date(t + 4 * 3600e3).toISOString().slice(5, 16).replace('T', ' ') + 'loc'

function loadSession(dir) {
  // The host appends one small zstd frame per write: the file is a multi-frame
  // stream, so a single zstdDecompressSync reads only the first frame. Scan for
  // the magic byte-exactly and decompress frame by frame (same as verify-live).
  const buffer = readFileSync(join(dir, 'session.jsonl.zstd'))
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  let text = ''
  let offset = 0
  while (offset + 4 <= buffer.length) {
    if (buffer.readUInt32BE(offset) === 0x28b52ffd) {
      const found = buffer.indexOf(MAGIC, offset + 4)
      const end = found < 0 ? buffer.length : found
      try { text += zstdDecompressSync(buffer.subarray(offset, end)).toString('utf8') } catch { /* torn tail */ }
      offset = end
    } else {
      offset += 1
    }
  }
  const records = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { records.push(JSON.parse(line)) } catch { /* torn last line */ }
  }
  return records
}

function* sessionDirs(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const p = join(dir, e.name)
    if (e.name.startsWith('session-')) yield p
    else yield* sessionDirs(p)
  }
}

const rows = []
for (const p of sessionDirs(root)) {
  let ev
  try { ev = loadSession(p) } catch { continue }
  if (!ev.length) continue
  const id = p.split(/[/\\]/).at(-1).replace('session-', '').slice(0, 8)
  if (!FORCE.some((x) => id.startsWith(x))) {
    const times = ev.map((r) => r.time).filter((t) => typeof t === 'number')
    if (!times.length || now - Math.max(...times) > WINDOW) continue
  }
  const proj = p.split(/[\\/]/).at(-2)
  const writes = ev.filter((r) => r?.type === 'todo/write')
  const deliveries = ev.filter((r) => r?.type === 'user/message' && r?.data?.source?.plugin === 'todo-continuation')
  const compactions = ev.filter((r) => r?.type === 'compaction/summary')
  const starts = ev.filter((r) => r?.type === 'turn/start')
  const header = {}
  for (const r of ev) if (r?.type === 'session/header' || r?.type === 'header') Object.assign(header, r.data ?? {})
  rows.push({
    proj,
    id,
    origin: header.origin ?? '-',
    depth: header.delegationDepth ?? 0,
    span: `${fmt(ev[0]?.time)} → ${fmt(ev.at(-1)?.time)}`,
    writes: writes.map((r) => fmt(r.time)),
    deliveries: deliveries.map((r) => `${fmt(r.time)} "${String(r.data?.source?.summary ?? r.data?.text ?? '').slice(0, 70)}"`),
    compactions: compactions.map((r) => fmt(r.time)),
    turns: starts.length,
  })
}
rows.sort((a, b) => (a.id < b.id ? -1 : 1))
for (const r of rows) {
  console.log(`\n== ${r.id}  [${r.proj}]  origin=${r.origin} depth=${r.depth} turns=${r.turns}`)
  console.log(`   span      : ${r.span}`)
  console.log(`   todo/write: ${r.writes.length ? r.writes.join(' | ') : 'NONE EVER'}`)
  console.log(`   compact   : ${r.compactions.length ? r.compactions.join(' | ') : '-'}`)
  console.log(`   plugin    : ${r.deliveries.length ? '' : 'NONE'}\n      ${r.deliveries.join('\n      ')}`)
}
