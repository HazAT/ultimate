export function linkedConversation(url: URL, navigation: string | undefined) {
  return (
    navigation === 'navigate' &&
    url.searchParams.has('conversation') &&
    !url.searchParams.has('inbox')
  )
}
