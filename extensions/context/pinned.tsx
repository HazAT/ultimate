import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  keepLast,
  useAction,
  useConversation,
  useConversationSummary,
  useTranscript,
  useTranscriptScroll,
  useUiState,
  writingAs,
} from '@/sdk'
import { plural } from '@/sdk'
import { DiffBody, Header, signed } from './parts.tsx'
import { CurrentPromptAction } from './refs.ts'
import type { Breakdown } from './types.ts'

function useStartInView() {
  const { scrollRef, contentRef } = useTranscriptScroll()
  const [inView, setInView] = useState(false)
  const entriesLoadingStartCard = useTranscript()
  useEffect(() => {
    const unpinnedStartCard = contentRef.current?.querySelector(
      '[data-context-header="start"]:not([data-ui="pinned-prompt"] *)',
    )
    if (!unpinnedStartCard) return setInView(false)
    const observer = new IntersectionObserver(([seen]) => setInView(seen.isIntersecting), {
      root: scrollRef.current,
    })
    observer.observe(unpinnedStartCard)
    return () => observer.disconnect()
  }, [scrollRef, contentRef, entriesLoadingStartCard])
  return inView
}

export function PinnedPrompt() {
  const id = useConversation((conversation) => conversation.id)
  const owned = useConversationSummary(id)?.parentConversationId
  const promptTargetUnknown = id === undefined
  return promptTargetUnknown || owned !== undefined ? null : (
    <ConversationPromptState id={id} key={id} />
  )
}

function ConversationPromptState({ id }: { id: number }) {
  const agent = useConversation((conversation) => conversation.agent)
  const entries = useTranscript()
  const startInView = useStartInView()
  const refetchOnSystemEntry = entries.findLast((entry) => entry.kind === 'pi.system')?.id
  const [acknowledgedPrompt, setAcknowledgedPrompt] = useUiState<number | null>(
    `context.seen.${id}`,
    null,
  )
  const conversationPrompt = useAction(
    CurrentPromptAction,
    acknowledgedPrompt === null ? {} : { since: acknowledgedPrompt },
    {
      onError: keepLast,
      on: refetchOnSystemEntry,
    },
  )
  const current = conversationPrompt.data
  useEffect(() => {
    const at = current?.at
    if (acknowledgedPrompt === null && at !== undefined)
      writingAs('app', () => setAcknowledgedPrompt(at))
  }, [acknowledgedPrompt, current?.at, setAcknowledgedPrompt])
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
                  onClick={() => current.at !== undefined && setAcknowledgedPrompt(current.at)}
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
            <span className="min-w-0 truncate text-brand" data-pinned-notice>
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
