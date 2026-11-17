// Copy a project's live database into a scratch home that opens paused, for measuring on real data without waking it.
// Usage: node copy-paused.ts <source state.sqlite> <scratch home>
// The source is only read (VACUUM INTO). The copy gets a manual pause in the root's `pause.state` document, so queued
// inputs, automations and interrupted runs in it stay held: the pause extension holds the scheduler on open.
import { mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const [source, home] = process.argv.slice(2).map((path) => resolve(path))
if (!source || !home)
  throw new Error('Usage: node copy-paused.ts <source state.sqlite> <scratch home>')
const target = join(home, 'state.sqlite')
if (existsSync(target)) throw new Error(`${target} exists; use a fresh scratch home`)
mkdirSync(home, { recursive: true })

const live = new DatabaseSync(source, { readOnly: true })
live.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
live.close()

// Pi upstream: @earendil-works/pi-durable@1.5.2 src/storage/sqlite/migrations.ts — a document is a `documents` row
// plus `document_revisions` (a base, then deltas of chord ops), each revision numbered from durable_metadata.next_seq.
const db = new DatabaseSync(target)
try {
  db.exec('BEGIN')
  const next = Number(
    db.prepare('SELECT next_seq FROM durable_metadata WHERE singleton = 1').get()!.next_seq,
  )
  const now = Date.now()
  const doc = db
    .prepare(
      `SELECT id FROM documents WHERE kind = '"pause.state"' AND scope_kind = 'conversation' AND owner_id = 1 AND retired_at IS NULL`,
    )
    .get()?.id as number | undefined
  // A home that was never paused has no document to extend; pause it once (⌘K Pause, then Play) and copy again.
  if (doc === undefined)
    throw new Error('The source has no pause.state document; pause and play it once first')
  const ops = [
    ['s', ['paused'], true],
    ['s', ['since'], now],
    ['s', ['runs'], {}],
    ['s', ['manual'], true],
  ]
  db.prepare(
    `INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, ?, 'delta', 1, ?)`,
  ).run(doc, next, JSON.stringify(ops))
  db.prepare('UPDATE durable_metadata SET next_seq = ? WHERE singleton = 1').run(next + 1)
  db.exec('COMMIT')
} finally {
  db.close()
}
console.log(
  `Copied ${source} to ${target}, paused. Verify with the pause extension's state action after start.`,
)
