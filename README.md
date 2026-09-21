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

Fifty-one end-to-end checks run in a headless iPhone-sized browser: adding
by ISBN, the check-digit guard, duplicates, title search, both ways of
reordering, order surviving a reload, shelf moves, the cover fallback chain,
the offline and throttled error messages, export/restore, sync in both
directions, updates reaching an installed app, and the whole app loading with
the network cut.
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

The app asks the browser to treat that storage as persistent, which keeps iOS
from evicting it when the phone is short of space. What no browser storage
survives is deliberate removal — clearing Safari's website data, or deleting
the Home Screen icon, which takes the installed app's storage with it. Turn on
sync (above) to be covered for that, or:
**Backup → Export a copy** now and then. On iPhone that opens the share sheet,
so you can drop the JSON file into Files or iCloud Drive. *Restore from a file*
reads it back and skips anything already on the list.

## Books worth going back to

Any book can be put in a rotation: open it and tick *Read this again every so
often*. One cycle covers everything — two years by default, changed at the top
of the **Rereads** tab, which lists the rotation with whatever has gone longest
unread at the top.

A book added while the Rereads tab is open joins the rotation as a book you
have read, and the tab does not change underneath you; the same goes for the
Read tab. Set *When you last finished it* to place it properly in the rotation — until
then it reads as never logged and leads the tab, but it stays out of the
reading list, since nothing yet says a cycle has elapsed.

A book in the rotation does not clutter the reading list until it comes round.
When it does, it appears there under **Due again**, directly after Next up, so
the reading list stays the one place worth looking. *I finished it again today*
on a book's page restarts its cycle; so does finishing it the ordinary way.

Each finish stamps the date, and picking a book up again keeps the previous
one until the new finish replaces it — that date is the whole basis of the
rotation, and clearing it on starting a reread would quietly destroy it.

## Bringing a Goodreads library across

Goodreads closed its public API in 2020, so nothing can ask it for your
shelves — but it will hand *you* the lot as a file, and the app reads that.

On goodreads.com (easier on a computer than in their app): **My Books** →
**Import and export** in the left sidebar → **Export Library**. Then in the
app: **Backup → From Goodreads → Choose the Goodreads file**.

Shelves map straight across — *to-read*, *currently-reading* and *read* become
this app's three — along with star ratings, reviews as the note on each book,
and the date you finished. Covers are not in the export, so they are fetched
afterwards, one at a time with a pause: a library of several hundred books
should not arrive at Open Library as several hundred simultaneous requests.
Custom shelves are ignored, importing twice adds nothing twice, and there is a
tickbox for leaving finished books behind.

## Sync (optional)

Without sync, the list lives only in the browser you added the books in, and
that is fine until the phone isn't: deleting the Home Screen icon, clearing
Safari's data, or losing the handset takes the list with it.

Turning sync on gives the list somewhere else to live. It then saves itself
about a second after every change and is fetched whenever the app opens, so a
new phone, a reinstall, or a second device picks up where the last one left
off. It is off until you enter an address.

### Setting it up, once

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/oswahmahmood/Book-Tracker)

That button reads `wrangler.jsonc`, which names the Worker and asks for the
storage it needs, so the whole thing is: sign in to Cloudflare (free, no card),
confirm, wait a minute. Copy the address it gives you into **Backup → Sync →
Sync address**, press **Turn sync on**, and you are done.

If the deploy asks for a KV namespace rather than making one, create it as
`LISTS` and bind it under the same name; the manual route below does exactly
that. All of it is browser-only — the free tier is far larger than one reading
list will ever need.

**The manual route**, if the button misbehaves:

1. Make a free account at [cloudflare.com](https://dash.cloudflare.com/sign-up).
2. In the dashboard, go to **Storage & Databases → KV** and create a namespace
   called `LISTS`.
3. Go to **Compute (Workers) → Create → Start with Hello World**, name it
   something like `reading-list-sync`, and deploy it.
4. Open the new Worker → **Edit code**, delete what's there, and paste in the
   contents of [`worker/sync-worker.js`](worker/sync-worker.js). Deploy.
5. Worker → **Settings → Bindings → Add → KV namespace**. Variable name
   `LISTS`, and pick the namespace from step 2. Deploy once more.
6. Copy the Worker's address (it looks like
   `https://reading-list-sync.your-name.workers.dev`).
7. In the app: **Backup → Sync → Sync address**, paste it in, **Turn sync on**.

Optionally set an `ALLOWED_ORIGIN` variable on the Worker (same Bindings
screen, as a plain text variable) to your app's address, so only the app's own
pages may call it.

### What you are trusting

There are no accounts and no passwords. The app generates a long random key for
itself, your list is stored under that key, and **holding the key is what grants
access** — so "Copy link for another device" produces something worth treating
like a password. Anyone with it can read or change the list; nobody without it
can find it. For a list of books that seemed a better trade than a sign-in, but
it is a deliberate trade rather than an oversight.

The data sits in your own Cloudflare account. Nothing goes anywhere else.

### How conflicts resolve

Newer wins, judged per list rather than per book — per-book merging is a great
deal more code for one person and a phone. In practice that means: edit on one
device, open the other, and the newer list replaces the older one. A device
with nothing on it always takes what the cloud holds, so a fresh phone fills
itself rather than uploading its emptiness.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Markup and the row/dialog templates |
| `app.css` | Styles — the Fig & Moss palette and type, in light mode whatever the phone is set to |
| `app.js` | Storage, ISBN validation, the two lookup APIs, ordering, drag and drop |
| `sw.js` | Service worker — network-first for the app itself, cache-first for covers |
| `manifest.webmanifest` | Makes it installable (name, icons, standalone display) |
| `tools/make-icons.py` | Regenerates `icons/` — no image libraries needed |
| `tests/run.mjs` | The end-to-end suite |
| `tests/smoke.mjs` | The live check against the real book services |
| `worker/sync-worker.js` | The optional Cloudflare Worker that holds a synced list |

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
