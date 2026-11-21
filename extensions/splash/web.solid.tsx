/** @jsxImportSource @solidjs/web */
import { TriangleAlertIcon, XIcon } from '@lucide/solid'
import { createEffect, createSignal, For, onSettled, Show, untrack } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { api, defineWebExtension, errorMessage, notify, useReady, useStore } from '@/sdk/solid'
import { resumed } from '@/sdk/resume.ts'
import { meansNone } from '../../lib/errors.ts'
import { pace } from '../../lib/timers.ts'
import { StatusAction } from '../onboarding/refs.ts'
import { Electric } from './electric.solid.tsx'

const readinessDeadlineMs = 8000

type GlyphContours = readonly string[]
type WordmarkContours = readonly [
  U: GlyphContours,
  L: GlyphContours,
  T: GlyphContours,
  I: GlyphContours,
  M: GlyphContours,
  A: readonly [outline: string, counter: string],
  T: GlyphContours,
  E: GlyphContours,
]

const interSemiboldContours: WordmarkContours = [
  [
    'M721 1514Q539 1514 403.5 1445Q268 1376 193 1254.5Q118 1133 118 975L118 0L379 0L379 954Q379 1049 421 1122.5Q463 1196 539.5 1238Q616 1280 721 1280Q826 1280 902.5 1238Q979 1196 1020.5 1122.5Q1062 1049 1062 954L1062 0L1323 0L1323 975Q1323 1134 1248.5 1255.5Q1174 1377 1038.5 1445.5Q903 1514 721 1514Z',
  ],
  ['M2138 1490L2138 0L2402 0L2402 1261L3093 1261L3093 1490Z'],
  ['M3567 229L3567 0L4758 0L4758 229L4296 229L4296 1490L4031 1490L4031 229Z'],
  ['M5766 0L5766 1490L5502 1490L5502 0Z'],
  [
    'M6587 1490L6587 0L6967 0L7257 783Q7272 826 7291.5 887Q7311 948 7332 1015Q7351 1076 7368 1131Q7385 1076 7404 1015Q7425 948 7444.5 887Q7464 826 7478 783L7763 0L8145 0L8145 1490L7885 1490L7885 730Q7885 681 7886 616.5Q7887 552 7889.5 480.5Q7892 409 7894 335Q7894 321 7894 306Q7888 327 7881 348Q7857 426 7834 497.5Q7811 569 7791.5 628.5Q7772 688 7758 730L7474 1490L7258 1490L6972 730Q6958 688 6937.5 628.5Q6917 569 6894 497.5Q6871 426 6846 348Q6843 338 6839 328Q6839 332 6840 335Q6841 409 6843 480.5Q6845 552 6846 616.5Q6847 681 6847 730L6847 1490Z',
  ],
  [
    'M8855 1490L9387 0L9719 0L10249 1490L9958 1490L9839 1134L9261 1134L9139 1490Z',
    'M9767 917L9697 707Q9658 583 9615 443Q9587 352 9553 239Q9520 352 9492 443Q9448 583 9407 707L9335 917Z',
  ],
  ['M10681 229L10681 0L11872 0L11872 229L11410 229L11410 1490L11145 1490L11145 229Z'],
  [
    'M12616 1490L12616 0L13651 0L13651 229L12880 229L12880 621L13593 621L13593 846L12880 846L12880 1261L13651 1261L13651 1490Z',
  ],
]
const fontUnitsYDownBounds = { x: 118, width: 13533, height: 1514 }

