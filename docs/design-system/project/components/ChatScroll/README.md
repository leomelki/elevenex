# ChatScroll

The chat's scrolling area. Messages and replies are always shown in full, so a long reply can push your message out of view. While you read that reply, **your message stays pinned at the top** as a reminder of what it answers: “You asked”, the first two lines, **Back to your message** (↑, or click the text) and **Hide**.

- It follows the exchange you're reading: scroll up into an older reply and it shows that reply's message; once the next message reaches the upper part of the view, it goes.
- Back scrolls smoothly to the message and rings it once.
- Hide dismisses it for that message; the next exchange gets its reminder again.
- It slides down 8px and fades in, leaves on `ease-in`, and the text blurs in when the exchange changes. On first paint it's simply there.
- The chat opens scrolled to its latest message (`startAtEnd`, default true) and, while you're at the bottom, follows what arrives as it grows. Scroll up and it stays where you are (`NewMessagesPill` offers the way down).

**Provide:** the chat's messages and turns as children (give user `Message`s an `id`), `innerClassName` (`ex-shell-chat` in the app), optional `reminder: false`, `startAtEnd`.

- Don't clamp messages or replies with “Show more”; the pin is the only shortened copy, and it's a reminder, not the message.

The card scrolls on its own: into the long reply (the reminder shows), on to the next question (it goes), and back.
