import { Check } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { Toggle } from '@/components/ui/toggle.solid.tsx'
import { cn, PromptBox } from '@/sdk/solid'
import type { Question } from '../messages/refs.ts'
import { answerOf, choices, keyOf, position } from './state.web.ts'
import type { Draft } from './state.web.ts'

const mark =
  'size-3 transition-[scale,opacity] duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] starting:scale-40 starting:opacity-0'
const ring = 'outline-none focus-visible:ring-2 focus-visible:ring-ring/50'

const optionClass =
  'group/option flex h-auto min-h-9 w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] leading-snug font-normal whitespace-normal motion-safe:active:scale-[0.995] max-md:min-h-11'

function OptionControl(props: {
  name: string
  chosen: boolean
  multi: boolean
  disabled: boolean
  onSelect: (pressed?: boolean) => void
  onFocus: () => void
  children: JSX.Element
}) {
  return (
    <Show
      when={props.multi}
      fallback={
        <Button
          aria-current={props.chosen ? 'true' : undefined}
          aria-label={props.name}
          data-selected={props.chosen ? '' : undefined}
          disabled={props.disabled}
          onClick={() => props.onSelect()}
          onFocus={props.onFocus}
          class={cn(optionClass, ring)}
          size={null}
          variant={null}
        >
          {props.children}
        </Button>
      }
    >
      <Toggle
        aria-label={props.name}
        pressed={props.chosen}
        disabled={props.disabled}
        onPressedChange={(pressed) => props.onSelect(pressed)}
        onFocus={props.onFocus}
        class={cn(optionClass, ring, 'data-pressed:bg-transparent data-pressed:text-inherit')}
        size={null}
        variant={null}
      >
        {props.children}
      </Toggle>
    </Show>
  )
}

type FieldKey = KeyboardEvent & { currentTarget: HTMLTextAreaElement }

function Field(props: {
  value: string
  name: string
  placeholder: string
  focus?: boolean
  disabled: boolean
  onChange: (value: string) => void
  onKey: (event: FieldKey) => boolean
  onSend: () => void
  onUploading: (busy: boolean) => void
}) {
  let input: HTMLTextAreaElement | undefined
  createEffect(
    () => props.focus,
    (focus) => {
      if (focus) input?.focus()
    },
  )
  return (
    <PromptBox
      accepts={{ images: false }}
      disabled={props.disabled}
      draft={undefined}
      label={`Your answer to ${props.name}`}
      minimal
      name={props.name}
      onKeyDown={(event) => props.onKey(event)}
      onSubmit={() => Promise.resolve(props.onSend())}
      onUploading={(busy) => props.onUploading(busy)}
      onValue={(value) => props.onChange(value)}
      placeholder={props.placeholder}
      ref={(element) => {
        input = element
      }}
      value={props.value}
    />
  )
}

