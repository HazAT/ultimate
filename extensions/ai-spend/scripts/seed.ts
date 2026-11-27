import { emptyHistory, saveHistory } from '../history.ts'
import { advance, createState, overheadRows, usageTotal } from '../model/rows.ts'
import type { EntryLike, RowState, UsageBucket, UsageLike } from '../model/rows.ts'
import type { Conversation, Price, Row } from '../model/types.ts'

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/seed.ts <path to costs-history.json>')
  process.exit(2)
}

let seed = 20261119
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (low: number, high: number) => low + random() * (high - low)
const int = (low: number, high: number) => Math.floor(between(low, high + 1))
const pick = <T>(weighted: readonly (readonly [T, number])[]): T => {
  let roll = random() * weighted.reduce((sum, [, weight]) => sum + weight, 0)
  for (const [value, weight] of weighted) if ((roll -= weight) <= 0) return value
  return weighted[0][0]
}

const OPUS = 'anthropic/claude-opus-5-5'
const EXPLORE = 'proxy/shopify/explore'
const ASTRA = 'openai/gpt-6-astra'
const prices: Record<string, Price> = {
  [OPUS]: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  [EXPLORE]: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  [ASTRA]: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
}
const TOOLS = [
  ['bash', 30, 200, 8000],
  ['read', 25, 1000, 15000],
  ['edit', 15, 100, 600],
  ['write', 4, 100, 300],
  ['codemode', 10, 500, 6000],
  ['browser', 4, 300, 3000],
  ['plan', 4, 200, 1500],
  ['message', 3, 100, 400],
  ['screenshot', 2, 100, 200],
  ['memory', 3, 300, 2500],
] as const
const IMAGE = 4000

const MIN = 60_000
const DAY = 24 * 60 * MIN
const now = Date.now()
const midnight = new Date(now)
midnight.setHours(0, 0, 0, 0)
const dayStart = (d: number) =>
  new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() - 34 + d).getTime()

type Kind = { agent: string; label?: string; family: string | null; model: string; title: string }
type Sim = {
  conversation: Omit<Conversation, 'usage' | 'busy' | 'concluded'>
  model: string
  state: RowState
  prompt: number
  cached: number
  end: number
  usage: UsageLike
}
let nextId = 100000
let nextEntry = 1
const sims: Sim[] = []

function open(kind: Kind, owner?: Sim): Sim {
  const id = nextId++
  const sim: Sim = {
    conversation: {
      id,
      title: kind.title,
      agent: kind.agent,
      ...(kind.label ? { label: kind.label } : {}),
      family: kind.family,
      ...(owner ? { owner: owner.conversation.id } : {}),
      root: owner ? owner.conversation.root : id,
      live: false,
    },
    model: kind.model,
    state: createState(id),
    prompt: int(9000, 16000),
    cached: 0,
    end: 0,
    usage: { models: {}, tools: {} },
  }
  sims.push(sim)
  return sim
}

