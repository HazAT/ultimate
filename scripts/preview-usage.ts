import { DatabaseSync } from 'node:sqlite'
import { chapterFiles, readChapters } from '../lib/chapters.ts'

const [home, since = '2026-10-26'] = process.argv.slice(2)
if (!home) throw new Error('Usage: node scripts/preview-usage.ts <project home> [first week]')
const from = Date.parse(since)

type Week = {
  week: string
  conversations: Set<number>
  browserCalls: number
  uiSteps: number
  clickSteps: number
  evalSteps: number
  screenshots: number
}
const weeks = new Map<string, Week>()
const weekOf = (ms: number) => {
  const day = new Date(ms)
  day.setUTCHours(0, 0, 0, 0)
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
  return day.toISOString().slice(0, 10)
}
const at = (ms: number) => {
  const week = weekOf(ms)
  const item = weeks.get(week) ?? {
    week,
    conversations: new Set<number>(),
    browserCalls: 0,
    uiSteps: 0,
    clickSteps: 0,
    evalSteps: 0,
    screenshots: 0,
  }
  weeks.set(week, item)
  return item
}

type Content = { type: string; name?: string; arguments?: { steps?: Record<string, unknown>[] } }
type Message = { role: string; timestamp?: number; toolName?: string; content?: Content[] }
const count = (conversation: number, message: Message) => {
  if (!message.timestamp || message.timestamp < from) return
  if (message.role === 'toolResult') {
    if (message.toolName === 'browser' && message.content?.some((part) => part.type === 'image'))
      at(message.timestamp).screenshots++
    return
  }
  if (message.role !== 'assistant') return
  for (const part of message.content ?? []) {
    if (part.type !== 'toolCall' || (part.name !== 'browser' && part.name !== 'screenshot'))
      continue
    const week = at(message.timestamp)
    week.conversations.add(conversation)
    if (part.name === 'screenshot') {
      week.screenshots++
      continue
    }
    week.browserCalls++
    for (const step of part.arguments?.steps ?? []) {
      if ('ui' in step) week.uiSteps++
      else if ('click' in step || 'fill' in step || 'press' in step) week.clickSteps++
      else if ('eval' in step) week.evalSteps++
    }
  }
}

for (const { name } of (await readChapters(home)).chapters) {
  const db = new DatabaseSync(chapterFiles(home, name).database, { readOnly: true })
  const rows = db
    .prepare(
      `SELECT conversation_id AS conversation, record FROM entries
       WHERE record LIKE '%"name":"browser"%' OR record LIKE '%"name":"screenshot"%'
          OR record LIKE '%"toolName":"browser"%'`,
    )
    .all() as { conversation: number; record: string }[]
  db.close()
  for (const row of rows)
    for (const message of (JSON.parse(row.record) as { model?: Message[] }).model ?? [])
      count(row.conversation, message)
}
console.log(
  JSON.stringify(
    [...weeks.values()]
      .toSorted((a, b) => a.week.localeCompare(b.week))
      .map(({ conversations, ...week }) => ({ ...week, conversations: conversations.size })),
  ),
)
