/** @jsxImportSource @solidjs/web */
import { ListTodoIcon } from '@lucide/solid'
import { defineWebExtension } from '@/sdk/solid'
import { TodoCall } from './call.solid.tsx'
import { ModelOnlyTodoReminder } from './note.solid.tsx'
import { TodoList } from './panel.solid.tsx'

export default defineWebExtension({
  tools: { todo: TodoCall },
  entries: { 'todos.note': ModelOnlyTodoReminder },
  panels: [{ id: 'todos', title: 'To-dos', icon: ListTodoIcon, component: TodoList, order: 0 }],
  commands: [
    {
      id: 'todos.open',
      title: 'Show to-dos',
      run: (context) => context.openPanel('todos'),
    },
  ],
})
