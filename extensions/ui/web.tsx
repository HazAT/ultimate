import type { JsonValue } from '@earendil-works/chord/json'
import { useEffect } from 'react'
import {
  api,
  cn,
  defineWebExtension,
  formatTime,
  getState,
  provide,
  scopeOf,
  uiAgent,
  useEvents,
} from '@/sdk'
import { SystemTab } from '../system/ui.tsx'
import { createRecorder } from './recorder.ts'
import { ChangedEvent, RecordAction } from './refs.ts'

function Recorder() {
  useEffect(() => {
    const recorder = createRecorder({
      driven: uiAgent.driven,
      locate: (element) => {
        const { ui, view } = getState()
        const conversation = scopeOf(element ?? null) ?? view?.conversation.id
        return {
          ...(ui.surface ? { surface: ui.surface.id } : {}),
          ...(conversation === undefined ? {} : { conversation }),
        }
      },
      send: (batch, keepalive) =>
        api.action(RecordAction, batch, { keepalive, conversationId: batch.conversation }),
    })
    const unsubscribe = uiAgent.bridge().subscribe(recorder.observe)
    const unregister = uiAgent.onFlush(recorder.flush)
    return () => {
      unsubscribe()
      unregister()
      void recorder.flush(true)
    }
  }, [])
  return null
}

const shown = (value: JsonValue | undefined) =>
  typeof value === 'string' ? value : JSON.stringify(value ?? null)

function Changes() {
  const changes = useEvents({ events: [ChangedEvent], limit: 100 })
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ul className="flex flex-col py-1">
        {changes?.map(({ id, at, data }) => {
          const agent = data.source === 'agent'
          const who = agent
            ? 'agent'
            : data.driven
              ? 'agent tab'
              : `person · ${data.device ?? data.source}`
          return (
            <li
              className="flex min-w-0 items-start gap-1.5 px-3 py-[3px] font-mono text-[10.5px] leading-[18px] text-muted-foreground hover:bg-muted/40 pointer-coarse:py-1.5"
              data-change={id}
              key={id}
              title={`${data.source}${data.reason ? ` · ${data.reason}` : ''}${data.surface ? ` · ${data.surface}` : ''}${data.conversation === undefined ? '' : ` · #${data.conversation}`}`}
            >
              <time className="w-14 shrink-0 tabular-nums text-muted-foreground/60" dateTime={at}>
                {formatTime(at, true)}
              </time>
              <span
                className={cn(
                  'w-28 shrink-0 truncate',
                  agent ? 'text-brand' : data.driven ? 'text-brand/70' : 'text-foreground/70',
                )}
              >
                {who}
              </span>
              <span className="min-w-0 shrink-0 truncate font-sans text-[11px] text-foreground/85 md:max-w-56">
                {data.label ?? data.component}
              </span>
              <span className="shrink-0 text-muted-foreground/70">{data.key}</span>
              <span className="min-w-0 flex-1 truncate">
                {data.previous !== undefined && (
                  <span className="text-muted-foreground/60">{shown(data.previous)} → </span>
                )}
                <span className="text-foreground/85">{shown(data.value)}</span>
              </span>
            </li>
          )
        })}
      </ul>
      <p className="px-3 py-4 text-center font-mono text-[11px] text-muted-foreground/70">
        {changes === undefined
          ? 'loading…'
          : changes.length === 0
            ? 'no UI changes recorded yet'
            : 'changes among the newest 100 recorded events'}
      </p>
    </div>
  )
}

const tab = { id: 'ui', title: 'UI changes', component: Changes }

export default defineWebExtension({
  slots: { overlay: [Recorder] },
  provides: [provide(SystemTab, () => tab)],
})
