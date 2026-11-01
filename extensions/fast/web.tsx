import { ZapIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, cn, defineWebExtension, events, useAction, useConversation, useEvent } from '@/sdk'
import { SetAction, StatusAction } from './refs.ts'

/** Fast mode for the composer's OpenAI model: on for every request to that model, wherever it runs. */
function FastToggle() {
  const ref = useConversation().agent.model
  const status = useAction(StatusAction)
  useEvent('fast:changed', () => void status.refetch())
  if ((ref?.provider !== 'openai-codex' && ref?.provider !== 'openai') || !status.data) return null
  const model = `${ref.provider}/${ref.modelId}`
  const on = status.data.models.includes(model)
  const { project } = status.data
  const toggle = async () => {
    await api.action(SetAction, { model, on: !on })
    events.emit('fast:changed', undefined)
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label="Fast"
          aria-pressed={on}
          className={cn(
            'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 font-mono text-[0.7188rem] transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none',
            on ? 'text-foreground/85' : 'text-muted-foreground',
          )}
          data-fast={on}
          disabled={project}
          onClick={() => void toggle()}
          type="button"
        >
          <ZapIcon className={cn('size-3.5 shrink-0', on && 'fill-brand/30 text-brand')} />
          <span className="@max-md:hidden">fast</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {project
          ? 'Fast models are set by project settings'
          : on
            ? `Fast for every ${ref.modelId} request · uses plan limits 2.5× faster · click for Standard`
            : `Standard speed · click to run every ${ref.modelId} request fast`}
      </TooltipContent>
    </Tooltip>
  )
}

export default defineWebExtension({
  slots: { 'composer.toolbar': { component: FastToggle, order: 1 } },
})
