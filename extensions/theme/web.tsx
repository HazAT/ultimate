import { defineWebExtension, getState } from '@/sdk'

export default defineWebExtension({
  commands: [
    {
      id: 'theme.toggle',
      get title() {
        const theme = getState().ui.theme
        return `Toggle theme (current: ${theme[0].toUpperCase() + theme.slice(1)})`
      },
      group: 'Ultimate',
      keepOpen: true,
      run: (context) => {
        const theme = getState().ui.theme
        context.setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')
      },
    },
  ],
})
