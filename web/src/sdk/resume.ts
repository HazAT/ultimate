/**
 * Reloads resume where they left off: when the page goes away it stores what it shows (markup, styles, scroll
 * positions) in `sessionStorage`, `index.html` paints that before any module loads, and it fades out once the app has
 * rendered again (`rendered()`). A core swap, a Vite full reload or F5 so never flash an empty window or the splash.
 */
import { debounce, deadline } from '../../../lib/timers.ts'

const key = 'ultimate.resume'
/** The view `index.html` painted from the previous page, until released. */
const shown = document.getElementById('resume')
/** Longest the previous view covers the app, should it never render. */
const coverMs = 8000
/**
 * Once the app has rendered, it settles for at most this long, and counts as settled after this long without the
 * transcript growing or scrolling. Timestamps and status text keep changing and do not count.
 */
const settle = 700
const quiet = 120
let covering = shown !== null
/** The app has rendered: there is a view worth resuming. */
let ready = false

/** True when this page load painted the previous page's view: a reload, not a fresh start. */
export const resumed = shown !== null
/** True while the previous page's view still covers the app. */
export const covered = () => covering

/**
 * What `node` shows, for the stored view: elements on screen as they are, each off screen as a blank of its size, so
 * a long transcript stays small and scroll offsets still land. Out-of-flow elements off screen take no room, so they
 * go; hidden ones keep no content.
 */
function copy(node: Node): Node {
  if (!(node instanceof HTMLElement)) return node.cloneNode(true)
  const box = node.getBoundingClientRect()
  if (box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) {
    const { margin, position } = getComputedStyle(node)
    if (position === 'absolute' || position === 'fixed') return document.createTextNode('')
    const blank = document.createElement('div')
    blank.style.cssText = `width:${box.width}px;height:${box.height}px;margin:${margin};flex:none`
    return blank
  }
  const view = node.cloneNode(false) as HTMLElement
  if (node.scrollTop > 0 || node.scrollLeft > 0)
    view.dataset.resumeScroll = `${node.scrollTop},${node.scrollLeft}`
  // A draft lives in the textarea's value, which markup leaves out.
  if (node instanceof HTMLTextAreaElement) view.textContent = node.value
  else if (node.getClientRects().length > 0 || getComputedStyle(node).display === 'contents')
    for (const child of node.childNodes) view.append(copy(child))
  return view
}

function capture() {
  // Going away again before the app rendered: the previous view is still the one to show, stored as it came.
  if (covering) {
    const stored = sessionStorage.getItem(key)
    if (stored)
      sessionStorage.setItem(key, JSON.stringify({ ...JSON.parse(stored), at: Date.now() }))
    return
  }
  // Still loading, under the splash: the next load starts fresh too.
  if (!ready) {
    sessionStorage.removeItem(key)
    return
  }
  const view = document.createElement('div')
  for (const element of document.body.children) {
    if (element.tagName === 'SCRIPT' || element === shown) continue
    if (element.id === 'app') for (const child of element.childNodes) view.append(copy(child))
    else view.append(copy(element))
  }
  const html = view.innerHTML
  const css = [...document.styleSheets]
    .flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
    .join('\n')
  try {
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), html, css }))
  } catch {
    // Over the storage quota: the next load starts fresh, with the splash.
    sessionStorage.removeItem(key)
  }
}

/** Crossfades the previous view out over the app beneath, which shows the same page by now. */
function uncover() {
  if (!shown || !covering) return
  covering = false
  sessionStorage.removeItem(key)
  if (document.hidden) shown.remove()
  else
    void shown
      .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-out' })
      // Cancellation also ends the cover; do not leave its rejected finished promise floating.
      .finished.then(
        () => shown.remove(),
        () => shown.remove(),
      )
}

/**
 * The app has rendered: a reload from here resumes it, and the previous view uncovers it once it has settled, when
 * nothing in it was added, removed or scrolled for `quiet` ms (such as the transcript sticking to its bottom as code
 * blocks highlight) or after `settle` ms.
 */
export function rendered() {
  if (ready) return
  ready = true
  if (!covering) return
  const app = document.getElementById('app')!
  const wait = debounce(quiet, done)
  wait()
  const changes = new MutationObserver(wait)
  changes.observe(app, { subtree: true, childList: true })
  addEventListener('scroll', wait, true)
  const cancelCap = deadline(settle, done)
  function done() {
    changes.disconnect()
    removeEventListener('scroll', wait, true)
    wait.cancel()
    cancelCap()
    uncover()
  }
}

addEventListener('pagehide', capture)
if (shown) deadline(coverMs, uncover)
