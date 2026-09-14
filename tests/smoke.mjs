/* Live check against the real book services — no stubs.
 *
 *   npm run smoke
 *
 * Drives the actual app: searches for each book, adds the top result, and
 * reports what came back, including whether the cover image really rendered.
 * Needs a working internet connection, and can fail for reasons that are not
 * this app's fault (a service being down or rate-limiting you), which is why
 * it is kept out of `npm test`. */
import { serve } from './static-server.mjs';

const { chromium, devices } = await import('playwright');

const PORT = 8124;
const BASE = `http://127.0.0.1:${PORT}/`;

const WANTED = [
  { query: 'the good immigrant nikesh shukla', expect: /good immigrant/i },
  { query: 'the inner game of tennis gallwey', expect: /inner game/i },
  { query: 'mind the gap karen gurney', expect: /mind the gap/i },
  { query: 'the authority gap sieghart', expect: /authority gap/i },
];

const server = await serve(PORT);
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
await page.goto(BASE);

let resolved = 0;
for (const { query, expect } of WANTED) {
  console.log(`\n"${query}"`);
  await page.fill('#query', query);
  await page.click('#add-btn');

  try {
    await page.waitForSelector('#results:not([hidden]) .result, #add-status.error', { timeout: 20000 });
  } catch {
    console.log('  timed out waiting for a response');
    continue;
  }

  if (await page.locator('#add-status.error').count()) {
    console.log('  ' + (await page.textContent('#add-status')));
    continue;
  }

  const choices = await page.locator('#results .result').evaluateAll((els) =>
    els.slice(0, 3).map((el) => el.textContent.replace(/Add$/, '').trim()));
  choices.forEach((c, i) => console.log(`  ${i === 0 ? '→' : ' '} ${c}`));

  await page.locator('#results .result').first().click();
  await page.waitForSelector('.book');

  const book = await page.evaluate(() => {
    const books = JSON.parse(localStorage.getItem('reading-list.v1')).books;
    return books[books.length - 1];
  });
  if (!expect.test(book.title)) console.log(`  ! top result was "${book.title}", not what was asked for`);

  // give the cover touch-up a moment to settle
  await page.waitForTimeout(2500);
  const shown = await page.evaluate((id) => {
    const row = [...document.querySelectorAll('.book')].find((el) => el.dataset.id === id);
    const img = row?.querySelector('.cover');
    return !!img && !img.hidden && img.complete && img.naturalWidth > 1;
  }, book.id);

  const fresh = await page.evaluate((id) => JSON.parse(localStorage.getItem('reading-list.v1')).books.find((b) => b.id === id), book.id);
  console.log(`    added:  ${fresh.title}${fresh.subtitle ? ` — ${fresh.subtitle}` : ''}`);
  console.log(`    by:     ${(fresh.authors || []).join(', ') || '(no author listed)'}  ${fresh.year || ''}`);
  console.log(`    isbn:   ${fresh.isbn || '(none returned)'}   via ${fresh.source}`);
  console.log(`    cover:  ${shown ? 'renders' : 'MISSING'}  ${fresh.cover || ''}`);
  if (shown) resolved++;
}

console.log(`\n${resolved} of ${WANTED.length} books resolved with a cover.`);
await browser.close();
server.close();
process.exitCode = resolved === 0 ? 1 : 0;
