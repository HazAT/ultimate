export function shortTitle(prompt: string, max = 60) {
  const lines = prompt
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)*/, '')
        .replace(/\*\*|__/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
  const isTitleRatherThanSingleWordHeading = (line: string) => /\s/.test(line)
  const text = lines.find(isTitleRatherThanSingleWordHeading) ?? lines[0] ?? ''
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}
