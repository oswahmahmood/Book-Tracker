/* End-to-end checks, run against a headless iPhone-sized Chromium.
 *
 *   npm install && npm test
 *
 * The book APIs are stubbed so the suite is deterministic and works offline;
 * what is being tested is this app's own behaviour around them. */
import assert from 'node:assert/strict';
import { serve } from './static-server.mjs';


// Lets Playwright's route stubs reach fetches made by the service worker, which
// the offline check depends on. Must be set before Playwright is loaded.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
const { chromium, devices } = await import('playwright');

const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}/`;

// A real 24x24 PNG, stood in for cover art.
const COVER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR42mPQsImiCmIYNWjUoFGDRg0aNWjUoIE3CADGAquQoNoL3wAAAABJRU5ErkJggg==',
  'base64');

const ISBN = '9780571364886';
const olRecord = (cover) => ({ [`ISBN:${ISBN}`]: {
  title: 'Piranesi', authors: [{ name: 'Susanna Clarke' }], publishers: [{ name: 'Bloomsbury' }],
  publish_date: 'Sep 15, 2020', number_of_pages: 245,
  ...(cover ? { cover: { large: 'https://covers.openlibrary.org/b/id/9-L.jpg' } } : {}) } });

/* The catalogue the stubbed search runs against. The four at the top are real
 * books used as a lifelike fixture; no ISBNs are written down for them, because
 * the real ones come back from the services themselves — tests/smoke.mjs asks
 * the live APIs for those. */
const CATALOGUE = [
  { title: 'The Good Immigrant', author_name: ['Nikesh Shukla'], first_publish_year: 2016, cover_i: 11 },
  { title: 'The Inner Game of Tennis', author_name: ['W. Timothy Gallwey'], first_publish_year: 1974, cover_i: 12 },
  { title: 'Mind the Gap', subtitle: 'The truth about desire and how to futureproof your sex life',
    author_name: ['Karen Gurney'], first_publish_year: 2020, cover_i: 13 },
  { title: 'The Authority Gap', subtitle: 'Why women are still taken less seriously than men',
    author_name: ['Mary Ann Sieghart'], first_publish_year: 2021, cover_i: 14 },
  { title: 'Wolf Hall', author_name: ['Hilary Mantel'], first_publish_year: 2009, isbn: ['9780007230181'], cover_i: 2 },
  { title: 'Bring Up the Bodies', author_name: ['Hilary Mantel'], first_publish_year: 2012, isbn: ['9780007315093'], cover_i: 3 },
];

/* Stands in for Open Library's search: every word of the query has to appear
   somewhere in the title, subtitle or author. */
function searchCatalogue(url) {
  const q = (new URL(url).searchParams.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
  const docs = CATALOGUE.filter((d) => {
    const hay = `${d.title} ${d.subtitle || ''} ${d.author_name.join(' ')}`.toLowerCase();
    return q.every((word) => hay.includes(word));
  });
  return { docs };
}

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const image = () => ({ status: 200, contentType: 'image/png', body: COVER_PNG });

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (err) {
    const detail = err.message.split('\n').filter(Boolean).slice(0, 5).join('\n       ');
    results.push(`  FAIL ${name}\n       ${detail}`);
    process.exitCode = 1;
  }
}

const titles = (page) => page.locator('.book .title').allTextContents();

const server = await serve(PORT);
const browser = await chromium.launch();

async function newPage({ serviceWorkers = 'block', routes = {} } = {}) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers });
  await ctx.route(/openlibrary\.org\/api\/books/, (r) => r.fulfill(json(routes.ol ?? olRecord(true))));
  await ctx.route(/openlibrary\.org\/search\.json/, (r) => r.fulfill(json(routes.search ?? searchCatalogue(r.request().url()))));
  await ctx.route(/covers\.openlibrary\.org\//, (r) => (routes.covers === false ? r.abort() : r.fulfill(image())));
  await ctx.route(/googleapis\.com\//, (r) => (routes.google === false ? r.abort() : r.fulfill(json(routes.google ?? { items: [] }))));
  await ctx.route(/books\.google\.com\//, (r) => r.fulfill(image()));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  return { ctx, page, errors };
}

async function addIsbn(page, isbn = ISBN) {
  await page.fill('#query', isbn);
  await page.click('#add-btn');
}

await check('starts cleanly when a list is already saved', async () => {
  // A fresh browser exercises none of the loading path, so this failure mode
  // only shows up for someone who already has books — that is, the actual user.
  const { ctx, page, errors } = await newPage();
  await seed(page, 3);
  assert.deepEqual(await titles(page), ['One', 'Two', 'Three']);
  assert.deepEqual(errors, [], 'nothing should throw while reading a saved list');
  await ctx.close();
});

await check('adds a book from its ISBN', async () => {
  const { ctx, page, errors } = await newPage();
  await addIsbn(page);
  await page.waitForSelector('.book');
  assert.deepEqual(await titles(page), ['Piranesi']);
  assert.equal(await page.locator('.book .author').textContent(), 'Susanna Clarke');
  assert.match(await page.locator('.book .sub').textContent(), /2020 · 245 pp/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check('rejects a bad check digit without calling out', async () => {
  const { ctx, page } = await newPage();
  let called = false;
  await page.route(/openlibrary\.org/, (r) => { called = true; r.fulfill(json(olRecord(true))); });
  await addIsbn(page, '9780571364880');
  await page.waitForSelector('#add-status.error');
  assert.match(await page.textContent('#add-status'), /check digit/);
  assert.equal(called, false);
  await ctx.close();
});

await check('refuses to add the same book twice', async () => {
  const { ctx, page } = await newPage();
  await addIsbn(page);
  await page.waitForSelector('.book');
  await addIsbn(page);
  await page.waitForFunction(() => /[Aa]lready/.test(document.querySelector('#add-status').textContent));
  assert.equal(await page.locator('.book').count(), 1);
  await ctx.close();
});

await check('searches by title and adds the chosen result', async () => {
  const { ctx, page } = await newPage();
  await page.fill('#query', 'hilary mantel');
  await page.click('#add-btn');
  await page.waitForSelector('#results:not([hidden]) .result');
  assert.equal(await page.locator('#results .result').count(), 2);
  await page.locator('#results .result').nth(1).click();
  await page.waitForSelector('.book');
  assert.deepEqual(await titles(page), ['Bring Up the Bodies']);
  await ctx.close();
});

await check('reorders with the arrow buttons', async () => {
  const { ctx, page } = await newPage();
  await seed(page, 3);
  await page.locator('.book').last().locator('.up').click();
  assert.deepEqual(await titles(page), ['One', 'Three', 'Two']);
  await ctx.close();
});

await check('reorders by dragging the handle, and the order survives a reload', async () => {
  const { ctx, page } = await newPage();
  await seed(page, 3);
  const grip = await page.locator('.book').last().locator('.grip').boundingBox();
  const first = await page.locator('.book').first().boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width / 2, first.y + 4, { steps: 12 });
  await page.mouse.up();
  assert.deepEqual(await titles(page), ['Three', 'One', 'Two']);
  await page.reload();
  await page.waitForSelector('.book');
  assert.deepEqual(await titles(page), ['Three', 'One', 'Two']);
  await ctx.close();
});

await check('shows the note in the row, and nothing when there is none', async () => {
  const { ctx, page } = await newPage();
  await seed(page, 2);
  assert.equal(await page.locator('.book .note').first().isHidden(), true, 'no note, no line');

  await page.locator('.book').first().locator('.open').click();
  await page.fill('#book-dialog textarea', 'Ada keeps quoting it at me');
  await page.click('#book-dialog button[type="submit"]');
  await page.waitForFunction(
    (text) => document.querySelector('.book .note')?.textContent === text,
    'Ada keeps quoting it at me');
  assert.equal(await page.locator('.book .note').nth(1).isHidden(), true);

  // a long note is clamped in the row but kept whole in the sheet
  const essay = 'Because '.repeat(40).trim();
  await page.locator('.book').first().locator('.open').click();
  await page.fill('#book-dialog textarea', essay);
  await page.click('#book-dialog button[type="submit"]');
  // closing the sheet redraws the row, so wait for the new one before measuring
  await page.waitForFunction((text) => document.querySelector('.book .note')?.textContent === text, essay);
  const row = await page.locator('.book .note').first().boundingBox();
  assert.ok(row.height < 44, `the row note should stay short, was ${row.height}px`);
  await page.locator('.book').first().locator('.open').click();
  assert.equal(await page.inputValue('#book-dialog textarea'), essay, 'the sheet keeps all of it');
  await ctx.close();
});

await check('tapping anywhere on a book opens it, except the controls', async () => {
  const { ctx, page } = await newPage();
  await seed(page, 2);

  // the cover, the title, the empty space — all of it
  for (const spot of ['.cover-wrap', '.title', '.meta']) {
    await page.locator('.book').first().locator(spot).click();
    assert.equal(await page.locator('#book-dialog').isVisible(), true, `${spot} should open the book`);
    await page.click('#book-dialog button[type="submit"]');
  }

  // the drag handle and the arrows still do their own jobs
  await page.locator('.book').first().locator('.grip').click();
  assert.equal(await page.locator('#book-dialog').isVisible(), false, 'the drag handle must not open the sheet');
  await page.locator('.book').last().locator('.up').click();
  assert.equal(await page.locator('#book-dialog').isVisible(), false, 'the arrows must not open the sheet');
  assert.deepEqual(await titles(page), ['Two', 'One'], 'the arrow should still have reordered');
  await ctx.close();
});

await check('a book links out to where you can read more', async () => {
  const { ctx, page } = await newPage();
  await addIsbn(page);
  await page.waitForSelector('.book');
  await page.locator('.book .title').click();

  const links = await page.locator('#book-dialog .book-link').evaluateAll((els) =>
    els.map((el) => ({ label: el.textContent, href: el.href, target: el.target, rel: el.rel })));
  assert.equal(links.length, 3);
  assert.deepEqual(links.map((l) => l.label), ['Google Books', 'Open Library', 'Amazon']);
  for (const link of links) {
    assert.match(link.href, new RegExp(ISBN), `${link.label} should point at the ISBN: ${link.href}`);
    assert.equal(link.target, '_blank');
    assert.match(link.rel, /noopener/);
  }
  await ctx.close();
});

await check('a book with no ISBN still links out, by title and author', async () => {
  const { ctx, page } = await newPage();
  await page.fill('#query', 'the good immigrant');
  await page.click('#add-btn');
  await page.waitForSelector('#results:not([hidden]) .result');
  await page.locator('#results .result').first().click();
  await page.waitForSelector('.book');
  await page.locator('.book .title').click();
  const hrefs = await page.locator('#book-dialog .book-link').evaluateAll((els) => els.map((el) => el.href));
  for (const href of hrefs) {
    assert.match(href.toLowerCase(), /immigrant/, `expected a title search, got ${href}`);
  }
  await ctx.close();
});

await check('moving a book between shelves keeps the other shelf intact', async () => {
  const { ctx, page } = await newPage();
  await seed(page, 3);
  await page.locator('.book').nth(1).locator('.open').click();
  await page.selectOption('#book-dialog select', 'reading');
  await page.fill('#book-dialog textarea', 'on the train');
  await page.click('#book-dialog button[type="submit"]');
  assert.deepEqual(await titles(page), ['Two', 'One', 'Three'], 'the book being read moves to the top');
  assert.equal(await page.textContent('[data-count="unfinished"]'), '3');
  await page.reload();
  assert.deepEqual(await titles(page), ['Two', 'One', 'Three'], 'what you are reading sits on top');
  await page.locator('.book').first().locator('.open').click();
  assert.equal(await page.inputValue('#book-dialog textarea'), 'on the train');
  await ctx.close();
});

await check('what you are reading leads the list, and looks different', async () => {
  const { ctx, page } = await newPage();
  await seed(page, 3);

  // start the middle one
  await page.locator('.book').nth(1).locator('.open').click();
  await page.selectOption('#book-dialog select', 'reading');
  await page.click('#book-dialog button[type="submit"]');

  assert.deepEqual(await titles(page), ['Two', 'One', 'Three'], 'it should move to the top');
  assert.equal(await page.locator('.book').first().getAttribute('class'), 'book is-reading');
  assert.equal(await page.locator('.book').first().locator('.row-badge').textContent(), 'Reading now');
  assert.equal(await page.locator('.book').nth(1).locator('.row-badge').textContent(), 'Next up',
    'the first unstarted book is what comes next');

  // the highlight is a different colour from the rest of the app
  const [readingBorder, plainBorder] = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.book')];
    return [getComputedStyle(rows[0]).borderTopColor, getComputedStyle(rows[1]).borderTopColor];
  });
  assert.notEqual(readingBorder, plainBorder, 'a book on the go should stand out');

  // two started books keep their own order above the rest
  await page.locator('.book').last().locator('.open').click();
  await page.selectOption('#book-dialog select', 'reading');
  await page.click('#book-dialog button[type="submit"]');
  assert.deepEqual(await titles(page), ['Two', 'Three', 'One']);
  await page.reload();
  assert.deepEqual(await titles(page), ['Two', 'Three', 'One'], 'and survive a reload');
  await ctx.close();
});

await check('finished books move to their own tab', async () => {
  const { ctx, page } = await newPage();
  await seed(page, 2);
  await page.locator('.book').first().locator('.open').click();
  await page.selectOption('#book-dialog select', 'read');
  await page.click('#book-dialog button[type="submit"]');

  assert.deepEqual(await titles(page), ['Two'], 'a finished book leaves the reading list');
  assert.equal(await page.textContent('[data-count="read"]'), '1');
  await page.click('.shelf[data-shelf="read"]');
  assert.deepEqual(await titles(page), ['One']);
  assert.equal(await page.locator('.book').first().locator('.row-badge').isHidden(), true,
    'no badges on the finished shelf');
  await ctx.close();
});

await check('falls back to the other source when one has no cover art', async () => {
  const { ctx, page } = await newPage({ routes: {
    ol: olRecord(false), covers: false,
    google: { items: [{ volumeInfo: { imageLinks: { thumbnail: 'http://books.google.com/books/content?id=x&zoom=1&edge=curl' } } }] },
  } });
  await addIsbn(page);
  await page.waitForFunction(() => {
    const img = document.querySelector('.book .cover');
    return img && !img.hidden && img.naturalWidth > 1;
  }, null, { timeout: 5000 });
  const cover = await stored(page, 'cover');
  assert.match(cover, /books\.google\.com/);
  await ctx.close();
});

await check('shows a tidy placeholder when neither source has a cover', async () => {
  const { ctx, page } = await newPage({ routes: { ol: olRecord(false), covers: false } });
  await addIsbn(page);
  await page.waitForSelector('.book');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('reading-list.v1')).books[0].coverChecked === true);
  assert.equal(await stored(page, 'cover'), '');
  assert.equal(await page.locator('.book .cover').isHidden(), true);
  assert.equal(await page.locator('.book .cover-fallback').textContent(), 'No cover');
  await ctx.close();
});

await check('retries the cover on a later visit if the servers were unreachable', async () => {
  let down = true;
  const ctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  await ctx.route(/openlibrary\.org\/api\/books/, (r) => r.fulfill(json(olRecord(false))));
  await ctx.route(/covers\.openlibrary\.org\//, (r) => (down ? r.abort() : r.fulfill(image())));
  await ctx.route(/googleapis\.com\//, (r) => (down ? r.abort() : r.fulfill(json({ items: [] }))));
  const page = await ctx.newPage();
  await page.goto(BASE);
  await addIsbn(page);
  await page.waitForSelector('.book');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('reading-list.v1')).books[0].coverChecked === false);

  down = false;
  await page.reload();
  await page.waitForFunction(() => {
    const img = document.querySelector('.book .cover');
    return img && !img.hidden && img.naturalWidth > 1;
  }, null, { timeout: 5000 });
  await ctx.close();
});

await check('builds a four-book list and holds the order it is put in', async () => {
  const { ctx, page, errors } = await newPage();

  const wanted = [
    ['the good immigrant', 'The Good Immigrant'],
    ['inner game of tennis', 'The Inner Game of Tennis'],
    ['mind the gap gurney', 'Mind the Gap'],
    ['the authority gap', 'The Authority Gap'],
  ];

  for (const [query, title] of wanted) {
    await page.fill('#query', query);
    await page.click('#add-btn');
    await page.waitForSelector('#results:not([hidden]) .result');
    await page.locator('#results .result').first().click();
    await page.waitForFunction((t) => [...document.querySelectorAll('.book .title')].some((el) => el.textContent === t), title);
  }

  assert.deepEqual(await titles(page), wanted.map(([, t]) => t), 'new books land at the bottom of the queue');
  assert.equal(await page.textContent('[data-count="unfinished"]'), '4');
  assert.equal(await page.locator('.book').nth(3).locator('.author').textContent(), 'Mary Ann Sieghart');

  // Read The Authority Gap first, then Mind the Gap.
  await page.locator('.book').nth(3).locator('.open').click();
  await page.click('#book-dialog .stack button.ghost');       // move to the top of this shelf
  await page.locator('.book').nth(3).locator('.up').click();
  assert.deepEqual(await titles(page), [
    'The Authority Gap', 'The Good Immigrant', 'Mind the Gap', 'The Inner Game of Tennis',
  ]);

  // Start the one at the top; the rest keep their order behind it.
  await page.locator('.book').first().locator('.open').click();
  await page.selectOption('#book-dialog select', 'reading');
  await page.click('#book-dialog button[type="submit"]');

  await page.reload();
  await page.waitForSelector('.book');
  assert.deepEqual(await titles(page), [
    'The Authority Gap', 'The Good Immigrant', 'Mind the Gap', 'The Inner Game of Tennis',
  ], 'the one being read leads, the rest keep their order');
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check('keeps a subtitle out of the title but shows the author', async () => {
  const { ctx, page } = await newPage();
  await page.fill('#query', 'mind the gap gurney');
  await page.click('#add-btn');
  await page.waitForSelector('#results:not([hidden]) .result');
  await page.locator('#results .result').first().click();
  await page.waitForSelector('.book');
  assert.equal(await page.locator('.book .title').textContent(), 'Mind the Gap');
  assert.equal(await page.locator('.book .author').textContent(), 'Karen Gurney');
  await page.locator('.book').first().locator('.open').click();
  const sheet = await page.locator('#dialog-body').textContent();
  assert.match(sheet, /The truth about desire/, 'the subtitle belongs in the detail sheet');
  await ctx.close();
});

await check('surfaces a common title that only one of the two services ranks well', async () => {
  // What Open Library actually does with "mind the gap": plenty of namesakes,
  // none of them the book being looked for.
  const namesakes = { docs: [
    { title: 'Mind the Gap', author_name: ['A Different Author'], first_publish_year: 2005, cover_i: 31 },
    { title: 'Mind the Gap: A History of the Underground', author_name: ['Someone Else'], first_publish_year: 2013, cover_i: 32 },
    { title: 'Mind the Gap in Financial Planning', author_name: ['A Third Person'], first_publish_year: 2018, cover_i: 33 },
  ] };
  const google = { items: [{ volumeInfo: {
    title: 'Mind the Gap', subtitle: 'The truth about desire and how to futureproof your sex life',
    authors: ['Karen Gurney'], publishedDate: '2020', pageCount: 288,
    imageLinks: { thumbnail: 'http://books.google.com/books/content?id=g&zoom=1&edge=curl' },
  } }] };

  const { ctx, page } = await newPage({ routes: { search: namesakes, google } });

  // The bare title is ambiguous, but the right book must at least be offered.
  await page.fill('#query', 'mind the gap');
  await page.click('#add-btn');
  await page.waitForSelector('#results:not([hidden]) .result');
  const offered = await page.locator('#results .result').allTextContents();
  assert.ok(offered.some((t) => t.includes('Karen Gurney')), 'the Gurney edition should be among the results');

  // Naming the author should put it first.
  await page.click('#results-close');
  await page.fill('#query', 'mind the gap karen gurney');
  await page.click('#add-btn');
  await page.waitForSelector('#results:not([hidden]) .result');
  assert.match(await page.locator('#results .result').first().textContent(), /Karen Gurney/);

  await page.locator('#results .result').first().click();
  await page.waitForSelector('.book');
  assert.equal(await page.locator('.book .title').textContent(), 'Mind the Gap');
  assert.equal(await page.locator('.book .author').textContent(), 'Karen Gurney');
  await ctx.close();
});

await check('does not list the same book twice when both services return it', async () => {
  const both = { docs: [{ title: 'Piranesi', author_name: ['Susanna Clarke'], first_publish_year: 2020, cover_i: 41 }] };
  const google = { items: [{ volumeInfo: {
    title: 'Piranesi', authors: ['Susanna Clarke'], publishedDate: '2020', pageCount: 245,
    industryIdentifiers: [{ type: 'ISBN_13', identifier: '9781526622426' }],
  } }] };
  const { ctx, page } = await newPage({ routes: { search: both, google } });
  await page.fill('#query', 'piranesi');
  await page.click('#add-btn');
  await page.waitForSelector('#results:not([hidden]) .result');
  assert.equal(await page.locator('#results .result').count(), 1, 'the duplicate should be merged away');
  await page.locator('#results .result').first().click();
  await page.waitForSelector('.book');
  // the merged entry keeps the cover from one service and the ISBN from the other
  const book = await page.evaluate(() => JSON.parse(localStorage.getItem('reading-list.v1')).books[0]);
  assert.match(book.cover, /covers\.openlibrary\.org/);
  assert.equal(book.isbn, '9781526622426');
  await ctx.close();
});

await check('says something human when the lookup services are unreachable', async () => {
  const { ctx, page } = await newPage({ routes: { google: false } });
  await page.unroute(/openlibrary\.org\/api\/books/);
  await page.route(/openlibrary\.org\/api\/books/, (r) => r.abort());
  await addIsbn(page);
  await page.waitForSelector('#add-status.error');
  assert.match(await page.textContent('#add-status'), /offline/);
  await ctx.close();
});

await check('gives the same offline message when a title search cannot reach anything', async () => {
  const { ctx, page } = await newPage({ routes: { google: false } });
  await page.unroute(/openlibrary\.org\/search\.json/);
  await page.route(/openlibrary\.org\/search\.json/, (r) => r.abort());
  await page.fill('#query', 'the good immigrant');
  await page.click('#add-btn');
  await page.waitForSelector('#add-status.error');
  assert.match(await page.textContent('#add-status'), /offline/);
  await ctx.close();
});

await check('says the services are busy, not that you are offline, when throttled', async () => {
  let attempts = 0;
  const ctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  await ctx.route(/openlibrary\.org/, (r) => { attempts++; r.fulfill({ status: 429, body: 'slow down' }); });
  await ctx.route(/googleapis\.com/, (r) => { attempts++; r.fulfill({ status: 429, body: 'slow down' }); });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.fill('#query', 'the good immigrant');
  await page.click('#add-btn');
  await page.waitForSelector('#add-status.error');
  const message = await page.textContent('#add-status');
  assert.match(message, /busy/, `expected a "busy" message, got: ${message}`);
  assert.doesNotMatch(message, /offline/, 'the phone is online — do not blame the connection');
  assert.match(message, /429/);
  assert.ok(attempts >= 4, `each service should be retried once before giving up, saw ${attempts} calls`);
  await ctx.close();
});

await check('a throttled lookup succeeds on the retry', async () => {
  let first = true;
  const ctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  await ctx.route(/openlibrary\.org\/api\/books/, (r) => {
    if (first) { first = false; return r.fulfill({ status: 429, body: 'slow down' }); }
    return r.fulfill(json(olRecord(true)));
  });
  await ctx.route(/covers\.openlibrary\.org\//, (r) => r.fulfill(image()));
  await ctx.route(/googleapis\.com/, (r) => r.fulfill(json({ items: [] })));
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.fill('#query', ISBN);
  await page.click('#add-btn');
  await page.waitForSelector('.book');
  assert.deepEqual(await titles(page), ['Piranesi']);
  await ctx.close();
});

/* A stand-in for the Cloudflare Worker: one list held in memory. */
function fakeWorker() {
  const store = new Map();
  const handle = (route) => {
    const request = route.request();
    const key = new URL(request.url()).pathname.split('/').pop();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, body: '' });
    if (request.method() === 'PUT') {
      store.set(key, request.postData());
      return route.fulfill(json({ ok: true, savedAt: Date.now() }));
    }
    const stored = store.get(key);
    return stored
      ? route.fulfill({ status: 200, contentType: 'application/json', body: stored })
      : route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"nothing stored yet"}' });
  };
  return { store, handle };
}

const SYNC_HOST = 'https://sync.example.test';

async function turnSyncOn(page) {
  await page.click('#backup-btn');
  await page.fill('#sync-url', SYNC_HOST);
  await page.click('#sync-connect');
  await page.click('#backup-dialog button[type="submit"]');
}

await check('sync sends the list up whenever it changes', async () => {
  const worker = fakeWorker();
  const { ctx, page } = await newPage();
  await ctx.route(/sync\.example\.test/, worker.handle);
  await seed(page, 2);
  await turnSyncOn(page);

  await page.locator('.book').first().locator('.open').click();
  await page.fill('#book-dialog textarea', 'for the train');
  await page.click('#book-dialog button[type="submit"]');

  await page.waitForFunction(() => true);
  await page.waitForTimeout(1800);  // the push is debounced
  assert.equal(worker.store.size, 1, 'the worker should be holding one list');
  const sent = JSON.parse([...worker.store.values()][0]);
  assert.equal(sent.books.length, 2);
  assert.equal(sent.books[0].notes, 'for the train');
  await ctx.close();
});

await check('another device picks the list up from the sync link', async () => {
  const worker = fakeWorker();
  const first = await newPage();
  await first.ctx.route(/sync\.example\.test/, worker.handle);
  await seed(first.page, 3);
  await turnSyncOn(first.page);
  await first.page.waitForTimeout(1800);
  assert.equal(worker.store.size, 1, 'the first device should have pushed');

  // the link carries the address and the key; a second device needs nothing else
  const link = await first.page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('reading-list.sync'));
    return `#sync=${encodeURIComponent(s.url)}&key=${encodeURIComponent(s.key)}`;
  });
  await first.ctx.close();

  const second = await newPage();
  await second.ctx.route(/sync\.example\.test/, worker.handle);
  second.page.on('dialog', (d) => d.accept());
  await second.page.goto(BASE + link);
  await second.page.waitForSelector('.book');
  assert.deepEqual(await titles(second.page), ['One', 'Two', 'Three'], 'the list should arrive on the new device');
  assert.equal(await second.page.evaluate(() => location.hash), '', 'the key should not be left in the address bar');
  await second.ctx.close();
});

