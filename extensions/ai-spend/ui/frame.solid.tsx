import { CoinsIcon } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { Conversation, Dock, Header, StatusLine } from '@/sdk/solid'

export function SpendTitle() {
  return (
    <span class="flex shrink-0 items-center gap-2 text-[13px] font-medium">
      <CoinsIcon class="size-4 text-muted-foreground" />
      Spend
    </span>
  )
}

export function SpendFrame(props: { header: JSX.Element; children: JSX.Element }) {
  return (
    <>
      <div class="flex min-h-0 flex-1">
        <main class="flex min-w-0 flex-1 flex-col">
          <Header>{props.header}</Header>
          {props.children}
        </main>
        <Dock>
          <Conversation variant="dock" />
        </Dock>
      </div>
      <StatusLine />
    </>
  )
}
