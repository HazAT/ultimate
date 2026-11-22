import type { ImageContent, TextContent } from '@earendil-works/pi-ai'

export function textOf(content: string | readonly (TextContent | ImageContent)[]) {
  return typeof content === 'string'
    ? content
    : content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

export function skillInput(text: string) {
  const match =
    /^<skill name="([^"]+)" location="([^"]+)">\nReferences are relative to [^\n]*\n\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]*))?$/.exec(
      text,
    )
  return match
    ? { name: match[1], location: match[2], body: match[3], request: match[4] ?? '' }
    : undefined
}
