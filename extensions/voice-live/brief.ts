/**
 * The context brief a voice session starts from, put together in code, no model: the project memory a branch starts
 * from, the user's recent requests to @ultimate with the gist of each answer, and the open branches.
 */
import type { Context } from '@earendil-works/chord/context'
import type { ConversationId, Cursor, EntryRecord } from '@earendil-works/pi-durable'
import type { Message } from '@earendil-works/pi-ai'
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import { formatAgo } from '../../lib/ago.ts'
import { isInput } from '../../lib/entries.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { LineageApi } from '../lineage/api.ts'
import { MessagesApi } from '../messages/api.ts'
import type { VoiceContext } from './refs.ts'

const REQUESTS = 5
const BRANCHES = 8
/** How far back into @ultimate's transcript to look for the recent requests. */
const SCAN = 3000

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
const oneLine = (text: string) =>
  text
    .split('\n')
    .map((line) => line.replace(/[*_`#>]/g, '').trim())
    .find(Boolean) ?? ''

function contentText(content: Message['content']) {
  return typeof content === 'string'
    ? content
    : content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

/** What the user asked in `entry`, or undefined when it is not a request from the user. */
function request(entry: EntryRecord) {
  const data = (entry.data ?? {}) as { text?: unknown; from?: unknown }
  if (entry.kind === 'voice.utterance' && typeof data.text === 'string')
    return { text: data.text, voice: true }
  if (entry.kind === 'board.message' && data.from === 'user' && typeof data.text === 'string')
    return { text: data.text, voice: false }
  const message = entry.model?.[0]
  if (entry.kind === 'pi.user' && message?.role === 'user')
    return { text: contentText(message.content), voice: false }
  return undefined
}

/** What @ultimate told the user in `entry`: its message to the user, else its prose. */
function said(entry: EntryRecord) {
  let text = ''
  for (const message of entry.model ?? []) {
    if (message.role !== 'assistant') continue
    for (const part of message.content) {
      if (part.type === 'text' && part.text.trim()) text = part.text
      if (
        part.type === 'toolCall' &&
        part.name === 'message' &&
        part.arguments.to === 'user' &&
        typeof part.arguments.text === 'string'
      )
        text = part.arguments.text
    }
  }
  return text
}

/**
 * The user's newest requests to @ultimate, oldest first, each with the first line of what its run answered: the newest
 * text of the run the request started, before the next input (a branch's message, a wake-up) began another.
 */
async function recentRequests(host: ExtensionHost, main: ConversationId, ctx: Context) {
  const conversation = (await host.harness().conversation(main, ctx))!
  const found: { entry: EntryRecord; text: string; voice: boolean; answer: string }[] = []
  let answer = ''
  let scanned = 0
  let cursor: Cursor | undefined
  scan: do {
    const page = await conversation.entries({ order: 'descending' }, 100, cursor, ctx)
    for (const entry of page.items) {
      const asked = request(entry)
      if (asked) {
        found.push({ entry, ...asked, answer })
        answer = ''
        if (found.length === REQUESTS) break scan
      } else if (isInput(entry)) answer = ''
      else if (!answer && entry.kind === 'pi.assistant') answer = said(entry)
      if (++scanned === SCAN) break scan
    }
    cursor = page.next
  } while (cursor)
  const now = Date.now()
  return found.toReversed().map(({ entry, text, voice, answer: answered }) => {
    const at = entry.model?.[0]?.timestamp
    const when = at === undefined ? '' : formatAgo(at, now, { ago: true })
    const reply = oneLine(answered)
    return `- ${when}${voice ? ', by voice' : ''}: "${clip(text.trim().replace(/\s+/g, ' '), 300)}"\n  → ${reply ? clip(reply, 220) : 'no answer yet'}`
  })
}

/** The open branches, newest activity first: not concluded, with their title and whether they are working. */
async function openBranches(host: ExtensionHost, ctx: Context) {
  const concluded = await host.need(ConversationsApi).concluded(ctx)
  const now = Date.now()
  return host
    .conversations()
    .filter((c) => c.branchOf && !c.parentConversationId && !concluded.has(c.id as ConversationId))
    .toSorted((a, b) => (b.inputAt ?? 0) - (a.inputAt ?? 0))
    .slice(0, BRANCHES)
    .map(
      (c) =>
        `- #${c.id} "${clip(c.title ?? 'untitled', 120)}" · ${c.busy ? 'working' : 'idle'}${c.inputAt ? ` · last input ${formatAgo(c.inputAt, now, { ago: true })}` : ''}`,
    )
}

/** The brief for a session of @ultimate's voice, `main` being @ultimate's conversation. */
export async function voiceBrief(
  host: ExtensionHost,
  main: ConversationId,
  ctx: Context,
): Promise<VoiceContext> {
  const [memory, requests, branches, questions] = await Promise.all([
    host.need(LineageApi).memoryBrief(main, ctx),
    recentRequests(host, main, ctx),
    openBranches(host, ctx),
    host.need(MessagesApi).openQuestions(ctx),
  ])
  const now = Date.now()
  const asker = (id: number) =>
    id === main
      ? '@ultimate'
      : `#${id} "${clip(host.conversations().find((c) => c.id === id)?.title ?? 'untitled', 80)}"`
  const text = [
    '<voice_context>',
    'Context for this voice session: background for understanding what the user refers to, not a request.',
    ...(memory ? ['', memory.text] : []),
    '',
    requests.length
      ? `The user's latest requests to @ultimate, oldest first, each with the first line of its answer:\n${requests.join('\n')}`
      : 'No recent requests to @ultimate.',
    '',
    branches.length
      ? `Open branches (conversations @ultimate started for a feature or fix):\n${branches.join('\n')}`
      : 'No open branches.',
    '',
    questions.length
      ? `Open questions waiting on the user, oldest first (the Inbox order):\n${questions
          .map(
            (q) =>
              `- message ${q.message} from ${asker(q.conversation)}: ${q.text} (asked ${formatAgo(q.at, now, { ago: true })})`,
          )
          .join('\n')}`
      : 'No open questions.',
    '</voice_context>',
  ].join('\n')
  return {
    text,
    memories: memory?.memories ?? 0,
    requests: requests.length,
    branches: branches.length,
    questions: questions.length,
    tokens: estimateTextTokens(text),
    at: Date.now(),
  }
}