await check('a newer list from the cloud replaces an older one on the device', async () => {
  const worker = fakeWorker();
  const { ctx, page } = await newPage();
  await ctx.route(/sync\.example\.test/, worker.handle);
  await seed(page, 1);
  await turnSyncOn(page);
  await page.waitForTimeout(1800);

  // something else edited the list later
  const key = await page.evaluate(() => JSON.parse(localStorage.getItem('reading-list.sync')).key);
  worker.store.set(key, JSON.stringify({
    version: 1,
    changedAt: Date.now() + 60000,
    books: [{ id: 'z', title: 'Added Elsewhere', authors: ['Someone'], status: 'toread', notes: '', isbn: '', cover: '' }],
  }));

  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.book').length === 1
    && document.querySelector('.book .title').textContent === 'Added Elsewhere');
  await ctx.close();
});

await check('a sync link has to be agreed to before it takes the list', async () => {
  const worker = fakeWorker();
  const { ctx, page } = await newPage();
  await ctx.route(/sync\.example\.test/, worker.handle);
  await seed(page, 2);

  // a link from anywhere else: refusing it must change nothing
  page.on('dialog', (d) => d.dismiss());
  await page.goto(`${BASE}#sync=${encodeURIComponent('https://somewhere.else.test')}&key=abcdefghijklmnopqrstuvwx`);
  await page.waitForSelector('.book');
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => localStorage.getItem('reading-list.sync')), null,
    'a refused link must not configure sync');
  assert.equal(worker.store.size, 0, 'and must not send the list anywhere');
  assert.deepEqual(await titles(page), ['One', 'Two'], 'and must not replace the list');
  await ctx.close();
});

