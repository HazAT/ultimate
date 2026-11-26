import type { ConversationId } from '@earendil-works/pi-durable'
import type { JSX } from '@solidjs/web'
import { createEffect, createMemo, createSignal, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  keepLast,
  useAction,
  useAgent,
  useConversationId,
  useConversationSummary,
  useTranscript,
  useTranscriptElements,
  useUiState,
  useViewport,
  writingAs,
} from '@/sdk/solid'
import { changeCounts, DiffBody, Header, signed } from './parts.solid.tsx'
import { CurrentPromptAction } from './refs.ts'
import type { Breakdown } from './types.ts'

function useStartInView() {
  const { scroll, content } = useTranscriptElements()
  const [inView, setInView] = createSignal(false)
  const mounted = createMemo(
    (): { column: HTMLElement; root: HTMLElement | null } | undefined => {
      const column = content()
      return column ? { column, root: scroll() } : undefined
    },
    { equals: (a, b) => a?.column === b?.column && a?.root === b?.root },
  )
  createEffect(mounted, (elements) => {
    if (!elements) return undefined
    const { column, root } = elements
    const observer = new IntersectionObserver(([seen]) => setInView(seen.isIntersecting), {
      root,
    })
    let start: Element | null = null
    const observeStart = () => {
      if (start && column.contains(start)) return
      const next = column.querySelector(
        '[data-context-header="start"]:not([data-ui="pinned-prompt"] *)',
      )
      observer.disconnect()
      start = next
      if (start) observer.observe(start)
      else setInView(false)
    }
    observeStart()
    const changes = new MutationObserver(observeStart)
    changes.observe(column, { childList: true, subtree: true })
    return () => {
      changes.disconnect()
      observer.disconnect()
    }
  })
  return inView
}

function Unowned(props: { prompt: (conversation: ConversationId) => JSX.Element }) {
  const id = useConversationId()
  const summary = useConversationSummary(id)
  return (
    <Show keyed when={summary()?.parentConversationId === undefined ? id() : undefined}>
      {props.prompt}
    </Show>
  )
}

export function PinnedPrompt() {
  const viewport = useViewport()
  return (
    <Show when={viewport() !== 'phone'}>
      <Unowned prompt={conversationPrompt} />
    </Show>
  )
}

export const InheritedPromptStart = () => <Unowned prompt={promptStart} />

const sum = (items: readonly { tokens: number }[]) =>
  items.reduce((total, item) => total + item.tokens, 0)

function useCurrentPrompt(conversation: ConversationId) {
  const agent = useAgent()
  const entries = useTranscript()
  const [acknowledged, acknowledge] = useUiState<number | null>(
    `context.seen.${conversation}`,
    null,
  )
  const { data: current } = useAction(
    CurrentPromptAction,
    {
      get since() {
        return acknowledged() ?? undefined
      },
    },
    {
      conversation,
      onError: keepLast,
      on: () => entries().findLast((entry) => entry.kind === 'pi.system')?.id,
    },
  )
  const breakdown = createMemo((): Breakdown | undefined => {
    const result = current()
    if (!result?.at) return undefined
    const { model, thinkingLevel } = agent()
    const prompt = sum(result.prompt.sections)
    const tools = sum(result.prompt.tools)
    return {
      prompt: result.prompt,
      ...(model && {
        model: { provider: model.provider, model: model.modelId, thinking: thinkingLevel },
      }),
      tokens: { prompt, tools, injected: 0, total: prompt + tools },
    }
  })
  return { acknowledged, acknowledge, current, breakdown }
}

function promptStart(conversation: ConversationId) {
  const { breakdown } = useCurrentPrompt(conversation)
  return (
    <Show when={breakdown()}>
      {(shown) => (
        <Header breakdown={shown()} label={`Transcript start context #${conversation}`} />
      )}
    </Show>
  )
}

function conversationPrompt(conversation: ConversationId) {
  const label = `Pinned prompt #${conversation}`
  const startInView = useStartInView()
  const { acknowledged, acknowledge, current, breakdown } = useCurrentPrompt(conversation)
  createEffect(
    () => (acknowledged() === null ? current()?.at : undefined),
    (at) => {
      if (at !== undefined) writingAs('app', () => acknowledge(at))
    },
  )
  const changed = () => {
    const diff = current()?.diff
    return diff && diff.sections.length + diff.tools.length > 0 ? diff : undefined
  }
  const notice = () => {
    const diff = changed()
    return diff && `${changeCounts(diff)} changed · ${signed(diff.delta)}`
  }
  return (
    <Show when={(!startInView() || changed()) && breakdown()}>
      {(shown) => (
        <div
          class="pointer-events-auto bg-background pt-2 pb-1 max-md:hidden"
          data-ui="pinned-prompt"
        >
          <Header
            bodyClassName="max-h-[min(70vh,40rem)] overflow-y-auto"
            breakdown={shown()}
            changes={
              <Show when={changed()}>
                {(diff) => (
                  <div class="border-b border-border/70 bg-brand/5 pt-2" data-pinned-changes>
                    <div class="flex items-center gap-2 px-3">
                      <span class="section-label text-brand">Changed since you last looked</span>
                      <Button
                        aria-label={`Dismiss changes (${label})`}
                        class="ml-auto h-6 px-2 font-mono text-[11px]"
                        onClick={() => {
                          const at = current()?.at
                          if (at !== undefined) acknowledge(at)
                        }}
                        size="sm"
                        variant="outline"
                      >
                        Dismiss
                      </Button>
                    </div>
                    <DiffBody diff={diff()} label={label} />
                  </div>
                )}
              </Show>
            }
            class={changed() ? 'border-brand/50 bg-card shadow-sm' : 'bg-card shadow-sm'}
            label={label}
            notice={notice()}
          />
        </div>
      )}
    </Show>
  )
}
