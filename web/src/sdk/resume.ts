import { debounce, deadline } from '../../../lib/timers.ts'
import { capturePlace, restorePlace } from './resume-place.ts'
import type { Place } from './resume-place.ts'

const key = 'ultimate.resume'
const placeKey = 'ultimate.resume-place'
const placeFreshMs = 30000
const previousPageCover = document.getElementById('resume')
const unrenderedCoverLimitMs = 8000
const renderSettleLimitMs = 700
const transcriptMutationOrScrollQuietMs = 120
let covering = previousPageCover !== null
let appHasRendered = false
let markFirstRender: () => void = () => {}

export const firstRender = new Promise<void>((resolve) => {
  markFirstRender = resolve
})

/** True when this page load painted the previous page's view: a reload, not a fresh start. */
export const resumed = previousPageCover !== null
export const covered = () => covering

let previousPlace = ((): Place | undefined => {
  const stored = JSON.parse(sessionStorage.getItem(placeKey) ?? 'null') as
    | (Place & { at: number })
    | null
  return stored && Date.now() - stored.at < placeFreshMs ? stored : undefined
})()
const previousKept = new Map(Object.entries(previousPlace?.kept ?? {}))
const keepers = new Map<string, () => unknown>()

export function keepAcrossReload(name: string, read: () => unknown) {
  keepers.set(name, read)
  return () => {
    if (keepers.get(name) === read) keepers.delete(name)
  }
}

export function takeFromLastPage(name: string): unknown {
  const kept = previousKept.get(name)
  previousKept.delete(name)
  return kept
}

function placeForNextPage() {
  if (previousPlace) return previousPlace
  if (!appHasRendered) return undefined
  return capturePlace(Object.fromEntries([...keepers].map(([name, read]) => [name, read()])))
}

function keepPlace() {
  try {
    const place = placeForNextPage()
    if (place) sessionStorage.setItem(placeKey, JSON.stringify({ ...place, at: Date.now() }))
    else sessionStorage.removeItem(placeKey)
  } catch {
    sessionStorage.removeItem(placeKey)
  }
}

function takeTypedUnderCover() {
  const typed = previousPageCover?.dataset.typed ?? ''
  if (previousPageCover) delete previousPageCover.dataset.typed
  return typed
}

function copyViewportWithPlaceholders(node: Node): Node {
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
  if (node instanceof HTMLTextAreaElement) view.textContent = node.value
  else if (node.getClientRects().length > 0 || getComputedStyle(node).display === 'contents')
    for (const child of node.childNodes) view.append(copyViewportWithPlaceholders(child))
  return view
}

function captureForNextPage() {
  if (covering) {
    const stored = sessionStorage.getItem(key)
    if (stored)
      sessionStorage.setItem(key, JSON.stringify({ ...JSON.parse(stored), at: Date.now() }))
    return
  }
  if (!appHasRendered) {
    sessionStorage.removeItem(key)
    return
  }
  const view = document.createElement('div')
  for (const element of document.body.children) {
    if (element.tagName === 'SCRIPT' || element === previousPageCover) continue
    if (element.id === 'app')
      for (const child of element.childNodes) view.append(copyViewportWithPlaceholders(child))
    else view.append(copyViewportWithPlaceholders(element))
  }
  const html = view.innerHTML
  const css = [...document.styleSheets]
    .flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
    .join('\n')
  try {
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), html, css }))
  } catch {
    sessionStorage.removeItem(key)
  }
}

function uncover() {
  if (!previousPageCover || !covering) return
  takeTypedUnderCover()
  covering = false
  sessionStorage.removeItem(key)
  if (document.hidden) previousPageCover.remove()
  else
    void previousPageCover
      .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-out' })
      .finished.then(
        () => previousPageCover.remove(),
        () => previousPageCover.remove(),
      )
}

export function rendered() {
  if (appHasRendered) return
  appHasRendered = true
  markFirstRender()
  if (!covering && !previousPlace) return
  const app = document.getElementById('app')!
  const wait = debounce(transcriptMutationOrScrollQuietMs, done)
  wait()
  const changes = new MutationObserver(wait)
  changes.observe(app, { subtree: true, childList: true })
  addEventListener('scroll', wait, true)
  const cancelCap = deadline(renderSettleLimitMs, done)
  function done() {
    changes.disconnect()
    removeEventListener('scroll', wait, true)
    wait.cancel()
    cancelCap()
    const place = previousPlace
    previousPlace = undefined
    sessionStorage.removeItem(placeKey)
    const typed = takeTypedUnderCover()
    if (place) restorePlace(place, typed)
    uncover()
  }
}

addEventListener('pagehide', () => {
  captureForNextPage()
  keepPlace()
})
if (previousPageCover) deadline(unrenderedCoverLimitMs, uncover)
