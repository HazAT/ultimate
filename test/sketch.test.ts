import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import type { Tx } from '@earendil-works/pi-durable'
import { actions, describe, sketch } from '../extensions/sketch/server.ts'
import type { SketchForm } from '../extensions/sketch/refs.ts'
import type { ActionContext } from '../server/actions.ts'
import { temp } from './helpers.ts'

const chart = {
  blocks: [
    {
      type: 'chart',
      kind: 'bar',
      x: 'day',
      series: [{ name: 'Landings', field: 'n' }],
      data: [
        { day: 'Tue', n: 37 },
        { day: 'Wed', n: 35 },
      ],
    },
  ],
}

async function setup(root?: string) {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const model = faux.getModel()
  const steps = new Map<number, unknown>()
  const run = (request: string, data?: string) =>
    sketch({
      models,
      model: { provider: model.provider, id: model.id, thinking: 'off' },
      root: root ?? '/',
      request,
      data,
      signal: new AbortController().signal,
      step: async (index, make) => {
        if (!steps.has(index)) steps.set(index, await make())
        return steps.get(index) as Awaited<ReturnType<typeof make>>
      },
    })
  return { faux, run }
}

it('draws a spec from the data in one model call', async () => {
  const { faux, run } = await setup()
  faux.setResponses([fauxAssistantMessage([fauxToolCall('render', chart)])])
  const { spec, steps } = await run('a bar chart of landings', 'Tue 37, Wed 35')
  expect(steps).toHaveLength(1)
  expect(spec).toEqual(chart)
  expect(describe(spec)).toBe('bar chart (2 points)')
})

it('repairs an invalid spec once, then fails on the second', async () => {
  const { faux, run } = await setup()
  const invalid = { blocks: [{ type: 'chart', kind: 'pie', x: 'day', series: [], data: [] }] }
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('render', invalid)]),
    (context) => {
      // The validation errors went back to the model as the render call's result.
      const result = context.messages.at(-1)
      expect(result).toMatchObject({ role: 'toolResult', toolName: 'render', isError: true })
      return fauxAssistantMessage([fauxToolCall('render', chart)])
    },
  ])
  expect((await run('a chart', 'Tue 37')).spec).toEqual(chart)

  const again = await setup()
  again.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('render', invalid)]),
    fauxAssistantMessage([fauxToolCall('render', invalid)]),
  ])
  await expect(again.run('a chart', 'Tue 37')).rejects.toThrow('Validation failed')
})

it('reads project files without data and refuses paths outside the project', async () => {
  const root = await temp()
  await mkdir(join(root, 'data'))
  await writeFile(join(root, 'data/landings.csv'), 'day,n\nTue,37\nWed,35\n')
  const { faux, run } = await setup(root)
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('read', { path: 'data/landings.csv' }),
      fauxToolCall('read', { path: '/etc/passwd' }),
    ]),
    (context) => {
      const results = context.messages.filter((message) => message.role === 'toolResult')
      expect(results.map((result) => [result.isError, result.content[0]])).toEqual([
        [false, { type: 'text', text: 'day,n\nTue,37\nWed,35\n' }],
        [true, { type: 'text', text: '/etc/passwd is outside the project' }],
      ])
      return fauxAssistantMessage([fauxToolCall('render', chart)])
    },
  ])
  const { read } = await run('chart data/landings.csv')
  expect(read).toEqual(['data/landings.csv'])
})

it('submits a form once as the user’s input, then locks it', async () => {
  const forms: Record<string, SketchForm> = {
    call_1: {
      title: 'Night watch',
      fields: [
        { name: 'every', label: 'Interval', kind: 'select', options: ['15m', '30m'] },
        { name: 'phone', label: 'Notify on phone', kind: 'toggle' },
      ],
    },
  }
  const inputs: unknown[] = []
  const tx = { doc: async () => ({ forms }) } as unknown as Tx
  const harness = {
    commit: async (change: (tx: Tx) => unknown) => change(tx),
    conversation: async () => ({ submit: async (input: unknown) => inputs.push(input) }),
  }
  const ctx = { host: { harness: () => harness }, conversationId: 7 } as unknown as ActionContext
  await expect(actions.submit({ call: 'call_1', values: { every: 'daily' } }, ctx)).rejects.toThrow(
    'every must be one of 15m, 30m',
  )
  await actions.submit({ call: 'call_1', values: { every: '30m', phone: true } }, ctx)
  expect(inputs).toEqual([
    expect.objectContaining({
      type: 'input',
      requestId: 'sketch:call_1',
      content: 'Submitted the form "Night watch":\nInterval: 30m\nNotify on phone: true',
    }),
  ])
  expect(forms.call_1.submitted?.values).toEqual({ every: '30m', phone: true })
  await expect(actions.submit({ call: 'call_1', values: { every: '15m' } }, ctx)).rejects.toThrow(
    'already submitted',
  )
  expect(inputs).toHaveLength(1)
})

it('fails with the model’s words when it draws nothing', async () => {
  const { faux, run } = await setup()
  faux.setResponses([fauxAssistantMessage('No landing counts were given.')])
  await expect(run('a chart of landings', '')).rejects.toThrow(
    'Nothing drawn: No landing counts were given.',
  )
})
