import { useEffect } from 'react'
import { api, defineWebExtension, getState, useAction, useEvents, useUltimate } from '@/sdk'
import { SetThemeAction, ThemeAction, ThemeChanged } from './refs.ts'

function MachineTheme() {
  const { setTheme } = useUltimate()
  const latest = useEvents({ events: [ThemeChanged], limit: 1 })?.[0]?.id
  const { data } = useAction(ThemeAction, null, { on: latest })
  useEffect(() => {
    if (data && data !== getState().ui.theme) setTheme(data)
  }, [data, setTheme])
  return null
}

export default defineWebExtension({
  slots: { 'titlebar.right': [MachineTheme] },
  commands: [
    {
      id: 'theme.toggle',
      title: 'Toggle light and dark theme',
      group: 'Ultimate',
      run: (context) => {
        const next = getState().ui.theme === 'dark' ? 'light' : 'dark'
        context.setTheme(next)
        void api.action(SetThemeAction, next)
      },
    },
  ],
})
