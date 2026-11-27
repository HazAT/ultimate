import { WHY, cache, cacheBy } from './cache.ts'
import type { CacheLine } from './cache.ts'
import { CACHE, DIMENSIONS } from './dimensions.ts'
import type { Dimension, Filter } from './dimensions.ts'
import { count, keyLabel, percent, signed, usd } from './format.ts'
import { labelOf, namesOf } from './labels.ts'
import { refOf } from './types.ts'
import type { SpendData } from './types.ts'

export const KEEP_WARM =
  'not done today: keep-warm pings only @ultimate, 55 min after its last cache request, on claude-code or with long retention'

export type BriefInput = {
  data: SpendData
  filter: Filter
  range: string
  filters: readonly (readonly [Dimension, readonly string[]])[]
  total: number
}

const table = (head: string[], rows: string[][], words = 1) =>
  [
    `| ${head.join(' | ')} |`,
    `|${head.map((_, i) => (i < words ? ' --- ' : ' ---: ')).join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n')

const ofLeak = (line: CacheLine) =>
  line.leakUsd > 0 ? percent(line.underHourUsd / line.leakUsd, 0) : '—'

const byNumber = (dimension: Dimension) => dimension === 'conversation' || dimension === 'tree'

const PARAGRAPH_AFTER = ['', '']

export function brief({ data, filter, range, filters, total }: BriefInput): string {
  const report = cache(data, filter)
  const names = namesOf(data)
  const byId = names.byId
  const name = (dimension: Dimension, key: string) => {
    const conversation = byNumber(dimension) ? byId.get(Number(key)) : undefined
    return conversation
      ? refOf(conversation)
      : keyLabel(dimension, key, labelOf(dimension, key, names))
  }
  const scope = filters.length
    ? filters
        .map(
          ([dimension, values]) =>
            `${DIMENSIONS[dimension].toLowerCase()} = ${values.map((key) => name(dimension, key)).join(', ')}`,
        )
        .join('; ')
    : 'none'
  const { pinging, hourCache } = report
  const share = (leakUsd: number) => percent(leakUsd / report.leakUsd)

  const causes = report.classes.filter((cls) => cls.leakUsd > 0)
  const causeRows = causes.flatMap((cls) => [
    [
      WHY[cls.key] ? `${cls.key}: ${WHY[cls.key]}` : cls.key,
      count(cls.responses),
      usd(cls.leakUsd),
      share(cls.leakUsd),
    ],
    ...(cls.key === CACHE.idle
      ? report.gaps
          .filter((gap) => gap.responses > 0)
          .map((gap) => [
            `· after ${gap.key}`,
            count(gap.responses),
            usd(gap.leakUsd),
            share(gap.leakUsd),
          ])
      : []),
  ])
  const conversations = cacheBy(data, filter, 'conversation').map((line) => {
    const conversation = byId.get(Number(line.key))
    return [
      conversation ? refOf(conversation) : `#${line.key}`,
      conversation?.agent ?? '—',
      name('model', line.model),
      count(line.idle),
      usd(line.leakUsd),
      ofLeak(line),
    ]
  })
  const models = cacheBy(data, filter, 'model').map((line) => [
    name('model', line.key),
    count(line.responses),
    count(line.idle),
    usd(line.leakUsd),
    ofLeak(line),
  ])

  return [
    'Look at the prompt-cache numbers below, from the Spend page, and propose cache configuration changes that would cut the leak.',
    '',
    `## Spend's cache view: ${range}, filters: ${scope}`,
    '',
    `- **Leaked:** ${usd(report.leakUsd)}, ${percent(total > 0 ? report.leakUsd / total : 0)} of the ${usd(total)} spent: what a warm cache would have saved (rewrites' cache writes and misses' input, priced as cache reads).`,
    `- **Ping while away** (estimate): ${signed(pinging.savedUsd - pinging.costUsd)}, saves ${usd(pinging.savedUsd)}, costs ${usd(pinging.costUsd)}. Assumes a ping every 4½ min in every conversation, reading its prompt from the cache, through pauses under 8 h: ${count(pinging.pings)} pings over ${count(pinging.rewrites)} idle rewrites.`,
    `- **One-hour cache** (estimate): ${signed(hourCache.savedUsd - hourCache.extraUsd)}, saves ${usd(hourCache.savedUsd)}, costs ${usd(hourCache.extraUsd)} more. Assumes every cache write at 2× input (Anthropic's one-hour price) on models whose writes cost more than input; it saves the ${count(hourCache.rewrites)} idle rewrites after pauses under 1 h.`,
    '',
    '### Leak by cause',
    '',
    causeRows.length
      ? table(['cause', 'responses', 'leaked', 'of leak'], causeRows)
      : 'No estimated cache leaks in these responses.',
    '',
    '### Conversations that leak the most',
    '',
    conversations.length
      ? table(
          ['conversation', 'agent', 'model', 'idle rewrites', 'leaked', 'of it after pauses < 1 h'],
          conversations,
          3,
        )
      : 'None.',
    '',
    '### Models that leak the most',
    '',
    models.length
      ? table(['model', 'responses', 'idle rewrites', 'leaked', 'of it after pauses < 1 h'], models)
      : 'None.',
    '',
    '## What Ultimate does today',
    '',
    'keep-warm pings only @ultimate, 55 min after its last cache request, while the user\'s last input is under 8 h old, and only on `claude-code`, or on `anthropic` with long retention (`PI_CACHE_RETENTION=long`). Nothing pings other conversations or every 4½ min, so the "ping while away" estimate is not something a setting turns on today.',
    '',
    '## Where the settings live',
    '',
    '- **Which model an agent runs on:** its agent definition (`model`, or the `family` it runs on) and the model families (⌘K → Model families…).',
    "- **Compaction thresholds:** Pi's settings, key `compaction` (`settings.json` in Pi's agent directory, which is `$PI_CODING_AGENT_DIR` when the server's environment sets it and `~/.pi/agent` otherwise, then `<project>/.pi/settings.json`), with `compaction.modelOverrides` keyed by `\"provider/modelId\"`; read when the server starts. See Ultimate's `docs/settings.md`.",
    "- **keep-warm:** which conversations and providers it pings, in Ultimate's `extensions/keep-warm/README.md`; the `warm` chip in the status line turns it on or off.",
    "- **Anthropic's one-hour cache:** the `PI_CACHE_RETENTION=long` environment variable, for every Anthropic request.",
    '- Check project memory for what was already decided about these.',
    '',
    '## How to answer',
    '',
    'Propose each change on a question card, with what it would save by the numbers above. Change no file or setting until I say yes.',
    ...PARAGRAPH_AFTER,
  ].join('\n')
}
