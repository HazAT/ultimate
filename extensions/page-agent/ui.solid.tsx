/** The page agent for other extensions' browser code: this page's id, which names it as the page that runs a conversation's `ui` requests. */

/** This page's id for its life; pass it where a request should run on this page (what `PageAgentPages.pageFor` returns). */
export const pageId = crypto.randomUUID()
