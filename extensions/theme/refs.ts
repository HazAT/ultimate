/** Theme in the browser: the machine-wide light or dark choice. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'

export type Theme = 'dark' | 'light'

/** No arguments → the theme in `~/.ultimate/settings.json`, or null while the machine has not chosen one. */
export const ThemeAction = actionRef<null, Theme | null>('theme', 'get')
/** The theme to keep for every Ultimate project on this machine → null. */
export const SetThemeAction = actionRef<Theme, null>('theme', 'set')
/** The machine's theme in `~/.ultimate/settings.json` changed, by any project's home; only on a change. */
export const ThemeChanged = defineEvent<{ theme: Theme | null }>('theme.changed')
