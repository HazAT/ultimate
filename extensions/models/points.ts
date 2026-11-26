import { definePoint } from '../../web/src/sdk/types.ts'

export type PickerRow = {
  value: string
  title: string
  detail?: string
  disabled?: boolean
  confirm?: string
  activate: () => Promise<unknown>
  worktree?: { title: string; activate: () => Promise<unknown> }
}

export const PickerRows = definePoint<
  { query: string },
  { group: string; rows: PickerRow[] } | undefined
>('models.picker-rows')