await check('a bare tap on the drag handle is not a change', async () => {
  const worker = fakeWorker();
  const { ctx, page } = await newPage();
  await ctx.route(/sync\.example\.test/, worker.handle);
  await seed(page, 2);
  await turnSyncOn(page);
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('reading-list.v1')).changedAt);

  await page.locator('.book').first().locator('.grip').click();
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('reading-list.v1')).changedAt);
  assert.equal(after, before, 'tapping the handle should not count as reordering');
  await ctx.close();
});

await check('everything still works with sync switched off', async () => {
  const { ctx, page, errors } = await newPage();
  await seed(page, 2);
  await page.locator('.book').last().locator('.up').click();
  assert.deepEqual(await titles(page), ['Two', 'One']);
  await page.reload();
  assert.deepEqual(await titles(page), ['Two', 'One']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

/* A Goodreads export, with the things that break naive parsers: a comma inside
   a quoted title, a review running over several lines with an escaped quote in
   it, their ="..." ISBN format, a blank ISBN, and a custom shelf. */
const GOODREADS_CSV = [
  'Book Id,Title,Author,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Exclusive Shelf,My Review',
  '1,"Wolf Hall, and after",Hilary Mantel,,="0007230184",="9780007230181",5,4.1,Fourth Estate,653,2009,2009,2024/03/11,2024/01/02,history,read,"Loved it.',
  'The ""second"" half especially, once Cromwell settles in."',
  '2,Piranesi,Susanna Clarke,,="1526622424",="9781526622426",0,4.2,Bloomsbury,245,2020,2020,,2025/06/01,,currently-reading,',
  '3,The Good Immigrant,Nikesh Shukla,Chimene Suleyman,="",="",0,4.3,Unbound,208,2016,2016,,2025/07/14,,to-read,',
  '4,Some Reference Book,A Compiler,,="",="",0,3.9,Someone,100,2001,2001,,2025/07/15,,reference,',
].join('\n');

await check('imports a Goodreads export, shelves and reviews intact', async () => {
  const { ctx, page } = await newPage();
  await page.click('#backup-btn');
  await page.setInputFiles('#goodreads-input',
    { name: 'goodreads_library_export.csv', mimeType: 'text/csv', buffer: Buffer.from(GOODREADS_CSV) });
  await page.waitForFunction(() => document.querySelector('#goodreads-state').textContent.includes('Added'));
  const message = await page.textContent('#goodreads-state');
  assert.match(message, /Added 3 books/, message);
  await page.click('#backup-dialog button[type="submit"]');

  // currently-reading leads, then to-read; the finished one is on the other tab
  assert.deepEqual(await titles(page), ['Piranesi', 'The Good Immigrant']);
  assert.equal(await page.locator('.book').first().locator('.row-badge').textContent(), 'Reading now');
  await page.click('.shelf[data-shelf="read"]');
  assert.deepEqual(await titles(page), ['Wolf Hall, and after'], 'a comma inside a quoted title survives');

  const finished = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('reading-list.v1')).books.find((b) => b.status === 'read'));
  assert.equal(finished.isbn, '9780007230181', 'the ="..." ISBN format is unwrapped');
  assert.equal(finished.rating, 5);
  assert.equal(finished.finishedAt, '2024-03-11');
  assert.match(finished.notes, /Loved it\./);
  assert.match(finished.notes, /"second" half/, 'an escaped quote inside the review');
  assert.match(finished.notes, /\n/, 'a review spanning lines stays whole');

  const noIsbn = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('reading-list.v1')).books.find((b) => b.title === 'The Good Immigrant'));
  assert.equal(noIsbn.isbn, '', 'a blank ISBN is blank, not ="" ');
  assert.deepEqual(noIsbn.authors, ['Nikesh Shukla', 'Chimene Suleyman']);

  const titlesStored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('reading-list.v1')).books.map((b) => b.title));
  assert.ok(!titlesStored.includes('Some Reference Book'), 'a custom shelf is not a reading status');
  await ctx.close();
});

