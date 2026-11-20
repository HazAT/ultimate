/** @jsxImportSource @solidjs/web */
import { ArrowLeft, Code, ExternalLink, ScrollText } from '@lucide/solid'
import { For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Kbd, KbdGroup } from '@/components/ui/kbd.solid.tsx'
import {
  api,
  cn,
  column,
  errorMessage,
  formatKeys,
  notify,
  ROOT,
  showSurface,
  switchConversation,
  useConversationId,
  useDocOf,
  writerNow,
  writingAs,
} from '@/sdk/solid'
import type { SolidComposerProps } from '@/sdk/solid'
import { StandingAction } from '../subagents/refs.ts'
import { useGithubRepo } from '../workspaces/ui.solid.tsx'
import { OpenEditorAction, RootsDoc } from './refs.ts'

export function RootComposer(props: SolidComposerProps) {
  const id = useConversationId()
  const roots = useDocOf(() => ROOT, RootsDoc)
  const root = () => {
    const shown = id()
    return shown !== undefined && roots()?.roots.includes(shown) ? shown : undefined
  }
  return (
    <Show when={root()} fallback={props.core}>
      {(shown) => <HistoryBanner dock={props.dock} id={shown()} />}
    </Show>
  )
}

function HistoryBanner(props: { id: number; dock?: boolean }) {
  const github = useGithubRepo()
  const backToUltimate = async () => {
    const who = writerNow()
    const id = await api.action(StandingAction, { name: 'ultimate' })
    writingAs(who, () => {
      switchConversation(id)
      showSurface('agent')
    })
  }
  return (
    <div class={cn(column(props.dock), 'pb-3')}>
      <div
        class="flex flex-wrap items-center gap-x-3 gap-y-2.5 rounded-lg border border-border/70 border-l-2 border-l-brand/50 bg-muted/30 px-3.5 py-3"
        data-lineage-history={props.id}
      >
        <ScrollText class="size-4 shrink-0 text-brand" />
        <div class="min-w-56 flex-1">
          <p class="text-[13.5px] font-medium text-foreground">
            You're reading the project's history
          </p>
          <p class="text-[12.5px] leading-snug text-muted-foreground">
            Every branch, abstract and landing so far, read-only. To change anything, talk to
            @ultimate.
          </p>
        </div>
        <div class="ml-auto flex items-center gap-1">
          <Button
            class="pointer-coarse:hidden"
            onClick={() =>
              api
                .action(OpenEditorAction)
                .catch((error: unknown) => notify({ level: 'error', message: errorMessage(error) }))
            }
            title="Open the project folder in Zed, on the machine Ultimate runs on"
            variant="ghost"
          >
            <Code />
            Open in Zed
          </Button>
          <Show when={github()}>
            {(repo) => (
              <Button
                aria-label="Open on GitHub"
                render={(link) => (
                  <a
                    {...link}
                    href={`https://${repo()}`}
                    rel="noreferrer"
                    target="_blank"
                    title={`The code as it landed, on ${repo()}`}
                  >
                    <ExternalLink />
                  </a>
                )}
                size="icon"
                variant="ghost"
              />
            )}
          </Show>
          <Button onClick={backToUltimate}>
            <ArrowLeft />
            Back to @ultimate
            <KbdGroup class="hidden sm:inline-flex pointer-coarse:hidden">
              <For each={formatKeys('mod+0')[0]}>{(key) => <Kbd>{key}</Kbd>}</For>
            </KbdGroup>
          </Button>
        </div>
      </div>
    </div>
  )
}
