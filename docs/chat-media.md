# Videos in chat

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
when viewing a Markdown file). Absolute paths inside that worktree and remote
HTTP/HTTPS URLs work too. Local media fragments such as `demo.mp4#t=2,5` are
preserved. Local files stream with byte-range support for seeking.

Markdown references ending in `.mp4`, `.webm`, `.ogv`, `.mov`, or `.m4v` become
players. HTML `<video>` can reference other URLs without a file extension.
Playback depends on the browser's codec support. Players always have controls,
preload metadata, and do not autoplay. Scripts and event handlers are stripped.
