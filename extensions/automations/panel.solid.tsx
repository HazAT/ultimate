import type { ConversationId } from '@earendil-works/pi-durable'
import { CircleAlert, Plus, Timer } from '@lucide/solid'
import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  errorMessage,
  openPanel,
  switchConversation,
  useCommands,
  useConversationId,
  useExtensionUiState,
  useNow,
  useStore,
} from '@/sdk/solid'
import { AutomationForm } from './form.solid.tsx'
import { useAutomations, useRunSignature, useShown } from './live.solid.tsx'
import { attention, lookOf, looks, worstFirst } from './looks.web.ts'
import { Heading } from './parts.solid.tsx'
import { AutomationRow } from './row.solid.tsx'
import { ScriptDetail } from './script.solid.tsx'
import type { Automation } from './refs.ts'

export function AutomationsPanel() {
  const shown = useShown()
  const overdue = (items: Automation[] | undefined) =>
    (items ?? []).some(
      (item) => item.enabled && item.nextAt !== undefined && Date.now() - item.nextAt > 1500,
    )
  const polled = useAutomations(
    (items) => (shown() || overdue(items) ? 2000 : 15000),
    useRunSignature(),
  )
  const list = () => polled().data ?? []
  const refreshList = () => polled().refetch()
  const commands = useCommands()
  const [expanded, setExpanded] = useExtensionUiState<string[]>('expanded', [])
  const [editor, setEditor] = createSignal<{
    automation?: Automation
    opener: HTMLElement | null
  }>()
  const [formOpen, setFormOpen] = createSignal(false)
  const conversationId = useConversationId()
  const requested = useStore((state) => state.requested)
  const conversation = createMemo(() => requested() ?? conversationId())
  const [listing, setListing] = createSignal<ConversationId>()
  createEffect(conversation, () => setListing(undefined))
  const fast = () =>
    shown() ||
    list().some(
      (item) =>
        item.runs.some((run) => run.status === 'running') ||
        (item.nextAt !== undefined && item.nextAt - Date.now() < 120_000),
    )
  const fastClock = useNow(1000, fast)
  const slowClock = useNow(15000, () => !fast())
  const now = () => (fast() ? fastClock() : slowClock())
  const watcher = () =>
    listing() !== conversation()
      ? list().find((item) => item.script?.conversationId === conversation())
      : undefined
  const automations = createMemo(() => worstFirst(list(), now()))
  const failing = () => automations().filter((item) => attention(lookOf(item, now()))).length
  const resting = () => automations().filter((item) => looks[lookOf(item, now())].rank > 3).length
  const listError = () => errorMessage(polled().error).replace(/^automations\/list: /, '')
  let newButton: HTMLButtonElement | undefined
  const edit = (opener: HTMLElement | null, automation?: Automation) => {
    setEditor({ automation, opener })
    setFormOpen(true)
  }
  const newLabel = 'Add an automation'

  return (
    <Show
      when={watcher()?.id}
      keyed
      fallback={
        <div class="pb-4">
          <div class="flex items-center gap-2 px-3 pt-2 pb-1.5">
            <Heading
              class="min-w-0 flex-1"
              meta={
                <Show when={automations().length > 0}>
                  <Show when={failing()}>
                    <span class="text-error">{failing()} need attention · </span>
                  </Show>
                  {automations().length}
                  {resting() > 0 && !failing() && ` · ${resting()} paused or done`}
                </Show>
              }
            >
              Automations
            </Heading>
            <Show when={automations().length > 0}>
              <Button
                aria-label={newLabel}
                class="-mr-1.5 h-6 gap-1 px-1.5 text-[11.5px] text-muted-foreground hover:text-foreground"
                onClick={(event) => edit(event.currentTarget)}
                ref={newButton}
                size="xs"
                variant="ghost"
              >
                <Plus class="size-3.5" /> New
              </Button>
            </Show>
          </div>
          <Switch>
            <Match when={!polled().data && polled().error}>
              <div class="px-3 py-3">
                <p class="flex items-start gap-1.5 font-mono text-[11.5px] leading-snug text-error">
                  <CircleAlert class="mt-px size-3 shrink-0" />
                  {listError()}
                </p>
                <Show
                  when={
                    /subagents/.test(listError()) &&
                    commands().some((command) => command.id === 'manager.open')
                  }
                >
                  <Button
                    class="mt-2 h-7 text-[12px]"
                    onClick={() => openPanel('extensions')}
                    size="sm"
                    variant="outline"
                  >
                    Open Extensions
                  </Button>
                </Show>
              </div>
            </Match>
            <Match when={!polled().data}>
              <p class="px-3 py-2 font-mono text-[11.5px] text-muted-foreground">loading…</p>
            </Match>
            <Match when={automations().length === 0}>
              <div class="flex flex-col items-center px-6 pt-8 pb-6 text-center">
                <Timer class="size-5 text-muted-foreground/60" />
                <p class="mt-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
                  Run a prompt on a schedule, or have a script watch for something and wake you when
                  it happens.
                </p>
                <Button
                  aria-label={newLabel}
                  class="mt-3.5 h-7 gap-1.5 text-[12px]"
                  onClick={(event) => edit(event.currentTarget)}
                  ref={newButton}
                  size="sm"
                  variant="outline"
                >
                  <Plus class="size-3.5" /> New automation
                </Button>
              </div>
            </Match>
            <Match when={true}>
              <ul aria-label="Automations" class="border-t border-border/50">
                <For each={automations()} keyed={(item) => item.id}>
                  {(item) => (
                    <AutomationRow
                      automation={item()}
                      now={now()}
                      expanded={expanded().includes(item().id)}
                      onExpand={(open) => {
                        const id = item().id
                        setExpanded((previous) =>
                          open
                            ? [...new Set([...previous, id])]
                            : previous.filter((key) => key !== id),
                        )
                      }}
                      onEdit={(opener) => edit(opener, item())}
                      onDeleted={(id) => {
                        setExpanded((previous) => previous.filter((key) => key !== id))
                        requestAnimationFrame(() => newButton?.focus())
                      }}
                      onOpenScript={() => {
                        setListing(undefined)
                        switchConversation(item().script!.conversationId)
                        openPanel('automations')
                      }}
                    />
                  )}
                </For>
              </ul>
            </Match>
          </Switch>
          <Show when={editor()} keyed>
            {(session) => (
              <AutomationForm
                automation={session.automation}
                open={formOpen()}
                close={() => setFormOpen(false)}
                finalFocus={() =>
                  session.opener?.isConnected ? session.opener : (newButton ?? null)
                }
                onSaved={() => void refreshList()}
              />
            )}
          </Show>
        </div>
      }
    >
      {(id) => (
        <ScriptDetail
          automation={list().find((item) => item.id === id)!}
          live={shown()}
          now={now()}
          onBack={() => setListing(conversation())}
        />
      )}
    </Show>
  )
}
