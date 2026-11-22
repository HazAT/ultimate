import type { ConversationId } from '@earendil-works/pi-durable'
import { createEffect, createSignal, onSettled } from 'solid-js'
import {
  api,
  events,
  keepLast,
  ROOT,
  showSurface,
  useConversation,
  useDocOf,
  useEvent,
  useReady,
  useStore,
} from '@/sdk/solid'
import { parseConversationId } from '../../lib/ids.ts'
import { callerOf } from './caller.ts'
import { openQuestion } from './data.ts'
import { CallerAction, MessagesDoc } from './refs.ts'

type Target = { conversation: ConversationId; entry?: number; call?: string; message?: number }

function fromAddress(): Target | undefined {
  const url = new URL(location.href)
  if (!url.searchParams.has('message')) return undefined
  const message = Number(url.searchParams.get('message'))
  const conversation = parseConversationId(Number(url.searchParams.get('conversation')))
  url.searchParams.delete('message')
  history.replaceState(history.state, '', url)
  if (Number.isSafeInteger(message) && Number.isSafeInteger(conversation) && conversation > 0)
    return { conversation, message }
  return undefined
}

export function MessageNavigation() {
  const current = useConversation()
  const surface = useStore((state) => state.ui.surface?.id ?? 'agent')
  const log = useDocOf(() => ROOT, MessagesDoc)
  const ready = useReady()
  const [target, setTarget] = createSignal<Target>()
  useEvent('messages:open', (value) => setTarget(value as Target))
  onSettled(() => {
    const initial = fromAddress()
    if (initial) setTarget((pending) => pending ?? initial)
  })

  createEffect(
    () => {
      const wanted = target()
      if (wanted?.message === undefined) return undefined
      const messages = log()?.messages
      if (!messages) return undefined
      const asked = messages.find((m) => m.id === wanted.message)
      const call =
        asked?.from === wanted.conversation && openQuestion(asked) ? asked.call : undefined
      return { conversation: wanted.conversation, call }
    },
    (resolved) => {
      if (!resolved) return
      if (resolved.call) {
        showSurface('agent')
        setTarget(resolved)
      } else setTarget(undefined)
    },
  )

  createEffect(
    () => {
      const wanted = target()
      if (!wanted || wanted.message !== undefined || !ready().ready || surface() !== 'agent')
        return undefined
      const { id, entries, loading } = current()
      if (id !== wanted.conversation || loading) return undefined
      const toolCallId = wanted.call?.split('/')[0]
      const entry = wanted.entry ?? (toolCallId ? callerOf(entries, toolCallId)?.id : undefined)
      return { ...wanted, toolCallId, entry }
    },
    (wanted) => {
      if (!wanted) return undefined
      const { conversation, call, toolCallId, entry } = wanted
      const reveal = (entryId: number) =>
        events.emit('ultimate:reveal-entry', { conversationId: conversation, entryId, toolCallId })
      if (entry !== undefined) {
        const frame = requestAnimationFrame(() => {
          setTarget(undefined)
          reveal(entry)
        })
        return () => cancelAnimationFrame(frame)
      }
      setTarget(undefined)
      if (call)
        void api.action(CallerAction, { conversation, call }).then((result) => {
          if (result.entry !== undefined) reveal(result.entry)
        }, keepLast)
      return undefined
    },
  )
  return null
}
