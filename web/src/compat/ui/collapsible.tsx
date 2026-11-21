import { createContext, useContext, useId, useMemo, useRef, useState } from 'react'
import type { ComponentProps } from 'react'

const CollapsibleContext = createContext<{
  open: boolean
  disabled?: boolean
  contentId: string
  toggle: () => void
} | null>(null)

const state = (open: boolean) => (open ? 'open' : 'closed')

function useCollapsible(part: string) {
  const context = useContext(CollapsibleContext)
  if (!context) throw new Error(`${part} must be inside a Collapsible`)
  return context
}

function Collapsible({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  disabled,
  ...props
}: ComponentProps<'div'> & {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
}) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen)
  const open = openProp ?? uncontrolled
  const contentId = useId()
  const latest = useRef({ open, controlled: openProp !== undefined, onOpenChange })
  latest.current = { open, controlled: openProp !== undefined, onOpenChange }
  const context = useMemo(
    () => ({
      open,
      disabled,
      contentId,
      toggle: () => {
        const next = !latest.current.open
        if (!latest.current.controlled) setUncontrolled(next)
        latest.current.onOpenChange?.(next)
      },
    }),
    [open, disabled, contentId],
  )
  return (
    <CollapsibleContext.Provider value={context}>
      <div
        data-disabled={disabled ? '' : undefined}
        data-slot="collapsible"
        data-state={state(open)}
        {...props}
      />
    </CollapsibleContext.Provider>
  )
}

function CollapsibleTrigger({ onClick, ...props }: ComponentProps<'button'>) {
  const { open, disabled, contentId, toggle } = useCollapsible('CollapsibleTrigger')
  return (
    <button
      aria-controls={open ? contentId : undefined}
      aria-expanded={open}
      data-disabled={disabled ? '' : undefined}
      data-slot="collapsible-trigger"
      data-state={state(open)}
      disabled={disabled}
      type="button"
      {...props}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) toggle()
      }}
    />
  )
}

function UnmeasuredUnanimatedOpenContent(props: ComponentProps<'div'>) {
  const { open, disabled, contentId } = useCollapsible('CollapsibleContent')
  if (!open) return null
  return (
    <div
      data-disabled={disabled ? '' : undefined}
      data-slot="collapsible-content"
      data-state="open"
      id={contentId}
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, UnmeasuredUnanimatedOpenContent as CollapsibleContent }
