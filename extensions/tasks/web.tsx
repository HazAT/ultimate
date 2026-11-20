import { ListTreeIcon } from 'lucide-react'
import { defineWebExtension, island, provide, RunStart, useAction } from '@/sdk'
import { TasksPanel } from './panel.solid.tsx'
import { StartedAction } from './refs.ts'

function useRunStart(id: number | undefined): number | undefined {
  const { data } = useAction(
    StartedAction,
    { ids: id === undefined ? [] : [id] },
    { enabled: id !== undefined },
  )
  return id === undefined ? undefined : data?.[id]
}

export default defineWebExtension({
  provides: [provide(RunStart, useRunStart)],
  panels: [
    { id: 'tasks', title: 'Tasks', icon: ListTreeIcon, component: island(TasksPanel), order: 1 },
  ],
  commands: [
    {
      id: 'tasks.open',
      title: 'Show the task graph',
      run: (context) => context.openPanel('tasks'),
    },
  ],
})
