# Images and videos in chat

Agents can embed video files using Markdown image syntax or a Markdown link:

```markdown
![Demo](clips/demo.mp4)
[Recording](clips/demo.webm)
```

HTML video markup is also supported, including multiple sources and a poster:

```html
<video controls poster="clips/poster.png">
  <source src="clips/demo.mp4" type="video/mp4" />
  <source src="clips/demo.webm" type="video/webm" />
</video>
```

Relative paths resolve inside the session worktree (or relative to the document
when viewing a Markdown file). In chat, absolute paths anywhere on the agent’s
computer, `~/` paths, `file://` URLs, and parent-relative paths outside the checkout work too. Remote HTTP/HTTPS
URLs are also supported. Repository documents keep their root-relative link
convention. Local media fragments such as `demo.mp4#t=2,5` are preserved. Local files stream with byte-range support for seeking.

Markdown references ending in `.mp4`, `.webm`, `.ogv`, `.mov`, or `.m4v` become
players. HTML `<video>` can reference other URLs without a file extension.
Playback depends on the browser's codec support. Players always have controls,
preload metadata, and do not autoplay. Scripts and event handlers are stripped.

For example, agents can show files saved outside the repository:

```markdown
![Screenshot](</Users/me/Desktop/my screenshot.png>)
![Design](~/Pictures/design.png)
[Demo](/tmp/recording.mp4)
```

Local files are read from the computer running the session backend (the remote
host for SSH sessions). Paths with spaces can be wrapped in `<...>` or URL encoded.
The local media endpoint supports image and video formats only.

Click an image, or focus it and press Enter or Space, to open a larger preview.
The viewer provides fit-to-window and 100–300% zoom, previous/next images within
the message, loading and unavailable states. Use arrow keys to navigate, `+`/`-`
to zoom, `0` to fit, and Escape to close. Focus returns to the image on dismissal.
Videos use their native playback, seeking, and fullscreen controls.

Local media responses are not cached. Each displayed chat message has its own
image URLs, and opening the enlarged viewer refreshes local images again, so
new mentions show the current file after an agent edits it. Streaming updates
keep the same image URLs to avoid repeated downloads.
