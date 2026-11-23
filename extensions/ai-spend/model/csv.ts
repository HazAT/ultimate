import type { Group } from './groups.ts'

const cell = (value: string | number) => {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function csv(groups: Group[]): string {
  const lines = ['group,subgroup,usd,tokens,responses']
  for (const group of groups) {
    lines.push(
      [group.label, '', group.usd.toFixed(6), Math.round(group.tokens), group.responses]
        .map(cell)
        .join(','),
    )
    for (const child of group.children ?? [])
      lines.push(
        [group.label, child.label, child.usd.toFixed(6), Math.round(child.tokens), child.responses]
          .map(cell)
          .join(','),
      )
  }
  return `${lines.join('\n')}\n`
}