function run(sim: Sim, start: number, count: number) {
  const id = sim.conversation.id
  const [provider, ...rest] = sim.model.split('/')
  const price = prices[sim.model]
  const writes = price.cacheWrite > 0
  const entries: EntryLike[] = []
  let at = start
  sim.cached = 0
  for (let i = 0; i < count && at < now; i++) {
    const output = int(40, 1500)
    const calls =
      random() < 0.85
        ? Array.from({ length: random() < 0.2 ? int(2, 4) : 1 }, () =>
            pick(TOOLS.map((tool) => [tool, tool[1]] as const)),
          )
        : []
    const fresh = sim.prompt - sim.cached
    const input = writes ? Math.min(fresh, int(1, 8)) : fresh
    const usage = { input, output, cacheRead: sim.cached, cacheWrite: writes ? fresh - input : 0 }
    const cost = {
      input: (usage.input * price.input) / 1e6,
      output: (usage.output * price.output) / 1e6,
      cacheRead: (usage.cacheRead * price.cacheRead) / 1e6,
      cacheWrite: (usage.cacheWrite * price.cacheWrite) / 1e6,
    }
    entries.push({
      id: nextEntry++,
      conversationId: id,
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          provider,
          model: rest.join('/'),
          content: [
            { type: 'thinking', thinking: 't'.repeat(Math.round(output * 1.2)) },
            { type: 'text', text: 'a'.repeat(Math.round(output * 0.8)) },
            ...calls.map(([name], n) => ({
              type: 'toolCall',
              id: `c${n}`,
              name,
              arguments: {
                a: 'x'.repeat(name === 'edit' || name === 'write' ? int(300, 3000) : int(20, 300)),
              },
            })),
          ],
          usage: {
            ...usage,
            totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
            reasoning: Math.round(output * 0.4),
            cost: {
              ...cost,
              total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite,
              totalFromProvider: false,
            },
          },
          timestamp: at,
          durationMs: int(2000, 40000),
          thinkingLevel: sim.conversation.family === null ? 'medium' : 'high',
        },
      ],
    })
    sim.cached = sim.prompt
    sim.prompt += output
    for (const [name, , low, high] of calls) {
      const chars = int(low, high)
      const image = name === 'screenshot'
      entries.push({
        id: nextEntry++,
        conversationId: id,
        kind: 'pi.tool-result',
        model: [
          {
            role: 'toolResult',
            toolName: name,
            content: [
              { type: 'text', text: 'r'.repeat(chars) },
              ...(image ? [{ type: 'image' }] : []),
            ],
          },
        ],
      })
      sim.prompt += Math.round((chars + (image ? IMAGE : 0)) / 2.5)
    }
    if (random() < 0.08 || !calls.length) {
      const chars = int(100, 2500)
      entries.push({
        id: nextEntry++,
        conversationId: id,
        kind: 'board.message',
        model: [{ role: 'user', content: 'u'.repeat(chars), timestamp: at }],
      })
      sim.prompt += Math.round(chars / 2.5)
    }
    at += int(8, 90) * 1000
    if (random() < 0.04) {
      at += int(6, 45) * MIN
      sim.cached = 0
    }
    if (sim.prompt > 170_000) {
      entries.push({
        id: nextEntry++,
        conversationId: id,
        kind: 'pi.compaction',
        model: [{ role: 'user', content: 's'.repeat(40_000) }],
      })
      sim.prompt = int(18_000, 30_000)
      sim.cached = 0
    }
  }
  if (!advance(sim.state, entries).length) return
  sim.end = Math.max(sim.end, at)
  if (random() < 0.6) extra(sim.usage.models!, EXPLORE, between(0.002, 0.03), int(2000, 20000))
  if (sim.conversation.agent === 'ultimate' && random() < 0.5)
    extra(sim.usage.models!, OPUS, between(0.01, 0.06), int(20000, 90000))
  if (random() < 0.06)
    extra(
      sim.usage.tools!,
      pick([
        ['web_search', 3],
        ['image_describe', 1],
      ] as const),
      between(0.005, 0.05),
      int(500, 5000),
    )
}

const bucket = (): UsageBucket => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})
function extra(buckets: Record<string, UsageBucket>, key: string, usd: number, tokens: number) {
  const sum = (buckets[key] ??= bucket())
  sum.input += tokens
  sum.cost.input += usd
  sum.cost.total += usd
}

function finish(sim: Sim): { conversation: Conversation; rows: Row[] } {
  for (const row of sim.state.rows) {
    const sum = (sim.usage.models![`${row.provider}/${row.model}`] ??= bucket())
    for (const kind of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      sum[kind] += row.tokens[kind]
      sum.cost[kind] += row.cost[kind]
    }
    sum.cost.total += row.cost.total
  }
  return {
    rows: [...sim.state.rows, ...overheadRows(sim.state, sim.usage)],
    conversation: {
      ...sim.conversation,
      busy: sim.end >= now - 30 * MIN && random() < 0.7,
      concluded: sim.end < now - DAY && random() < 0.8,
      usage: usageTotal(sim.usage),
    },
  }
}

const subjects = [
  'login page',
  'search index rebuild',
  'dashboard fix',
  'release notes',
  'costs tab',
  'sidebar PRs',
  'retry queue',
  'flaky test',
  'model catalogue',
  'schema cleanup',
  'review threads',
]
const subject = () => subjects[int(0, subjects.length - 1)]
const root = open({ agent: 'ultimate', family: 'lead', model: OPUS, title: '@ultimate' })
const advisor = open({
  agent: 'advisor',
  label: 'agent',
  family: null,
  model: OPUS,
  title: '@advisor',
})
const setup = open({ agent: 'agent', family: 'lead', model: OPUS, title: 'Ultimate setup' })
const questions = open({
  agent: 'agent',
  family: 'lead',
  model: OPUS,
  title: 'Billing questions',
})

