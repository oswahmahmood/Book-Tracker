# Reading list

A personal to-read list. Type an ISBN, it pulls the title, author, year, page
count and cover art; drag the books into the order you actually want to read
them in. Everything is stored on your own device — no account, no server, no
sign-in.

Three shelves: **To read** (the queue, in your order), **Reading**, **Read**.

## What format is this?

It's a plain web app — HTML, CSS and one JavaScript file, no build step and no
dependencies — set up as a **PWA** (progressive web app). On an iPhone you add
it to the Home Screen and it behaves like an app: its own icon, full screen, no
Safari chrome, works offline.

That's the format that gets you an app on your phone today without a Mac, Xcode
or an Apple Developer account. See "If you want a real native app" below for
the other route.

## Put it on your iPhone

1. **Merge this branch into `main`.** Nothing is published until you do — the
   workflow in `.github/workflows/pages.yml` only runs on a push to `main`, so
   until then the address below returns a 404.
2. **Switch Pages on:** Settings → Pages → Build and deployment → Source:
   **GitHub Actions**. Merging with this already set works too; either order is
   fine, but both have to happen.
3. **Wait for the deploy.** The run shows up under the repository's Actions tab
   and takes a minute or two. When it goes green the site is live at
   `https://oswahmahmood.github.io/Book-Tracker/` — note the capitals, these
   addresses are case-sensitive.
4. **Open that address in Safari on your iPhone** (it must be Safari — Chrome on
   iOS can't install to the Home Screen).
5. **Share → Add to Home Screen.** Done. Tap the icon and it opens standalone.

Anything pushed to `main` afterwards updates the app the next time you open
it: the app's own files are fetched from the network first and only fall back
to the cached copy when there is no connection. (Cache-first would be a hair
faster and would pin the phone to whichever copy it saw first — no update could
ever land. It did exactly that once.)

No prompts, banners or permission requests come with any of this: the app asks
for nothing — no notifications, no camera, no location — and iOS has no install
pop-up to dismiss. The only two dialogs in the whole app are ones you summon
yourself: a confirmation when you remove a book, and the iOS share sheet when
you export a backup.

## Running it locally

No toolchain needed, but it does need to be served over http (service workers
don't run from `file://`):

```sh
npm start   # then open http://localhost:8099
```

## Tests

```sh
npm install
npm test
```

Sixteen end-to-end checks run in a headless iPhone-sized browser: adding by
ISBN, the check-digit guard, duplicates, title search, both ways of reordering,
order surviving a reload, shelf moves, the cover fallback chain, the offline
error messages, export/restore, and the whole app loading with the network cut.
One of them builds a real four-book queue — *The Good Immigrant*, *The Inner
Game of Tennis*, *Mind the Gap* and *The Authority Gap* — reorders it and
checks it holds. The book APIs are stubbed, so the suite is deterministic and
needs no network.

There is also a live check, kept out of `npm test` because it depends on the
outside world:

```sh
npm run smoke
```

It looks those same four books up against the real Open Library and Google
Books, adds each one, and prints what came back — author, year, the ISBN the
service holds, and whether the cover image actually rendered. Worth running
once after any change to the lookup code.

A title search asks both services at once and merges what comes back, rather
than treating one as the other's fallback. They rank very differently: a book
with a common title ("Mind the Gap" has a dozen namesakes) can be buried by one
service and first on the other, and asking only the first one hides it
completely. Results are de-duplicated, with the cover from whichever service
had one and the ISBN from whichever held it, then ranked by how closely the
title and author match what was typed.

It is still worth adding the author's surname for a common title — the results
panel says so — since half a dozen books really are called the same thing.

## Where the data comes from

- [Open Library](https://openlibrary.org/developers/api) — tried first. Open
  data, no API key, good cover art at `covers.openlibrary.org`.
- [Google Books](https://developers.google.com/books) — fallback when Open
  Library has no record, which happens with some recent or regional editions.

Both are free and need no key at this volume. If an ISBN turns up nothing in
either, search by title instead — typing anything that isn't a valid ISBN runs
a title search and lets you pick from the results.

Cover art is treated separately from the metadata, because a book often has one
without the other: the app checks that the cover image really loads, and if it
doesn't, borrows the other source's thumbnail. A book added while you're offline
keeps its unverified cover URL and is retried the next time you open the app, so
it fills itself in rather than staying blank for good.

ISBNs are checked for a valid check digit before any lookup, so a mistyped
digit is caught immediately rather than coming back as "not found".

## Your data

The list lives in this browser's `localStorage`, under the key
`reading-list.v1`. It is never sent anywhere.

That also means it can be lost — clearing Safari's website data wipes it, and
iOS can evict storage for sites you haven't opened in a while (adding the app
to the Home Screen makes that much less likely, but isn't a guarantee). So:
**Backup → Export a copy** now and then. On iPhone that opens the share sheet,
so you can drop the JSON file into Files or iCloud Drive. *Restore from a file*
reads it back and skips anything already on the list.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Markup and the row/dialog templates |
| `app.css` | Styles — one blush palette, in light mode whatever the phone is set to |
| `app.js` | Storage, ISBN validation, the two lookup APIs, ordering, drag and drop |
| `sw.js` | Service worker — network-first for the app itself, cache-first for covers |
| `manifest.webmanifest` | Makes it installable (name, icons, standalone display) |
| `tools/make-icons.py` | Regenerates `icons/` — no image libraries needed |
| `tests/run.mjs` | The end-to-end suite |
| `tests/smoke.mjs` | The live check against the real book services |

## If you want a real native app

This PWA is the fastest path and covers nearly everything you asked for. A
native iOS app (SwiftUI + SwiftData, same two APIs) is worth it for two things:

- **Barcode scanning** — point the camera at the back of a book instead of
  typing 13 digits. Safari on iOS still doesn't support the barcode-detection
  API, so in a web app this needs a heavyweight JS scanning library; in a native
  app it's a few lines of VisionKit.
- **iCloud sync** and Home Screen widgets.

What that route costs you: a Mac with Xcode, and signing. A free Apple ID can
install your own app on your own iPhone, but it expires every 7 days and needs
re-installing from Xcode. The **Apple Developer Program ($99/year)** gives you
year-long signing and TestFlight. Personal apps never need to go through App
Store review — the App Store is only for distribution to other people.
