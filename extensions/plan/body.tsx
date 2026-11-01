/** An epic body split at the section labels the `plan` tool asks for, for display only; storage stays plain text. */

const labels = [
  'Request',
  'Selected approach',
  'Intent',
  'Scope',
  'Acceptance criteria',
  'Implementation',
  'Verification',
  'Risks',
]
// `Label: text`, optionally bold, `Scope in:` or `Scope (in/out):`; or a Markdown heading `## Label`.
const line = new RegExp(
  `^\\*{0,2}(${labels.join('|')})( in| \\(in/out\\))?\\*{0,2}:\\*{0,2}[ \\t]*(.*)$|^#{1,4}[ \\t]+(${labels.join('|')}):?[ \\t]*$`,
  'i',
)
const canonical = (label: string) =>
  labels.find((known) => known.toLowerCase() === label.toLowerCase()) ?? label

export type Section = { label?: string; text: string }

/** The body's labelled sections in order, text before the first label unlabelled; undefined when it has no labels. */
export function sectionsOf(body: string): Section[] | undefined {
  const sections: Section[] = []
  let current: Section = { text: '' }
  for (const text of body.split('\n')) {
    const match = line.exec(text)
    if (!match) {
      current.text += `${text}\n`
      continue
    }
    if (current.label || current.text.trim()) sections.push(current)
    const suffix = match[2]?.trim().replace(/^\(|\)$/g, '')
    current = {
      label: canonical(match[1] ?? match[4]),
      text: match[3] ? `${suffix ? `${suffix}: ` : ''}${match[3]}\n` : '',
    }
  }
  sections.push(current)
  if (!sections.some((section) => section.label)) return undefined
  return sections.map((section) => ({ ...section, text: section.text.trim() }))
}

/**
 * Coordinator text as Markdown that shows it as written: a `<` outside code stays text instead of an HTML tag the
 * sanitizer drops (`<projects>`), and a single newline breaks the line instead of joining the paragraph.
 */
export function verbatim(text: string) {
  let fenced = false
  return text
    .split('\n')
    .map((row, index, rows) => {
      if (/^\s*(```|~~~)/.test(row)) {
        fenced = !fenced
        return row
      }
      if (fenced) return row
      const escaped = row
        .split(/(`[^`]*`)/)
        .map((part, i) => (i % 2 ? part : part.replace(/</g, '&lt;')))
        .join('')
      const next = rows[index + 1]
      return next?.trim() && row.trim() ? `${escaped}  ` : escaped
    })
    .join('\n')
}

const item = /^\s*(?:\d+[.)]|[-*+])\s+(?:\[[ xX]\]\s+)?(.*)$/

/** A section's list items (numbered, bulleted or task list), lines below an item joined to it; undefined if not a list. */
export function criteriaOf(text: string): string[] | undefined {
  const items: string[] = []
  for (const row of text.split('\n')) {
    if (!row.trim()) continue
    const match = item.exec(row)
    if (match) items.push(match[1].trim())
    else if (items.length > 0) items[items.length - 1] += ` ${row.trim()}`
    else return undefined
  }
  return items.length > 0 ? items : undefined
}
