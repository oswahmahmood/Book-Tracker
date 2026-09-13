/* End-to-end checks, run against a headless iPhone-sized Chromium.
 *
 *   npm install && npm test
 *
 * The book APIs are stubbed so the suite is deterministic and works offline;
 * what is being tested is this app's own behaviour around them. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';

// Lets Playwright's route stubs reach fetches made by the service worker, which
// the offline check depends on. Must be set before Playwright is loaded.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
const { chromium, devices } = await import('playwright');

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}/`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' };

// A real 24x24 PNG, stood in for cover art.
const COVER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR42mPQsImiCmIYNWjUoFGDRg0aNWjUoIE3CADGAquQoNoL3wAAAABJRU5ErkJggg==',
  'base64');

const ISBN = '9780571364886';
const olRecord = (cover) => ({ [`ISBN:${ISBN}`]: {
  title: 'Piranesi', authors: [{ name: 'Susanna Clarke' }], publishers: [{ name: 'Bloomsbury' }],
  publish_date: 'Sep 15, 2020', number_of_pages: 245,
  ...(cover ? { cover: { large: 'https://covers.openlibrary.org/b/id/9-L.jpg' } } : {}) } });

const SEARCH_DOCS = { docs: [
  { title: 'Wolf Hall', author_name: ['Hilary Mantel'], first_publish_year: 2009, isbn: ['9780007230181'], cover_i: 2 },
  { title: 'Bring Up the Bodies', author_name: ['Hilary Mantel'], first_publish_year: 2012, isbn: ['9780007315093'], cover_i: 3 },
] };

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const image = () => ({ status: 200, contentType: 'image/png', body: COVER_PNG });

function serve() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    try {
      const body = await readFile(file);
      const ext = file.slice(file.lastIndexOf('.'));
      res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (err) {
    results.push(`  FAIL ${name}\n       ${err.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
}

const titles = (page) => page.locator('.book .title').allTextContents();

const server = await serve();
const browser = await chromium.launch();

async function newPage({ serviceWorkers = 'block', routes = {} } = {}) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers });
  await ctx.route(/openlibrary\.org\/api\/books/, (r) => r.fulfill(json(routes.ol ?? olRecord(true))));
  await ctx.route(/openlibrary\.org\/search\.json/, (r) => r.fulfill(json(SEARCH_DOCS)));
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
  await page.fill('#query', 'wolf hall');
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

await check('moving a book between shelves keeps the other shelf intact', async () => {
  const { ctx, page } = await newPage();
  await seed(page, 3);
  await page.locator('.book').nth(1).locator('.open').click();
  await page.selectOption('#book-dialog select', 'reading');
  await page.fill('#book-dialog textarea', 'on the train');
  await page.click('#book-dialog button[type="submit"]');
  assert.deepEqual(await titles(page), ['One', 'Three']);
  assert.equal(await page.textContent('[data-count="reading"]'), '1');
  await page.reload();
  await page.click('.shelf[data-shelf="reading"]');
  assert.deepEqual(await titles(page), ['Two']);
  await page.locator('.book').first().locator('.open').click();
  assert.equal(await page.inputValue('#book-dialog textarea'), 'on the train');
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

await check('says something human when the lookup services are unreachable', async () => {
  const { ctx, page } = await newPage({ routes: { google: false } });
  await page.unroute(/openlibrary\.org\/api\/books/);
  await page.route(/openlibrary\.org\/api\/books/, (r) => r.abort());
  await addIsbn(page);
  await page.waitForSelector('#add-status.error');
  assert.match(await page.textContent('#add-status'), /offline/);
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
