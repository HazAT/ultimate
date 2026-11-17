import { expect, it } from 'vitest'
import { pillOf } from '../../progress.tsx'

const epic = (key: string, status: string, ...tasks: string[]) => ({
  key,
  status,
  tasks: Object.fromEntries(tasks.map((task, i) => [`${key}.${i + 1}`, { status: task }])),
})

it('shows no pill once every epic is done', () => {
  expect(pillOf({})).toBeUndefined()
  expect(pillOf({ E1: epic('E1', 'done', 'done', 'canceled') })).toBeUndefined()
})

it('shows the newest open epic, counting canceled tasks as finished', () => {
  const pill = pillOf({
    E1: epic('E1', 'in_progress', 'todo'),
    E2: epic('E2', 'in_progress', 'done', 'canceled', 'in_progress'),
    E10: epic('E10', 'done', 'done'),
  })
  expect(
    pill && { key: pill.epic.key, finished: pill.finished, total: pill.total, more: pill.more },
  ).toEqual({ key: 'E2', finished: 2, total: 3, more: 1 })
})
