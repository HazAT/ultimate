import { parseConversationId } from '../../../lib/ids.ts'
import type { ConversationId } from '@earendil-works/pi-durable'
import { createContext, useEffect } from 'react'
import type { ReactNode } from 'react'
import { store } from './client.ts'
import type { TranscriptFrame } from './transcript-frame.ts'

export const ConversationIdContext = createContext<ConversationId | undefined>(undefined)

export const TranscriptContext = createContext<TranscriptFrame | undefined>(undefined)

export const scopeAttribute = 'data-conversation-scope'

/**
 * Give descendants their own live conversation without switching the shell's shown conversation.
 * Hooks and transcript/composer contributions inherit this id, and so do shortcuts pressed inside it; the palette and
 * the imperative `api` stay global.
 * Scopes of the same id share a stream, released when the last scope unmounts.
 */
export function ConversationScope({ id, children }: { id: ConversationId; children: ReactNode }) {
  useEffect(() => store.watchConversation(id), [id])
  return (
    <ConversationIdContext value={id}>
      <TranscriptContext value={undefined}>
        <div className="contents" {...{ [scopeAttribute]: id }}>
          {children}
        </div>
      </TranscriptContext>
    </ConversationIdContext>
  )
}

export function scopeOf(target: EventTarget | null): ConversationId | undefined {
  const scope = target instanceof HTMLElement ? target.closest(`[${scopeAttribute}]`) : null
  const id = Number(scope?.getAttribute(scopeAttribute))
  return Number.isSafeInteger(id) && id > 0 ? parseConversationId(id) : undefined
}
