import { render } from '@solidjs/web'
import { createComponent, createStore } from 'solid-js'
import type { Component } from 'solid-js'
import { useContext, useEffect, useEffectEvent, useRef } from 'react'
import type { ReactNode } from 'react'
import { ConversationIdContext, TranscriptContext } from './conversation-scope.tsx'
import { ExtensionNameContext } from './hooks.ts'
import { markIsland } from './island-mark.ts'
import { ConversationScope, ExtensionName, Transcript } from './solid.ts'

type Props = Record<string, unknown>

type IslandProps<P> = { [K in keyof P]: K extends 'core' | 'cancel' ? ReactNode : P[K] }

/**
 * A React component that mounts the Solid `component` (from a `*.solid.tsx`) in place, so a `web.tsx` can contribute it
 * anywhere it contributes React: `slots: { 'statusline.left': island(Status) }`. The Solid tree gets the extension name,
 * the conversation scope and the transcript around it, and remounts when one changes. React props reach the Solid component as
 * live props: a React wrapper can hand it what only React reads (`<Panel count={entries.length} />` with
 * `const Panel = island(List)`), and a new value updates it without a remount. It mounts in a `display: contents`
 * `<div>`, or a `<span>` with `{ inline: true }` for a component that renders inside text. A Solid host (the
 * transcript) renders an island's component directly: a tool, entry or message renderer contributed as `island(Card)`
 * is plain Solid there.
 */
export function island<P extends object = Record<string, never>>(
  component: Component<P>,
  { inline = false }: { inline?: boolean } = {},
) {
  function Island(props: P) {
    const host = useRef<HTMLElement>(null)
    const extension = useContext(ExtensionNameContext) ?? null
    const conversation = useContext(ConversationIdContext) ?? null
    const transcript = useContext(TranscriptContext) ?? null
    const committed = useEffectEvent(() => ({ ...(props as Props) }))
    const live = useRef<(next: Props) => void>(undefined)
    useEffect(() => live.current?.(props as Props))
    useEffect(() => {
      const [store, setStore] = createStore<Props>(committed())
      live.current = (next) =>
        setStore((draft) => {
          for (const key of Object.keys(draft)) if (!Object.hasOwn(next, key)) delete draft[key]
          Object.assign(draft, next)
        })
      const dispose = render(
        () =>
          createComponent(ExtensionName, {
            value: extension,
            get children() {
              return createComponent(ConversationScope, {
                value: conversation,
                get children() {
                  return createComponent(Transcript, {
                    value: transcript,
                    get children() {
                      return createComponent(component, store as P)
                    },
                  })
                },
              })
            },
          }),
        host.current!,
      )
      return () => {
        live.current = undefined
        dispose()
      }
    }, [extension, conversation, transcript])
    const Host = inline ? 'span' : 'div'
    return <Host ref={host as never} className="contents" />
  }
  markIsland(Island, component)
  return Island as (props: IslandProps<P>) => ReactNode
}
