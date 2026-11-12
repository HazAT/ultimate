import { defineWebExtension, getState } from '@/sdk'
import type { ThemePreference } from '@/sdk'

const cycle: ThemePreference[] = ['system', 'light', 'dark']
const label = (theme: ThemePreference) => theme[0].toUpperCase() + theme.slice(1)

export default defineWebExtension({
  commands: cycle.map((theme, index) => {
    const next = cycle[(index + 1) % cycle.length]
    return {
      id: `theme.${theme}`,
      title: `Theme: ${label(theme)}`,
      group: 'Ultimate',
      when: () => getState().ui.theme === theme,
      run: (context) => context.setTheme(next),
    }
  }),
})
