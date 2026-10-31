import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { apis, eventHost, temp, until } from './helpers.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ActionContext } from '../server/actions.ts'
import messagesExtension, {
  actions as messageActions,
  gist,
} from '../extensions/messages/server.ts'
import { Messages } from '../extensions/messages/api.ts'
import type { MessagesService, Question } from '../extensions/messages/api.ts'
import { checkQuestions } from '../extensions/messages/questions.ts'
import questionsExtension, {
  actions,
  answerText,
  userActions,
} from '../extensions/questions/server.ts'
import { Standing } from '../extensions/subagents/api.ts'
import type { SubagentsService } from '../extensions/subagents/api.ts'
import { Workspaces } from '../extensions/workspaces/workspaces.ts'

const hosts: OpenHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})

const decisions: Question[] = [
  {
    text: 'Scope',
    kind: 'choice',
    ref: '1',
    options: [
      { label: 'all of it', key: 'a', recommended: true },
      { label: 'the format only', key: 'b' },
    ],
  },
  {
    text: 'Suites',
    kind: 'multi',
    ref: '2',
    options: [
      { label: 'unit', key: 'a', recommended: true },
      { label: 'e2e', key: 'b' },
      { label: 'lint', key: 'c', recommended: true },
    ],
  },
  { text: 'Land it?', kind: 'confirm', ref: '3' },
  { text: 'How finished is it?', kind: 'scale', ref: '4', scale: { min: 1, max: 5 } },
  { text: 'Name', kind: 'text', ref: '5' },
]

