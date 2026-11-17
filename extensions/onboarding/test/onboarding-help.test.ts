import { expect, it } from 'vitest'
import { Messages } from '../../messages/api.ts'
import { Starts } from '../server.ts'
import { Standing } from '../../subagents/api.ts'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../../../server/harness.ts'
import { fauxServer, post, sourceCopy, temp } from '../../../test/helpers.ts'

it('opens setup help in the standing conversation without a message', async () => {
  const home = await temp()
  const server = await fauxServer({ ultimateRoot: await sourceCopy(home), home, userHome: home })
  try {
    let id: number | undefined
    for (const card of ['project', 'git']) {
      const response = await post(server, '/api/extensions/onboarding/actions/help', {
        args: { card },
      })
      expect(response.status).toBe(200)
      id ??= response.data.result.id
      expect(response.data.result.id).toBe(id)
      await server.harness.waitForIdle(context)
    }
    const standing = await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context)
    expect(standing?.ultimate).toBe(id)
    const conversation = (await server.harness.conversation(standing!.ultimate, context))!
    const messages = JSON.stringify((await conversation.context(context)).messages)
    expect(messages).toContain("Help me decide whether to use this project's setup.")
    expect(messages).toContain('Help me set up git for this folder.')
    expect(
      (await server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))?.messages ?? [],
    ).toEqual([])
    // The walkthrough replays every time, never deduplicated like onboarding.start.
    for (let run = 0; run < 2; run++) {
      const walkthrough = await post(server, '/api/extensions/onboarding/actions/walkthrough', {})
      expect(walkthrough.data.result.id).toBe(id)
      await server.harness.waitForIdle(context)
    }
    const after = JSON.stringify((await conversation.context(context)).messages)
    expect(after.match(/Walkthrough started: run how-ultimate-works/g)).toHaveLength(2)
    // Dismissing Start here sticks for the project, and setup still starts afterwards (⌘K Get ready…).
    expect((await post(server, '/api/extensions/onboarding/actions/dismiss', {})).status).toBe(200)
    expect((await server.harness.snapshot(Starts, ROOT_CONVERSATION_ID, context))?.dismissed).toBe(
      true,
    )
    const started = await post(server, '/api/extensions/onboarding/actions/start', {})
    expect(started.data.result.id).toBe(id)
    await server.harness.waitForIdle(context)
    expect((await server.harness.snapshot(Starts, ROOT_CONVERSATION_ID, context))?.dismissed).toBe(
      true,
    )
    const invalid = await post(server, '/api/extensions/onboarding/actions/help', {
      args: { card: 'arbitrary' },
    })
    expect(invalid.status).not.toBe(200)
  } finally {
    await server.close()
  }
})
