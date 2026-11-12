/**
 * Whether this page load is a link to a conversation (`?conversation=<id>`) from outside: a phone app's WebView, a
 * notification, another project's fleet rail, a shared link. Such a link shows the conversation, so it brings the
 * agent surface along. The page writes `?conversation=` into its own address too, so a reload (F5, a bundle switch's
 * `location.reload()`) or a history step carries it and must keep the surface the user was on: only a `navigate` load
 * is a link. `?inbox=<key>` names the Inbox, which wins (`extensions/inbox/web.tsx`).
 */
export function linkedConversation(url: URL, navigation: string | undefined) {
  return (
    navigation === 'navigate' &&
    url.searchParams.has('conversation') &&
    !url.searchParams.has('inbox')
  )
}