await check('a second Goodreads import adds nothing twice', async () => {
  const { ctx, page } = await newPage();
  const file = { name: 'export.csv', mimeType: 'text/csv', buffer: Buffer.from(GOODREADS_CSV) };
  await page.click('#backup-btn');
  await page.setInputFiles('#goodreads-input', file);
  await page.waitForFunction(() => document.querySelector('#goodreads-state').textContent.includes('Added'));

  await page.setInputFiles('#goodreads-input', file);
  await page.waitForFunction(() => document.querySelector('#goodreads-state').textContent.includes('Nothing new'));
  assert.match(await page.textContent('#goodreads-state'), /all 3 of those are already/);
  await page.click('#backup-dialog button[type="submit"]');
  assert.equal(await page.locator('.book').count(), 2, 'no duplicates on the reading list');
  await ctx.close();
});

await check('the finished books can be left behind', async () => {
  const { ctx, page } = await newPage();
  await page.click('#backup-btn');
  await page.check('#goodreads-skip-read');
  await page.setInputFiles('#goodreads-input',
    { name: 'export.csv', mimeType: 'text/csv', buffer: Buffer.from(GOODREADS_CSV) });
  await page.waitForFunction(() => document.querySelector('#goodreads-state').textContent.includes('Added'));
  assert.match(await page.textContent('#goodreads-state'), /Added 2 books/);
  await page.click('#backup-dialog button[type="submit"]');
  assert.equal(await page.textContent('[data-count="read"]'), '0');
  await ctx.close();
});

