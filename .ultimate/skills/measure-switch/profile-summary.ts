// Summarise a CDP CPU profile from switch.ts: busy time and the bundle functions it was spent under (inclusive).
// Usage: node profile-summary.ts <file.cpuprofile> [top=30]
import { readFileSync } from 'node:fs'

interface Node {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
  children?: number[]
}
const [file, top = '30'] = process.argv.slice(2)
if (!file) throw new Error('Usage: node profile-summary.ts <file.cpuprofile> [top]')
const profile = JSON.parse(readFileSync(file, 'utf8')) as {
  nodes: Node[]
  samples: number[]
  timeDeltas: number[]
}
const byId = new Map(profile.nodes.map((node) => [node.id, node]))
const parent = new Map<number, number>()
for (const node of profile.nodes)
  for (const child of node.children ?? []) parent.set(child, node.id)

// The page runs the production bundle from /assets/; the build keeps function names, so frames stay readable.
const app = (node: Node) => node.callFrame.url.includes('/assets/')
const name = (node: Node) =>
  `${node.callFrame.functionName || '(anonymous)'} ${node.callFrame.url.replace(/^.*\/assets\//, '')}:${node.callFrame.lineNumber + 1}`

let busy = 0
const inclusive = new Map<string, number>()
profile.samples.forEach((sample, index) => {
  const ms = profile.timeDeltas[index] / 1000
  if (/^\((idle|program|root)\)$/.test(byId.get(sample)!.callFrame.functionName)) return
  busy += ms
  const seen = new Set<string>()
  for (let id: number | undefined = sample; id !== undefined; id = parent.get(id)) {
    const node = byId.get(id)!
    if (!app(node)) continue
    const key = name(node)
    if (seen.has(key)) continue
    seen.add(key)
    inclusive.set(key, (inclusive.get(key) ?? 0) + ms)
  }
})
console.log(`busy ${Math.round(busy)} ms`)
for (const [key, ms] of [...inclusive].toSorted((a, b) => b[1] - a[1]).slice(0, Number(top)))
  console.log(`${String(Math.round(ms)).padStart(6)} ms  ${key}`)
