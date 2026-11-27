const firstSectionChars = 250
const sectionChars = 1200

export function sections(markdown: string): string[] {
  const blocks: string[] = []
  let fence: string[] | undefined
  let block: string[] = []
  const flush = () => {
    if (block.join('').trim()) blocks.push(block.join('\n'))
    block = []
  }
  for (const line of markdown.split('\n')) {
    if (fence) {
      fence.push(line)
      if (/^\s*(```|~~~)/.test(line)) {
        blocks.push(fence.join('\n'))
        fence = undefined
      }
    } else if (/^\s*(```|~~~)/.test(line)) {
      flush()
      fence = [line]
    } else if (!line.trim()) flush()
    else block.push(line)
  }
  if (fence) blocks.push(fence.join('\n'))
  flush()
  const parts: string[] = []
  let current = ''
  for (const piece of blocks.flatMap(sentencesWithin)) {
    const limit = parts.length ? sectionChars : firstSectionChars
    if (current && current.length + piece.length > limit) {
      parts.push(current)
      current = piece
    } else current = current ? `${current}\n\n${piece}` : piece
  }
  if (current) parts.push(current)
  return parts
}

function sentencesWithin(block: string): string[] {
  if (/^\s*(```|~~~|\|)/.test(block)) return [block]
  return block.split(/\n(?=\s*(?:[-*+]|\d+[.)])\s)/).flatMap((item) => {
    if (item.length <= firstSectionChars) return [item]
    const pieces: string[] = []
    let current = ''
    for (const sentence of item.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [item]) {
      if (current && current.length + sentence.length > firstSectionChars) {
        pieces.push(current.trim())
        current = ''
      }
      current += sentence
    }
    if (current.trim()) pieces.push(current.trim())
    return pieces
  })
}

export function plainSpeech(markdown: string): string {
  return markdown
    .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, '')
    .replace(/^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/gm, '')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, cells: string) =>
      cells
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(', '),
    )
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/`([^`]*)`/g, (_, code: string) => (unspeakable(code) ? '' : code))
    .replace(/(^|[\s(])#\d+(\/\d+)?\b/g, '$1')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, '')
    .replace(/^[ \t]*#{1,6}[ \t]+(.*)$/gm, '$1.')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(.*)$/gm, '$1')
    .replace(/(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/(?<!\n)[ \t]*\n(?!\n)/g, (_match, offset: number, text: string) =>
      /[.!?:;,]$/.test(text.slice(0, offset).trimEnd()) ? ' ' : '. ',
    )
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/([.!?])[.,]+/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n\n')
    .trim()
}

function unspeakable(code: string) {
  return (
    /[/\\]/.test(code) ||
    /\.\w{1,5}$/.test(code) ||
    /^[0-9a-f]{7,40}$/.test(code) ||
    /[(){}=<>;]/.test(code) ||
    code.length > 40
  )
}

export const words = (text: string) => text.split(/\s+/).filter(Boolean).length