await check('a file that is not a Goodreads export says so', async () => {
  const { ctx, page } = await newPage();
  await page.click('#backup-btn');
  await page.setInputFiles('#goodreads-input',
    { name: 'shopping.csv', mimeType: 'text/csv', buffer: Buffer.from('milk,bread\n1,2\n') });
  await page.waitForSelector('#goodreads-state.error');
  assert.match(await page.textContent('#goodreads-state'), /does not look like a Goodreads export/);
  await ctx.close();
});

await check('exports and restores the list', async () => {
  const { ctx, page } = await newPage();
  await seed(page, 2);
  const backup = await page.evaluate(() => localStorage.getItem('reading-list.v1'));
  await page.evaluate(() => localStorage.removeItem('reading-list.v1'));
  await page.reload();
  assert.equal(await page.locator('.book').count(), 0);
  await page.click('#backup-btn');
  await page.setInputFiles('#import-input', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await page.waitForSelector('#backup-status:not(:empty)');
  assert.match(await page.textContent('#backup-status'), /Restored 2 books/);
  await page.click('#backup-dialog button[type="submit"]');
  assert.deepEqual(await titles(page), ['One', 'Two']);
  await ctx.close();
});

await check('restoring a backup does not duplicate books that have no ISBN', async () => {
  const { ctx, page } = await newPage();
  await page.evaluate(() => localStorage.setItem('reading-list.v1', JSON.stringify({ version: 1, books: [
    { id: 'a1', isbn: '', title: 'The Good Immigrant', authors: ['Nikesh Shukla'], status: 'toread', notes: '', cover: '' },
  ] })));
  await page.reload();
  await page.waitForSelector('.book');

  // the same book, saved by another device, so it carries a different id
  const backup = JSON.stringify({ version: 1, books: [
    { id: 'b2', isbn: '', title: 'The Good Immigrant', authors: ['Nikesh Shukla'], status: 'toread', notes: '', cover: '' },
    { id: 'b3', isbn: '', title: 'The Authority Gap', authors: ['Mary Ann Sieghart'], status: 'toread', notes: '', cover: '' },
  ] });
  await page.click('#backup-btn');
  await page.setInputFiles('#import-input', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await page.waitForSelector('#backup-status:not(:empty)');
  assert.match(await page.textContent('#backup-status'), /Restored 1 book/);
  await page.click('#backup-dialog button[type="submit"]');
  assert.deepEqual(await titles(page), ['The Good Immigrant', 'The Authority Gap']);
  await ctx.close();
});

await check('an unreachable service is not reported as an unknown ISBN', async () => {
  const { ctx, page } = await newPage({ routes: { google: false } });
  await page.unroute(/openlibrary\.org\/api\/books/);
  // Open Library answers, and simply has no record of it
  await page.route(/openlibrary\.org\/api\/books/, (r) => r.fulfill(json({})));
  await addIsbn(page);
  await page.waitForSelector('#add-status.error');
  const message = await page.textContent('#add-status');
  assert.doesNotMatch(message, /No record found/, `should not claim the book is unknown: ${message}`);
  await ctx.close();
});

await check('picks up a new version instead of serving its cached copy forever', async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true,
    'the service worker should be in charge before this means anything');

  // Stand in for a deploy: the server now holds different CSS.
  await ctx.route(/app\.css$/, (r) => r.fulfill({
    status: 200, contentType: 'text/css', body: 'body { background: rgb(1, 2, 3); }',
  }));
  await page.reload();
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(background, 'rgb(1, 2, 3)',
    'a cache-first worker would keep serving the old stylesheet and never update');
  await ctx.close();
});