async function fixture() {
  const home = await temp('ultimate-messages-questions-')
  const prepared = await prepareHarness({
    home,
    ultimateRoot: home,
    userHome: home,
    faux: fauxProvider(),
  })
  let opened: OpenHost
  const services = new Map<string, unknown>()
  const openers: (() => Promise<void>)[] = []
  const closers: (() => Promise<void>)[] = []
  const events = eventHost(() => opened.harness, 'questions')
  openers.push(async () => void (await events.start()))
  closers.push(async () => void (await events.stop()))
  const host = {
    ...prepared,
    userHome: home,
    projectSettings: async () => ({}),
    harness: () => opened.harness,
    ...apis(services),
    doc: () => undefined,
    onOpen: (fn: () => Promise<void>) => openers.push(fn),
    onClose: (fn: () => Promise<void>) => closers.push(fn),
    emit: events.emit,
    react: events.react,
    notice: (message: string) => {
      throw new Error(message)
    },
  } as unknown as ExtensionHost
  // Messages’ core dependencies: no standing agents to list, no worktrees.
  services.set('subagents', { residents: async () => [] } satisfies Partial<SubagentsService>)
  services.set('workspaces', { doc: Workspaces })
  prepared.registry.install(messagesExtension(host))
  prepared.registry.install(questionsExtension(host))
  const observed: string[] = []
  const route: FauxResponseFactory = async (transcript) => {
    prepared.faux!.appendResponses([route])
    const last = transcript.messages.at(-1)!
    const text = typeof last.content === 'string' ? last.content : ''
    observed.push(text)
    if (last.role === 'user' && text.startsWith('SEND '))
      return fauxAssistantMessage([fauxToolCall('message', JSON.parse(text.slice(5)))], {
        stopReason: 'toolUse',
      })
    return fauxAssistantMessage([fauxText('Sent.')])
  }
  prepared.faux!.setResponses([route])
  opened = await prepared.open()
  hosts.push(opened)
  for (const fn of openers) await fn()
  const log = async () => (await opened.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
  // Settled: every event reacted to and every task done, deliveries included.
  const settled = () =>
    until(
      async () =>
        (await events.settled()) &&
        (await opened.harness.commit(
          async (tx) =>
            (await tx.scanTasks({}, 1000)).items.every((task) => task.state.status === 'terminal'),
          context,
        )),
    )
  const entries = async (id: ConversationId) =>
    (
      await opened.harness.commit((tx) => tx.scanEntries({ conversationId: id }, 1000), context)
    ).items.toSorted((a, b) => a.id - b.id)
  /** A new conversation registered as the standing @ultimate. */
  const ultimate = async () => {
    const conversation = await opened.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    const agent = await opened.root.agent(context)
    await opened.harness.commit(async (tx) => {
      await configure(tx, conversation.id, { model: agent.model, tools: agent.tools })
      ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = conversation.id
    }, context)
    return conversation.id
  }
  const type = async (id: ConversationId, content: string) => {
    const conversation = (await opened.harness.conversation(id, context))!
    return (await conversation.submit({ type: 'input', content }, context)).wait(context)
  }
  /** @ultimate's `message` call with `args`; the message it sent, or the tool's error. */
  const ask = async (id: ConversationId, args: Record<string, unknown>) => {
    await type(id, `SEND ${JSON.stringify({ to: 'user', ...args })}`)
    await settled()
    const call = (await entries(id)).findLast((entry) => entry.kind === 'pi.tool-result')
    const result = call?.model?.[0] as unknown as
      | { isError?: boolean; content: { text?: string }[] }
      | undefined
    return {
      error: result?.isError ? result.content.map((part) => part.text).join('') : undefined,
      message: (await log()).messages.findLast((m) => m.from === id && m.to === 'user'),
    }
  }
  const action = (conversationId?: number) =>
    ({ host, conversationId, signal: new AbortController().signal }) as ActionContext
  const answer = (args: Parameters<typeof actions.answer>[0]) => actions.answer(args, action())
  const dismiss = (messageId: number) => actions.dismiss({ messageId }, action())
  /** The `withdraw` action as conversation `by` calls it through codemode. */
  const withdraw = (by: number | undefined, args: { messageId: number; reason: string }) =>
    messageActions.withdraw(args, action(by))
  const openQuestions = () => (services.get('messages') as MessagesService).openQuestions(context)
  return {
    opened,
    ultimate,
    type,
    ask,
    answer,
    dismiss,
    withdraw,
    openQuestions,
    log,
    entries,
    observed,
    settled,
  }
}

describe('questions on a message', () => {
  it('are stored as the tool validated them, only on reply-expected messages to the user', async () => {
    const f = await fixture()
    const id = await f.ultimate()
    const sent = await f.ask(id, { text: 'Decide these.', questions: decisions })
    expect(sent.error).toBeUndefined()
    expect(sent.message).toMatchObject({ state: 'delivered', questions: decisions })
    const oneWay = await f.ask(id, { text: 'FYI', reply: false, questions: decisions })
    expect(oneWay.error).toContain('reply-expected message to the user')
    expect(oneWay.message?.text).toBe('Decide these.')
    // To a conversation, never: questions are the user's card.
    const other = await f.opened.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    const toConversation = await f.ask(id, { to: `#${other.id}`, text: 'Hi', questions: decisions })
    expect(toConversation.error).toContain('reply-expected message to the user')
    expect((await f.log()).messages.filter((m) => m.questions)).toHaveLength(1)
  })

  it('refuses questions the card could not answer, naming the question', async () => {
    const f = await fixture()
    const id = await f.ultimate()
    const refused = async (questions: unknown, reason: string) => {
      const { error } = await f.ask(id, { text: 'Decide.', questions })
      expect(error).toContain(reason)
    }
    await refused([], 'at least one question')
    await refused(
      [{ text: 'One?', kind: 'choice', options: [{ label: 'only' }] }],
      'question 1 needs at least two options',
    )
    await refused(
      [{ text: 'One?', kind: 'choice', ref: '3', options: [{ label: 'a' }, { label: ' a ' }] }],
      'question 3 repeats an option label',
    )
    await refused(
      [
        {
          text: 'One?',
          kind: 'choice',
          options: [
            { label: 'x', key: 'a' },
            { label: 'y', key: 'a' },
          ],
        },
      ],
      'repeats an option key',
    )
    await refused(
      [{ text: 'One?', kind: 'choice', options: [{ label: 'x' }, { label: 'Something else' }] }],
      'offers "Something else…" itself',
    )
    await refused([{ text: '  ', kind: 'confirm' }], 'question 1 has no text')
    await refused(
      [{ text: 'One?', kind: 'choice', options: [{ label: 'x' }, { label: ' ' }] }],
      'has an option without a label',
    )
    await refused(
      [{ text: 'Which?', kind: 'multi', options: [{ label: 'unit, fast' }, { label: 'e2e' }] }],
      'its labels hold no ", "',
    )
    await refused([{ text: 'Rate', kind: 'scale' }], 'needs scale')
    await refused([{ text: 'Rate', kind: 'scale', scale: { min: 1, max: 20 } }], 'at most 10 steps')
    await refused(
      [
        { text: 'Same', kind: 'confirm', ref: '1' },
        { text: 'Same', kind: 'confirm', ref: '2' },
      ],
      "repeats another question's text",
    )
    await refused(
      [
        { text: 'A', kind: 'confirm', ref: '1' },
        { text: 'B', kind: 'confirm', ref: '1' },
      ],
      "repeats another question's ref",
    )
    // A schema miss is the tool's own error.
    await refused([{ text: 'One?', kind: 'ranking' }], 'kind')
    expect((await f.log()).messages.filter((m) => m.to === 'user')).toHaveLength(0)
  })

  it('answers in the message numbering for every kind, with a note after the answers', async () => {
    const f = await fixture()
    const id = await f.ultimate()
    const { message } = await f.ask(id, { text: 'Decide these.', questions: decisions })
    expect(userActions).toEqual(['answer', 'dismiss'])
    await expect(
      f.answer({ messageId: message!.id, answers: [{ question: 'Unknown', answer: 'Yes' }] }),
    ).rejects.toThrow('Unknown question')
    await expect(
      f.answer({
        messageId: message!.id,
        answers: [
          { question: 'Scope', answer: 'all of it' },
          { question: 'Scope', answer: 'the format only' },
        ],
      }),
    ).rejects.toThrow('Unknown question')
    await expect(f.answer({ messageId: message!.id, answers: [] })).rejects.toThrow(
      'Invalid answers',
    )
    const results = await Promise.allSettled([
      f.answer({
        messageId: message!.id,
        answers: [
          { question: 'Scope', answer: 'the format only' },
          { question: 'Suites', answer: 'unit, lint' },
          { question: 'Land it?', answer: 'Yes' },
          { question: 'How finished is it?', answer: '4' },
          { question: 'Name', answer: 'Questions' },
        ],
        note: 'Also rename the tab.',
      }),
      f.answer({ messageId: message!.id, answers: [{ question: 'Scope', answer: 'all of it' }] }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    await f.settled()
    const reply = (await f.log()).messages.find((m) => m.re === message!.id)!
    expect(reply.text).toBe(
      '1b. Scope: the format only\n\n2a,c. Suites: unit, lint\n\n3: Yes\n\n4: 4\n\n5: Questions\n\nNote: Also rename the tab.',
    )
    expect((await f.log()).messages.find((m) => m.id === message!.id)?.state).toBe('answered')
    expect(f.observed.some((text) => text.includes('2a,c. Suites: unit, lint'))).toBe(true)
    await expect(
      f.answer({ messageId: message!.id, answers: [{ question: 'Scope', answer: 'all of it' }] }),
    ).rejects.toThrow('These questions are no longer open')
  })

  it('sends a note on its own, and free text for a message without questions', async () => {
    const f = await fixture()
    const id = await f.ultimate()
    const { message } = await f.ask(id, { text: 'Decide these.', questions: decisions })
    await expect(f.answer({ messageId: message!.id, answers: [], note: '  ' })).rejects.toThrow(
      'Invalid answers',
    )
    await f.answer({ messageId: message!.id, answers: [], note: 'Later, after the demo.' })
    await f.settled()
    expect((await f.log()).messages.find((m) => m.re === message!.id)?.text).toBe(
      'Later, after the demo.',
    )
    const plain = (await f.ask(id, { text: 'What should the tab be called?' })).message!
    expect(plain.questions).toBeUndefined()
    await expect(f.answer({ messageId: plain.id, text: '  ' })).rejects.toThrow('Invalid answers')
    await expect(f.answer({ messageId: plain.id, text: 'x', note: 'y' })).rejects.toThrow(
      'Invalid answers',
    )
    const { id: reply } = await f.answer({ messageId: plain.id, text: ' Questions ' })
    expect((await f.log()).messages.find((m) => m.id === reply)).toMatchObject({
      from: 'user',
      re: plain.id,
      text: 'Questions',
    })
    await expect(f.answer({ messageId: plain.id, text: 'Again' })).rejects.toThrow(
      'These questions are no longer open',
    )
  })

  it("keeps @ultimate's open message open until its card answers it, naming it by its questions", async () => {
    const f = await fixture()
    const id = await f.ultimate()
    const { message } = await f.ask(id, { text: 'Decide these.', questions: decisions })
    await f.type(
      f.opened.root.id,
      `SEND ${JSON.stringify({ to: `#${id}`, text: 'Unrelated update' })}`,
    )
    await f.settled()
    expect((await f.log()).messages.find((m) => m.id === message!.id)?.state).toBe('delivered')
    await f.type(id, 'Something else entirely')
    const typed = await f.entries(id)
    const note = typed.findLast((entry) => entry.kind === 'board.open')!
    expect(note.data).toEqual({ ids: [message!.id] })
    expect(note.model?.[0]?.content).toMatch(
      new RegExp(
        `^Open questions to the user.*\\n- message ${message!.id}: questions 1\\. Scope; 2\\. Suites; 3\\. Land it\\?; 4\\. How finished is it\\?; 5\\. Name \\(asked just now\\)\\nOne that no longer needs an answer .* ultimate\\.action\\('messages', 'withdraw', \\{ messageId, reason \\}\\); only its asker can\\.$`,
        's',
      ),
    )
    expect(typed[typed.indexOf(note) + 1]).toMatchObject({ kind: 'pi.user' })
    await f.answer({ messageId: message!.id, answers: [{ question: 'Land it?', answer: 'No' }] })
    expect((await f.log()).messages.find((m) => m.id === message!.id)?.state).toBe('answered')
    await f.settled()
    const count = (await f.entries(id)).filter((entry) => entry.kind === 'board.open').length
    await f.type(id, 'Thanks')
    expect((await f.entries(id)).filter((entry) => entry.kind === 'board.open')).toHaveLength(count)
  })

  it('dismisses one open question with a one-way note that starts no run, leaving the others open', async () => {
    const f = await fixture()
    const id = await f.ultimate()
    const first = (await f.ask(id, { text: 'Keep it running?', questions: [decisions[2]] }))
      .message!
    const second = (await f.ask(id, { text: 'Which layout?' })).message!
    const before = (await f.entries(id)).filter((entry) => entry.kind === 'pi.assistant').length
    const { id: note } = await f.dismiss(first.id)
    await f.settled()
    const log = (await f.log()).messages
    expect(log.find((m) => m.id === first.id)?.state).toBe('dismissed')
    expect(log.find((m) => m.id === second.id)?.state).toBe('delivered')
    expect(log.find((m) => m.id === note)).toMatchObject({
      from: 'user',
      to: id,
      re: first.id,
      reply: false,
      state: 'delivered',
      text: expect.stringContaining('(message ' + first.id + '): questions 3. Land it?'),
    })
    const after = await f.entries(id)
    expect(after.findLast((entry) => entry.kind === 'board.message')?.data).toMatchObject({
      id: note,
      delivery: 'note',
    })
    expect(after.filter((entry) => entry.kind === 'pi.assistant')).toHaveLength(before)
    await expect(f.dismiss(first.id)).rejects.toThrow('These questions are no longer open')
    await expect(f.answer({ messageId: first.id, text: 'Yes' })).rejects.toThrow(
      'These questions are no longer open',
    )
  })

  // Regression: a question its asker had superseded stayed open for 12 hours until the user answered it; only the user
  // could close it.
  it('lets the asker, and only the asker, withdraw its own open question with a reason', async () => {
    const f = await fixture()
    const id = await f.ultimate()
    const first = (await f.ask(id, { text: 'Keep it running?', questions: [decisions[2]] }))
      .message!
    const second = (await f.ask(id, { text: 'Which layout?' })).message!
    const other = await f.opened.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    const reason = `superseded by message ${second.id}`
    await expect(f.withdraw(other.id, { messageId: first.id, reason })).rejects.toThrow(
      `Only the conversation that asked (#${id}) withdraws its question`,
    )
    await expect(f.withdraw(undefined, { messageId: first.id, reason })).rejects.toThrow(
      'Only the conversation that asked',
    )
    await expect(f.withdraw(id, { messageId: first.id, reason: ' ' })).rejects.toThrow(
      'reason must say',
    )
    expect((await f.log()).messages.find((m) => m.id === first.id)?.state).toBe('delivered')
    const before = (await f.log()).messages.length
    // The reason is kept on one line, whitespace collapsed.
    expect(
      await f.withdraw(id, {
        messageId: first.id,
        reason: `superseded by\n  message ${second.id} `,
      }),
    ).toEqual({ id: first.id })
    await f.settled()
    const log = (await f.log()).messages
    expect(log.find((m) => m.id === first.id)).toMatchObject({ state: 'withdrawn', reason })
    expect(log.find((m) => m.id === second.id)?.state).toBe('delivered')
    // No note or reply: the asker closed it itself.
    expect(log).toHaveLength(before)
    expect(await f.openQuestions()).toEqual([
      { message: second.id, conversation: id, at: second.at, text: 'Which layout?' },
    ])
    // The next run's open-questions line names only the question still open.
    await f.type(id, 'Thanks')
    const note = (await f.entries(id)).findLast((entry) => entry.kind === 'board.open')
    expect(note?.data).toEqual({ ids: [second.id] })
    await expect(f.withdraw(id, { messageId: first.id, reason })).rejects.toThrow(
      'These questions are no longer open',
    )
    await expect(f.answer({ messageId: first.id, text: 'Yes' })).rejects.toThrow(
      'These questions are no longer open',
    )
    await expect(f.dismiss(first.id)).rejects.toThrow('These questions are no longer open')
  })
})

describe('answer text', () => {
  it('names options by letter, several by letters, typed and rated answers by number, and unnumbered ones by text', () => {
    expect(
      answerText(
        [
          { question: 'Scope', answer: 'all of it' },
          { question: 'Suites', answer: 'e2e' },
          { question: 'Name', answer: 'only the keyboard one' },
        ],
        decisions,
      ),
    ).toBe('1a. Scope: all of it\n\n2b. Suites: e2e\n\n5: only the keyboard one')
    // A typed "Something else…" names no option: the number alone.
    expect(answerText([{ question: 'Scope', answer: 'neither' }], decisions)).toBe('1: neither')
    expect(
      answerText(
        [{ question: 'Land it?', answer: 'Yes' }],
        [{ text: 'Land it?', kind: 'confirm' }],
      ),
    ).toBe('Land it?: Yes')
    expect(answerText([], decisions, 'Just a thought.')).toBe('Just a thought.')
  })

  it('drops fields that do not apply to a kind and trims what it keeps', () => {
    expect(
      checkQuestions([
        {
          text: ' Land it? ',
          kind: 'confirm',
          options: [{ label: 'x' }, { label: 'y' }],
          placeholder: 'no',
        },
        {
          text: 'Rate',
          kind: 'scale',
          scale: { min: 1, max: 3, low: ' low ', high: '' },
          placeholder: 'no',
        },
        { text: 'Name', kind: 'text', placeholder: ' e.g. Questions ' },
        {
          text: 'Pick',
          kind: 'choice',
          options: [
            { label: ' a ', detail: ' why ', recommended: false, preview: ' ' },
            { label: 'b', key: 'b', recommended: true },
          ],
        },
      ]),
    ).toEqual([
      { text: 'Land it?', kind: 'confirm' },
      { text: 'Rate', kind: 'scale', scale: { min: 1, max: 3, low: 'low' } },
      { text: 'Name', kind: 'text', placeholder: 'e.g. Questions' },
      {
        text: 'Pick',
        kind: 'choice',
        options: [
          { label: 'a', detail: 'why' },
          { label: 'b', key: 'b', recommended: true },
        ],
      },
    ])
    // Only a whole "Other" / "Something else" is the card's own option; a label that starts so is a real one.
    expect(
      checkQuestions([
        {
          text: 'Scope',
          kind: 'choice',
          options: [{ label: 'This repo' }, { label: 'Other repos too' }],
        },
      ])[0].options!.map((o) => o.label),
    ).toEqual(['This repo', 'Other repos too'])
  })

  it('names a message by its questions in the open-questions note, else by its asking line', () => {
    expect(gist({ text: 'Decide.', questions: decisions })).toBe(
      'questions 1. Scope; 2. Suites; 3. Land it?; 4. How finished is it?; 5. Name',
    )
    expect(gist({ text: 'Done.\n\nShould I submit it?' })).toBe('Should I submit it?')
  })
})
