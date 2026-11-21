import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context'
import {
  defineExtension,
  section,
  type ConversationId,
  type Cursor,
} from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { browserVideoOf } from '../../lib/browser-video.ts'
import { parseConversationId } from '../../lib/ids.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { BrowserRecordings } from '../browser/api.ts'
import { QuestionVideo, QuestionVideos } from '../messages/api.ts'
import type { QuestionClip } from '../messages/refs.ts'
import { LandingClipsAction } from './refs.ts'

async function* recordings(host: ExtensionHost, sender: ConversationId, ctx: Context) {
  const handle = await host.harness().conversation(sender, ctx)
  if (!handle) return
  let cursor: Cursor | undefined
  do {
    const page = await handle.entries({}, 100, cursor, ctx)
    for (const entry of page.items) {
      if (entry.conversationId !== sender || entry.kind !== 'pi.tool-result') continue
      for (const message of entry.model ?? []) {
        if (
          message.role !== 'toolResult' ||
          message.toolName !== 'browser_video' ||
          message.isError
        )
          continue
        const clip = browserVideoOf(message.details)
        if (clip) yield clip
      }
    }
    cursor = page.next
  } while (cursor !== undefined)
}

export default function browserVideo(host: ExtensionHost) {
  host.implement(QuestionVideo, {
    async validate(sender, id, ctx) {
      const clip = await host.want(BrowserRecordings)?.find(id, ctx)
      if (!clip || clip.conversation !== sender)
        throw new Error('Choose an available browser_video clip from this conversation.')
      return { id: clip.id, title: clip.title }
    },
  })
  return defineExtension({
    name: 'browser-video',
    sections: [
      section('browser_video_review', ({ agent }) => {
        const names = new Set(agent.tools.map((tool) => tool.name))
        if (names.has('browser_video') && names.has('message'))
          return 'When motion is useful for a specific review question, call browser_video directly on an isolated demo with synthetic data. Pass its exact clip ID as video on your reply-expected message to the user. No Before clip is needed.'
        return undefined
      }),
    ],
  })
}

export const pollActions = ['landingClips']
export const actions = {
  landingClips: implementAction(LandingClipsAction, async (args, { host, signal }) => {
    const conversation =
      !Array.isArray(args) && typeof args === 'object' ? args?.conversation : null
    if (typeof conversation !== 'number' || !Number.isSafeInteger(conversation) || conversation < 1)
      throw new Error('conversation must be a conversation id')
    const available = host.want(BrowserRecordings)
    if (!available) return []
    const ctx = withAbortSignal(signal, BACKGROUND_CONTEXT)
    const branch = parseConversationId(conversation)
    const selected = await host.harness().snapshot(QuestionVideos, branch, ctx)
    const clips = new Map<string, QuestionClip>()
    for (const id of selected?.ids.toReversed() ?? []) {
      const clip = await available.find(id, ctx)
      if (clip?.conversation === branch) clips.set(id, { id, title: clip.title })
    }
    let recent = 0
    for await (const clip of recordings(host, branch, ctx)) {
      if (clips.has(clip.id) || !(await available.find(clip.id, ctx))) continue
      clips.set(clip.id, clip)
      if (++recent === 12) break
    }
    return [...clips.values()]
  }),
}
