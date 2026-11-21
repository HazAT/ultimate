/** @jsxImportSource @solidjs/web */
import { createEffect, createMemo } from 'solid-js'
import type { Accessor } from 'solid-js'
import { useUiState, writingAs } from '@/sdk/solid'
import { SELECTED, selectionAfterChange, shown } from './items.ts'
import type { Entry, Selection } from './items.ts'

export function useSelection(entries: Accessor<readonly Entry[]>) {
  const [selected, setSelected] = useUiState<Selection>(SELECTED, null)
  createEffect(
    () => selectionAfterChange(entries(), selected()),
    (next) => {
      if (next) writingAs('app', () => setSelected(next))
    },
  )
  const item = createMemo(() => shown(entries(), selected()))
  return { item, selected, setSelected }
}
