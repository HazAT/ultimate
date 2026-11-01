import { ChevronDownIcon, SendIcon } from 'lucide-react'
import { useState } from 'react'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn, useConversations, useDocOf } from '@/sdk'
import { Address } from '../messages/ui.tsx'
import { StandingDoc } from '../subagents/ui.tsx'

/** Who a review goes to: a button naming the conversation, opening standing agents and recent conversations. */
export function Recipient({ value, onChange }: { value?: number; onChange: (id: number) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const standing = useDocOf(1, StandingDoc) ?? {}
  const agents = new Set(Object.values(standing))
  const conversations = useConversations()
  const needle = query.trim().toLowerCase()
  const matches = (id: number, ...texts: (string | undefined)[]) =>
    !needle || [`#${id}`, ...texts].some((text) => text?.toLowerCase().includes(needle))
  const recent = conversations
    .filter((conversation) => !conversation.parentConversationId && !agents.has(conversation.id))
    .toSorted((a, b) => (b.inputAt ?? b.id) - (a.inputAt ?? a.id))
    .filter((conversation) => matches(conversation.id, conversation.title, conversation.label))
    .slice(0, 30)
  const choose = (id: number) => {
    setOpen(false)
    setQuery('')
    onChange(id)
  }
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          className="flex h-7 max-w-64 min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-border/70 px-2 font-mono text-[0.7188rem] text-muted-foreground hover:bg-accent/60"
          data-review-recipient={value}
          title="Who the review goes to"
          type="button"
        >
          <SendIcon className="size-3 shrink-0" />
          <span className="max-md:hidden">to</span>
          <span className="flex min-w-0 truncate text-foreground/90">
            {value === undefined ? '…' : <Address id={value} />}
          </span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-1rem))] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            className="font-mono text-[0.7812rem]"
            onValueChange={setQuery}
            placeholder="Send the review to…"
            value={query}
          />
          <CommandList className="max-h-[60vh]">
            {Object.entries(standing).some(([name, id]) => matches(id, name)) && (
              <CommandGroup heading="Agents">
                {Object.entries(standing)
                  .filter(([name, id]) => matches(id, name))
                  .map(([name, id]) => (
                    <CommandItem
                      className={cn('gap-2 py-1 text-[0.7812rem]', id === value && 'text-brand')}
                      key={id}
                      onSelect={() => choose(id)}
                      value={String(id)}
                    >
                      <span className="font-mono">@{name}</span>
                    </CommandItem>
                  ))}
              </CommandGroup>
            )}
            {recent.length > 0 && (
              <CommandGroup heading="Conversations">
                {recent.map((conversation) => (
                  <CommandItem
                    className={cn(
                      'gap-2 py-1 text-[0.7812rem]',
                      conversation.id === value && 'text-brand',
                    )}
                    key={conversation.id}
                    onSelect={() => choose(conversation.id)}
                    value={String(conversation.id)}
                  >
                    <Address id={conversation.id} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
