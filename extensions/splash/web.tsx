import { TriangleAlertIcon, XIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, defineWebExtension, errorMessage, resumed, useReady, useStore } from '@/sdk'
import { store } from '@/sdk/client'
import { StatusAction } from '../onboarding/ui.tsx'
import { Electric } from './electric.tsx'

/** The core's readiness deadline: not ready by then, the app opens anyway and the notice names what is missing. */
const timeout = 8000

/**
 * ULTIMATE as the header sets it, Inter SemiBold tracked 0.28em, at display size: the outlines of Inter's `opsz` 32,
 * `wght` 600 instance with overlaps removed, kerned by HarfBuzz. Font units (2048 per em), y down: the caps span 0 to
 * 1490 and U overshoots to 1514. One path per contour, so each traces on its own; A is its outline, then its counter.
 */
const letters: readonly (readonly string[])[] = [
  [
    'M721 1514Q539 1514 403.5 1445Q268 1376 193 1254.5Q118 1133 118 975L118 0L379 0L379 954Q379 1049 421 1122.5Q463 1196 539.5 1238Q616 1280 721 1280Q826 1280 902.5 1238Q979 1196 1020.5 1122.5Q1062 1049 1062 954L1062 0L1323 0L1323 975Q1323 1134 1248.5 1255.5Q1174 1377 1038.5 1445.5Q903 1514 721 1514Z',
  ], // U
  ['M2138 1490L2138 0L2402 0L2402 1261L3093 1261L3093 1490Z'], // L
  ['M3567 229L3567 0L4758 0L4758 229L4296 229L4296 1490L4031 1490L4031 229Z'], // T
  ['M5766 0L5766 1490L5502 1490L5502 0Z'], // I
  [
    'M6587 1490L6587 0L6967 0L7257 783Q7272 826 7291.5 887Q7311 948 7332 1015Q7351 1076 7368 1131Q7385 1076 7404 1015Q7425 948 7444.5 887Q7464 826 7478 783L7763 0L8145 0L8145 1490L7885 1490L7885 730Q7885 681 7886 616.5Q7887 552 7889.5 480.5Q7892 409 7894 335Q7894 321 7894 306Q7888 327 7881 348Q7857 426 7834 497.5Q7811 569 7791.5 628.5Q7772 688 7758 730L7474 1490L7258 1490L6972 730Q6958 688 6937.5 628.5Q6917 569 6894 497.5Q6871 426 6846 348Q6843 338 6839 328Q6839 332 6840 335Q6841 409 6843 480.5Q6845 552 6846 616.5Q6847 681 6847 730L6847 1490Z',
  ], // M
  [
    'M8855 1490L9387 0L9719 0L10249 1490L9958 1490L9839 1134L9261 1134L9139 1490Z',
    'M9767 917L9697 707Q9658 583 9615 443Q9587 352 9553 239Q9520 352 9492 443Q9448 583 9407 707L9335 917Z',
  ], // A
  ['M10681 229L10681 0L11872 0L11872 229L11410 229L11410 1490L11145 1490L11145 229Z'], // T
  [
    'M12616 1490L12616 0L13651 0L13651 229L12880 229L12880 621L13593 621L13593 846L12880 846L12880 1261L13651 1261L13651 1490Z',
  ], // E
]
const view = { x: 118, width: 13533, height: 1514 }

