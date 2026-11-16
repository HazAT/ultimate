const firstSectionChars = 400
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
  if (block.length <= sectionChars || /^\s*(```|~~~|\|)/.test(block)) return [block]
  const pieces: string[] = []
  let current = ''
  for (const sentence of block.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [block]) {
    if (current && current.length + sentence.length > sectionChars) {
      pieces.push(current.trim())
      current = ''
    }
    current += sentence
  }
  if (current.trim()) pieces.push(current.trim())
  return pieces
}

export function plainSpeech(markdown: string): string {
  return markdown
    .replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '')
    .replace(/^\s*\|(.*)\|\s*$/gm, (_, cells: string) =>
      cells
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(', '),
    )
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/`([^`]*)`/g, (_, code: string) => (unspeakable(code) ? '' : code))
    .replace(/(^|\s)#\d+(\/\d+)?\b/g, '$1')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, '')
    .replace(/^\s*#{1,6}\s+(.*)$/gm, '$1.')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/gm, '$1')
    .replace(/(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/[ \t]*\n(?!\n)/g, (match, offset: number, text: string) =>
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
