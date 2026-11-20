import { useEffect, useRef } from 'react'
import { useUiState, writingAs } from '@/sdk'
import { SELECTED, selectionAfterChange, shown } from './items.ts'
import type { Entry, Selection } from './items.ts'

type Handoff = { from: string; to: string }

export function useSelection(entries: readonly Entry[]) {
  const [selected, setSelected] = useUiState<Selection>(SELECTED, null)
  const sent = useRef<Handoff>(undefined)
  useEffect(() => {
    const key = selected?.key
    const departedCameBack =
      sent.current?.from === key && entries.some((entry) => entry.key === key)
    if (departedCameBack) sent.current = undefined
    const next = selectionAfterChange(entries, selected)
    if (!next || !key) return
    const rolledBack = sent.current?.from === key && sent.current.to === next.key
    if (rolledBack) return
    sent.current = { from: key, to: next.key }
    writingAs('app', () => setSelected(next))
  }, [entries, selected, setSelected])
  return { shown: shown(entries, selected), selected, setSelected }
}
