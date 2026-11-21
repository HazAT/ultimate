/** @jsxImportSource @solidjs/web */
import { For, Show, onSettled } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { CopyValue } from '@/components/ui/copy-value.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { Row, Rows } from '@/components/ui/rows.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import { cn, defineWebExtension, useExternal } from '@/sdk/solid'
import { byArea, enabled, ignored, metrics, record, reset, topHot } from './recorder.ts'
import type { Metrics } from './recorder.ts'

function flashIn(layer: HTMLElement) {
  return (element: Element) => {
    const box = element.getBoundingClientRect()
    if (box.width === 0 && box.height === 0) return
    const outline = document.createElement('div')
    outline.className = 'fixed rounded-[2px] border border-rose-500/90 bg-rose-500/10'
    Object.assign(outline.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    })
    layer.append(outline)
    outline.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 800,
      easing: 'ease-out',
    }).onfinish = () => outline.remove()
  }
}

function Flashes() {
  const on = useExternal(enabled.get, enabled.subscribe)
  return (
    <Show when={on()}>
      <div
        aria-hidden="true"
        class="pointer-events-none fixed inset-0 z-[2147483647]"
        ref={(layer) => {
          onSettled(() =>
            record({
              root: document.body,
              frame: (paint) => requestAnimationFrame(paint),
              flash: flashIn(layer),
            }),
          )
        }}
        {...{ [ignored]: '' }}
      />
    </Show>
  )
}

const seconds = (current: Metrics) =>
  Math.max(1, Math.round((performance.now() - current.since) / 1000))

const total = (current: Metrics) => Object.values(current.writes).reduce((a, b) => a + b, 0)

function summary(current: Metrics) {
  const areas = byArea(current).map(([area, count]) => `${area} ${count}`)
  const hot = topHot(current).map((entry) => `${entry.name} ×${entry.writes}`)
  return [
    `redraws over ${seconds(current)}s: ${total(current)} node writes in ${current.frames} frames (busiest ${current.busiestFrame})`,
    `by area: ${areas.join(', ') || 'none'}`,
    `long frames: ${current.longFrames}${current.longFrames ? `, worst ${Math.round(current.worstFrameMs)}ms` : ''}`,
    `hottest: ${hot.join('; ') || 'none'}`,
  ].join('\n')
}

const footerButton =
  'font-[family-name:inherit] text-[length:inherit] font-normal hover:text-foreground'

function Chip() {
  const on = useExternal(enabled.get, enabled.subscribe)
  const current = useExternal(metrics.get, metrics.subscribe)
  const areas = () => byArea(current())
  return (
    <Show when={on()}>
      <span class="flex items-center" {...{ [ignored]: '' }}>
        <Popover>
          <StatusPopoverTrigger aria-label="Redraws" class="text-rose-400">
            <span class="size-1.5 rounded-full bg-rose-500" />
            redraws {total(current())}
          </StatusPopoverTrigger>
          <PopoverContent
            align="end"
            class="w-80 space-y-2 p-2 font-mono"
            side="top"
            {...{ [ignored]: '' }}
          >
            <Rows>
              <Row label="window">
                {seconds(current())}s · {current().frames} frames
              </Row>
              <For each={areas()} keyed={(entry) => entry[0]}>
                {(entry) => <Row label={entry()[0]}>{entry()[1]} writes</Row>}
              </For>
              <Row label="long frames">
                {current().longFrames}
                {current().longFrames ? ` · worst ${Math.round(current().worstFrameMs)}ms` : ''}
              </Row>
            </Rows>
            <Show when={topHot(current()).length > 0}>
              <div class="space-y-0.5 border-t border-border/70 pt-1.5 text-[11px] text-muted-foreground">
                <For each={topHot(current())} keyed={(entry) => entry.id}>
                  {(entry) => (
                    <div class="flex gap-2">
                      <span class="min-w-0 flex-1 truncate">{entry().name}</span>
                      <span class="text-foreground/80">×{entry().writes}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <div class="flex items-center gap-3 border-t border-border/70 pt-1.5 text-[11px] text-muted-foreground">
              <CopyValue field="redraw metrics" value={summary(current())}>
                copy
              </CopyValue>
              <Button
                aria-label="Reset redraw counts"
                class={footerButton}
                onClick={reset}
                size={null}
                variant={null}
              >
                reset
              </Button>
              <Button
                aria-label="Stop showing redraws"
                class={cn(footerButton, 'ml-auto')}
                onClick={() => enabled.set(false)}
                size={null}
                variant={null}
              >
                stop
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </span>
    </Show>
  )
}

export default defineWebExtension({
  slots: {
    overlay: [Flashes],
    'statusline.right': [{ component: Chip, order: -2 }],
  },
  commands: [
    {
      id: 'redraws.toggle',
      title: 'Show redraws',
      group: 'Ultimate',
      run: () => enabled.set(!enabled.get()),
    },
  ],
})
