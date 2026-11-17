import { expect, it } from 'vitest'
import { fixedLine, parseSummary, scrub, summaryInput } from '../summary.ts'

it('labels a script with no call or one read-only call without the model', () => {
  expect(fixedLine([])).toEqual({ line: 'Ran a script without tool calls' })
  expect(fixedLine([{ name: 'ultimate.api', args: ['conversations'], status: 'ok' }])).toEqual({
    line: "Read the conversations extension's contract",
  })
  expect(fixedLine([{ name: 'ultimate.entries', args: [97078, {}], status: 'ok' }])).toEqual({
    line: 'Read the history of #97078',
  })
  expect(fixedLine([{ name: 'read', args: { path: '/a/b/notes.md' }, status: 'ok' }])).toEqual({
    line: 'Read notes.md',
  })
})

it('labels a failed read-only or empty script without the model, and asks it when a failure may follow a change', () => {
  const read = { name: 'ultimate.entries', args: [1], status: 'error' }
  expect(fixedLine([read], 'Error: Unknown conversation')).toEqual({
    line: 'Failed: Error: Unknown conversation',
  })
  expect(fixedLine([], 'SyntaxError: unexpected token')).toEqual({
    line: 'Failed: SyntaxError: unexpected token',
  })
  expect(fixedLine([], 'Error: token=abc123 rejected')).toEqual({
    line: 'Failed: Error: […] rejected',
  })
  const write = { name: 'write', args: { path: 'a' }, status: 'ok' }
  expect(fixedLine([write], 'Error: later step failed')).toBeUndefined()
})

it('asks the model for actions, writes, commands and several calls', () => {
  const action = { name: 'ultimate.action', args: ['conversations', 'conclude', {}], status: 'ok' }
  expect(fixedLine([action])).toBeUndefined()
  expect(fixedLine([{ name: 'bash', args: { command: 'ls' }, status: 'ok' }])).toBeUndefined()
  expect(fixedLine([{ name: 'write', args: { path: 'a' }, status: 'ok' }])).toBeUndefined()
  const read = { name: 'ultimate.system', args: [], status: 'ok' }
  expect(fixedLine([read, read])).toBeUndefined()
})

it('sends only the calls and a failure, never the script or a result', () => {
  const conclude = {
    name: 'ultimate.action',
    args: ['conversations', 'conclude', { ids: [1] }],
    status: 'ok',
  }
  expect(JSON.parse(summaryInput([conclude]))).toEqual({
    calls: [
      { name: 'ultimate.action', status: 'ok', args: '["conversations","conclude",{"ids":[1]}]' },
    ],
  })
  expect(JSON.parse(summaryInput([], 'Error: no such conversation'))).toEqual({
    calls: [],
    error: 'Error: no such conversation',
  })
})

it('removes credentials from arguments and errors before they reach the summary model', () => {
  const input = summaryInput(
    [
      {
        name: 'ultimate.action',
        args: ['secrets', 'set', { name: 'GH', value: 'v', apiKey: 'sk-live-1' }],
        status: 'ok',
      },
      {
        name: 'bash',
        args: {
          command: 'curl -H "Authorization: Bearer ghp_abcdef123" https://x?token=s3cr3t',
        },
        status: 'ok',
      },
    ],
    'Error: password=hunter2 refused for ' + 'A'.repeat(40),
  )
  for (const secret of ['sk-live-1', 'ghp_abcdef123', 's3cr3t', 'hunter2', 'A'.repeat(40)])
    expect(input).not.toContain(secret)
})

it('drops quoted, JSON and unnamed credentials, since only plain words leave', () => {
  const leaks = [
    `export API_KEY="q9Zr7vLm"`,
    `curl -d '{"client_secret":"q9Zr7vLm"}' https://x`,
    `--header='X-Api: q9Zr7vLm=='`,
    `set pass 'q9Zr7vLm'`,
    `token: "q9Zr7vLm"`,
    `Authorization: Bearer q9Zr7vLm`,
    `git clone https://user:q9Zr7vLm@github.com/o/r`,
    `AKIAIOSFODNN7EXAMPLE`,
    `sk-ant-api03-q9Zr7vLm`,
    `password = q9Zr7vLm`,
    `curl --user admin:q9Zr7vLm https://x`,
    `curl -u admin:q9Zr7vLm https://x`,
  ]
  for (const text of leaks)
    expect({ text, scrubbed: scrub(text) }).not.toMatchObject({
      scrubbed: expect.stringContaining('q9Zr7vLm'),
    })
  expect(scrub('AKIAIOSFODNN7EXAMPLE')).not.toContain('AKIA')
  expect(scrub('echo Basic dXNlcjpwYXNz')).not.toContain('dXNlcjpwYXNz')
  // Arguments are cleaned before serializing, so a value inside a JSON string can't escape as escaped text.
  const input = summaryInput([
    {
      name: 'bash',
      args: { command: 'curl -d \'{"password":"q9Zr7vLm"}\' x', env: { GITHUB_TOKEN: 'q9Zr7vLm' } },
      status: 'ok',
    },
  ])
  expect(input).not.toContain('q9Zr7vLm')
})

it('drops the word after a credential name, and unsafe object keys, through summaryInput', () => {
  const input = summaryInput([
    {
      name: 'bash',
      args: {
        command:
          'curl -H "Authorization: Basic dXNlcjpwYXNz" x; echo password: hunter2 token: q9Zr7vLm --api-key zzKey1',
      },
      status: 'ok',
    },
    {
      name: 'ultimate.action',
      args: ['secrets', 'set', { nested: { ghp_abcdefghij1234567890: 'v', session: 's3ss10n' } }],
      status: 'ok',
    },
    {
      name: 'write',
      args: { q9Zr7vLmq9Zr7vLmq9Zr7vLmq9Zr7vLm42: 'x', path: 'notes.md' },
      status: 'ok',
    },
  ])
  for (const secret of [
    'dXNlcjpwYXNz',
    'hunter2',
    'q9Zr7vLm',
    'zzKey1',
    'ghp_abcdefghij',
    's3ss10n',
  ])
    expect(input).not.toContain(secret)
  expect(input).toContain('notes.md')
})

it('keeps ordinary prose, ids and paths as they are', () => {
  for (const text of [
    'basic checks passed for #190416',
    'extensions/conversations/README.md',
    'pnpm test -- test/codemode.test.ts',
    'Concluded conversation #201645 (owned, not top-level)',
    'rg -n step12 src',
  ])
    expect({ text, scrubbed: scrub(text) }).toEqual({ text, scrubbed: text })
})

it('parses the line and effect, and rejects anything else', () => {
  expect(parseSummary('{"line":"Concluded 2 conversations (#1, #2)","effect":true}')).toEqual({
    line: 'Concluded 2 conversations (#1, #2)',
    effect: true,
  })
  expect(parseSummary('```json\n{"line":" Read the overview ","effect":false}\n```')).toEqual({
    line: 'Read the overview',
  })
  expect(() => parseSummary('{"effect":true}')).toThrow('No summary object')
  expect(() => parseSummary('Concluded things')).toThrow('No summary object')
})
