import type { Component } from 'solid-js'
import { definePoint } from '../../web/src/sdk/types.ts'

export type PickerRow = {
  value: string
  title: string
  icon?: Component<{ class?: string }>
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