export function QuestionItem(props: {
  question: Question
  index: number
  messageId: number
  draft: Draft | undefined
  current: boolean
  disabled: boolean
  hints: boolean
  onOpen: () => void
  onSelect: (choice: number, pressed?: boolean) => void
  onText: (text: string) => void
  onFieldKey: (event: FieldKey) => boolean
  onFieldSend: () => void
  onUploading: (busy: boolean) => void
}) {
  const list = createMemo(() => choices(props.question))
  const [active, setActive] = createSignal<number>()
  const words = createMemo(() => answerOf(props.question, props.draft))
  const number = () => position(props.question, props.index)
  const name = () => `question ${number()} · message ${props.messageId}`
  const multi = () => props.question.kind === 'multi'
  const confirm = () => props.question.kind === 'confirm'
  const previews = createMemo(() => list().some((choice) => choice.preview))
  const preview = () => {
    const options = list()
    return options[
      active() ??
        props.draft?.chosen[0] ??
        Math.max(
          0,
          options.findIndex((choice) => choice.recommended),
        )
    ]
  }
  const tag = () => {
    const keys =
      props.question.kind === 'scale' || props.draft?.other
        ? ''
        : (props.draft?.chosen ?? [])
            .map((i) => list()[i]?.key ?? '')
            .filter(Boolean)
            .join(',')
    return `${number()}${keys}`
  }
  const field = (placeholder: string, focus = false) => (
    <Field
      value={props.draft?.text ?? ''}
      name={name()}
      placeholder={placeholder}
      focus={focus}
      disabled={props.disabled}
      onChange={(value) => props.onText(value)}
      onKey={(event) => props.onFieldKey(event)}
      onSend={() => props.onFieldSend()}
      onUploading={(busy) => props.onUploading(busy)}
    />
  )
  const options = () => (
    <div class={cn('grid content-start gap-1.5', confirm() && 'grid-cols-2')}>
      <For each={list()} keyed={false}>
        {(choice, index) => {
          const chosen = () =>
            choice().custom ? !!props.draft?.other : !!props.draft?.chosen.includes(index)
          const showPreview = () => {
            if (!choice().custom) setActive(index)
          }
          return (
            <div
              class={cn(
                'rounded-md border transition-[background-color,border-color] duration-150',
                choice().custom && confirm() && 'col-span-2',
                chosen()
                  ? 'border-brand/50 bg-brand/10'
                  : choice().recommended
                    ? 'border-brand/25 bg-background/40 hover:bg-muted/60'
                    : 'border-border/70 bg-background/40 hover:border-border hover:bg-muted/60',
              )}
              onPointerEnter={showPreview}
            >
              <OptionControl
                name={`Option ${index + 1} · ${choice().label} · ${name()}`}
                chosen={chosen()}
                multi={multi()}
                disabled={props.disabled}
                onSelect={(pressed) => props.onSelect(index, pressed)}
                onFocus={showPreview}
              >
                <span
                  aria-hidden="true"
                  class={cn(
                    'mt-px flex size-5 shrink-0 items-center justify-center border font-mono text-[10px] transition-colors duration-150',
                    multi() ? 'rounded-[5px]' : 'rounded-full',
                    chosen()
                      ? 'border-brand bg-brand text-brand-foreground'
                      : 'border-border bg-background/60 text-muted-foreground group-hover/option:border-foreground/30 group-hover/option:text-foreground',
                  )}
                >
                  <Show when={chosen()} fallback={props.hints && keyOf(props.question, index)}>
                    <Check stroke-width={3} class={mark} />
                  </Show>
                </span>
                <span class="min-w-0 flex-1 pt-px">
                  <span
                    class={
                      choice().custom && !chosen() ? 'text-muted-foreground' : 'text-foreground'
                    }
                  >
                    {choice().label}
                  </span>
                  <Show when={choice().detail}>
                    <span class="mt-0.5 block text-xs text-muted-foreground">
                      {choice().detail}
                    </span>
                  </Show>
                </span>
                <Show when={choice().recommended}>
                  <span class="mt-0.5 shrink-0 rounded-full border border-brand/30 bg-brand/10 px-1.5 py-px font-mono text-[10px] text-brand">
                    my pick
                  </span>
                </Show>
              </OptionControl>
              <Show when={choice().custom && chosen()}>
                <div class="px-2.5 pb-2.5 pl-10">{field('Your answer…', true)}</div>
              </Show>
            </div>
          )
        }}
      </For>
    </div>
  )
  return (
    <fieldset
      disabled={props.disabled}
      data-current={props.current ? '' : undefined}
      class={cn(
        'min-w-0 rounded-md border transition-[background-color,border-color] duration-200',
        props.current ? 'border-border/80 bg-background/50' : 'border-transparent',
      )}
    >
      <legend class="sr-only">{props.question.text}</legend>
      <Button
        aria-label={`Open ${name()}: ${props.question.text}`}
        aria-expanded={props.current ? 'true' : 'false'}
        tabindex={props.current ? -1 : 0}
        disabled={props.disabled}
        onClick={() => props.onOpen()}
        class={cn(
          'flex h-auto w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left font-normal whitespace-normal',
          ring,
          props.current ? 'cursor-default' : 'hover:bg-muted/40',
        )}
        size={null}
        variant={null}
      >
        <span
          class={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] transition-colors duration-200',
            words()
              ? 'bg-brand/15 text-brand'
              : props.current
                ? 'border border-foreground/30 text-foreground'
                : 'border border-dashed border-muted-foreground/40 text-muted-foreground',
          )}
        >
          <Show when={words() && !props.current} fallback={number()}>
            <Check stroke-width={3} class={cn(mark, 'size-2.5')} />
          </Show>
        </span>
        <span
          class={cn(
            'min-w-0 text-[13px] leading-snug',
            props.current ? 'flex-1 text-foreground' : 'shrink truncate text-foreground/85',
          )}
        >
          {props.question.text}
        </span>
        <Show when={!props.current}>
          <span
            class={cn(
              'ml-auto flex min-w-0 shrink-[2] items-center gap-1.5 font-mono text-[11px]',
              words() ? 'text-muted-foreground' : 'text-muted-foreground/60',
            )}
          >
            <Show when={words()} fallback={<span class="whitespace-nowrap">not answered</span>}>
              <span class="shrink-0 text-brand">{tag()}</span>
              <span class="truncate font-sans text-xs text-foreground/80">{words()}</span>
            </Show>
          </span>
        </Show>
        <Show when={props.current && multi()}>
          <span class="shrink-0 font-mono text-[11px] text-muted-foreground">pick any</span>
        </Show>
      </Button>
      <div
        class={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          props.current ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div class="min-h-0 overflow-hidden" inert={!props.current}>
          <div class="px-2.5 pt-0.5 pb-2.5 @container">
            <Show
              when={props.question.kind !== 'text'}
              fallback={field(props.question.placeholder ?? 'Your answer…')}
            >
              <Show
                when={props.question.kind !== 'scale'}
                fallback={<Scale {...props} name={name()} />}
              >
                <div class={previews() ? 'grid gap-2 @lg:grid-cols-2' : 'contents'}>
                  {options()}
                  <Show when={previews()}>
                    <div class="relative min-h-24 min-w-0">
                      <div class="flex min-w-0 flex-col rounded-md border border-border/70 bg-background/70 @lg:absolute @lg:inset-0">
                        <div class="border-b border-border/60 px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
                          preview · {preview()?.label}
                        </div>
                        <div class="min-h-0 min-w-0 flex-1 overflow-auto px-2.5 py-2 text-xs leading-relaxed">
                          <Show
                            when={preview()?.preview}
                            fallback={
                              <span class="text-muted-foreground">No preview for this option.</span>
                            }
                          >
                            {(text) => <Markdown text={text()} />}
                          </Show>
                        </div>
                      </div>
                    </div>
                  </Show>
                </div>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </fieldset>
  )
}

