type Field = HTMLInputElement | HTMLTextAreaElement

export type Place = {
  fields: Record<string, string>
  focus?: { key: string; value: string; start: number; end: number; backward: boolean }
  kept: Record<string, unknown>
}

const textInputs = new Set(['search', 'tel', 'text', 'url'])
const keyOf = (element: Element) => element.getAttribute('data-resume') || undefined

function isField(element: Element | null): element is Field {
  if (element instanceof HTMLTextAreaElement) return true
  return element instanceof HTMLInputElement && textInputs.has(element.type)
}

function namedFields() {
  return [...document.querySelectorAll('input:not(#resume *), textarea:not(#resume *)')].filter(
    (element): element is Field => isField(element) && keyOf(element) !== undefined,
  )
}

const find = (key: string) => namedFields().find((field) => keyOf(field) === key)

function write(field: Field, text: string, start: number, end: number) {
  field.setRangeText(text, start, end, 'end')
  field.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
  )
}

export function capturePlace(kept: Record<string, unknown>): Place {
  const fields: Record<string, string> = {}
  for (const field of namedFields()) if (field.value) fields[keyOf(field)!] = field.value
  const active = document.activeElement
  const key = active && isField(active) ? keyOf(active) : undefined
  const focus =
    key && isField(active)
      ? {
          key,
          value: active.value,
          start: active.selectionStart ?? active.value.length,
          end: active.selectionEnd ?? active.value.length,
          backward: active.selectionDirection === 'backward',
        }
      : undefined
  return { fields, focus, kept }
}

export function restorePlace(place: Place, typed: string) {
  for (const [key, value] of Object.entries(place.fields)) {
    const field = find(key)
    if (field && field.value === '') write(field, value, 0, 0)
  }
  const focus = place.focus
  const field = focus && find(focus.key)
  if (!focus || !field) return
  field.focus({ preventScroll: true })
  if (field.value !== focus.value) return
  field.setSelectionRange(focus.start, focus.end, focus.backward ? 'backward' : 'forward')
  if (typed) write(field, typed, focus.start, focus.end)
}
