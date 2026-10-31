/** Sketch in the browser: the spec a `sketch` call renders, its forms' state and the action that submits one. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'

export type Field = {
  name: string
  label: string
  kind: 'text' | 'number' | 'select' | 'toggle' | 'date'
  options?: string[]
  default?: string | number | boolean
}
export type Leaf =
  | { type: 'text'; markdown: string }
  | { type: 'metric'; label: string; value: string; delta?: string }
  | {
      type: 'chart'
      kind: 'bar' | 'line'
      title?: string
      x: string
      series: { name: string; field: string }[]
      data: Record<string, string | number>[]
      unit?: string
    }
  | {
      type: 'table'
      columns: { key: string; label: string }[]
      rows: Record<string, string | number | boolean | null>[]
    }
  | { type: 'form'; submit: string; fields: Field[] }
export type Block = Leaf | { type: 'row'; blocks: Leaf[] }
export type Spec = { title?: string; blocks: Block[] }

/** A `sketch` call's details: the spec, when it was drawn and by which model, and the files it read. */
export type SketchDetails = { spec: Spec; at: number; model: string; read?: string[] }

export type Value = string | number | boolean
/** A form a `sketch` call drew, by call id: its fields, and its values once submitted (it is locked then). */
export type SketchForm = {
  title?: string
  fields: Field[]
  submitted?: { at: number; values: Record<string, Value> }
}
/** `{ forms }` on the conversation that called `sketch`. */
export const SketchFormsDoc = docRef<{ forms: Record<string, SketchForm> }>('sketch.forms')

/**
 * `{ call, values }` → `{ id }`: submit the form `sketch` call `call` drew, once; its values reach the conversation as the
 * user's input. User-only.
 */
export const SubmitAction = actionRef<
  { call: string; values: Record<string, Value> },
  { ok: true }
>('sketch', 'submit')