const wordmarkAlphaImage = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fontUnitsYDownBounds.x} 0 ${fontUnitsYDownBounds.width} ${fontUnitsYDownBounds.height}" width="${fontUnitsYDownBounds.width / 10}" height="${fontUnitsYDownBounds.height / 10}"><path d="${interSemiboldContours.flat().join('')}" fill="#fff"/></svg>`,
)}`

function Lightning(props: { level: () => Level }) {
  const theme = useStore((state) => state.ui.theme)
  return (
    <Electric
      edgeArcRate={0.25}
      bend={0.45}
      class="pointer-events-none absolute top-1/2 left-1/2 h-[400%] w-[120%] -translate-1/2"
      color={theme() === 'dark' ? '#e4d6ff' : '#7b47bf'}
      crackle={1}
      flicker={0.3}
      glow={0.8}
      glowColor={theme() === 'dark' ? '#bb9af4' : '#7b47bf'}
      burstCount={() => props.level().bursts}
      presence={() => props.level().presence}
      sweepLeftToRight={() => props.level().reveal}
      containerSizeFraction={1 / 1.2}
      speed={2}
      alphaImageSrc={wordmarkAlphaImage}
      outlineFilaments={3}
      theme={theme()}
      strandWidthPx={1.3}
    />
  )
}

function Wordmark(props: { still: boolean; level: () => Level }) {
  return (
    <div class="relative">
      <svg
        aria-hidden="true"
        class="block w-full overflow-visible"
        viewBox={`${fontUnitsYDownBounds.x} 0 ${fontUnitsYDownBounds.width} ${fontUnitsYDownBounds.height}`}
      >
        <Show when={props.still}>
          <path class="fill-brand" d={interSemiboldContours.flat().join('')} />
        </Show>
      </svg>
      <Show when={!props.still}>
        <Lightning level={props.level} />
      </Show>
      <div data-sweep="" hidden />
    </div>
  )
}

function canTraceWithWebGL2() {
  const gl = document.createElement('canvas').getContext('webgl2')
  gl?.getExtension('WEBGL_lose_context')?.loseContext()
  return gl !== null
}

const minVisibleMsByMotion = { motion: 700, still: 400 }
const readyDrawMs = 240
const lightningSweepMs = 900
const settledStrength = 0.75
const firstRunPlaybackRate = 0.8

const out = 'cubic-bezier(0.22, 1, 0.36, 1)'
const inOut = 'cubic-bezier(0.45, 0, 0.25, 1)'

const finished = (animations: readonly Animation[]) =>
  Promise.allSettled(animations.map((animation) => animation.finished))

interface Level {
  reveal: number
  presence: number
  bursts: 0 | 1
}

interface Show {
  level(): Level
  signature(): void
  reveal(): Promise<boolean>
  cancel(): void
}

function play(overlay: HTMLElement, still: boolean, release: () => void): Show {
  const started = performance.now()
  const find = (selector: string) => overlay.querySelector(selector)!

  const awaitedIntro: Animation[] = []
  const unawaitedRule: Animation[] = []
  const exit: Animation[] = []
  let cancelled = false
  let signature = false
  let ruled = false
  let revealing: Promise<boolean> | undefined
  let revealCommitted = false
  let invisibleSweepClock: Animation | undefined
  if (!still) {
    invisibleSweepClock = find('[data-sweep]').animate([{ opacity: 0 }, { opacity: 1 }], {
      delay: 60,
      duration: lightningSweepMs * 2,
      fill: 'both',
    })
    awaitedIntro.push(invisibleSweepClock)

    void finished([...awaitedIntro, ...unawaitedRule]).then(() => {
      if (!revealCommitted) drawStillLoadingRule()
    })
  }

  function drawStillLoadingRule() {
    if (ruled || cancelled) return
    ruled = true
    unawaitedRule.push(
      find('[data-rule]').animate(
        [
          { opacity: 0, transform: 'scaleX(0)' },
          { opacity: 1, transform: 'scaleX(1)' },
        ],
        { duration: 800, easing: out, fill: 'both' },
      ),
    )
  }

  function rushDrawing() {
    const remaining = Math.max(
      0,
      ...awaitedIntro.map((animation) => {
        const end = Number(animation.effect?.getComputedTiming().endTime ?? 0)
        return (end - Number(animation.currentTime ?? 0)) / animation.playbackRate
      }),
    )
    if (remaining > readyDrawMs)
      for (const animation of awaitedIntro)
        animation.updatePlaybackRate((animation.playbackRate * remaining) / readyDrawMs)
  }

  function cancel() {
    cancelled = true
    for (const animation of [...awaitedIntro, ...unawaitedRule, ...exit]) animation.cancel()
  }

  return {
    level() {
      const progress = invisibleSweepClock?.effect?.getComputedTiming().progress ?? 0
      const settle = Math.max(0, progress * 2 - 1)
      return {
        reveal: Math.min(1, progress * 2),
        presence: settledStrength + (1 - settledStrength) * (1 - settle),
        bursts: progress >= 0.5 ? 1 : 0,
      }
    },
    signature() {
      if (cancelled || signature || revealCommitted || still) return
      signature = true
      for (const animation of [...awaitedIntro, ...unawaitedRule])
        animation.updatePlaybackRate(firstRunPlaybackRate)
      void finished(awaitedIntro).then(() => drawStillLoadingRule())
    },
    reveal() {
      revealing ??= (async () => {
        const minimumRemainingMs = () =>
          (still ? minVisibleMsByMotion.still : minVisibleMsByMotion.motion) -
          (performance.now() - started)
        while (minimumRemainingMs() > 0) await pace(minimumRemainingMs())
        if (cancelled) return false
        revealCommitted = true

        const releaseAppInput = () => {
          overlay.dataset.revealing = ''
          release()
        }

        if (document.hidden) {
          releaseAppInput()
          return true
        }
        if (signature) await finished(awaitedIntro)
        else rushDrawing()
        await finished(awaitedIntro)
        if (cancelled) return false
        releaseAppInput()
        const mark = find('[data-mark]')
        const fade = [{ opacity: 1 }, { opacity: 0 }]
        if (still) exit.push(overlay.animate(fade, { duration: 180, fill: 'both' }))
        else if (signature)
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

const isBrowserReload = (event: KeyboardEvent) =>
  event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r')

function blockAppKeys(event: KeyboardEvent) {
  event.stopImmediatePropagation()
  if (!isBrowserReload(event)) event.preventDefault()
}

function guardAppInput(overlay: HTMLElement) {
  let requestedAppFocus =
    document.activeElement === document.body ? undefined : document.activeElement
  let redirectingFocus = false
  const hold = (event: FocusEvent) => {
    if (redirectingFocus || !(event.target instanceof Element) || overlay.contains(event.target))
      return
    requestedAppFocus = event.target
    redirectingFocus = true
    overlay.focus({ preventScroll: true })
    redirectingFocus = false
  }
  document.addEventListener('focusin', hold, true)
  window.addEventListener('keydown', blockAppKeys, true)
  window.addEventListener('keyup', blockAppKeys, true)
  overlay.focus({ preventScroll: true })
  let released = false
  return () => {
    if (released) return
    released = true
    document.removeEventListener('focusin', hold, true)
    window.removeEventListener('keydown', blockAppKeys, true)
    window.removeEventListener('keyup', blockAppKeys, true)
    if (requestedAppFocus instanceof HTMLElement && requestedAppFocus.isConnected)
      requestedAppFocus.focus({ preventScroll: true })
  }
}

const splashReplayMode = new URLSearchParams(location.search).get('splash')

function Overlay() {
  const ready = useReady()
  const [gone, setGone] = createSignal(
    splashReplayMode === null && (untrack(() => ready().ready) || resumed || navigator.webdriver),
  )
  const [take, setTake] = createSignal(1)
  return (
    <Show
      when={!gone()}
      fallback={
        <Show when={ready().timedOut}>
          <Late />
        </Show>
      }
    >
      <For each={[take()]}>
        {() => (
          <Playback onDone={() => setGone(true)} onReplay={() => setTake((count) => count + 1)} />
        )}
      </For>
    </Show>
  )
}

function Playback(props: { onDone: () => void; onReplay: () => void }) {
  const ready = useReady()
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches || !canTraceWithWebGL2()
  let overlay: HTMLDivElement | undefined
  const [show, setShow] = createSignal<Show>()
  const level = (): Level => show()?.level() ?? { reveal: 0, presence: 0, bursts: 0 }

  onSettled(() => {
    if (!overlay) return undefined
    const release = guardAppInput(overlay)
    const current = play(overlay, still, release)
    setShow(current)
    const replay = () => props.onReplay()
    if (splashReplayMode !== null) overlay.addEventListener('click', replay)
    if (splashReplayMode === 'first') current.signature()
    void api.action(StatusAction).then((status) => {
      if (status.firstRun) current.signature()
    }, meansNone)
    return () => {
      overlay?.removeEventListener('click', replay)
      current.cancel()
      release()
    }
  })

  createEffect(
    () => (splashReplayMode === null && ready().ready ? show() : undefined),
    (current) => {
      if (!current) return
      void current
        .reveal()
        .then((done) => {
          if (done) props.onDone()
        })
        .catch((error: unknown) => {
          notify({ level: 'error', message: errorMessage(error) })
          props.onDone()
        })
    },
  )

  return (
    <div
      class="pointer-events-auto fixed inset-0 z-[60] grid place-items-center bg-background outline-none data-revealing:pointer-events-none"
      data-splash=""
      ref={overlay}
      tabindex={-1}
    >
      <progress aria-busy="true" aria-label="Loading Ultimate" aria-live="polite" class="sr-only" />
      <div class="relative w-[min(72vw,40rem)]" data-mark="" aria-hidden="true">
        <Wordmark level={level} still={still} />
        <div
          class="relative mx-auto mt-[7%] h-px w-1/4 overflow-hidden bg-foreground/10 opacity-0"
          data-rule=""
        />
      </div>
    </div>
  )
}

function Names(props: { list: readonly string[] }) {
  return (
    <For each={props.list}>
      {(name, index) => (
        <span>
          {index() > 0 && ', '}
          <span class="text-foreground">{name}</span>
        </span>
      )}
    </For>
  )
}

function Late() {
  const ready = useReady()
  const [dismissed, setDismissed] = createSignal(false)
  return (
    <Show when={!dismissed() && (ready().pending.length || ready().failed.length)}>
      <div
        class="fixed top-12 left-1/2 z-40 flex w-96 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-start gap-2 rounded-md border border-border/80 bg-popover px-2.5 py-2 font-mono text-[11.5px] leading-snug shadow-lg"
        role="alert"
      >
        <TriangleAlertIcon class="mt-px size-3.5 shrink-0 text-warning" />
        <div class="min-w-0 flex-1 text-foreground/90">
          <p>Not ready after {readinessDeadlineMs / 1000} s, so it opened anyway.</p>
          <p class="mt-0.5 text-muted-foreground">
            <Show when={ready().pending.length}>
              still loading: <Names list={ready().pending} />.{' '}
            </Show>
            <Show when={ready().failed.length}>
              failed: <Names list={ready().failed} />.{' '}
            </Show>
          </p>
        </div>
        <Button
          aria-label="Dismiss slow loading notice"
          size={null}
          variant={null}
          class="shrink-0 text-muted-foreground/60 hover:text-foreground"
          onClick={() => setDismissed(true)}
        >
          <XIcon class="size-3.5" />
        </Button>
      </div>
    </Show>
  )
}

export default defineWebExtension({ slots: { overlay: Overlay } })
