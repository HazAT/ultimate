import { render } from '@solidjs/web'
import { createComponent } from 'solid-js'
import type { Component } from 'solid-js'
import { useContext, useEffect, useRef } from 'react'
import { ConversationIdContext } from './conversation-scope.tsx'
import { ExtensionNameContext } from './hooks.ts'
import { ConversationScope, ExtensionName } from './solid.ts'

/**
 * A React component that mounts the Solid `component` (from a `*.solid.tsx`) in place, so a `web.tsx` can contribute it
 * anywhere it contributes React: `slots: { 'statusline.left': island(Status) }`. The Solid tree gets the extension name
 * and the conversation scope around it, and remounts when either changes.
 */
export function island(component: Component) {
  return function Island() {
    const host = useRef<HTMLDivElement>(null)
    const extension = useContext(ExtensionNameContext) ?? null
    const conversation = useContext(ConversationIdContext) ?? null
    useEffect(
      () =>
        render(
          () =>
            createComponent(ExtensionName, {
              value: extension,
              get children() {
                return createComponent(ConversationScope, {
                  value: conversation,
                  get children() {
                    return createComponent(component, {})
                  },
                })
              },
            }),
          host.current!,
        ),
      [extension, conversation],
    )
    return <div ref={host} className="contents" />
  }
}
