/** @jsxImportSource @solidjs/web */
import { ChartNoAxesCombinedIcon } from '@lucide/solid'
import { Conversation, Dock, Header, StatusLine, defineWebExtension } from '@/sdk/solid'
import { Progress } from './progress.solid.tsx'

function Surface() {
  return (
    <>
      <Header>
        <span class="text-[13px]">Solid migration</span>
      </Header>
      <div class="flex min-h-0 flex-1">
        <main class="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          <Progress />
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
