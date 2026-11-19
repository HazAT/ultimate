import { ChartNoAxesCombinedIcon } from 'lucide-react'
import { Conversation, Dock, Header, StatusLine, defineWebExtension, island } from '@/sdk'
import { Progress } from './progress.solid.tsx'

const Body = island(Progress)

function Surface() {
  return (
    <>
      <Header>
        <span className="text-[13px]">Solid migration</span>
      </Header>
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          <Body />
        </main>
        <Dock>
          <Conversation variant="dock" />
        </Dock>
      </div>
      <StatusLine />
    </>
  )
}

export default defineWebExtension({
  surfaces: [
    {
      id: 'solid-progress',
      title: 'Solid',
      icon: ChartNoAxesCombinedIcon,
      description: 'How far the Solid 2 migration has come, step by step (temporary)',
      order: 90,
      component: Surface,
    },
  ],
})
