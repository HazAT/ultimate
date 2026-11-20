import { ListTodoIcon } from 'lucide-react'
import { defineWebExtension, island } from '@/sdk'
import { Waiting } from '../inbox/ui.tsx'
import { TodoCall } from './call.tsx'
import { TodoList } from './panel.solid.tsx'

const ModelOnlyTodoReminder = () => null
const List = island(TodoList)

function Todos() {
  return <Waiting>{(entries) => <List inbox={entries.length} />}</Waiting>
}

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
