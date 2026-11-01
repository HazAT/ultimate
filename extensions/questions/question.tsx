import { CheckIcon } from 'lucide-react'
import { useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { cn } from '@/sdk'
import type { Question } from '../messages/refs.ts'
import { answerOf, choices, keyOf, position } from './state.tsx'
import type { Choice, Draft } from './state.tsx'

/** A check that pops in when it mounts: the moment a choice lands. */
const Check = ({ className }: { className?: string }) => (
  <CheckIcon
    strokeWidth={3}
    className={cn(
      'size-3 transition-[scale,opacity] duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] starting:scale-40 starting:opacity-0',
      className,
    )}
  />
)

/**
 * The key hint that becomes the selection mark: a letter in a quiet box, filled with a check once chosen. Round for one
 * answer, square for several.
 */
function Mark({ hint, chosen, multi }: { hint?: string; chosen: boolean; multi: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-px flex size-5 shrink-0 items-center justify-center border font-mono text-[10px] transition-colors duration-150',
        multi ? 'rounded-[5px]' : 'rounded-full',
        chosen
          ? 'border-brand bg-brand text-brand-foreground'
          : 'border-border bg-background/60 text-muted-foreground group-hover/option:border-foreground/30 group-hover/option:text-foreground',
      )}
    >
      {chosen ? <Check /> : hint}
    </span>
  )
}

/** The field for a typed answer: Enter goes on, Esc hands the keys back to the card, ↑/↓ move between questions. */
function Field({
  value,
  label,
  placeholder,
  autoFocus,
  onChange,
  onKey,
}: {
  value: string
  label: string
  placeholder: string
  autoFocus?: boolean
  onChange: (value: string) => void
  onKey: (event: KeyboardEvent<HTMLInputElement>) => void
}) {
  return (
    <input
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- "Something else…" opens this field to type in at once.
      autoFocus={autoFocus}
      aria-label={label}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKey}
      className="min-h-9 w-full min-w-0 rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] transition-colors outline-none placeholder:text-muted-foreground focus:border-brand/60 max-md:min-h-11"
    />
  )
}

/** One option as a full-width row: its key mark, label and detail, and @ultimate's pick when it is one. */
function Option({
  choice,
  hint,
  chosen,
  multi,
  onSelect,
  onActive,
  children,
}: {
  choice: Choice
  hint?: string
  chosen: boolean
  multi: boolean
  onSelect: () => void
  onActive: () => void
  children?: ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-md border transition-[background-color,border-color] duration-150',
        chosen
          ? 'border-brand/50 bg-brand/10'
          : choice.recommended
            ? 'border-brand/25 bg-background/40 hover:bg-muted/60'
            : 'border-border/70 bg-background/40 hover:border-border hover:bg-muted/60',
      )}
      onPointerEnter={onActive}
    >
      <button
        type="button"
        aria-pressed={chosen}
        onClick={onSelect}
        onFocus={onActive}
        className="group/option flex min-h-9 w-full cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-[0.995] max-md:min-h-11"
      >
        <Mark hint={hint} chosen={chosen} multi={multi} />
        <span className="min-w-0 flex-1 pt-px">
          <span className={choice.custom && !chosen ? 'text-muted-foreground' : 'text-foreground'}>
            {choice.label}
          </span>
          {choice.detail && (
            <span className="mt-0.5 block text-xs text-muted-foreground">{choice.detail}</span>
          )}
        </span>
        {choice.recommended && (
          <span className="mt-0.5 shrink-0 rounded-full border border-brand/30 bg-brand/10 px-1.5 py-px font-mono text-[10px] text-brand">
            my pick
          </span>
        )}
      </button>
      {children}
    </div>
  )
}

/** A rating: numbered steps that fill up to the chosen one, with the ends named underneath. */
function Scale({
  question,
  draft,
  onSelect,
}: {
  question: Question
  draft: Draft | undefined
  onSelect: (choice: number) => void
}) {
  const steps = choices(question)
  const value = draft?.chosen[0]
  return (
    <div>
      <div className="flex gap-1">
        {steps.map((step, index) => {
          const chosen = value === index
          const below = value !== undefined && index < value
          return (
            <button
              key={step.label}
              type="button"
              aria-pressed={chosen}
              aria-label={step.label}
              onClick={() => onSelect(index)}
              style={{ transitionDelay: chosen || below ? `${index * 20}ms` : undefined }}
              className={cn(
                'h-9 min-w-0 flex-1 cursor-pointer rounded-md border font-mono text-[13px] transition-[background-color,border-color,color,scale] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-95 max-md:h-11',
                chosen
                  ? 'border-brand bg-brand text-brand-foreground'
                  : below
                    ? 'border-brand/30 bg-brand/15 text-foreground'
                    : 'border-border/70 bg-background/40 text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground',
              )}
            >
              {step.label}
            </button>
          )
        })}
      </div>
      {(question.scale?.low || question.scale?.high) && (
        <div className="mt-1.5 flex justify-between font-mono text-[11px] text-muted-foreground">
          <span>{question.scale?.low}</span>
          <span>{question.scale?.high}</span>
        </div>
      )}
    </div>
  )
}

/** The short form of an answer for a folded question or the settled card: "1a", "2a,c" or "5", and its words. */
export function brief(question: Question, index: number, draft: Draft | undefined) {
  const list = choices(question)
  const keys =
    question.kind === 'scale' || draft?.other
      ? ''
      : (draft?.chosen ?? [])
          .flatMap((i) => (list[i]?.key && !list[i].custom ? [list[i].key] : []))
          .join(',')
  return { tag: `${position(question, index)}${keys}`, words: answerOf(question, draft) }
}