function Scale(props: {
  question: Question
  draft?: Draft
  name: string
  disabled: boolean
  onSelect: (index: number) => void
}) {
  const value = () => props.draft?.chosen[0] ?? -1
  return (
    <div>
      <div class="flex gap-1">
        <For each={choices(props.question)} keyed={false}>
          {(step, index) => (
            <Button
              aria-current={value() === index ? 'true' : undefined}
              data-selected={value() === index ? '' : undefined}
              aria-label={`Rating ${step().label} · ${props.name}`}
              disabled={props.disabled}
              onClick={() => props.onSelect(index)}
              style={{ 'transition-delay': value() >= index ? `${index * 20}ms` : undefined }}
              class={cn(
                'h-9 min-w-0 flex-1 rounded-md border font-mono text-[13px] transition-[background-color,border-color,color,scale] duration-150 motion-safe:active:scale-95 max-md:h-11',
                ring,
                'data-selected:border-brand data-selected:bg-brand data-selected:text-brand-foreground',
                value() >= index
                  ? 'border-brand/30 bg-brand/15 text-foreground'
                  : 'border-border/70 bg-background/40 text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground',
              )}
              size={null}
              variant={null}
            >
              {step().label}
            </Button>
          )}
        </For>
      </div>
      <Show when={props.question.scale?.low || props.question.scale?.high}>
        <div class="mt-1.5 flex justify-between font-mono text-[11px] text-muted-foreground">
          <span>{props.question.scale?.low}</span>
          <span>{props.question.scale?.high}</span>
        </div>
      </Show>
    </div>
  )
}
