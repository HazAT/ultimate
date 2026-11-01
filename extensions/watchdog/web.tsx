import { AlertCircleIcon } from 'lucide-react'
import { defineWebExtension, useUltimate } from '@/sdk'
import { MessageResponse } from '@/components/ai/message'
import { ConversationRef } from '../conversations/ui.tsx'
import type { Failure } from './refs.ts'

export default defineWebExtension({
  entries: {
    'watchdog.failure': function FailureCard({ entry }) {
      const failure = entry.data as Failure
      const { switchConversation } = useUltimate()
      return (
        <section className="min-w-0 rounded-md border border-border border-l-2 border-l-destructive/60 bg-muted/20">
          <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[0.6875rem] text-muted-foreground">
            <AlertCircleIcon className="size-3.5 text-destructive" />
            <button
              type="button"
              className="min-w-0 cursor-pointer text-foreground hover:underline"
              onClick={() => switchConversation(failure.conversation)}
            >
              <ConversationRef id={failure.conversation} title={failure.title} />
            </button>
            <span>run failed</span>
          </header>
          <div className="space-y-2 px-3 py-3 text-[0.8125rem] leading-relaxed">
            <p className="whitespace-pre-wrap text-destructive">{failure.error}</p>
            <p className="font-mono text-[0.6875rem] text-muted-foreground">
              last step: {failure.step}
            </p>
            {failure.hint && <MessageResponse>{failure.hint}</MessageResponse>}
            {failure.retried && (
              <p className="text-[0.6875rem] text-muted-foreground">after one automatic retry</p>
            )}
          </div>
        </section>
      )
    },
    'watchdog.idle': ({ entry }) => (
      <p className="whitespace-pre-line font-mono text-[0.6875rem] text-muted-foreground">
        {(entry.data as { text: string }).text}
      </p>
    ),
  },
})
