import type { EntryRecord } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { compactEntry } from '../chapters.ts'

const entry = (fields: Record<string, unknown>) =>
  ({ id: 7, conversationId: 1, ...fields }) as unknown as EntryRecord

it('reads string and block content alike, keeping message text whole and tool output at both ends', () => {
  // Content is a string on board and lineage entries; mapping it as blocks crashed scripts (#534457/564167).
  const report = 'report '.repeat(800)
  expect(
    compactEntry(
      entry({
        kind: 'board.message',
        data: { text: report },
        model: [{ role: 'user', content: report, timestamp: 0 }],
      }),
    ),
  ).toEqual({
    id: 7,
    kind: 'board.message',
    at: '1970-01-01T00:00:00.000Z',
    role: 'user',
    text: report,
    data: `${JSON.stringify({ text: report }).slice(0, 500)}…`,
  })
  expect(
    compactEntry(
      entry({
        kind: 'pi.assistant',
        model: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hidden', thinkingSignature: 'x' },
              { type: 'text', text: 'Running it.' },
              { type: 'toolCall', id: 'a', name: 'bash', arguments: { command: 'pnpm test' } },
            ],
            stopReason: 'error',
            errorMessage: 'overloaded',
            diagnostics: [{ big: true }],
          },
        ],
      }),
    ),
  ).toEqual({
    id: 7,
    kind: 'pi.assistant',
    role: 'assistant',
    text: 'Running it.',
    tools: [{ name: 'bash', args: '{"command":"pnpm test"}' }],
    stopReason: 'error',
    error: 'overloaded',
  })
  const output = `start ${'x'.repeat(5000)} exit code 1`
  const result = compactEntry(
    entry({
      kind: 'pi.tool-result',
      data: { diagnostics: [] },
      model: [
        {
          role: 'toolResult',
          toolName: 'bash',
          isError: true,
          content: [{ type: 'text', text: output }],
        },
      ],
    }),
  )
  expect(result).toMatchObject({ tool: 'bash', error: true })
  expect(result.text).toMatch(/^start x+\n…\nx+ exit code 1$/)
  expect(result.text!.length).toBeLessThan(1100)
  expect(result).not.toHaveProperty('data')
})
