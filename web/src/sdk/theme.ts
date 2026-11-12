/**
 * How this browser looks. `system` follows the device's own appearance; `light` and `dark` are explicit choices that
 * never move on their own. The preference is this browser's, kept in `localStorage`, and applies as the `dark` class on
 * the page (the script in web/index.html paints a load from it before modules run).
 */
export type ThemePreference = 'system' | 'light' | 'dark'

/** The appearance actually on screen. */
export type Theme = 'light' | 'dark'

/** What this browser chose before, or `system` when it never chose: an old `light` or `dark` stays as it was. */
export function storedTheme(): ThemePreference {
  const stored = localStorage.getItem('ultimate.theme')
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

/** Whether the device asks for a dark appearance. */
export const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches

/** The appearance `preference` asks for, now. */
export const resolvedTheme = (preference: ThemePreference): Theme =>
  preference === 'system' ? (systemDark() ? 'dark' : 'light') : preference

/** Paint the page in `preference`'s appearance and remember it for the next load. */
export function applyTheme(preference: ThemePreference) {
  const theme = resolvedTheme(preference)
  localStorage.setItem('ultimate.theme', preference)
  document.documentElement.classList.toggle('dark', theme === 'dark')
  // The browser bar and the installed app's chrome take the page background (web/index.html).
  document
    .querySelector('meta[name=theme-color]')
    ?.setAttribute('content', theme === 'dark' ? '#111112' : '#f9fafb')
}

/** Follow the device while the page is open, so a page on `system` switches with it; returns the release. */
export function watchSystemTheme(change: () => void): () => void {
  const query = matchMedia('(prefers-color-scheme: dark)')
  query.addEventListener('change', change)
  return () => query.removeEventListener('change', change)
}
