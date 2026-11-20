import { useEffect } from 'react'
import { useUiState, writingAs } from '@/sdk'
import { SELECTED, selectionAfterChange, shown } from './items.ts'
import type { Entry, Selection } from './items.ts'

export function useSelection(entries: readonly Entry[]) {
  const [selected, setSelected] = useUiState<Selection>(SELECTED, null)
  useEffect(() => {
    const next = selectionAfterChange(entries, selected)
    if (next) writingAs('app', () => setSelected(next))
  }, [entries, selected, setSelected])
  return { shown: shown(entries, selected), selected, setSelected }
}
