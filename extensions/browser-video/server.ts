import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import {
  defineExtension,
  section,
  type ConversationId,
  type Cursor,
} from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { browserVideoId, browserVideoOf } from '../../lib/browser-video.ts'
import { errnoCode, isMissing } from '../../lib/errors.ts'
import { parseConversationId } from '../../lib/ids.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ExtensionFiles } from '../../server/private-files.ts'
import { QuestionVideo } from '../messages/api.ts'
import { LandingClipsAction } from './refs.ts'

function ownerOnly(stat: { uid: number; mode: number }) {
  return stat.uid === (process.getuid?.() ?? stat.uid) && !(stat.mode & 0o077)
}

async function openClip(home: string, id: string) {
  if (!browserVideoId.test(id)) return undefined
  const root = join(home, 'browser-videos')
  const directory = join(root, id)
  try {
    for (const path of [root, directory]) {
      const stat = await lstat(path)
      if (!stat.isDirectory() || !ownerOnly(stat)) return undefined
    }
    const file = await open(
      join(directory, 'video.webm'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    let keep = false
    try {
      const stat = await file.stat()
      keep = stat.isFile() && stat.size > 0 && ownerOnly(stat)
      if (keep) return file
    } finally {
      if (!keep) await file.close()
    }
  } catch (error) {
    if (!isMissing(error) && errnoCode(error) !== 'ELOOP') throw error
  }
  return undefined
}

export const files: ExtensionFiles = async (id, key, { host }) => {
  if (key !== 'video') return undefined
  const file = await openClip(host.home, id)
  if (file) return { file, name: 'browser-video.webm', type: 'video/webm' }
  return undefined
}

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
      if (browserVideoId.test(id)) {
        for await (const clip of recordings(host, sender, ctx)) {
          if (clip.id !== id) continue
          const file = await openClip(host.home, id)
          if (!file) throw new Error('The selected browser video is unavailable.')
          await file.close()
          return clip
        }
      }
      throw new Error('Choose a finalized browser_video clip from this conversation.')
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
    const clips = []
    for await (const clip of recordings(
      host,
      parseConversationId(conversation),
      BACKGROUND_CONTEXT,
    )) {
      signal.throwIfAborted()
      const file = await openClip(host.home, clip.id)
      if (!file) continue
      await file.close()
      clips.push(clip)
      if (clips.length === 12) break
    }
    return clips
  }),
}
