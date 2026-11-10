import { expect, it } from 'vitest'
import { translator } from '../../web/src/sdk/i18n.ts'
import type { ExtensionRecord } from '../../web/src/sdk/registry.ts'
import type { Messages } from '../../web/src/sdk/types.ts'

const record = (name: string, messages: Record<string, Messages>): ExtensionRecord => ({
  name,
  extension: { messages },
  loading: false,
  version: 1,
})

it('shows English unless a language is set and translates the text', () => {
  const records = [record('todos', { ja: { 'Show to-dos': 'ToDo を表示' } })]
  expect(translator(undefined, records)('Show to-dos')).toBe('Show to-dos')
  const t = translator('ja', records)
  expect(t('Show to-dos')).toBe('ToDo を表示')
  expect(t('Run a command…')).toBe('コマンドを実行…')
  expect(t('Not translated yet')).toBe('Not translated yet')
})

it('lets a later extension replace a translation and fills placeholders', () => {
  const t = translator('ja', [
    record('system', { ja: { System: 'システム' } }),
    record('my-ja-pack', { ja: { 'Run a command…': 'コマンド…', System: 'システム画面' } }),
  ])
  expect(t('Run a command…')).toBe('コマンド…')
  expect(t('Switch to {surface}', { surface: t('System') })).toBe('システム画面に切り替え')
  expect(t('{count} left, {missing}', { count: 2 })).toBe('2 left, {missing}')
})
