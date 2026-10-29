# Fixing a remake that doesn't match yet

Read the diff image first: `remake/score/<page>-<viewport>-NN.png` shows original | remake | difference. Red pixels differ, blue pixels were left out because they also change between two loads of the original. Fix the biggest red area first, then re-score only that page and viewport.

## Where differences come from

| What you see | Likely cause | Fix |
| --- | --- | --- |
| Text in a fallback font, wrong line breaks | A font file wasn't captured (other weight, other format) or a font CDN refused the copy | `remake serve`, open the page, then `remake fetch --missing`. Check `@font-face` URLs in the CSS point to files that exist under `site/`. |
| Empty boxes where images should be | Other image sizes (`srcset`), images that load on hover or in a slider | `remake fetch --missing` after clicking through the page. Image URLs built in scripts: search `site/` for the path pattern and fetch the files with `remake fetch <url>`. |
| Whole section missing, page shorter | A script failed (score prints script errors), so content that scripts draw never appeared | Read the error. Usual suspects: a check on `location.hostname`, an absolute API address, a JSON file that wasn't recorded. Patch the check, or fetch the file. |
| Page taller or shorter by a section | Lazy content, a pinned scroll scene, or an embed with a different height | Compare the original's rendered page in `remake/rendered/<page>-<viewport>.html` with the remake's files under `site/`. Look for elements with heights set by scripts. |
| A cookie banner or chat bubble in one and not the other | Third-party scripts (both sides block trackers, but not every widget) | Remove the widget's script tag from the remake if the original only showed it by chance; otherwise make sure its script was captured. |
| A WebGL or canvas scene differs | A texture or model file wasn't captured, or the shader reads data that wasn't recorded | `remake fetch --missing`; check `.glb`, `.json`, `.ktx2`, `.wasm` requests in the browser pane's network list. |
| Video area differs | The remake's video source points somewhere else, or the poster image is missing | Videos are held on their first frame during scoring. Compare `src` and `poster` with the original's HTML. Streams (HLS) keep playing from the original's host. |
| Map, YouTube or social embed differs | Live third-party content | If its frame alone keeps the screen under 98% and it's ≥ 90%, accept it with the reason after three attempts. |
| Off by a few pixels everywhere | Different page width (a scrollbar, a missing reset CSS) | Check `site/` has every stylesheet the original page links, in the same order. |
| Phone screens differ, desktop is fine | The site serves different HTML or images to phones | The capture visits at phone size too; check `remake/rendered/*-phone.html` against the remake's phone layout and fetch the phone-only files. |

## Platform notes

- **Next.js / Nuxt / SvelteKit.** Static chunks live under `/_next/static/`, `/_nuxt/`, `/_app/`. Client-side navigation fetches data the visit didn't record; the runtime sends those links back to the original. Remaking more pages (`--pages`) records more.
- **Framer.** Assets come from `framerusercontent.com` and are copied under `/_ext/`. Scroll and appear effects run from Framer's own scripts, which are copied too.
- **Webflow.** Interactions (IX2) need the `data-wf-page` and `data-wf-site` attributes on `<html>`; keep them.
- **WordPress.** Image sizes are `name-300x200.jpg` style; `fetch --missing` gets the ones the browser asks for at other widths.
- **Wix and Squarespace.** Heavy client rendering and frequent bot checks. If capture is refused, say so and offer `--archive`.
- **Smooth scroll (Lenis, Locomotive).** Scoring scrolls with the mouse wheel, so these libraries move as they do for visitors. If heights differ, check the scroll wrapper is in the remake.

## Rebuilding from the Internet Archive (`--archive`)

- The page loads at its own address and every file of the site comes from the Archive's untouched copy, so its scripts run as they did. Files from other hosts (video, font CDNs) still load live.
- **Stuck on the loading screen** usually means one script file of that date was never archived, and one missing module stops the whole app. List what the Archive has: `https://web.archive.org/cdx/search/cdx?url=<site>/<assets folder>/&matchType=prefix&collapse=urlkey&output=json&fl=timestamp,original` and pick a date whose script files are all there (sites redeploy with new file names; an older date often has a complete set). Then `remake capture --archive <that timestamp>`.
- Some recent images were never archived. `remake slots` lists them as "missing in the copy"; a swap fills them.

## When you're stuck

After two attempts on the same screen, ask the `remake-judge` agent: give it the project folder and the screen name. It reads the diff, the original's rendered DOM and the remake's files with fresh eyes and returns the top differences with the file to change.
