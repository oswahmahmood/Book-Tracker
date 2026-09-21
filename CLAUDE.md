# Working on this project

A personal reading list, used daily on one iPhone. The owner is not a
programmer and reads summaries rather than diffs, so the writing here matters
as much as the code: explain in plain language, and say what actually happened
rather than what was supposed to.

## Shipping

**Commit straight to `main`.** Pushing publishes the app — `.github/workflows/pages.yml`
deploys to GitHub Pages on every push — so a push reaches a real phone within a
minute or two. Pull requests are for when a change is worth looking at first,
not the default; the owner asked for the merge button to go away.

**`npm test` must pass before every push.** 53 end-to-end checks in a headless
iPhone-sized browser. There is no CI: this suite is the only thing standing
between a mistake and the owner's phone. A run takes a few minutes, which is
still cheaper than shipping a blank screen.

When fixing a bug, write the check first and confirm it fails against the
current code. Several tests here passed against broken behaviour until that was
done, and one hung rather than failing.

## The look

Fig & Moss, chosen from a design canvas of options: warm greige ground
(`--bg`), fig for what you do (buttons, the title), moss for what is being
read, amber for what is next. Three states, three colours — they were sharing
one before, and it did not read.

Fraunces at 900 for the app title and book titles (its `opsz`, `SOFT` and
`WONK` axes are set deliberately), Karla for everything else, both from Google
Fonts and cached by the service worker so they survive going offline. Tokens
live at the top of `app.css`; the palette is meant to carry to the owner's
other tools, so change it there and nowhere else.

## What the app is

Plain HTML, CSS and one JavaScript file. No build step, no framework, no
dependencies beyond Playwright for the tests. Keep it that way: it is hosted
free, forever, by copying files to a static host.

- `app.js` — storage, ISBN validation, the two lookup APIs, ordering, sync
- `sw.js` — service worker. **Network-first for the app's own files**, with
  revalidation. Cache-first here once pinned an installed app to the first
  version it ever saw, so nothing could be shipped at all. Covers stay
  cache-first; they never change.
- `worker/sync-worker.js` — optional Cloudflare Worker holding one list per key

## Things learned the hard way

- **Never suggest deleting the Home Screen icon.** iOS throws away the
  installed app's storage with it. That advice once cost the owner their books.
- Safari and the Home Screen app keep **separate** storage for the same site.
- The book APIs need no key, and throttle accordingly. A 429 is not "offline".
- Search asks both Open Library and Google Books and merges; treating one as
  the other's fallback hid books with common titles entirely.
- The phone is the only place the live APIs can be reached from — this
  environment's network policy blocks them. `npm run smoke` is the real check.
- Goodreads has no API since 2020. The CSV export is the only way in, and real
  exports contain commas in titles, multi-line reviews and ISBNs written as
  `="9780571364886"`.
- `finishedAt` is the basis of the reread rotation, not decoration. Every
  finish stamps it; starting a book again must not clear it.
- `[hidden]` loses to any author `display` rule, so a hidden flex container
  stays on screen. There is one global `[hidden] { display: none !important }`
  — do not go back to per-element rules.
- Dates come from the reader's clock, not UTC. `toISOString()` stamps
  yesterday after midnight in British summer time.
- A `display: none` child claims no grid column. Hiding one in a row means
  the row's `grid-template-columns` loses one too, or everything shifts left.
  A check that something is hidden says nothing about what it left behind:
  assert the layout.
- Redraw what changed, not the whole list. A blanket re-render left tests
  holding elements that had just been replaced — twice — and it was churn
  either way.
- A push cancels nothing now, but it used to. `cancel-in-progress` in
  `pages.yml` meant a second push killed the first one's deploy, so a change
  reported as shipped had never left GitHub. Deploys queue; a green run is the
  only evidence that something is live, and this environment cannot load the
  site to check.
- Nothing may be wider than the screen. A flex row of `nowrap` buttons cannot
  shrink below its text, so one tab hung off the edge — and on iOS a page wider
  than the screen will not pinch back to fit and reads taps near the edge as
  sideways pans, so the tabs stopped working. Assert `scrollWidth <= clientWidth`
  at 320px, and remember the real fonts never load here: stretch the type to
  stand in for them.
