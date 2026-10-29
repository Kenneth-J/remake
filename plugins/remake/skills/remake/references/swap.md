# Making it yours

The remake starts as a copy of someone else's work. Every slot in `remake/content.json` is a piece that still belongs to them. Fill a slot's `swap`, run `remake apply`, and the piece is yours. The swap board (`/_remake/swap/`) shows progress.

## What to ask the user for

Ask once, in one message, using the "What Claude needs from you" lines on the swap board. Accept whatever they send: a folder of photos, an About page, a LinkedIn bio, a logo file, a list of links. Don't ask them to fill `content.json` themselves.

## Copy

- Write in the user's voice, taken from what they sent. If they sent nothing, ask for two or three sentences about what they do and who for.
- **Keep each block within about 15% of the original's length.** The layout was built around those lengths; `remake apply` warns when a swap is much longer or shorter.
- Headlines stay headlines: short, same rhythm. Buttons stay verbs.
- Don't keep any of the original's sentences, claims, client names or numbers.

## Photos and logos

- Match by shape: each image slot has `width` and `height`. Give the closest-shaped photo to each slot; `apply` crops to fill and re-encodes in the original's format and every size variant.
- Logos: an SVG is best. A PNG works; it gets wrapped so the `.svg` file stays valid. Inline SVG logos (slots with kind `svg`) need an `.svg` file.
- Client logos on the original are its clients, not the user's. Swap them for the user's clients or remove the section (ask).

## Videos

Swap with an MP4 path, or with a photo: `apply` turns it into a 6-second slow-zoom clip (upright for phone videos), made by the browser itself. Videos that stream from the original's account (flag "plays from their account") need their player pointed at the new file; `apply` replaces the address where it appears in the HTML, and you finish the rest in the scripts if needed. "Use stills" means replacing the video element with an image.

## Fonts

A paid font (flag "paid font") must go unless the user owns a licence. Swap with a Google Fonts family name; `apply` downloads it and serves it under the original family name, so no CSS changes. Close free look-alikes:

| Original | Free look-alike |
| --- | --- |
| Suisse Int'l, Helvetica Now, Neue Haas | Inter, Inter Tight |
| Neue Montreal, PP Neue Machina | Manrope, Schibsted Grotesk |
| GT America, Graphik | Archivo, Public Sans |
| Söhne, Untitled Sans | Inter, Geist |
| Founders Grotesk | Archivo Narrow |
| GT Sectra, Canela | Fraunces, Playfair Display |
| Editorial New, Tiempos | Newsreader, Source Serif 4 |
| Monument Extended | Unbounded, Syne |
| GT Walsheim, Circular | Figtree, DM Sans |
| Any paid mono | JetBrains Mono, IBM Plex Mono |

## Colours, links and forms

- Colours: swap the top colours for the user's brand colours; `apply` replaces them in CSS and inline styles.
- Links: every external link is a slot (social, booking, email, phone). Swap with the user's. Remove links to the original's accounts. Links to the original's other pages that weren't remade are slots too ("Pages not remade"): on the copy they lead nowhere, so point each at the user's own matching page.
- Forms: swap with the address that should receive submissions (a Formspree, Basin or own endpoint URL). Until then the runtime holds submissions back and shows a note.

## After applying

`remake apply` → `remake board` → `remake ship` → `remake report`.

The first `apply` saves the last score of the untouched remake; the report keeps using it, because the site is meant to stop looking like the original now. Open the remake in the browser pane after applying to check nothing broke (text overflowing a box, a photo cropped badly). `remake score` still works if you want numbers, but it measures distance from the original, which is no longer the goal.

Remove the passcode only when the user asks and the board shows 100%: `vercel env rm REMAKE_PASSCODE production --yes` in the project, then `vercel deploy --prod --yes`. Make the repo public only when the user asks.
