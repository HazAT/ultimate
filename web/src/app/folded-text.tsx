import { cn } from 'cn'
import { useState } from 'react'
import { MentionText } from '@/components/ai/message'
import { overLimit } from './text-paste.ts'

/** How a folded message states its size: its lines, or its characters when it is one long line. */
export const sizeLabel = (text: string) => {
  const lines = text.split('\n').length
  return lines > 1 ? `${lines} lines` : `${text.length} chars`
}

/**
 * `text` as written, with mentions as chips. Past the composer's fold limit it shows a three-line preview and its size
 * instead, so a 400-line paste does not take over the transcript; the reader opens it in place.
 */
export function FoldedText({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const long = overLimit(text)
  const folded = long && !open
  return (
    <div className={cn('break-words', className)}>
      <p className={cn('whitespace-pre-wrap', folded && 'line-clamp-3')}>
        <MentionText text={text} />
      </p>
      {long && (
        <button
          aria-expanded={open}
          className="cursor-pointer font-mono text-[11px] text-muted-foreground/70 transition-colors hover:text-muted-foreground"
          onClick={() => setOpen(!open)}
          type="button"
        >
          {open ? 'show less' : `${sizeLabel(text)} · show`}
        </button>
      )}
    </div>
  )
}
