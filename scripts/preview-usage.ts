import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const [home, since = '2026-10-27'] = process.argv.slice(2)
if (!home) throw new Error('Usage: node scripts/preview-usage.ts <project home> [first week]')
const { chapters } = JSON.parse(await readFile(join(home, 'chapters.json'), 'utf8')) as {
  chapters: { name: string }[]
}
const databases = chapters.map(({ name }, index) =>
  index === 0 ? join(home, 'state.sqlite') : join(home, 'chapters', name, 'state.sqlite'),
)

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
  let item = weeks.get(week)
  if (!item)
    weeks.set(
      week,
      (item = {
        week,
        conversations: new Set(),
        browserCalls: 0,
        uiSteps: 0,
        clickSteps: 0,
        evalSteps: 0,
        screenshots: 0,
      }),
    )
  return item
}
const from = Date.parse(since)

type Content = { type: string; name?: string; arguments?: { steps?: Record<string, unknown>[] } }
type Message = { role: string; timestamp?: number; toolName?: string; content?: Content[] }
for (const path of databases) {
  const db = new DatabaseSync(path, { readOnly: true })
  const rows = db
    .prepare(
      `SELECT conversation_id AS conversation, record FROM entries
       WHERE record LIKE '%"name":"browser"%' OR record LIKE '%"name":"screenshot"%'
          OR record LIKE '%"toolName":"browser"%'`,
    )
    .all() as { conversation: number; record: string }[]
  db.close()
  for (const row of rows) {
    const message = (JSON.parse(row.record) as { model?: Message[] }).model?.[0]
    if (!message?.timestamp || message.timestamp < from) continue
    const week = at(message.timestamp)
    if (message.role === 'toolResult') {
      if (message.toolName === 'browser' && message.content?.some((part) => part.type === 'image'))
        week.screenshots++
      continue
    }
    if (message.role !== 'assistant') continue
    for (const part of message.content ?? []) {
      if (part.type !== 'toolCall') continue
      if (part.name === 'screenshot') {
        week.screenshots++
        week.conversations.add(row.conversation)
      }
      if (part.name !== 'browser') continue
      week.conversations.add(row.conversation)
      week.browserCalls++
      for (const step of part.arguments?.steps ?? []) {
        if ('ui' in step) week.uiSteps++
        else if ('click' in step || 'fill' in step || 'press' in step) week.clickSteps++
        else if ('eval' in step) week.evalSteps++
      }
    }
  }
}
console.log(
  JSON.stringify(
    [...weeks.values()]
      .toSorted((a, b) => a.week.localeCompare(b.week))
      .map(({ conversations, ...week }) => ({ ...week, conversations: conversations.size })),
  ),
)
