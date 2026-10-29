# How Remake works

Remake is a small engine (`engine/`, Node + Playwright) and a skill that tells Claude how to drive it (`plugins/remake/skills/remake/`). The engine does everything that should be exact and repeatable: visiting, recording, rewriting, freezing, measuring, deploying. Claude does what needs judgement: reading diff images, fixing what broke, writing your copy.

## 1. Record once, replay forever

`remake capture` opens the page in Chromium at 1440×900, then at 390×844 with a phone user agent. Every request goes through a recording layer (`engine/lib/httpstore.mjs`):

- if the response is already recorded, the browser gets the recording;
- if not, it's fetched once, kept, and handed to the browser.

So the phone visit reuses everything the desktop visit loaded, and every scoring run later replays the original from the recording without asking the site again. The browser identifies itself: its user agent ends with `Remake/<version> (+https://github.com/rubenhassid1/remake)`.

Files the visit never loaded (other `srcset` widths, unused font weights, source maps, plain video files) are fetched afterwards by `Polite`: one request at a time per host, half a second apart, a 404 remembered so it's never asked twice. If a host fails twice in a row, Remake stops asking it and looks in the Internet Archive instead (CDX lookup, skipping archived bot-check pages).

Trackers (analytics, ad pixels, consent managers, chat widgets) are blocked during the visit and removed from the HTML.

## 2. A site you can run from a folder

The recording becomes `site/`:

- The original's own paths are kept (`/wp-content/…`, `/_next/static/…`), so relative addresses work unchanged.
- Files from other hosts (font and image CDNs) go under `/_ext/<host>/…`, and every place that names them (HTML, CSS, JS, JSON, escaped or not) is rewritten.
- Absolute addresses on the original's domain become paths on yours.
- `integrity` attributes and CSP meta tags are removed (rewriting changes bytes).
- Streaming video (HLS, DASH) and very large files keep playing from the original's host; the swap board flags them.

A small runtime (`engine/templates/runtime.js`) loads first on every page. It answers the page's own `fetch` and `XMLHttpRequest` calls from the recorded responses (keyed by method, original address and a hash of the request body), sends links to pages that weren't remade back to the original site, turns off service workers and beacons, and holds form submissions until you give them an address.

## 3. Freezing time

The hard problem with measuring a modern site is that it never stands still. Remake makes it stand still (`engine/lib/freeze.mjs`):

1. **The clock is paused before the first script runs** (Playwright's clock: `install` then `pauseAt`, before navigation). `Date`, `performance.now`, timers and `requestAnimationFrame` only move when Remake moves them.
2. **Time moves in exact steps.** After load, Remake advances the page's clock in 100 ms steps, and between steps waits until the network is quiet. Intro animations, GSAP timelines, smooth-scroll easing and shader time all land on the same values every run.
3. **Random numbers are seeded per line of code.** `Math.random` is replaced by a seeded generator with a separate stream for every call site (file name and line, without the host). Scripts load in a different order on every visit; per-call-site streams keep "pick a random headline" picking the same headline anyway, in the original and in the remake.
4. **Videos are held on their first frame.** Video plays on the real clock, so `play()` is held and autoplay is turned off; before each screenshot every video is parked at 0 and Remake waits for that frame to decode.
5. **CSS animations are finished** at the moment of each screenshot (Playwright's `animations: "disabled"`).
6. **Scrolling uses the mouse wheel,** in small steps with page time advancing between them, so smooth-scroll libraries move the way they do for a visitor.

## 4. Scoring

For each page and viewport, the original is recorded twice. Pixels that differ between those two loads are the **noise mask** (dilated by 3 px): things nothing could match, like a live map tile. They're left out of the score and shown in blue on the diff image, and the share of masked pixels is printed next to every score so a high-noise screen can't hide.

Then the remake is loaded the same way and compared screen by screen. A pixel counts as different when any colour channel is off by more than 24 of 255. The score is the share of unmasked pixels that match.

Pass mark: every screen at 98% or more, at desktop and phone, page heights within 4 px, and every one of 24 motion frames (small scroll steps with only 120 ms of page time between them, to catch animations mid-flight) at 95% or more.

Original screens are cached in `remake/original/`, so re-scoring after a fix only loads the remake.

## 5. Slots and swaps

`remake slots` reads every HTML file with source positions (parse5), and lists:

- text blocks (the deepest block-level element with text), text inside scripts and JSON for pages drawn by JavaScript, image descriptions and search/sharing metadata;
- images, with their size variants grouped into one slot, their dimensions, and where they're shown on the rendered page;
- videos, fonts (with licence flags), the most-used colours, external links by kind (social, booking, email, phone), forms, inline SVG logos.

`remake apply` replaces each filled slot at its exact source position: text keeps its surrounding whitespace and tags, images are cropped and re-encoded to every variant's size and format inside the headless browser (no image libraries), fonts are downloaded from Google Fonts and served under the original family name so the CSS doesn't change. It warns when new copy is much longer or shorter than the old, because the layout was built around the old lengths.

## 6. Shipping and the report

`remake ship` commits, creates a private GitHub repo (`gh`), links and deploys to Vercel (`vercel`), and stores the passcode in the `REMAKE_PASSCODE` environment variable. The gate is Vercel Routing Middleware (`middleware.js`): without the right cookie every path returns a passcode page with `401`; the cookie holds a SHA-256 of the passcode, never the passcode. Then it checks from outside: locked without the passcode, open with it, `noindex` on every response.

`remake report` checks: captured, desktop match, phone match, motion match, score newer than the last change, swap checklist built, live and private with the deployed commit equal to the current one. Only when all pass does it print REMAKE COMPLETE. Accepted differences are listed with their reasons, and can only be accepted at 90% or more.

## Limits

- No backend: logins, databases, payments, emails. Recorded API answers make pages look right; they don't make them work.
- Bot-protected sites are refused (or rebuilt from the Internet Archive with `--archive`).
- Live data (prices, feeds, maps) shows up as noise or as accepted differences.
- The score measures what a browser draws at two sizes and in one scroll. It doesn't test every interaction; Claude exercises menus, sliders and forms by hand in the browser pane.
