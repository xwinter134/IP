# Design language

The interface follows the visual language of amass.tech (structure, type, colour
roles), without using its name, logo or wordmark.

## Type
- Text and headings: Inter (Google Fonts), fallback `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`.
  Headings weight 600 with tight tracking (-0.02em to -0.032em), large headings may pair a 600 line with a 300 line.
- Utility: Martian Mono (Google Fonts), fallback `ui-monospace, "SF Mono", Menlo, Consolas, monospace`.
  Used for overlines (uppercase, 11-12px, letter-spacing 0.14em, signal red), patent numbers, dates, counts, code-like data.
- Body 15-16px / 1.5; data tables 13-14px with `font-variant-numeric: tabular-nums`.

## Colour (warm neutrals, never blue-grey)
Light: background `#ffffff`, surface `#faf9f9`, muted `#f2efef`, hairline `#e7e4e4`,
strong hairline `#d7d0d0`, ring `#a99d9d`, text `#292424`, dim text `#574e4e`,
faint text `#796b6b`, primary button `#292424` on `#faf9f9`.
Dark: background `#171212`, surface `#1c1717`, muted `#292424`, hairline `#3a3232`,
strong hairline `#4a4040`, text `#f2efef`, dim `#c9c0c0`, faint `#a99d9d`,
primary button `#f2efef` on `#1c1717`.
Signal: brand red `#f84016` (overline / active marker `#dc2b05` in light, `#f95834` in dark).
Semantic (separate from the accent): good `#3b7b34` / `#78d771`, warn `#b45309` / `#fcd34d`,
critical `#bc2706` / `#fa856b`, info indigo `#4128da` / `#9ca8ff`.
Risk scale 0-4: `#3b7b34`, `#8a9a2a`, `#b45309`, `#dc2b05`, `#97260c` (dark theme: lighter steps of the same hues).

## Signature elements
- Gradient field: a band running indigo `#473F96` -> violet `#6B3D89` -> magenta `#953C65`
  -> rose `#A03D57` -> rust `#B0412A`, with a faint speckle texture (SVG feTurbulence, low
  opacity). Used once, for the top band of the app (title, corpus counts, global search),
  with white text and a translucent hairline frame. Not repeated elsewhere.
- Hairline grids: data cells separated by 1px hairlines without gaps or shadows (stat
  rows, facet panels, claim charts). Thin vertical guide lines at the content edges.
- Plates: content panels on white with a 1px hairline, radius 10px, soft shadow
  `0 1px 3px -1px #00000026, 0 4px 10px -2px #0000001a` only for floating things.
- Buttons: radius 8px; primary dark pill, secondary white with hairline, quiet text
  buttons. Active/selected state marked by the signal red (a 2px underline or dot),
  not by filling with red.
- Overline above section titles: Martian Mono uppercase in signal red.
- Motion: 160-240 ms, `cubic-bezier(.23, 1, .32, 1)`, rise of at most 12px; respects
  `prefers-reduced-motion`.
- Status and verdicts are shown in form as well as colour: pill with a dot or icon and a word.

## Language
UI copy is English: concise and professional, neutral imperatives and nouns ("Search",
"Run analysis"). Legal terms as used in the views: scope of protection, claim feature
analysis, literal / equivalent infringement, legal status, research exemption,
pre-screening (never "clearance" or "freedom to operate" as a finding). Route ids keep
their original names (#suche, #struktur, ...). Patent text stays in its original language.
