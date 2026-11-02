These font files are bundled locally. The app must not request runtime fonts
from Google Fonts or another CDN.

- `instrument-sans.woff2`: Instrument Sans variable (width/weight), from
  [Instrument/instrument-sans](https://github.com/Instrument/instrument-sans/tree/7fa22308a3d0c94ee2b3cd537a1196b65db34a3e),
  `fonts/webfonts/InstrumentSans[wdth,wght].woff2`.
- `geist-mono.woff2`: Geist Mono variable (weight), from
  [vercel/geist-font](https://github.com/vercel/geist-font/tree/1d6dfdb6e58c0ddd841c1e24e59aef01ec3916e4),
  `fonts/GeistMono/webfonts/GeistMono[wght].woff2`.

Instrument Sans and Geist Mono's SIL Open Font Licenses are included beside their binaries.

- `terminal-symbols-nerd-mono.ttf`: unmodified Symbols Nerd Font Mono from the
  [Nerd Fonts v3.5.1 symbols-only release](https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1),
  archive `NerdFontsSymbolsOnly.tar.xz`, file `SymbolsNerdFontMono-Regular.ttf`.
  Font SHA-256: `fe471e538392f51910faab985fa8e192a39dd3426125edd15b71b3680df0e749`.
  Archive SHA-256: `01172f37db8543edb102e5cb5c64101c9f4686630804d49b419aa07b23a69996`.
  Its MIT license and upstream icon-set attribution table are retained as
  `Terminal-Symbols-MIT.txt` and `Terminal-Symbols-upstream.md`.

The symbols-only face is restricted to symbol/private-use ranges and used only
by the terminal. Normal terminal letters and metrics continue to use Geist Mono.
The adapter awaits its local load before creating xterm so prompt glyph widths
are measured correctly. This covers Nerd Font/Powerline prompts without a system
font install or runtime CDN request.