await check('works with no network once installed', async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  await ctx.route(/covers\.openlibrary\.org\//, (r) => r.fulfill(image()));
  const page = await ctx.newPage();
  await page.goto(BASE);
  await seed(page, 1, { cover: 'https://covers.openlibrary.org/b/id/9-L.jpg' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForSelector('.book .cover');
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('.book');
  assert.deepEqual(await titles(page), ['One']);
  const coverShown = await page.evaluate(() => {
    const img = document.querySelector('.book .cover');
    return !img.hidden && img.complete && img.naturalWidth > 1;
  });
  assert.equal(coverShown, true, 'cached cover should still render offline');
  await ctx.close();
});

function stored(page, field) {
  return page.evaluate((f) => JSON.parse(localStorage.getItem('reading-list.v1')).books[0][f], field);
}

/* Put n books straight into storage, so ordering tests don't depend on lookups. */
async function seed(page, n, extra = {}) {
  const names = ['One', 'Two', 'Three', 'Four'];
  await page.evaluate(([count, titlesIn, more]) => {
    const books = Array.from({ length: count }, (_, i) => ({
      id: `seed${i}`, isbn: '', title: titlesIn[i], authors: ['An Author'], year: '2020', pages: 100,
      cover: '', coverChecked: true, publisher: '', source: 'test', status: 'toread', notes: '',
      rating: 0, addedAt: '', finishedAt: '', ...more,
    }));
    localStorage.setItem('reading-list.v1', JSON.stringify({ version: 1, books }));
  }, [n, names, extra]);
  await page.reload();
  await page.waitForSelector('.book');
}

await browser.close();
server.close();
console.log(results.join('\n'));
console.log(process.exitCode ? '\nsome checks failed' : `\nall ${results.length} checks passed`);
