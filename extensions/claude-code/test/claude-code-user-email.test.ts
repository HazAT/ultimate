import { expect, it } from 'vitest'
import {
  removeUserEmail,
  rewriteInitialRequest,
} from '@earendil-works/pi-claude-code/src/claude-cli.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/claude-cli.ts — Claude Code 2.1.325 puts the logged-in
// account's email into its session-context reminder ("# userEmail"), on the first user message and, when the context
// is re-read, beside tool results and later user messages. The relay drops that section before a request leaves
// (#243625). Drop with the matching pnpm patch when upstream stops sending it.
type Message = { role: string; content: unknown }

const text = (value: string) => ({ type: 'text', text: value })
const email = 'user@example.com'
const session = (...sections: string[]) =>
  [
    '<system-reminder>',
    "As you answer the user's questions, you can use the following context:",
    ...sections,
    '',
    "Claude Code attached this context automatically; it isn't part of the user's message.",
    '</system-reminder>',
  ].join('\n')
const account = `# userEmail\nThe user's email address is ${email}. Use it only to identify the user.`
const gitStatus = '# gitStatus\nOn branch main'
const instructions =
  '<system-reminder>\nCodebase and user instructions are shown below.\n</system-reminder>'
const date = "<system-reminder>\nToday's date is 2026-11-18.\n</system-reminder>"

const strip = (messages: Message[]) => removeUserEmail(structuredClone(messages))

it('drops the account block that is its own content entry', () => {
  expect(
    strip([
      { role: 'user', content: [text(instructions), text(session(account)), text('Fix it.')] },
    ]),
  ).toEqual([{ role: 'user', content: [text(instructions), text('Fix it.')] }])
})

it('drops the account reminder next to the user text and keeps the text exactly', () => {
  expect(
    strip([
      { role: 'user', content: [text(`${session(account)}\nFix it.`)] },
      { role: 'user', content: `Again.\n${session(account)}` },
    ]),
  ).toEqual([
    { role: 'user', content: [text('Fix it.')] },
    { role: 'user', content: 'Again.' },
  ])
})

it('drops the account reminder from a tool result message', () => {
  const result = (content: unknown) => ({ type: 'tool_result', tool_use_id: 'toolu_1', content })
  expect(
    strip([
      { role: 'user', content: [result(`echoed\n${session(account)}`), text(session(account))] },
      { role: 'user', content: [result([text('listed'), text(session(account))])] },
    ]),
  ).toEqual([
    { role: 'user', content: [result('echoed')] },
    { role: 'user', content: [result([text('listed')])] },
  ])
})

it('drops a message that held only the account reminder and keeps the order around it', () => {
  expect(
    strip([
      { role: 'user', content: 'Fix it.' },
      { role: 'user', content: [text(session(account))] },
      { role: 'system', content: [text('# Environment')] },
      { role: 'assistant', content: [text('Done.')] },
      { role: 'user', content: session(account) },
    ]).map((message) => message.role),
  ).toEqual(['user', 'system', 'assistant'])
})

it('leaves every other reminder and section untouched', () => {
  const others: Message[] = [
    {
      role: 'user',
      content: [text(instructions), text(date), text(session(gitStatus)), text('Fix it.')],
    },
  ]
  expect(strip(others)).toEqual(others)
  expect(strip([{ role: 'user', content: [text(session(account, gitStatus))] }])).toEqual([
    { role: 'user', content: [text(session(gitStatus))] },
  ])
})

it('keeps the account email out of replayed requests and their stored prefix', () => {
  const canonical = [text('Fix it.')]
  const prefix = [text(instructions), text(session(account))]
  const payload = {
    messages: [
      { role: 'user', content: [...prefix, ...canonical] },
      { role: 'system', content: [text('# Environment')] },
      { role: 'assistant', content: [text('Done.')] },
      { role: 'user', content: [text(session(account)), text('Next.')] },
    ],
  }
  const body = rewriteInitialRequest(Buffer.from(JSON.stringify(payload)), prefix, canonical, [
    payload.messages[1],
  ]).toString()
  expect(body).not.toContain(email)
  expect(JSON.parse(body).messages[0].content.map((block: { text: string }) => block.text)).toEqual(
    [instructions, 'Fix it.'],
  )
})
