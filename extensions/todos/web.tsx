import { ListTodoIcon } from 'lucide-react'
import { defineWebExtension, island } from '@/sdk'
import { TodoCall } from './call.solid.tsx'
import { ModelOnlyTodoReminder } from './note.solid.tsx'
import { TodoList } from './panel.solid.tsx'

export default defineWebExtension({
  tools: { todo: island(TodoCall) },
  entries: { 'todos.note': island(ModelOnlyTodoReminder) },
  panels: [
    { id: 'todos', title: 'To-dos', icon: ListTodoIcon, component: island(TodoList), order: 0 },
  ],
  commands: [
    {
      id: 'todos.open',
      title: 'Show to-dos',
      run: (context) => context.openPanel('todos'),
    },
  ],
})
