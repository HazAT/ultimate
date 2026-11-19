import type { UiSource } from '../../../shared/events.ts'

export type UiWho = UiSource['source']

let writer: UiWho = 'person'

export function writingAs<T>(source: string | undefined, write: () => T): T {
  const outer = writer
  writer = source === 'agent' ? 'agent' : 'person'
  try {
    return write()
  } finally {
    writer = outer
  }
}

export const writerNow = (): UiWho => writer
