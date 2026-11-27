import { LoaderCircleIcon, MoonIcon } from '@lucide/solid'
import { For, Show, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog.solid.tsx'
import {
  api,
  errorMessage,
  showSurface,
  switchConversation,
  useDialog,
  writingAs,
} from '@/sdk/solid'
import { talkToUltimate } from '../subagents/ui.solid.tsx'
import { StartAction } from './refs.ts'
import { passLabels } from './moon.solid.tsx'
import { PASSES } from './types.shared.ts'
import type { PassName } from './types.shared.ts'

export const dreamDialog = 'dream.start'

const passWhat: Record<PassName, string> = {
  memory: 'what is outdated, duplicated or never written down',
  failures: 'what broke often, and why',
  tools: 'which tools fail, crawl or go unused',
  corrections: 'what you told me twice, and what I wish I could do',
  codify: 'memories that should become how I work',
  project: 'what I keep doing by hand here, and what to build for it',
}

const SHRINKABLE_DIALOG_COLUMN =
  'max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto p-0 sm:max-w-[30rem]'
export function DreamDialog() {
  const [open, setOpen] = useDialog(dreamDialog)
  return (
    <Dialog onOpenChange={setOpen} open={open()}>
      <DialogContent class={SHRINKABLE_DIALOG_COLUMN} data-dream-dialog>
        <Show when={open()}>
          <Body onClose={() => setOpen(false)} />
        </Show>
      </DialogContent>
    </Dialog>
  )
}

function Body(props: { onClose: () => void }) {
  const [starting, setStarting] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const start = async (source: Parameters<typeof writingAs>[0]) => {
    setStarting(true)
    setFailure(undefined)
    try {
      await api.action(StartAction, null)
      const close = props.onClose
      await writingAs(source, async () => {
        close()
        await talkToUltimate({ showSurface, switchConversation })
      })
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setStarting(false)
    }
  }
  return (
    <>
      <div class="space-y-4 px-6 pt-6 pb-5">
        <div class="space-y-2">
          <DialogTitle class="flex items-center gap-2 text-base">
            <MoonIcon class="size-4 text-brand" />
            Dream
          </DialogTitle>
          <DialogDescription class="text-[13px] leading-relaxed text-muted-foreground">
            People make sense of the day while they sleep: what mattered settles, what didn't fades.
            A dream is that for me. I read back over our conversations, memory, failures and tools,
            and wake up with a journal of what I learned and a few changes I'd like to make.
          </DialogDescription>
        </div>
        <section class="space-y-1.5">
          <h3 class="section-label">Six passes</h3>
          <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[13px] leading-5">
            <For each={PASSES}>
              {(pass) => (
                <>
                  <dt class="text-foreground">{passLabels[pass]}</dt>
                  <dd class="text-muted-foreground">{passWhat[pass]}</dd>
                </>
              )}
            </For>
          </dl>
        </section>
        <p class="text-[13px] leading-relaxed text-muted-foreground">
          I start a dream branch with a handoff of everything I still remember. Its journal comes
          back to @ultimate's conversation, and we go through its proposals together. Each one you
          approve becomes an ordinary branch that is reviewed and lands as usual.{' '}
          <span class="text-foreground">Nothing changes code or memory by itself.</span> You can
          also just tell me to start dreaming.
        </p>
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 border-t border-border/60 pt-3 text-[12px]">
          <dt class="text-muted-foreground">Takes</dt>
          <dd>about 30–60 minutes</dd>
          <dt class="text-muted-foreground">Costs</dt>
          <dd>real model tokens, roughly 1–3M</dd>
          <dt class="text-muted-foreground">Runs in</dt>
          <dd>
            this database{' '}
            <span class="text-muted-foreground">
              — starting a fresh chapter comes later, by your hand
            </span>
          </dd>
        </dl>
      </div>
      <footer class="space-y-3 border-t border-border/60 bg-muted/30 px-6 py-4">
        {failure() && <p class="text-[12px] text-error">{failure()}</p>}
        <div class="flex items-center justify-end gap-2">
          <Button onClick={() => props.onClose()} size="sm" variant="ghost">
            Not now
          </Button>
          <Button
            data-dream-start
            disabled={starting()}
            onClick={(_, details) => start(details.source)}
            size="sm"
          >
            {starting() && <LoaderCircleIcon class="motion-safe:animate-spin" />}
            Start dreaming
          </Button>
        </div>
      </footer>
    </>
  )
}
