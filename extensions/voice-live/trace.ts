import { cell } from '../../lib/cell.ts'

export type StageKey = 'mic' | 'transcribe' | 'send' | 'model' | 'thinking' | 'voice'
export type StageStatus = 'idle' | 'running' | 'done' | 'skipped' | 'failed' | 'slow'
export type Stage = {
  key: StageKey
  label: string
  status: StageStatus
  detail: string
  since?: number
  ms?: number
}

const SLOW_MS: Partial<Record<StageKey, number>> = {
  transcribe: 1500,
  send: 800,
  model: 4000,
  thinking: 8000,
  voice: 800,
}

export function createTrace(keys: StageKey[], labels: Partial<Record<StageKey, string>> = {}) {
  const born = Date.now()
  const stages = cell<Stage[]>(
    keys.map((key) => ({ key, label: labels[key] ?? key, status: 'idle', detail: '·' })),
    { notifyOnEqual: true },
  )
  const total = cell<string | undefined>(undefined)
  const update = (key: StageKey, change: (stage: Stage) => Stage) =>
    stages.set(stages.get().map((stage) => (stage.key === key ? change(stage) : stage)))
  const current = () => stages.get().find((stage) => stage.status === 'running')
  return {
    born,
    stages,
    total,
    start(key: StageKey) {
      const running = current()
      if (running && running.key !== key) this.done(running.key)
      update(key, (stage) => ({ ...stage, status: 'running', since: Date.now(), detail: '' }))
    },
    detail(key: StageKey, detail: string) {
      update(key, (stage) => ({ ...stage, detail }))
    },
    done(key: StageKey, detail?: string) {
      update(key, (stage) => {
        if (stage.status !== 'running') return detail ? { ...stage, detail } : stage
        const ms = Date.now() - (stage.since ?? Date.now())
        return {
          ...stage,
          ms,
          status: ms > (SLOW_MS[key] ?? Infinity) ? 'slow' : 'done',
          detail: detail ?? '',
        }
      })
    },
    record(key: StageKey, ms: number) {
      update(key, (stage) => ({ ...stage, status: 'done', ms, detail: '' }))
    },
    drop(key: StageKey) {
      stages.set(stages.get().filter((stage) => stage.key !== key))
    },
    skip(key: StageKey, detail: string) {
      const running = current()
      if (running && running.key !== key) this.done(running.key)
      update(key, (stage) => ({ ...stage, status: 'skipped', detail }))
    },
    fail(detail: string) {
      const running = current()
      if (running) update(running.key, (stage) => ({ ...stage, status: 'failed', detail }))
    },
    finish(text: string) {
      const running = current()
      if (running) this.done(running.key)
      total.set(text)
    },
    label(key: StageKey, label: string) {
      update(key, (stage) => ({ ...stage, label }))
    },
  }
}

export type Trace = ReturnType<typeof createTrace>
