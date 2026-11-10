import { ListTodoIcon } from 'lucide-react'
import { defineWebExtension } from '@/sdk'
import { TodoCall } from './call.tsx'
import { Todos } from './panel.tsx'

export default defineWebExtension({
  messages: { ja: { 'Show to-dos': 'ToDo を表示' } },
  tools: { todo: TodoCall },
  // @ultimate's changed-list reminder is model context, not something to read in the transcript.
  entries: { 'todos.note': () => null },
  panels: [{ id: 'todos', title: 'To-dos', icon: ListTodoIcon, component: Todos, order: 0 }],
  commands: [
    {
      id: 'todos.open',
      title: 'Show to-dos',
      run: (context) => context.openPanel('todos'),
    },
  ],
})
