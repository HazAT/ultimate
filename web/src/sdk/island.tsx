import { render } from '@solidjs/web'
import { createComponent, createStore } from 'solid-js'
import type { Component } from 'solid-js'
import { useContext, useEffect, useRef } from 'react'
import { ConversationIdContext } from './conversation-scope.tsx'
import { ExtensionNameContext } from './hooks.ts'
import { ConversationScope, ExtensionName } from './solid.ts'

type Props = Record<string, unknown>

/**
 * A React component that mounts the Solid `component` (from a `*.solid.tsx`) in place, so a `web.tsx` can contribute it
 * anywhere it contributes React: `slots: { 'statusline.left': island(Status) }`. The Solid tree gets the extension name
 * and the conversation scope around it, and remounts when either changes. React props reach the Solid component as
 * live props: a React wrapper can hand it what only React reads (`<Panel count={entries.length} />` with
 * `const Panel = island(List)`), and a new value updates it without a remount.
 */
export function island<P extends object = Record<string, never>>(component: Component<P>) {
  return function Island(props: P) {
    const host = useRef<HTMLDivElement>(null)
    const extension = useContext(ExtensionNameContext) ?? null
    const conversation = useContext(ConversationIdContext) ?? null
    const latest = useRef(props as Props)
    latest.current = props as Props
    const live = useRef<(next: Props) => void>(undefined)
    useEffect(() => live.current?.(props as Props))
    useEffect(() => {
      const [store, setStore] = createStore<Props>({ ...latest.current })
      live.current = (next) =>
        setStore((draft) => {
          for (const key of Object.keys(draft)) if (!(key in next)) delete draft[key]
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
                  return createComponent(component, store as P)
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
    }, [extension, conversation])
    return <div ref={host} className="contents" />
  }
}
