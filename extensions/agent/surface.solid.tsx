import { Conversation, Header, Panels, Sidebar, StatusLine } from '@/sdk/solid'

export function Agent() {
  return (
    <>
      <div class="flex min-h-0 flex-1">
        <Sidebar />
        <main class="flex min-w-0 flex-1 flex-col">
          <Header />
          <Conversation />
        </main>
        <Panels />
      </div>
      <StatusLine />
    </>
  )
}
