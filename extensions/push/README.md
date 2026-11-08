Push: Web Push notifications to a phone or desktop browser, useful without opening the app. Off by default; turn it on
with `extensions.enable: ["push"]` in user or project settings.

## What pushes

- **A question waiting on you:** any reply-expected `message` to the user, titled by the asking conversation, the
  question as its text. It has an inline **Reply** (Chrome's text action) and, when every question has a recommended
  answer (or is a yes/no confirmation), **Approve**, which sends those answers. Both call `questions/answer` from the
  service worker without opening the app; a failure replaces the notification with the reason. Answering on any card
  closes the notification on open devices.
- **A landing** (`workspaces.landed`).
- **@ultimate's failed run**, read from the conversation overview as the sounds do (`extensions/sounds/cues.ts`).

A browser that reported the app on screen in the last 15 s gets nothing. Tapping a notification opens its
conversation, a question's at the question.

## Setup

The status line's **notify** bell turns notifications on for this browser (it asks for permission), sends a test and
says why it cannot. On Android, install the app first (Chrome ⋮ → Install app): only an installed app keeps receiving.
Each origin (host and port) is its own installed app with its own subscription, so a project or preview on another
port is subscribed separately.

The VAPID key is the user-global secret `WEB_PUSH_VAPID_KEY`, made on first use; deleting it in Secrets rotates it,
and every browser must turn notifications on again. Subscriptions (endpoint, keys, origin) live in the private
`push.subscriptions` document on the root, never sent to the page. A push service's 404 or 410 drops the
subscription; other failures become notices. Encryption (RFC 8291) and VAPID signing use `node:crypto`.

## Service worker

`web/public/sw.js`, registered by the always-on `share` extension, shows the pushes and handles the actions. It caches
nothing and handles no fetch but the share target's POST, so a reload still lands on the newest bundle.

Adapted from mjaverto/ultimate's notifications extension (MIT, https://github.com/mjaverto/ultimate).