/**
 * One question on the card. The current one is open with its options; the others fold to a line with their answer, or
 * "not answered", and open on a click. The body folds by animating its grid row, so the card's height eases.
 */
export function QuestionItem({
  question,
  index,
  draft,
  current,
  disabled,
  hints,
  onOpen,
  onSelect,
  onText,
  onFieldKey,
}: {
  question: Question
  index: number
  draft: Draft | undefined
  current: boolean
  disabled: boolean
  hints: boolean
  onOpen: () => void
  onSelect: (choice: number) => void
  onText: (text: string) => void
  onFieldKey: (event: KeyboardEvent<HTMLInputElement>) => void
}) {
  const list = choices(question)
  const [active, setActive] = useState<number>()
  const answer = brief(question, index, draft)
  const done = !!answer.words
  const previews = list.some((choice) => choice.preview)
  const shown =
    active ??
    draft?.chosen[0] ??
    Math.max(
      0,
      list.findIndex((choice) => choice.recommended),
    )
  const multi = question.kind === 'multi'
  const field = (label: string, placeholder: string, autoFocus?: boolean) => (
    <Field
      value={draft?.text ?? ''}
      label={label}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={onText}
      onKey={onFieldKey}
    />
  )
  const options = (
    <div className={cn('grid content-start gap-1.5', question.kind === 'confirm' && 'grid-cols-2')}>
      {list.map((choice, number) => {
        const chosen = choice.custom ? !!draft?.other : !!draft?.chosen.includes(number)
        return (
          <div
            // oxlint-disable-next-line react/no-array-index-key -- Fixed options addressed by position in the draft.
            key={number}
            className={cn(choice.custom && question.kind === 'confirm' && 'col-span-2')}
          >
            <Option
              choice={choice}
              hint={hints ? keyOf(question, number) : undefined}
              chosen={chosen}
              multi={multi}
              onSelect={() => onSelect(number)}
              onActive={() => !choice.custom && setActive(number)}
            >
              {choice.custom && chosen && (
                <div className="px-2.5 pb-2.5 pl-10">
                  {field(
                    `Your answer to question ${position(question, index)}`,
                    'Your answer…',
                    true,
                  )}
                </div>
              )}
            </Option>
          </div>
        )
      })}
    </div>
  )
  return (
    <fieldset
      disabled={disabled}
      data-current={current ? '' : undefined}
      className={cn(
        'min-w-0 rounded-md border transition-[background-color,border-color] duration-200',
        current ? 'border-border/80 bg-background/50' : 'border-transparent',
      )}
    >
      <legend className="sr-only">{question.text}</legend>
      <button
        type="button"
        tabIndex={current ? -1 : 0}
        aria-expanded={current}
        onClick={onOpen}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring',
          current ? 'cursor-default' : 'cursor-pointer hover:bg-muted/40',
        )}
      >
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] transition-colors duration-200',
            done
              ? 'bg-brand/15 text-brand'
              : current
                ? 'border border-foreground/30 text-foreground'
                : 'border border-dashed border-muted-foreground/40 text-muted-foreground',
          )}
        >
          {done && !current ? <Check className="size-2.5" /> : position(question, index)}
        </span>
        <span
          className={cn(
            'min-w-0 text-[13px] leading-snug',
            current ? 'flex-1 text-foreground' : 'shrink truncate text-foreground/85',
          )}
        >
          {question.text}
        </span>
        {!current && (
          <span
            className={cn(
              'ml-auto flex min-w-0 shrink-[2] items-center gap-1.5 font-mono text-[11px]',
              done ? 'text-muted-foreground' : 'text-muted-foreground',
            )}
          >
            {done ? (
              <>
                <span className="shrink-0 text-brand">{answer.tag}</span>
                <span className="truncate font-sans text-xs text-foreground/80">
                  {answer.words}
                </span>
              </>
            ) : (
              <span className="whitespace-nowrap">not answered</span>
            )}
          </span>
        )}
        {current && multi && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">pick any</span>
        )}
      </button>
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          current ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={!current}>
          <div className="px-2.5 pt-0.5 pb-2.5 @container">
            {question.kind === 'text' ? (
              field(
                `Your answer to question ${position(question, index)}`,
                question.placeholder ?? 'Your answer…',
              )
            ) : question.kind === 'scale' ? (
              <Scale question={question} draft={draft} onSelect={onSelect} />
            ) : previews ? (
              // Side by side, the preview fills the options' height and scrolls inside, so hovering never moves them.
              <div className="grid gap-2 @lg:grid-cols-2">
                {options}
                <div className="relative min-h-24 min-w-0">
                  <div className="flex min-w-0 flex-col rounded-md border border-border/70 bg-background/70 @lg:absolute @lg:inset-0">
                    <div className="border-b border-border/60 px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
                      preview · {list[shown]?.label}
                    </div>
                    <div className="min-h-0 min-w-0 flex-1 overflow-auto px-2.5 py-2 text-xs leading-relaxed">
                      {list[shown]?.preview ? (
                        <MessageResponse>{list[shown].preview}</MessageResponse>
                      ) : (
                        <span className="text-muted-foreground">No preview for this option.</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              options
            )}
          </div>
        </div>
      </div>
    </fieldset>
  )
}
