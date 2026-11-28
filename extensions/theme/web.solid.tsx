import { onCleanup } from 'solid-js'
import { defineWebExtension, getState, native, nativeCan, setTheme } from '@/sdk/solid'

function FollowNativeApp() {
  const follow = (scheme: 'dark' | 'light') => {
    if (getState().ui.theme !== scheme) setTheme(scheme)
  }
  const changed = (event: Event) => follow((event as CustomEvent<'dark' | 'light'>).detail)
  void nativeCan('theme').then(async (can) => {
    if (!can) return
    addEventListener('native-color-scheme', changed)
    follow(await native.colorScheme())
  })
  onCleanup(() => removeEventListener('native-color-scheme', changed))
  return null
}

export default defineWebExtension({
  slots: { 'titlebar.right': [FollowNativeApp] },
  commands: [
    {
      id: 'theme.toggle',
      title: 'Toggle light and dark theme',
      group: 'Ultimate',
      run: (context) => context.setTheme(getState().ui.theme === 'dark' ? 'light' : 'dark'),
    },
  ],
})
