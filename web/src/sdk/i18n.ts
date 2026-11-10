import { ja } from './locales/ja.ts'
import type { ExtensionRecord } from './registry.ts'
import type { Messages } from './types.ts'

/** The core's own translations by language; extensions add theirs with `messages`. */
const core: Readonly<Record<string, Messages>> = { ja }

/** Translates English source text, filling `{name}` placeholders from `values`. */
export type Translate = (text: string, values?: Readonly<Record<string, string | number>>) => string

/**
 * The translator for `language`: the core's messages, then every extension's in discovery order, a later one winning
 * a text. English text without a translation stays as it is, so an unset language or a missing entry shows English.
 */
export function translator(
  language: string | undefined,
  records: readonly ExtensionRecord[],
): Translate {
  const messages: Record<string, string> = language
    ? Object.assign(
        {},
        core[language],
        ...records.map(({ extension }) => extension?.messages?.[language]),
      )
    : {}
  return (text, values) =>
    (messages[text] ?? text).replace(/\{(\w+)\}/g, (match, name: string) =>
      values && Object.hasOwn(values, name) ? String(values[name]) : match,
    )
}
