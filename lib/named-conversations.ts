import type { Context } from '@earendil-works/chord/context'
import type { ExtensionHost } from '../server/extensions.ts'
import { parseConversationId } from './ids.ts'
import { mentionedConversations } from './mentions.ts'

export async function namedConversations(
  host: Pick<ExtensionHost, 'harness' | 'metadata'>,
  text: string,
  ctx: Context,
) {
  const named = await Promise.all(
    mentionedConversations(text).map(async (id) => {
      const conversation = parseConversationId(id)
      if (!(await host.harness().conversation(conversation, ctx))) return { id }
      const title = (await host.harness().snapshot(host.metadata, conversation, ctx))?.title
      return { id, title: title ?? 'untitled' }
    }),
  )
  const unknown = named.filter((item) => item.title === undefined).map(({ id }) => `#${id}`)
  if (unknown.length)
    throw new Error(
      `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a conversation' : 'are not conversations'}; nothing was sent. Quote a conversation id from the tool result that returned it, or write a number that is not one without its # ("card 6214").`,
    )
  return named.length
    ? `\nNamed: ${named.map(({ id, title }) => `#${id} ${title}`).join('; ')}.`
    : ''
}
