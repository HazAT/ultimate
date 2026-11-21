Browser video: records opted-in browser steps on an isolated synthetic demo and plays the private clip in the transcript, review question, Inbox, and landing card.

Use `browser_video` instead of `browser` when motion matters. Pass the exact returned ID as `message.video` on a reply-expected message to the user. Only successful recordings from the sending conversation can be attached; the question and its Inbox detail play that clip, not the latest one. The existing screenshot Reel is unchanged. A landing card lists recent clips from its branch.

Record synthetic data only, never a personal session or real user data. Clips live in the host's private `browser-videos` directory and play through its same-origin, admitted API. No video requests are made until Play. The clip is not published to Git or to a public URL. Deleting its local file makes it unavailable in existing cards.
