/** @jsxImportSource @solidjs/web */
import { Flag, LoaderCircle } from '@lucide/solid'
import { Show, createSignal, untrack } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Textarea } from '@/components/ui/input.solid.tsx'
import { Card } from '@/sdk/parts.solid.tsx'
import { ROOT, api, errorMessage, formatTime, useDocOf } from '@/sdk/solid'
import type { ToolCallView } from '@/sdk'
import { openUltimate, useOpenGoal } from './chip.solid.tsx'
import { GoalDoc, StartAction } from './refs.ts'

const words = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export function ProposedGoal(props: { call: ToolCallView }) {
  const doc = useDocOf(() => ROOT, GoalDoc)
  const started = () => doc()?.goals.find((goal) => goal.proposal === props.call.id)
  const open = useOpenGoal()
  const proposed = () => words(props.call.args.text)
  return (
    <Card data-goal-proposal={props.call.id}>
      <header class="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <Flag class="size-3.5 text-brand" />
        <span class="text-foreground">Proposed hands-off goal</span>
        <Show when={started()}>
          {(goal) => (
            <span data-goal-proposal-started>
              you started it as goal {goal().id} · {formatTime(goal().startedAt)}
            </span>
          )}
        </Show>
      </header>
      <Show
        when={doc() && !started() && props.call.status === 'done'}
        fallback={
          <p class="px-4 py-3 text-[13px] leading-relaxed whitespace-pre-wrap text-foreground">
            {started()?.text ?? proposed()}
          </p>
        }
      >
        <StartForm blocked={open()?.id} call={props.call.id} text={proposed()} />
      </Show>
    </Card>
  )
}

function StartForm(props: { call: string; text: string; blocked?: number }) {
  const [text, setText] = createSignal(untrack(() => props.text))
  const [failure, setFailure] = createSignal<string>()
  const canStart = () => props.blocked === undefined && !!text().trim()

  async function start(source: string) {
    if (!canStart()) return
    setFailure(undefined)
    try {
      await api.action(StartAction, { text: text(), proposal: props.call })
    } catch (error) {
      setFailure(errorMessage(error))
      return
    }
    await openUltimate(source)
  }

  return (
    <Form>
      <div class="px-3 pt-3 pb-2">
        <Textarea
          aria-label={`Goal text (call ${props.call})`}
          autoResize
          class="max-h-80 min-h-20 bg-transparent text-[13px] leading-relaxed"
          data-goal-proposal-text
          disabled={props.blocked !== undefined}
          onValueChange={setText}
          rows={3}
          submitShortcut="mod+enter"
          value={text()}
        />
      </div>
      <footer class="flex flex-wrap items-center gap-3 border-t border-border/60 px-4 py-2.5">
        <span class="min-w-0 flex-1 text-[12px] leading-snug text-muted-foreground">
          <Show
            when={props.blocked}
            fallback="Edit it if you like. Starting it hands decisions to @ultimate until it ends."
          >
            {(id) => (
              <span data-goal-blocked>
                <span class="text-foreground">Goal {id()} is still open.</span> End it first.
              </span>
            )}
          </Show>
        </span>
        <Show when={failure()}>
          <p class="w-full text-[12px] break-words text-error" role="alert">
            {failure()}
          </p>
        </Show>
        <Button
          aria-label={`Start this goal (call ${props.call})`}
          class="group/goal-propose"
          data-agent-confirm="Hands decisions to @ultimate until the goal ends."
          data-goal-proposal-start
          disabled={!canStart()}
          onClick={(_, details) => start(details.source)}
          pendingAnnouncement="Starting hands-off goal"
          size="sm"
          type="submit"
        >
          <LoaderCircle
            aria-hidden="true"
            class="hidden group-data-pending/goal-propose:block motion-safe:animate-spin"
          />
          Start this goal
        </Button>
      </footer>
    </Form>
  )
}
