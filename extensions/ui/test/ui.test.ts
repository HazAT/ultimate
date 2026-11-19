import type { JsonValue } from '@earendil-works/chord/json'
import { expect, it, vi } from 'vitest'
import { actions, userActions } from '../server.ts'
import { ChangedEvent } from '../refs.ts'
import type { ActionContext } from '../../../server/actions.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'

function host() {
  const emitted: { name: string; data: JsonValue }[] = []
  const commits = vi.fn<(work: (tx: object) => Promise<void>) => Promise<void>>((work) => work({}))
  const fake = {
    harness: () => ({ commit: commits }),
    emit: async (_tx: object, event: { name: string }, data: JsonValue) => {
      emitted.push({ name: event.name, data })
    },
  } as unknown as ExtensionHost
  return { fake, emitted, commits }
}

const device = { device: 'desktop firefox', login: 'me@example.com' }
const record = (fake: ExtensionHost, args: JsonValue) =>
  actions.record(args, {
    host: fake,
    device,
    signal: new AbortController().signal,
  } as ActionContext)

it('records each change as one ui.changed event with the device, in one commit', async () => {
  const { fake, emitted, commits } = host()
  const result = await record(fake, {
    changes: [
      {
        component: 'switch',
        label: 'Keep warm',
        key: 'checked',
        value: false,
        previous: true,
        source: 'agent',
      },
      {
        component: 'input',
        label: 'Token',
        key: 'value',
        value: '[redacted]',
        source: 'keyboard',
        reason: 'input',
      },
    ],
    surface: 'agent',
    conversation: 7,
    driven: true,
  })
  expect(result).toEqual({ recorded: 2 })
  expect(commits).toHaveBeenCalledTimes(1)
  expect(emitted).toEqual([
    {
      name: ChangedEvent.name,
      data: {
        component: 'switch',
        label: 'Keep warm',
        key: 'checked',
        value: false,
        previous: true,
        source: 'agent',
        surface: 'agent',
        conversation: 7,
        driven: true,
        ...device,
      },
    },
    {
      name: ChangedEvent.name,
      data: {
        component: 'input',
        label: 'Token',
        key: 'value',
        value: '[redacted]',
        source: 'keyboard',
        reason: 'input',
        surface: 'agent',
        conversation: 7,
        driven: true,
        ...device,
      },
    },
  ])
})

it('records a large value as too large, and refuses a malformed batch before committing', async () => {
  const { fake, emitted, commits } = host()
  await record(fake, {
    changes: [
      {
        component: 'textarea',
        key: 'value',
        value: 'x'.repeat(5000),
        previous: '',
        source: 'keyboard',
      },
    ],
  })
  expect(emitted.map((event) => event.data)).toEqual([
    {
      component: 'textarea',
      key: 'value',
      value: '[too large]',
      previous: '',
      source: 'keyboard',
      ...device,
    },
  ])
  await expect(record(fake, { changes: [] })).rejects.toThrow('Expected { changes }')
  await expect(
    record(fake, { changes: [{ key: 'value', value: 1, source: 'agent' }] }),
  ).rejects.toThrow('Expected component')
  expect(commits).toHaveBeenCalledTimes(1)
})

it('is user-only, so an agent cannot record history in a person’s name', () => {
  expect(userActions).toEqual(['record'])
})
