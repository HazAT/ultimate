import type { UiSource } from '../../../shared/events.ts'

export type UiWho = UiSource['source']

let pageWriter: UiWho = 'person'
let writer: UiWho = pageWriter

export function agentsPage() {
  pageWriter = 'agent'
  writer = pageWriter
}

export function writingAs<T>(source: string | undefined, write: () => T): T {
  const outer = writer
  writer = source === 'agent' ? 'agent' : source === 'app' ? 'app' : pageWriter
  try {
    return write()
  } finally {
    writer = outer
  }
}

export const writerNow = (): UiWho => writer
