import { ListTodoIcon } from 'lucide-react'
import { defineWebExtension } from '@/sdk'
import { TodoCall } from './call.tsx'
import { Todos } from './panel.tsx'

const ModelOnlyTodoReminder = () => null

export default defineWebExtension({
  tools: { todo: TodoCall },
  entries: { 'todos.note': ModelOnlyTodoReminder },
  panels: [{ id: 'todos', title: 'To-dos', icon: ListTodoIcon, component: Todos, order: 0 }],
  commands: [
    {
      id: 'todos.open',
      title: 'Show to-dos',
      run: (context) => context.openPanel('todos'),
    },
  ],
})
