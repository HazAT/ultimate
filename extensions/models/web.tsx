import { BrainIcon, CpuIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  api,
  defineWebExtension,
  errorMessage,
  getConversation,
  getState,
  island,
  refreshModels,
  useTranscript,
  useUltimate,
} from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { store } from '@/sdk/client'
import { FallbackEntry } from './entries.ts'
import { agentsPanel } from './family-state.ts'
import { LoginDialog } from './login.solid.tsx'
import { ModelPicker } from './picker.solid.tsx'
import { RefreshCatalogAction } from './refs.ts'
import type { Fallback } from './refs.ts'
import { nextThinking, openLogin, openPicker, thinkingDialog } from './state.ts'
import { switchAt } from './switches.ts'
import { ModelButton, ThinkingButton } from './toolbar.solid.tsx'

function Switched({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const change = switchAt(useTranscript(), entry)
  if (!change) return core
  const Icon = change.model ? CpuIcon : BrainIcon
  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70"
        data-models-switch
        title="The model and thinking level from this response on"
      >
        <span className="flex max-w-[80%] min-w-0 items-center gap-1.5">
          <Icon className="size-3 shrink-0" />
          <span className="truncate">
            {[
              change.model && `${change.model.from} → ${change.model.to}`,
              change.thinking && `thinking ${change.thinking.from} → ${change.thinking.to}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
      </div>
      {core}
    </div>
  )
}

const switchedTo: Record<Exclude<Fallback['reason'], 'none'>, string> = {
  same: 'the same model through another login',
  pin: 'the model its agent definition pins',
  default: 'the default model',
}

function FellBack({ entry }: { entry: EntryRecord }) {
  const actions = useUltimate()
  if (!FallbackEntry.is(entry)) return null
  const { from, to, reason } = entry.data
  const provider = from.split('/')[0]
  return (
    <section
      className="min-w-0 rounded-md border border-border border-l-2 border-l-warning/60 bg-muted/20"
      data-models-fallback
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <CpuIcon className="size-3.5 text-warning" />
        <span>{to ? 'model switched' : 'needs you · login missing'}</span>
      </header>
      <div className="space-y-2 px-3 py-3 text-[13px] leading-relaxed">
        <p className="font-mono text-[12px]">
          {to ? (
            <>
              <span className="text-muted-foreground line-through">{from}</span>
              {' → '}
              <span className="text-foreground">{to}</span>
            </>
          ) : (
            <span className="text-foreground">{from}</span>
          )}
        </p>
        <p className="text-muted-foreground">
          {reason !== 'none'
            ? `${provider} has no login here, so this conversation now runs on ${switchedTo[reason]}.`
            : `${provider} has no login here, and no subscription login can take over, so this conversation keeps its model and its requests fail until you log in to ${provider}.`}{' '}
          <button
            className="cursor-pointer text-foreground hover:underline"
            onClick={() => openPicker(actions)}
            type="button"
          >
            Pick another
          </button>{' '}
          or{' '}
          <button
            className="cursor-pointer text-foreground hover:underline"
            onClick={() => openLogin(actions)}
            type="button"
          >
            log in
          </button>
          .
        </p>
      </div>
    </section>
  )
}

export default defineWebExtension({
  entries: { 'pi.assistant': Switched, 'models.fallback': FellBack },
  slots: {
    'composer.toolbar': [island(ModelButton), island(ThinkingButton)],
    overlay: [island(ModelPicker), island(LoginDialog)],
  },
  commands: [
    {
      id: 'model.families',
      title: 'Model families…',
      run: (context) => context.openPanel(agentsPanel),
    },
    {
      id: 'model.pick',
      title: 'Pick a model',
      run: (context) => {
        if (!getConversation(context.conversationId).loading) openPicker(context)
      },
    },
    {
      id: 'model.thinking',
      title: 'Set the thinking level',
      run: (context) => context.open(thinkingDialog(context.conversationId)),
    },
    {
      id: 'model.thinking.cycle',
      title: 'Cycle the thinking level',
      keys: 'shift+tab',
      whileTyping: true,
      run: async (context) => {
        const { agent, loading } = getConversation(context.conversationId)
        if (loading) return undefined
        const ref = agent.model
        const thinking = agent.thinkingLevel
        const model = getState().models?.models.find(
          (candidate) => candidate.provider === ref?.provider && candidate.id === ref.modelId,
        )
        if (!model?.reasoning) return undefined
        return api.configure(
          { thinkingLevel: nextThinking(thinking, model) },
          context.conversationId,
        )
      },
    },
    {
      id: 'model.catalog.refresh',
      title: 'Refresh model catalog',
      run: async () => {
        try {
          const { errors } = await api.action(RefreshCatalogAction, null)
          await refreshModels()
          const failed = Object.entries(errors)
          store.notify(
            failed.length
              ? {
                  level: 'warning',
                  message: `Model catalog refreshed, except ${failed.map(([provider, message]) => `${provider} (${message})`).join(', ')}`,
                }
              : { level: 'info', message: 'Model catalog refreshed' },
          )
        } catch (error) {
          store.notify({ level: 'error', message: errorMessage(error) })
        }
      },
    },
    {
      id: 'auth.login',
      title: 'Log in to a provider',
      run: (context) => openLogin(context),
    },
  ],
})
