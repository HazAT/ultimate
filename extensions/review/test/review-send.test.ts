import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { limits } from '../comments.ts'
import type { ReviewComment } from '../comments.ts'
import { context } from '../../../server/harness.ts'
import { fauxServer, post, removeTemp, temp } from '../../../test/helpers.ts'

const comment = (overrides: Partial<ReviewComment> = {}): ReviewComment => ({
  file: 'src/app.ts',
  side: 'new',
  start: 3,
  end: 4,
  excerpt: 'const a = 1\nconst b = 2',
  text: 'Name these.',
  ...overrides,
})

it('sends one review input to a conversation, refuses bad reviews, and is user-only', async () => {
  const home = await temp('ultimate-review-send-')
  const project = join(home, 'project')
  await mkdir(join(project, '.ultimate'), { recursive: true })
  await writeFile(join(project, '.ultimate/settings.json'), '{}')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome: home,
    home: join(home, 'state'),
    localSetup: false,
  })
  try {
    const send = (args: unknown) => post(server, '/api/extensions/review/actions/send', { args })
    const target = (await post(server, '/api/conversations', { title: 'Recipient' })).data
      .id as number
    const conversation = (await server.harness.conversation(target as ConversationId, context))!
    server.host.faux!.setResponses([fauxAssistantMessage('Looking at it.')])

    const sent = await send({
      conversation: target,
      spec: 'abc1234',
      note: 'Mostly naming.',
      comments: [
        comment(),
        comment({ file: 'README.md', side: 'old', start: 7, end: 7, excerpt: '# Old' }),
      ],
    })
    expect(sent.status).toBe(200)
    expect(sent.data.result).toEqual({ conversation: target })
    await server.harness.waitForIdle(context)
    const entries = (await conversation.context(context)).entries
    const reviews = entries.filter((entry) => entry.kind === 'review.comments')
    expect(reviews).toHaveLength(1)
    expect(reviews[0].data).toMatchObject({ spec: 'abc1234', note: 'Mostly naming.' })
    const message = reviews[0].model?.[0]
    expect(message?.role).toBe('user')
    expect(message && 'content' in message ? message.content : undefined).toBe(
      [
        'Review of `abc1234` (2 comments)',
        'Mostly naming.',
        '`src/app.ts:3-4` (new)\n```ts\nconst a = 1\nconst b = 2\n```\nName these.',
        '`README.md:7` (old)\n```md\n# Old\n```\nName these.',
      ].join('\n\n'),
    )
    // It woke the recipient as a typed message would.
    expect(entries.at(-1)?.kind).toBe('pi.assistant')

    const refusals: [unknown, string][] = [
      [{ conversation: 9999, spec: 'x', comments: [comment()] }, 'existing conversation'],
      [{ conversation: target, spec: 'x', comments: [] }, 'non-empty'],
      [
        { conversation: target, spec: 'x', comments: Array.from({ length: 51 }, () => comment()) },
        'At most 50',
      ],
      [
        { conversation: target, spec: 'x', comments: [comment({ text: 'x'.repeat(4001) })] },
        'longer than 4000',
      ],
      [
        {
          conversation: target,
          spec: 'x',
          comments: [comment({ excerpt: Array.from({ length: 41 }, () => 'x').join('\n') })],
        },
        'longer than 40 lines',
      ],
      [
        { conversation: target, spec: 'x', comments: [comment({ excerpt: 'é'.repeat(4097) })] },
        'larger than 8 KB',
      ],
      [
        { conversation: target, spec: 'x', comments: [comment({ start: 5, end: 4 })] },
        'start ≤ end',
      ],
      [
        { conversation: target, spec: 'x', comments: [comment({ side: 'left' as 'old' })] },
        'old or new',
      ],
    ]
    expect(limits.comments).toBe(50)
    for (const [args, error] of refusals) {
      const response = await send(args)
      expect(response.status).not.toBe(200)
      expect(JSON.stringify(response.data)).toContain(error)
    }
    expect(
      (await conversation.context(context)).entries.filter(
        (entry) => entry.kind === 'review.comments',
      ),
    ).toHaveLength(1)

    // Without a branch, landing or trailer behind the spec, a review goes to the primary agent.
    const standing = await post(server, '/api/extensions/subagents/actions/standing', {
      args: { name: 'ultimate' },
    })
    for (const spec of ['uncommitted', 'deadbeef', 'a...b'])
      expect(
        (await post(server, '/api/extensions/review/actions/recipient', { args: { spec } })).data
          .result,
      ).toEqual({ conversation: standing.data.result })

    // An agent cannot send a review in the user's name.
    const route: FauxResponseFactory = (transcript) => {
      const last = transcript.messages.at(-1)
      return last?.role === 'toolResult'
        ? fauxAssistantMessage('Done')
        : fauxAssistantMessage(
            [
              fauxToolCall('codemode', {
                code: `return await ultimate.action('review', 'send', ${JSON.stringify({ conversation: target, spec: 'x', comments: [comment()] })});`,
              }),
            ],
            { stopReason: 'toolUse' },
          )
    }
    server.host.faux!.setResponses([route, route])
    await server.root.submit({ type: 'input', content: 'send a review' }, context)
    await server.harness.waitForIdle(context)
    const result = (await server.root.context(context)).entries.findLast(
      (entry) => entry.kind === 'pi.tool-result',
    )
    expect(JSON.stringify(result?.model)).toContain('review/send is a user-only action')
  } finally {
    await server.close()
    await removeTemp(home)
  }
})
