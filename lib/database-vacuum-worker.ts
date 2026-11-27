import { DatabaseSync } from 'node:sqlite'
import { workerData } from 'node:worker_threads'

const { database, copy } = workerData as { database: string; copy: string }
using db = new DatabaseSync(database, { readOnly: true })
db.prepare('VACUUM INTO ?').run(copy)
