import { useEffect, useRef } from 'react'
import { useUiState, writingAs } from '@/sdk'
import { SELECTED, selectionAfterChange, shown } from './items.ts'
import type { Entry, Selection } from './items.ts'

type Handoff = { from: string; to: string; departedKey?: string }

export function useSelection(entries: readonly Entry[]) {
  const [selected, setSelected] = useUiState<Selection>(SELECTED, null)
  const sent = useRef<Handoff>(undefined)
  useEffect(() => {
    const key = selected?.key
    const departedCameBack =
      sent.current?.departedKey === key && entries.some((entry) => entry.key === key)
    if (departedCameBack) sent.current = undefined
    const next = selectionAfterChange(entries, selected)
    if (!next || !key) return
    const handoff = { from: JSON.stringify(selected), to: JSON.stringify(next) }
    const rolledBack = sent.current?.from === handoff.from && sent.current.to === handoff.to
    if (rolledBack) return
    sent.current = { ...handoff, departedKey: next.key === key ? undefined : key }
    writingAs('app', () => setSelected(next))
  }, [entries, selected, setSelected])
  return { shown: shown(entries, selected), selected, setSelected }
}