/** The wordmark's outline, for the lightning to trace. */
const charge = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.x} 0 ${view.width} ${view.height}" width="${view.width / 10}" height="${view.height / 10}"><path d="${letters.flat().join('')}" fill="#fff"/></svg>`,
)}`

/**
 * Lightning around the wordmark, in a box reaching past it so the glow has room. `level` drives it: how far the sweep
 * has reached and how strong it is. Theme colours: brand light in dark, brand ink in light.
 */
function Lightning({ level }: { level: () => Level }) {
  const theme = useStore((state) => state.ui.theme)
  return (
    <Electric
      arcs={0.25}
      bend={0.45}
      className="pointer-events-none absolute top-1/2 left-1/2 h-[400%] w-[120%] -translate-1/2"
      color={theme === 'dark' ? '#e4d6ff' : '#7b47bf'}
      crackle={1}
      flicker={0.3}
      glow={0.8}
      glowColor={theme === 'dark' ? '#bb9af4' : '#7b47bf'}
      bursts={() => level().bursts}
      presence={() => level().presence}
      reveal={() => level().reveal}
      scale={1 / 1.2}
      speed={2}
      src={charge}
      strands={3}
      theme={theme}
      thickness={1.3}
    />
  )
}

/**
 * The wordmark: drawn by lightning alone, or, `still` (reduced motion or no WebGL2), as solid letters. The SVG keeps
 * the wordmark's size either way.
 */
function Wordmark({ still, level }: { still: boolean; level: () => Level }) {
  return (
    <div className="relative">
      <svg
        aria-hidden="true"
        className="block w-full overflow-visible"
        viewBox={`${view.x} 0 ${view.width} ${view.height}`}
      >
        {still && <path className="fill-brand" d={letters.flat().join('')} />}
      </svg>
      {!still && <Lightning level={level} />}
      <div data-sweep="" hidden />
    </div>
  )
}

/** Whether the lightning can draw: WebGL2, asked once on a throwaway canvas. */
function canSpark() {
  const gl = document.createElement('canvas').getContext('webgl2')
  gl?.getExtension('WEBGL_lose_context')?.loseContext()
  return gl !== null
}

/** On screen at least this long, so a warm start does not flash. */
const minimum = { motion: 700, still: 400 }
/** Once ready, the rest of the drawing takes at most this long. */
const rush = 240
/** The lightning sweeps across the name for this long, then settles over as long again. */
const sweep = 900
/** Once swept, the lightning idles at this strength. */
const idle = 0.75
/** The first run's intro plays at this rate: the signature version. */
const signatureRate = 0.8

const out = 'cubic-bezier(0.22, 1, 0.36, 1)'
const inOut = 'cubic-bezier(0.45, 0, 0.25, 1)'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
const finished = (animations: readonly Animation[]) =>
  Promise.allSettled(animations.map((animation) => animation.finished))

/** The lightning's state: how far it has swept across the name (0 to 1) and how strong it is. */
interface Level {
  reveal: number
  presence: number
  /** 1 once the sweep has reached the end: the lightning bursts from the middle. */
  bursts: number
}

interface Show {
  /** The lightning, read every frame. */
  level(): Level
  /** Plays the first run's signature version: a slower intro in full, the rule drawn beneath. */
  signature(): void
  /** Settles the wordmark and fades the overlay into the app; true once it has gone, false when cancelled. */
  reveal(): Promise<boolean>
  cancel(): void
}

/**
 * Animates the splash in `overlay` with the Web Animations API: a clock drives the lightning's sweep across the name and
 * its settling. Held longer, a rule draws out beneath until the reveal. `still` (reduced
 * motion) shows the settled wordmark and only fades. `release` hands input back to the app as the overlay fades.
 */
function play(overlay: HTMLElement, still: boolean, release: () => void): Show {
  const started = performance.now()
  const find = (selector: string) => overlay.querySelector(selector)!
  /** The drawing: hurried along once the app is ready. */
  const intro: Animation[] = []
  /** The rule: not waited for. */
  const flair: Animation[] = []
  const exit: Animation[] = []
  let cancelled = false
  let signature = false
  let ruled = false
  let revealing: Promise<boolean> | undefined
  /** The reveal has begun: the show no longer changes. */
  let committed = false

  /** The sweep's clock: an invisible animation, so hurrying and the signature rate move the lightning too. */
  let clock: Animation | undefined
  if (!still) {
    clock = find('[data-sweep]').animate([{ opacity: 0 }, { opacity: 1 }], {
      delay: 60,
      duration: sweep * 2,
      fill: 'both',
    })
    intro.push(clock)
    // Still loading once all of it has played: the rule says so.
    // oxlint-disable-next-line typescript/no-floating-promises -- finished uses allSettled to consume animation cancellations; rule starts only a synchronous animation.
    void finished([...intro, ...flair]).then(() => {
      if (!committed) rule()
    })
  }

  function rule() {
    if (ruled || cancelled) return
    ruled = true
    flair.push(
      find('[data-rule]').animate(
        [
          { opacity: 0, transform: 'scaleX(0)' },
          { opacity: 1, transform: 'scaleX(1)' },
        ],
        { duration: 800, easing: out, fill: 'both' },
      ),
    )
  }

  /** Finishes the drawing within `rush` ms. */
  function hurry() {
    const remaining = Math.max(
      0,
      ...intro.map((animation) => {
        const end = Number(animation.effect?.getComputedTiming().endTime ?? 0)
        return (end - Number(animation.currentTime ?? 0)) / animation.playbackRate
      }),
    )
    if (remaining > rush)
      for (const animation of intro)
        animation.updatePlaybackRate((animation.playbackRate * remaining) / rush)
  }

  function cancel() {
    cancelled = true
    for (const animation of [...intro, ...flair, ...exit]) animation.cancel()
  }

  return {
    level() {
      const progress = clock?.effect?.getComputedTiming().progress ?? 0
      const settle = Math.max(0, progress * 2 - 1)
      return {
        reveal: Math.min(1, progress * 2),
        presence: idle + (1 - idle) * (1 - settle),
        bursts: progress >= 0.5 ? 1 : 0,
      }
    },
    signature() {
      if (signature || committed || still) return
      signature = true
      for (const animation of [...intro, ...flair]) animation.updatePlaybackRate(signatureRate)
      // oxlint-disable-next-line typescript/no-floating-promises -- finished uses allSettled to consume animation cancellations; rule starts only a synchronous animation.
      void finished(intro).then(() => rule())
    },
    reveal() {
      revealing ??= (async () => {
        // The first run's signature may still arrive meanwhile.
        const left = () => (still ? minimum.still : minimum.motion) - (performance.now() - started)
        while (left() > 0) await wait(left())
        if (cancelled) return false
        committed = true
        /** The app takes input from here on, as it comes up. */
        const handOver = () => {
          overlay.dataset.revealing = ''
          release()
        }
        // Nobody is watching: skip the show.
        if (document.hidden) {
          handOver()
          return true
        }
        if (signature) await finished(intro)
        else hurry()
        await finished(intro)
        if (cancelled) return false
        handOver()
        const mark = find('[data-mark]')
        const fade = [{ opacity: 1 }, { opacity: 0 }]
        if (still) exit.push(overlay.animate(fade, { duration: 180, fill: 'both' }))
        else if (signature)
          // Hands over to onboarding's first page: the name lifts away as the page beneath comes up.
          exit.push(
            mark.animate(
              [
                { opacity: 1, transform: 'none' },
                { opacity: 0, transform: 'translateY(-6%) scale(0.94)' },
              ],
              { duration: 560, easing: inOut, fill: 'both' },
            ),
            overlay.animate(fade, { delay: 140, duration: 640, easing: inOut, fill: 'both' }),
          )
        else
          exit.push(
            mark.animate(
              [
                { opacity: 1, transform: 'none', filter: 'blur(0)' },
                { opacity: 0, transform: 'scale(1.03)', filter: 'blur(4px)' },
              ],
              { duration: 380, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'both' },
            ),
            overlay.animate(fade, { delay: 80, duration: 460, easing: out, fill: 'both' }),
          )
        await finished(exit)
        return !cancelled
      })()
      return revealing
    },
    cancel,
  }
}

/** F5 and Ctrl/Cmd+R: reloading stays possible while the splash covers, for a load that hangs. */
const reloads = (event: KeyboardEvent) =>
  event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r')

/** Keeps a key from everything after it, its default action included, except the browser's reload. */
function swallow(event: KeyboardEvent) {
  event.stopImmediatePropagation()
  if (!reloads(event)) event.preventDefault()
}

/**
 * Keeps input from the app beneath while `overlay` covers it, a dialog included: the overlay holds focus and takes every
 * key before the app's own listeners (the shell starts its shortcuts after it, once ready). Focus the app asks for
 * meanwhile, such as the composer or a dialog's first button, is remembered; the returned release hands it back.
 */
function shield(overlay: HTMLElement) {
  let wanted = document.activeElement === document.body ? undefined : document.activeElement
  let holding = false
  const hold = (event: FocusEvent) => {
    // A dialog's focus trap may pull focus straight back: it wins, and its keys still stop here.
    if (holding || !(event.target instanceof Element) || overlay.contains(event.target)) return
    wanted = event.target
    holding = true
    overlay.focus({ preventScroll: true })
    holding = false
  }
  document.addEventListener('focusin', hold, true)
  window.addEventListener('keydown', swallow, true)
  window.addEventListener('keyup', swallow, true)
  overlay.focus({ preventScroll: true })
  let released = false
  return () => {
    if (released) return
    released = true
    document.removeEventListener('focusin', hold, true)
    window.removeEventListener('keydown', swallow, true)
    window.removeEventListener('keyup', swallow, true)
    if (wanted instanceof HTMLElement && wanted.isConnected) wanted.focus({ preventScroll: true })
  }
}

/**
 * `?splash` holds the splash on screen to polish it, automated browsers included, and a click replays it;
 * `?splash=first` plays the first run's signature version.
 */
const rehearsal = new URLSearchParams(location.search).get('splash')

/** The splash, played again on each click while rehearsing. */
function Overlay() {
  const [take, setTake] = useState(0)
  return (
    <Splash
      key={take}
      replay={rehearsal === null ? undefined : () => setTake((current) => current + 1)}
    />
  )
}

/** The ULTIMATE wordmark over the whole window until the page is ready, then the app. */
function Splash({ replay }: { replay?: () => void }) {
  const { ready, timedOut } = useReady()
  // Mounted once the page is ready, as on a very warm start or a hot reload, on a reload that shows the previous
  // page's view meanwhile, or driven by automation such as the agent's browser tool: nothing to show.
  const [gone, setGone] = useState(!replay && (ready || resumed || navigator.webdriver))
  const [still] = useState(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches || !canSpark(),
  )
  const overlay = useRef<HTMLDivElement>(null)
  const show = useRef<Show>(undefined)
  const level = () => show.current?.level() ?? { reveal: 0, presence: 0, bursts: 0 }

  useLayoutEffect(() => {
    if (!overlay.current) return undefined
    const release = shield(overlay.current)
    const current = play(overlay.current, still, release)
    show.current = current
    // The first run plays the signature version, then hands over to onboarding's first page.
    let active = true
    api.action(StatusAction).then(
      (status) => {
        if (active && (status.firstRun || rehearsal === 'first')) current.signature()
      },
      // Without onboarding there is no first run.
      () => {},
    )
    return () => {
      active = false
      current.cancel()
      release()
    }
  }, [still])

  useEffect(() => {
    if (gone || !ready || rehearsal !== null) return
    void show.current
      ?.reveal()
      .then((done) => {
        if (done) setGone(true)
      })
      .catch((error: unknown) => {
        store.notify({ level: 'error', message: errorMessage(error) })
        setGone(true)
      })
  }, [gone, ready])

  if (gone) return timedOut ? <Late /> : null
  return (
    <div
      aria-busy="true"
      aria-label="Loading Ultimate"
      aria-live="polite"
      // Takes the clicks itself, even under a modal dialog's `pointer-events: none` on the body.
      className="pointer-events-auto fixed inset-0 z-[60] grid place-items-center bg-background outline-none data-revealing:pointer-events-none"
      onClick={replay}
      ref={overlay}
      role="progressbar"
      tabIndex={-1}
    >
      <div className="relative w-[min(72vw,40rem)]" data-mark="">
        <Wordmark level={level} still={still} />
        <div
          className="relative mx-auto mt-[7%] h-px w-1/4 overflow-hidden bg-foreground/10 opacity-0"
          data-rule=""
        ></div>
      </div>
    </div>
  )
}

const names = (list: readonly string[]) =>
  list.map((name, index) => (
    <span key={name}>
      {index > 0 && ', '}
      <span className="text-foreground">{name}</span>
    </span>
  ))

/** After the timeout: what had not loaded, until it has or the notice is dismissed. */
function Late() {
  const { failed, pending } = useReady()
  const [dismissed, setDismissed] = useState(false)
  if (dismissed || (pending.length === 0 && failed.length === 0)) return null
  return (
    <div
      className="fixed top-12 left-1/2 z-40 flex w-96 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-start gap-2 rounded-md border border-border/80 bg-popover px-2.5 py-2 font-mono text-[11.5px] leading-snug shadow-lg"
      role="alert"
    >
      <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1 text-foreground/90">
        <p>Not ready after {timeout / 1000} s, so it opened anyway.</p>
        <p className="mt-0.5 text-muted-foreground">
          {pending.length > 0 && <>still loading: {names(pending)}. </>}
          {failed.length > 0 && <>failed: {names(failed)}. </>}
        </p>
      </div>
      <button
        aria-label="Dismiss"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => setDismissed(true)}
        type="button"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
}

export default defineWebExtension({ slots: { overlay: Overlay } })
