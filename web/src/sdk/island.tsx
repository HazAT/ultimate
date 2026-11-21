import { insert as mount, registerDelegatedRoot, unregisterDelegatedRoot } from '@solidjs/web'
import {
  createComponent,
  createRoot,
  createStore,
  flush,
  getOwner,
  onCleanup,
  runWithOwner,
} from 'solid-js'
import type { Component } from 'solid-js'
import { useContext, useEffect, useEffectEvent, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ConversationIdContext, TranscriptContext } from './conversation-scope.tsx'
import { ExtensionNameContext } from './hooks.ts'
import { markIsland } from './island-mark.ts'
import { ConversationScope, ExtensionName, Transcript } from './solid.ts'

type Props = Record<string, unknown>

const islands = createRoot(() => getOwner())

type IslandProps<P> = {
  [K in keyof P]: K extends 'core' | 'cancel' | 'children' ? ReactNode : P[K]
}

/**
 * A React component that mounts the Solid `component` (from a `*.solid.tsx`) in place, so a `web.tsx` can contribute it
 * anywhere it contributes React: `slots: { 'statusline.left': island(Status) }`. The Solid tree gets the extension name,
 * the conversation scope and the transcript around it, and remounts when one changes. React props reach the Solid component as
 * live props: a React wrapper can hand it what only React reads (`<Panel count={entries.length} />` with
 * `const Panel = island(List)`), and a new value updates it without a remount. It mounts in a `display: contents`
 * `<div>`, or a `<span>` with `{ inline: true }` for a component that renders inside text. React `children` reach the
 * Solid component as one `display: contents` element it places where they go; React renders them into it through a
 * portal, so React context still reaches them, and only while the Solid component places it. A Solid host (the transcript) renders an island's component directly: a
 * tool, entry or message renderer contributed as `island(Card)` is plain Solid there.
 */
export function island<P extends object = Record<string, never>>(
  component: Component<P>,
  { inline = false }: { inline?: boolean } = {},
) {
  function Island(given: P) {
    const host = useRef<HTMLElement>(null)
    const extension = useContext(ExtensionNameContext) ?? null
    const conversation = useContext(ConversationIdContext) ?? null
    const transcript = useContext(TranscriptContext) ?? null
    const [childHost] = useState(() =>
      Object.assign(document.createElement(inline ? 'span' : 'div'), { className: 'contents' }),
    )
    const [placements, setPlacements] = useState(0)
    const [placeChildren] = useState(() => () => {
      setPlacements((count) => count + 1)
      onCleanup(() => setPlacements((count) => count - 1))
      return childHost
    })
    const { children, ...rest } = given as Props & { children?: ReactNode }
    const props = children === undefined ? rest : { ...rest, children: placeChildren }
    const committed = useEffectEvent(() => ({ ...props }))
    const live = useRef<(next: Props) => void>(undefined)
    useEffect(() => live.current?.(props))
    useEffect(() => {
      const [store, setStore] = createStore<Props>(committed())
      live.current = (next) =>
        setStore((draft) => {
          for (const key of Object.keys(draft)) if (!Object.hasOwn(next, key)) delete draft[key]
          Object.assign(draft, next)
        })
      const element = host.current!
      let dispose: (() => void) | undefined
      const release = () => {
        try {
          dispose?.()
        } finally {
          unregisterDelegatedRoot(element)
          element.textContent = ''
        }
      }
      registerDelegatedRoot(element)
      try {
        runWithOwner(islands, () =>
          createRoot((done) => {
            dispose = done
            mount(element, () =>
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
            )
          }),
        )
        flush()
      } catch (failure) {
        release()
        throw failure
      }
      return () => {
        live.current = undefined
        release()
      }
    }, [extension, conversation, transcript])
    const Host = inline ? 'span' : 'div'
    return (
      <>
        <Host ref={host as never} className="contents" />
        {children !== undefined && placements > 0 && createPortal(children, childHost)}
      </>
    )
  }
  markIsland(Island, component)
  return Island as (props: IslandProps<P>) => ReactNode
}
