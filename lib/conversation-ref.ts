const hues = [
  'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
]

export const featureTagClass = 'min-w-0 truncate rounded px-1.5 font-sans text-[10px] leading-4'

export function featureHue(feature: string) {
  let hash = 0
  for (const char of feature) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) | 0
  return hues[(hash >>> 0) % hues.length]
}

export function conversationRefParts({
  standing,
  title,
  feature,
  live,
}: {
  standing?: string
  title?: string
  feature?: string
  live?: string
}) {
  const tag = standing ? undefined : feature
  return { tag, name: standing ?? title ?? (tag ? undefined : live) }
}
