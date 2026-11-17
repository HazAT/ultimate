import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterAll, expect, it } from 'vitest'
import { context } from '../../../../server/harness.ts'
import { Messages } from '../../api.ts'
import { fauxServer, post, removeTemp, sourceCopy, temp, until } from '../../../../test/helpers.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
const homes: string[] = []
afterAll(async () => {
  // Capture both lists before close can yield to another test's setup.
  const closing = servers.splice(0)
  const taken = homes.splice(0)
  await Promise.all(closing.map((server) => server.close()))
  for (const home of taken) await removeTemp(home)
})
const textOf = (content: unknown) =>
  typeof content === 'string'
    ? content
    : ((content as { type: string; text?: string }[]) ?? [])
        .flatMap((part) => (part.type === 'text' ? [part.text!] : []))
        .join('')

/** One faux Ultimate whose @ultimate runs the codemode in `TELL <code>` inputs and echoes anything else. */
async function ultimate(userHome: string, ultimateRoot: string, name: string) {
  const projectRoot = join(userHome, name)
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(join(projectRoot, '.ultimate/settings.json'), '{"summaryModel":"unavailable/x"}')
  const home = join(userHome, '.ultimate/projects', `${name}-1`)
  const server = await fauxServer({ ultimateRoot, projectRoot, home, userHome })
  servers.push(server)
  // The supervisor writes these; `ultimate.projects()` finds a running instance through them.
  await writeFile(
    join(home, 'project.json'),
    JSON.stringify({ root: projectRoot, name: basename(projectRoot) }),
  )
  await writeFile(
    join(home, 'ultimate.lock'),
    JSON.stringify({ pid: process.pid, port: Number(new URL(server.url).port) }),
  )
  const seen: string[] = []
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    const text = textOf(last.content)
    seen.push(text)
    if (last.role === 'user' && text.startsWith('TELL '))
      return fauxAssistantMessage([fauxToolCall('codemode', { code: text.slice(5) })], {
        stopReason: 'toolUse',
      })
    return fauxAssistantMessage(last.role === 'toolResult' ? 'Told.' : `Answer from ${name}`)
  }
  server.host.faux!.setResponses([route])
  const agent = (
    await post(server, '/api/extensions/subagents/actions/standing', {
      args: { name: 'ultimate' },
    })
  ).data.result as ConversationId
  const log = async () =>
    (await server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))?.messages ?? []
  return { server, agent, seen, log }
}

it('tells another running Ultimate, whose @ultimate answers back as a reply', async () => {
  const userHome = await temp('ultimate-remote-')
  homes.push(userHome)
  const ultimateRoot = await sourceCopy(userHome)
  const a = await ultimate(userHome, ultimateRoot, 'alpha')
  const b = await ultimate(userHome, ultimateRoot, 'beta')
  const conversation = (await a.server.harness.conversation(a.agent, context))!
  await (
    await conversation.submit(
      {
        type: 'input',
        content: `TELL return await ultimate.tell({ project: 'beta', text: 'Start a branch that does X' })`,
      },
      context,
    )
  ).wait(context)
  // B's @ultimate got it, from A's Ultimate, and nothing else of B's did.
  await until(async () =>
    (await b.log()).some((m) => m.from === 'remote' && m.state === 'answered'),
  )
  const received = (await b.log()).find((m) => m.from === 'remote')!
  expect(received).toMatchObject({ to: b.agent, reply: true, remote: { project: 'alpha' } })
  expect(b.seen.some((text) => text.startsWith('Message from @ultimate@alpha on '))).toBe(true)
  // A's @ultimate gets B's answer as a reply to its message, which expects none.
  await until(async () => (await a.log()).some((m) => m.from === 'remote' && m.re !== undefined))
  const [told] = (await a.log()).filter((m) => m.to === 'remote')
  expect(told).toMatchObject({
    from: a.agent,
    state: 'answered',
    remote: { project: 'beta', id: received.id },
  })
  expect((await a.log()).find((m) => m.from === 'remote')).toMatchObject({
    to: a.agent,
    re: told.id,
    reply: false,
    text: 'Answer from beta',
  })
  await until(() =>
    a.seen.some(
      (text) =>
        text.startsWith(`Reply from @ultimate@beta on `) && text.includes('Answer from beta'),
    ),
  )
  // The reply ends there: B's log holds one message from A and its one answer, nothing more travels.
  await a.server.harness.waitForIdle(context)
  await b.server.harness.waitForIdle(context)
  expect((await b.log()).filter((m) => m.to === 'remote' || m.from === 'remote')).toHaveLength(2)
})