for (let d = 0; d < 35; d++) {
  const day = dayStart(d)
  const weekday = new Date(day).getDay()
  const weekend = weekday === 0 || weekday === 6
  const volume = (weekend ? 0.25 : 1) * between(0.6, 1.4) * (0.8 + (0.4 * d) / 34)
  const at = (fromHour: number, toHour: number) => day + int(fromHour * 60, toHour * 60) * MIN
  run(root, at(8, 10), Math.round(25 * volume) + 2)
  if (!weekend) run(root, at(14, 17), Math.round(20 * volume))
  if (d === 2 || d === 3) run(setup, at(13, 15), int(30, 60))
  if (d >= 18 && d <= 21 && !weekend) run(questions, at(11, 12), int(15, 30))
  const dream = open(
    {
      agent: 'automation',
      label: 'automation · dream',
      family: 'default',
      model: EXPLORE,
      title: 'Dream pass',
    },
    root,
  )
  run(dream, at(2, 4), int(8, 20))
  const coordinators = weekend ? (random() < 0.5 ? 1 : 0) : int(1, 3)
  for (let c = 0; c < coordinators; c++) {
    const start = at(9, 16)
    const coordinator = open(
      {
        agent: 'coordinator',
        label: 'coordinator',
        family: 'lead',
        model: OPUS,
        title: `Coordinate: ${subject()}`,
      },
      root,
    )
    run(coordinator, start, Math.round(between(25, 70) * volume) + 5)
    for (let n = int(1, 4); n > 0; n--)
      run(
        open(
          {
            agent: 'worker',
            label: subject(),
            family: 'default',
            model: EXPLORE,
            title: `Work: ${subject()}`,
          },
          coordinator,
        ),
        start + int(5, 60) * MIN,
        int(30, 120),
      )
    for (let n = int(0, 2); n > 0; n--)
      run(
        open(
          {
            agent: 'scout',
            label: 'scout',
            family: 'default',
            model: EXPLORE,
            title: `Scout: ${subject()}`,
          },
          coordinator,
        ),
        start + int(2, 20) * MIN,
        int(10, 40),
      )
    for (let n = int(1, 3); n > 0; n--)
      run(
        open(
          {
            agent: 'reviewer',
            label: 'reviewer',
            family: 'default',
            model: ASTRA,
            title: `Review: ${subject()}`,
          },
          coordinator,
        ),
        start + int(60, 180) * MIN,
        int(12, 40),
      )
    if (random() < 0.3)
      run(
        open(
          { agent: 'lander', label: 'lander', family: 'default', model: EXPLORE, title: 'Land' },
          coordinator,
        ),
        start + int(120, 240) * MIN,
        int(6, 15),
      )
  }
  if (!weekend && random() < 0.35) {
    const start = at(10, 17)
    run(advisor, start, int(10, 30))
    const panel = open(
      {
        agent: 'panel',
        label: 'panel',
        family: null,
        model: OPUS,
        title: 'Lenses: evidence, adversary, alternatives',
      },
      advisor,
    )
    run(panel, start + 5 * MIN, int(6, 15))
    for (const lens of ['evidence', 'adversary', 'alternatives'])
      run(
        open(
          {
            agent: 'judge',
            label: `judge · ${lens}`,
            family: null,
            model: OPUS,
            title: `Lens: ${lens}`,
          },
          panel,
        ),
        start + 7 * MIN,
        int(8, 25),
      )
  }
}

const happened = sims.filter((sim) => sim.state.rows.length)
const needed = new Set(
  happened.flatMap((sim) => [sim.conversation.id, sim.conversation.owner, sim.conversation.root]),
)
const finished = sims.filter((sim) => needed.has(sim.conversation.id)).map(finish)
const rows = finished.flatMap((item) => item.rows)
const conversations = finished.map((item) => item.conversation)
const SEEDED = 'seeded'
await saveHistory(path, {
  ...emptyHistory(),
  savedAt: now,
  conversations: conversations.map((conversation) => ({ ...conversation, chapter: SEEDED })),
  rows: rows.map((row) => ({ ...row, chapter: SEEDED })),
  prices,
})
const usd = rows.reduce((sum, row) => sum + row.cost.total, 0)
console.log(
  `${path}: ${conversations.length} conversations, ${rows.length} rows, $${usd.toFixed(2)} over 35 days`,
)
