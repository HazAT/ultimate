import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  useAction,
  useConversation,
  useConversations,
  useTranscript,
  useTranscriptScroll,
  useUiState,
} from '@/sdk'
import { plural } from '@/sdk'
import { DiffBody, Header, signed } from './parts.tsx'
import { CurrentPromptAction } from './refs.ts'
import type { Breakdown } from './types.ts'

/** Whether the conversation's start card is in the transcript's view. */
function useStartInView() {
  const { scrollRef, contentRef } = useTranscriptScroll()
  const [inView, setInView] = useState(false)
  const entries = useTranscript()
  useEffect(() => {
    const start = contentRef.current?.querySelector('[data-context-header="start"]')
    if (!start) return setInView(false)
    const observer = new IntersectionObserver(([seen]) => setInView(seen.isIntersecting), {
      root: scrollRef.current,
    })
    observer.observe(start)
    return () => observer.disconnect()
    // The start card mounts once the whole history is loaded, after new entries.
  }, [scrollRef, contentRef, entries])
  return inView
}

/**
 * At the top of a top-level conversation as it scrolls: the prompt it runs with now, as the start card shows the one it
 * started with. A change since the prompt the user last acknowledged lights it up and opens to its diff above the
 * parts; Dismiss makes the current prompt the new normal. The first prompt it sees is acknowledged as it is, so it starts
 * quiet. Acknowledged prompts are durable UI state, shared by every tab and device. While the start card is on screen
 * it says the same, so the pin waits for it to scroll away, unless there is a change to show.
 */
export function PinnedPrompt() {
  const id = useConversation((conversation) => conversation.id)
  const agent = useConversation((conversation) => conversation.agent)
  const owned = useConversations().find(
    (conversation) => conversation.id === id,
  )?.parentConversationId
  const entries = useTranscript()
  const startInView = useStartInView()
  // A new `pi.system` entry in the stream means the prompt changed: ask for it again.
  const latest = entries.findLast((entry) => entry.kind === 'pi.system')?.id
  const [seen, setSeen] = useUiState<number | null>(`context.seen.${id}`, null)
  const shown = useAction(
    CurrentPromptAction,
    seen === null ? {} : { since: seen },
    // Without a prompt there is nothing to pin; a failure leaves the pin out rather than raising a notice.
    { enabled: id !== undefined && owned === undefined, onError: () => {} },
  )
  const { refetch } = shown
  // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
  useEffect(() => void refetch(), [latest, refetch])
  const current = shown.data
  useEffect(() => {
    if (seen === null && current?.at !== undefined) setSeen(current.at)
  }, [seen, current?.at, setSeen])
  const breakdown = useMemo((): Breakdown | undefined => {
    if (!current?.at) return undefined
    const sum = (items: readonly { tokens: number }[]) =>
      items.reduce((total, item) => total + item.tokens, 0)
    const prompt = sum(current.prompt.sections)
    const tools = sum(current.prompt.tools)
    return {
      prompt: current.prompt,
      ...(agent.model && {
        model: {
          provider: agent.model.provider,
          model: agent.model.modelId,
          ...(agent.thinkingLevel && { thinking: agent.thinkingLevel }),
        },
      }),
      tokens: { prompt, tools, injected: 0, total: prompt + tools },
    }
  }, [current, agent.model, agent.thinkingLevel])
  if (!breakdown || !current) return null
  const diff = current.diff
  const changed = diff && diff.sections.length + diff.tools.length > 0 ? diff : undefined
  if (startInView && !changed) return null
  return (
    <div className="pointer-events-auto bg-background pt-2 pb-1" data-ui="pinned-prompt">
      <Header
        bodyClassName="max-h-[min(70vh,40rem)] overflow-y-auto"
        breakdown={breakdown}
        changes={
          changed && (
            <div className="border-b border-border/70 bg-brand/5 pt-2" data-pinned-changes>
              <div className="flex items-center gap-2 px-3">
                <span className="section-label text-brand">Changed since you last looked</span>
                <Button
                  className="ml-auto h-6 cursor-pointer px-2 font-mono text-[11px]"
                  onClick={() => current.at !== undefined && setSeen(current.at)}
                  size="sm"
                  variant="outline"
                >
                  Dismiss
                </Button>
              </div>
              <DiffBody diff={changed} />
            </div>
          )
        }
        className={changed ? 'border-brand/50 bg-card shadow-sm' : 'bg-card shadow-sm'}
        notice={
          changed && (
            <span className="text-brand" data-pinned-notice>
              {[
                changed.sections.length > 0 && plural(changed.sections.length, 'section'),
                changed.tools.length > 0 && plural(changed.tools.length, 'tool'),
              ]
                .filter(Boolean)
                .join(' · ')}{' '}
              changed · {signed(changed.delta)}
            </span>
          )
        }
      />
    </div>
  )
}
