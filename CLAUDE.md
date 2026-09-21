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

**`npm test` must pass before every push.** 45 end-to-end checks in a headless
iPhone-sized browser. There is no CI: this suite is the only thing standing
between a mistake and the owner's phone. A run takes a few minutes, which is
still cheaper than shipping a blank screen.

When fixing a bug, write the check first and confirm it fails against the
current code. Several tests here passed against broken behaviour until that was
done, and one hung rather than failing.

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
- Redraw what changed, not the whole list. A blanket re-render left tests
  holding elements that had just been replaced — twice — and it was churn
  either way.
