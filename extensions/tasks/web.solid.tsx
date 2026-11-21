/** @jsxImportSource @solidjs/web */
import { ListTreeIcon } from '@lucide/solid'
import type { TaskId } from '@earendil-works/pi-durable'
import type { Accessor } from 'solid-js'
import { createMemo } from 'solid-js'
import { defineWebExtension, provide, RunStart, useAction } from '@/sdk/solid'
import { TasksPanel } from './panel.solid.tsx'
import { StartedAction } from './refs.ts'

function runStart(task: Accessor<TaskId | undefined>) {
  const read = createMemo(() => {
    const id = task()
    if (id === undefined) return () => undefined
    const { data } = useAction(StartedAction, { ids: [id] })
    return () => data()?.[id]
  })
  return () => read()()
}

export default defineWebExtension({
  provides: [provide(RunStart, runStart)],
  panels: [{ id: 'tasks', title: 'Tasks', icon: ListTreeIcon, component: TasksPanel, order: 1 }],
  commands: [
    {
      id: 'tasks.open',
      title: 'Show the task graph',
      run: (context) => context.openPanel('tasks'),
    },
  ],
})
