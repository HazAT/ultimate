import { createEffect, onCleanup, useContext } from 'solid-js'
import type { Component } from 'solid-js'
import type { ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { ExtensionBoundary } from '../app/boundary.tsx'
import { ConversationIdContext } from './conversation-scope.tsx'
import { ConversationScope, ExtensionName } from './solid.ts'

/**
 * Temporary, for the core switch only: C5 deletes it with React. The reverse of `island`: a Solid component that mounts
 * the React `component` in place, so a Solid core host (the transcript, the shell) can render an extension's leftover
 * React renderer. It renders inside an `ExtensionName`; the React tree gets that name and the conversation scope, sits
 * in an `ExtensionBoundary` so a throw stays inside it, and re-renders with each change of the Solid props without a
 * remount. Only `web/src/app` imports it.
 */
export function reactIsland<P extends object = Record<string, never>>(
  component: ComponentType<P>,
): Component<P> {
  const Rendered = component as ComponentType<object>
  return function ReactIsland(props: P) {
    const extension = useContext(ExtensionName)
    if (extension === null) throw new Error('reactIsland renders only inside an ExtensionName')
    const conversation = useContext(ConversationScope) ?? undefined
    const host = document.createElement('div')
    host.className = 'contents'
    const root = createRoot(host)
    onCleanup(() => root.unmount())
    createEffect(
      () => ({ ...props }),
      (current) =>
        root.render(
          <ConversationIdContext value={conversation}>
            <ExtensionBoundary extension={extension} version={0}>
              <Rendered {...current} />
            </ExtensionBoundary>
          </ConversationIdContext>,
        ),
    )
    return host
  }
}
