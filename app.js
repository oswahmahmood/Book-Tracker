/* Reading list — a personal to-read queue.
   Everything is stored in this browser (localStorage); nothing is sent anywhere
   except the two public book APIs used to look up covers and metadata. */
(() => {
  'use strict';

  const STORE_KEY = 'reading-list.v1';
  const SHELVES = ['toread', 'reading', 'read'];
  const SHELF_LABELS = { toread: 'To read', reading: 'Reading', read: 'Read' };

  /* One list of books you have not finished, with whatever you are actually
     reading floated to the top of it — a book on the go is not a different
     kind of thing from the one you will pick up next, it is just first. */
  const VIEWS = {
    unfinished: ['reading', 'toread'],
    rereads: null,   // not a status: a book in the rotation can be on any shelf
    read: ['read'],
  };
  const EMPTY_COPY = {
    unfinished: 'Nothing here yet. Add a book by its ISBN — the 13 digits under the barcode.',
    rereads: 'Nothing in the rotation. Open a book you love and turn on "read this again every so often".',
    read: 'Books you finish will collect here.',
  };

  const A_YEAR = 365.25 * 24 * 60 * 60 * 1000;
  const today = () => new Date().toISOString().slice(0, 10);
  const lastReadAt = (book) => (book.finishedAt ? Date.parse(book.finishedAt) : NaN);

  /* Due when the cycle has elapsed since it was last finished — and a book put
     in the rotation without a date is due now, since there is nothing saying
     otherwise. */
  function dueAgain(book, now = Date.now()) {
    if (!book.reread) return false;
    const last = lastReadAt(book);
    return Number.isNaN(last) || now - last >= rereadYears * A_YEAR;
  }

  function describeWhen(book) {
    const last = lastReadAt(book);
    if (Number.isNaN(last)) return 'Not logged as read yet — due now';
    const when = new Date(last).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const months = Math.round((rereadYears * A_YEAR - (Date.now() - last)) / (A_YEAR / 12));
    if (months <= 0) return `Last read ${when} · due now`;
    if (months === 1) return `Last read ${when} · due next month`;
    if (months < 12) return `Last read ${when} · due in ${months} months`;
    const years = Math.round(months / 12);
    return `Last read ${when} · due in ${years === 1 ? 'a year' : `${years} years`}`;
  }

  /* ---------------------------------------------------------------- state */

  // Declared before load(), which fills the two timestamps in as it reads.
  let rereadYears = 2; // one cycle for every book in the rotation
  let changedAt = 0;   // when the list last changed
  let exportedAt = 0;  // when a copy was last saved off the device
  let books = load();
  let view = 'unfinished';

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      rereadYears = Number(parsed?.rereadYears) || 2;
      changedAt = parsed?.changedAt || 0;
      exportedAt = parsed?.exportedAt || 0;
      return Array.isArray(parsed?.books) ? parsed.books.filter(isBook) : [];
    } catch (err) {
      console.warn('Could not read saved list', err);
      return [];
    }
  }

  function write() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ version: 1, books, rereadYears, changedAt, exportedAt }));
    } catch (err) {
      setStatus(addStatus, 'Could not save — this browser is out of storage space.', true);
    }
    markBackupState();
  }

  function save({ exported = false } = {}) {
    const now = Date.now();
    if (exported) exportedAt = now; else changedAt = now;
    write();
    if (!exported) pushSoon();
  }

  /* The list lives only in this browser, so an un-exported list is one bad tap
     from gone. Say so quietly but visibly. */
  function needsBackup() {
    return books.length > 0 && changedAt > exportedAt;
  }

  function markBackupState() {
    backupBtn.classList.toggle('needs-backup', needsBackup());
  }

  function describeBackupAge() {
    if (!books.length) return 'Nothing to back up yet.';
    if (sync && exportedAt) return 'Sync is on, so the list saves itself. No need to export by hand.';
    if (!exportedAt) {
      return 'You have never exported this list. It exists only on this device \u2014 '
        + 'deleting the Home Screen icon or clearing Safari\u2019s data would take it with it.';
    }
    const days = Math.floor((Date.now() - exportedAt) / 86400000);
    const when = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    return needsBackup()
      ? `Last exported ${when}, and you have added or changed books since.`
      : `Last exported ${when}. Nothing has changed since.`;
  }

  function isBook(b) { return b && typeof b === 'object' && typeof b.title === 'string'; }

  /* ----------------------------------------------------------------- ISBN */

  function normalizeIsbn(input) {
    return String(input).replace(/[^0-9Xx]/g, '').toUpperCase();
  }

  function isValidIsbn(raw) {
    const s = normalizeIsbn(raw);
    if (s.length === 10) {
      let sum = 0;
      for (let i = 0; i < 10; i++) {
        const c = s[i];
        const v = i === 9 && c === 'X' ? 10 : Number(c);
        if (Number.isNaN(v)) return false;
        sum += v * (10 - i);
      }
      return sum % 11 === 0;
    }
    if (s.length === 13) {
      if (!/^\d{13}$/.test(s)) return false;
      let sum = 0;
      for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
      return sum % 10 === 0;
    }
    return false;
  }

  /* ------------------------------------------------------------ book APIs */

  const serviceName = (url) => (url.includes('openlibrary.org') ? 'Open Library' : 'Google Books');

  async function fetchJSON(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) {
        // Keep the status: being turned away is a different problem from being
        // unable to reach anything, and they need different advice.
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, service: serviceName(url) });
      }
      return await res.json();
    } catch (err) {
      err.service = err.service || serviceName(url);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* Neither service needs an API key, and the price of that is being throttled
     when you look up a few books in a row. That is usually over in a second, so
     take the hint and try once more rather than reporting failure. */
  async function getJSON(url, ms = 9000) {
    try {
      return await fetchJSON(url, ms);
    } catch (err) {
      const worthRetrying = err.status === 429 || err.status >= 500;
      if (!worthRetrying) throw err;
      await wait(900);
      return fetchJSON(url, ms);
    }
  }

  /* Says what actually happened. "You may be offline" while the phone is plainly
     online sends you hunting for a problem you do not have. */
  function lookupFailure(errors) {
    const refused = errors.filter((err) => err.status);
    if (!refused.length || navigator.onLine === false) {
      return 'Couldn\u2019t reach the book databases \u2014 you may be offline.';
    }
    const busy = refused.filter((err) => err.status === 429 || err.status >= 500);
    const detail = refused.map((err) => `${err.service} ${err.status}`).join(', ');
    return busy.length
      ? `The book databases are busy and turned the request away (${detail}). Wait a moment and try again.`
      : `The book databases refused the request (${detail}). The ISBN from the back cover may still work.`;
  }

  const failure = (errors) => Object.assign(new Error('lookup-failed'), { userMessage: lookupFailure(errors) });

  function googleCover(links) {
    const src = links?.thumbnail || links?.smallThumbnail;
    if (!src) return '';
    return src.replace(/^http:/, 'https:').replace(/&edge=curl/, '');
  }

  function fromOpenLibrary(data, isbn) {
    return {
      isbn,
      title: data.title || 'Untitled',
      subtitle: data.subtitle || '',
      authors: (data.authors || []).map((a) => a.name).filter(Boolean),
      publisher: (data.publishers || [])[0]?.name || '',
      year: (String(data.publish_date || '').match(/\d{4}/) || [''])[0],
      pages: data.number_of_pages || null,
      cover: data.cover?.large || data.cover?.medium
        || (isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false` : ''),
      info: data.url || '',
      source: 'Open Library',
    };
  }

  function fromGoogle(item, isbn) {
    const v = item.volumeInfo || {};
    const ids = v.industryIdentifiers || [];
    const best = ids.find((i) => i.type === 'ISBN_13') || ids.find((i) => i.type === 'ISBN_10');
    return {
      isbn: isbn || best?.identifier || '',
      title: v.title || 'Untitled',
      subtitle: v.subtitle || '',
      authors: v.authors || [],
      publisher: v.publisher || '',
      year: (String(v.publishedDate || '').match(/\d{4}/) || [''])[0],
      pages: v.pageCount || null,
      cover: googleCover(v.imageLinks),
      info: v.infoLink || v.canonicalVolumeLink || '',
      source: 'Google Books',
    };
  }

  /* Open Library records sometimes carry metadata but no cover art, and its
     cover server 404s rather than saying so up front — so confirm the image
     really loads, and borrow Google's thumbnail when it doesn't. */
  function imageLoads(url) {
    return new Promise((resolve) => {
      const img = new Image();
      const done = (ok) => { img.onload = img.onerror = null; resolve(ok); };
      img.onload = () => done(img.naturalWidth > 1);
      img.onerror = () => done(false);
      img.src = url;
      setTimeout(() => done(false), 8000);
    });
  }

  /* `reached` says whether we actually heard back — "this book has no cover"
     and "we couldn't ask" need to be told apart, so only the first is final. */
  async function googleCoverFor(isbn) {
    if (!isbn) return { cover: '', reached: false };
    try {
      const data = await getJSON(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
      return { cover: googleCover(data?.items?.[0]?.volumeInfo?.imageLinks), reached: true };
    } catch (err) {
      return { cover: '', reached: false };
    }
  }

  /* Runs after the book is already on the list, so a slow or missing cover
     never holds up the add. */
  function attachCover(book) {
    withCover(book).then((resolved) => {
      if (!byId(book.id)) return;
      const changed = resolved.cover !== book.cover;
      book.cover = resolved.cover;
      book.coverChecked = resolved.checked;
      save();
      if (changed) render();
    });
  }

  async function withCover(info) {
    if (info.cover && await imageLoads(info.cover)) return { cover: info.cover, checked: true };
    if (info.source === 'Google Books') {
      return { cover: navigator.onLine ? '' : info.cover, checked: navigator.onLine };
    }
    const { cover: alt, reached } = await googleCoverFor(info.isbn);
    if (alt && await imageLoads(alt)) return { cover: alt, checked: true };
    // Keep an unverified URL rather than dropping it: if we simply couldn't
    // reach the servers, it is still the best candidate to retry next time.
    return { cover: reached ? '' : info.cover, checked: reached };
  }

  /* Look an ISBN up. Open Library first (open data, good covers), Google Books
     as a fallback — between them the hit rate is high. */
  async function lookupIsbn(isbn) {
    const errors = [];
    try {
      const key = `ISBN:${isbn}`;
      const data = await getJSON(`https://openlibrary.org/api/books?bibkeys=${key}&format=json&jscmd=data`);
      if (data && data[key]) return fromOpenLibrary(data[key], isbn);
    } catch (err) { errors.push(err); }

    try {
      const data = await getJSON(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
      if (data?.items?.length) return fromGoogle(data.items[0], isbn);
    } catch (err) { errors.push(err); }

    // One service saying "no match" while the other never answered is not
    // proof the book is unknown — say what went wrong instead of blaming
    // the ISBN.
    if (errors.length) throw failure(errors);
    return null;
  }

  function fromOpenLibraryDoc(d) {
    return {
      isbn: (d.isbn || []).find((i) => i.length === 13) || (d.isbn || [])[0] || '',
      title: d.title || 'Untitled',
      subtitle: d.subtitle || '',
      authors: d.author_name || [],
      publisher: (d.publisher || [])[0] || '',
      year: d.first_publish_year ? String(d.first_publish_year) : '',
      pages: d.number_of_pages_median || null,
      cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : '',
      source: 'Open Library',
    };
  }

  const searchKey = (info) => `${info.title.toLowerCase().trim()}|${(info.authors[0] || '').toLowerCase().trim()}`;

  /* Common titles ("Mind the Gap" has a dozen namesakes) come back ranked by
     whatever the service thinks is popular, which buries the book you meant.
     Score an exact title match above a partial one, and prefer entries that
     carry enough detail — a cover, an author — to be recognisable. */
  function rankResults(results, query) {
    const wanted = query.toLowerCase().trim();
    const score = (info) => {
      const title = info.title.toLowerCase().trim();
      const authors = info.authors.join(' ').toLowerCase();
      let n = 0;
      if (title === wanted) n += 6;
      else if (title.startsWith(wanted)) n += 4;
      else if (title.includes(wanted)) n += 2;
      // the whole query matching title-plus-author is the strongest signal of all
      if (wanted.split(/\s+/).every((word) => `${title} ${authors}`.includes(word))) n += 3;
      if (info.cover) n += 1;
      if (info.authors.length) n += 1;
      return n;
    };
    return results
      .map((info, i) => ({ info, i, n: score(info) }))
      .sort((a, b) => b.n - a.n || a.i - b.i)
      .map((entry) => entry.info);
  }

  function mergeResults(lists) {
    const seen = new Map();
    for (const info of lists.flat()) {
      const key = searchKey(info);
      const kept = seen.get(key);
      if (!kept) {
        seen.set(key, info);
        continue;
      }
      // Same book from both services: keep whichever detail each one has.
      kept.cover = kept.cover || info.cover;
      kept.isbn = kept.isbn || info.isbn;
      kept.subtitle = kept.subtitle || info.subtitle;
      kept.pages = kept.pages || info.pages;
      kept.publisher = kept.publisher || info.publisher;
    }
    return [...seen.values()];
  }

  /* Ask both services every time and merge — not one as the other's fallback.
     They rank differently, and between them the book you meant is usually in
     the first few. */
  async function searchTitle(query) {
    const q = encodeURIComponent(query);
    const fields = 'title,subtitle,author_name,first_publish_year,number_of_pages_median,isbn,cover_i,publisher';

    const [openLibrary, google] = await Promise.allSettled([
      getJSON(`https://openlibrary.org/search.json?q=${q}&limit=12&fields=${fields}`)
        .then((data) => (data?.docs || []).map(fromOpenLibraryDoc)),
      getJSON(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=12`)
        .then((data) => (data?.items || []).map((item) => fromGoogle(item, ''))),
    ]);

    if (openLibrary.status === 'rejected' && google.status === 'rejected') {
      throw failure([openLibrary.reason, google.reason]);
    }

    const merged = mergeResults([openLibrary.value || [], google.value || []]);
    return rankResults(merged, query).slice(0, 12);
  }

  /* ----------------------------------------------------------------- list */

  const listEl = document.getElementById('book-list');
  const emptyEl = document.getElementById('empty');
  const hintEl = document.getElementById('reorder-hint');
  const template = document.getElementById('book-template');

  /* The order within each status is the order you set; the statuses themselves
     are ranked, so reading always sits above to-read. */
  function visible() {
    if (view === 'rereads') {
      // Longest unread first — whatever has been neglected most is the top.
      return books
        .filter((b) => b.reread)
        .sort((a, b) => {
          const left = lastReadAt(a);
          const right = lastReadAt(b);
          if (Number.isNaN(left) && Number.isNaN(right)) return 0;
          if (Number.isNaN(left)) return -1;
          if (Number.isNaN(right)) return 1;
          return left - right;
        });
    }
    const wanted = VIEWS[view];
    return books
      .filter((b) => wanted.includes(b.status))
      .sort((a, b) => wanted.indexOf(a.status) - wanted.indexOf(b.status));
  }

  function render() {
    const rows = visible();
    listEl.textContent = '';

    /* Headings rather than badges: "which am I reading, what's next" is a
       question about groups, and a label on a group says it once and plainly
       instead of decorating each row and hoping the colour carries it. */
    if (view === 'unfinished') {
      const reading = rows.filter((b) => b.status === 'reading');
      const queue = rows.filter((b) => b.status === 'toread');
      /* Books in the rotation are not on this shelf — they have been read —
         but once they come round again they are as pickable as anything else,
         so they surface here rather than waiting to be looked for. */
      const due = books
        .filter((b) => b.status === 'read' && dueAgain(b))
        .sort((a, b) => (lastReadAt(a) || 0) - (lastReadAt(b) || 0));

      if (reading.length) {
        listEl.append(groupHeading('Reading now', 'reading'));
        for (const book of reading) listEl.append(renderBook(book));
      }
      if (queue.length) {
        listEl.append(groupHeading('Next up', 'next'));
        listEl.append(renderBook(queue[0]));
      }
      if (due.length) {
        listEl.append(groupHeading(`Due again — ${due.length}`, 'due'));
        for (const book of due) listEl.append(renderBook(book, { showWhen: true }));
      }
      if (queue.length > 1) {
        listEl.append(groupHeading(`Then — ${queue.length - 1} more`, 'later'));
        for (const book of queue.slice(1)) listEl.append(renderBook(book));
      }
    } else if (view === 'rereads') {
      for (const book of rows) listEl.append(renderBook(book, { showWhen: true }));
    } else {
      for (const book of rows) listEl.append(renderBook(book));
    }

    listEl.classList.toggle('is-queue', view === 'unfinished');
    document.getElementById('reread-settings').hidden = view !== 'rereads';
    emptyEl.hidden = rows.length > 0;
    emptyEl.textContent = EMPTY_COPY[view];
    hintEl.hidden = view !== 'unfinished' || rows.length < 2;

    for (const [name, statuses] of Object.entries(VIEWS)) {
      const el = document.querySelector(`[data-count="${name}"]`);
      if (!el) continue;
      el.textContent = statuses
        ? books.filter((b) => statuses.includes(b.status)).length
        : books.filter((b) => b.reread).length;
    }
  }

  function groupHeading(text, kind) {
    const li = document.createElement('li');
    li.className = `group-head is-${kind}`;
    const h = document.createElement('h2');
    h.textContent = text;
    li.append(h);
    return li;
  }

  function renderBook(book, { showWhen = false } = {}) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.dataset.id = book.id;
    if (book.status === 'reading') node.classList.add('is-reading');
    if (showWhen && dueAgain(book)) node.classList.add('is-due');

    const when = node.querySelector('.when');
    if (showWhen) when.textContent = describeWhen(book);
    when.hidden = !showWhen;

    const img = node.querySelector('.cover');
    const fallback = node.querySelector('.cover-fallback');
    if (book.cover) {
      img.src = book.cover;
      img.addEventListener('error', () => { img.hidden = true; fallback.textContent = 'No cover'; }, { once: true });
    } else {
      img.hidden = true;
      fallback.textContent = 'No cover';
    }

    node.querySelector('.title').textContent = book.title;
    node.querySelector('.author').textContent = (book.authors || []).join(', ') || 'Unknown author';
    node.querySelector('.sub').textContent = [book.year, book.pages ? `${book.pages} pp` : ''].filter(Boolean).join(' · ');

    // Why you wanted it is the thing worth seeing at a glance, so it goes in
    // the row; the rest of a long note stays in the detail sheet.
    const note = node.querySelector('.note');
    const written = (book.notes || '').trim();
    note.textContent = written;
    note.hidden = !written;

    node.querySelector('.open').addEventListener('click', () => openDetail(book.id));

    // Tapping anywhere on the row opens it — the drag handle and the arrows do
    // their own jobs, so they are left alone.
    node.addEventListener('click', (event) => {
      if (event.target.closest('.grip, .up, .down, .open')) return;
      openDetail(book.id);
    });
    node.querySelector('.up').addEventListener('click', () => nudge(book.id, -1));
    node.querySelector('.down').addEventListener('click', () => nudge(book.id, 1));
    node.querySelector('.grip').addEventListener('pointerdown', (e) => startDrag(e, node));
    return node;
  }

  function byId(id) { return books.find((b) => b.id === id); }

  function showNote(book) {
    const note = listEl.querySelector(`[data-id="${book.id}"] .note`);
    if (!note) return;
    const written = (book.notes || '').trim();
    note.textContent = written;
    note.hidden = !written;
  }

  /* Rewrite the global array so the books on this shelf take the order given,
     leaving books on other shelves where they are. */
  function applyOrder(ids, forStatus) {
    const wanted = forStatus ? [forStatus] : VIEWS[view];
    let moved = false;

    for (const status of wanted) {
      const slots = [];
      books.forEach((b, i) => { if (b.status === status) slots.push(i); });
      // Only this status's books, in the order the screen now shows them.
      const reordered = ids.map(byId).filter((b) => b && b.status === status);
      if (reordered.length !== slots.length) continue;

      // A tap on the drag handle ends as a reorder to the same order. Saving
      // that would bump the change time, light the backup warning and spend a
      // sync write on nothing.
      if (slots.every((slot, i) => books[slot] === reordered[i])) continue;

      slots.forEach((slot, i) => { books[slot] = reordered[i]; });
      moved = true;
    }

    if (moved) save();
  }

  function nudge(id, delta) {
    const ids = visible().map((b) => b.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    applyOrder(ids);
    render();
  }

  function moveToTop(id) {
    const book = byId(id);
    if (!book) return;
    // Its shelf, not the one on screen: the sheet that asked may have moved it.
    const ids = books.filter((b) => b.status === book.status).map((b) => b.id);
    const from = ids.indexOf(id);
    if (from <= 0) return;
    ids.unshift(ids.splice(from, 1)[0]);
    applyOrder(ids, book.status);
    render();
  }

  /* -------------------------------------------------------------- dragging */

  let drag = null;

  /* Pointer capture is no use here: reordering moves the dragged row in the DOM,
     which releases the capture. Listen on the window for the duration instead. */
  function startDrag(event, node) {
    if (drag || event.button > 0) return;
    event.preventDefault();
    drag = { node, pointerId: event.pointerId };
    node.classList.add('dragging');
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  }

  function onDragMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const target = rowUnder(event.clientX, event.clientY);
    if (!target || target === drag.node) return;
    const box = target.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    target.insertAdjacentElement(after ? 'afterend' : 'beforebegin', drag.node);
  }

  function rowUnder(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.parentElement === listEl && el.classList.contains('book')) return el;
    }
    return null;
  }

  function endDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.node.classList.remove('dragging');
    drag = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    applyOrder([...listEl.children].filter((el) => el.dataset.id).map((el) => el.dataset.id));
    render();
  }

  /* ---------------------------------------------------------------- adding */

  const backupBtn = document.getElementById('backup-btn');
  const form = document.getElementById('add-form');
  const queryInput = document.getElementById('query');
  const addBtn = document.getElementById('add-btn');
  const addStatus = document.getElementById('add-status');
  const resultsEl = document.getElementById('results');
  const resultsList = document.getElementById('results-list');

  function setStatus(el, message, isError = false) {
    el.textContent = message;
    el.classList.toggle('error', isError);
  }

  function addBook(info) {
    const isbn = info.isbn ? normalizeIsbn(info.isbn) : '';
    const dupe = books.find((b) => (isbn && b.isbn === isbn)
      || (b.title.toLowerCase() === info.title.toLowerCase()
          && (b.authors || []).join() === (info.authors || []).join()));
    if (dupe) {
      setStatus(addStatus, `Already on your ${SHELF_LABELS[dupe.status].toLowerCase()} shelf: ${dupe.title}`);
      return null;
    }
    const book = {
      id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      ...info,
      isbn,
      status: 'toread',
      notes: '',
      rating: 0,
      addedAt: new Date().toISOString(),
      finishedAt: '',
    };
    books.push(book);
    save();
    view = 'unfinished';
    syncShelfButtons();
    render();
    setStatus(addStatus, `Added ${book.title}.`);
    return book;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = queryInput.value.trim();
    if (!raw) return;
    hideResults();
    addBtn.disabled = true;

    try {
      const maybeIsbn = normalizeIsbn(raw);
      if ((maybeIsbn.length === 10 || maybeIsbn.length === 13) && /^\d/.test(maybeIsbn)) {
        if (!isValidIsbn(maybeIsbn)) {
          setStatus(addStatus, 'That ISBN’s check digit doesn’t add up — worth a re-read of the barcode.', true);
          return;
        }
        setStatus(addStatus, 'Looking it up…');
        const info = await lookupIsbn(maybeIsbn);
        if (!info) {
          setStatus(addStatus, 'No record found for that ISBN. Try searching by title instead.', true);
          return;
        }
        const added = addBook(info);
        if (added) {
          queryInput.value = '';
          attachCover(added);
        }
      } else {
        setStatus(addStatus, 'Searching…');
        const results = await searchTitle(raw);
        if (!results.length) {
          setStatus(addStatus, 'Nothing found. Try a different spelling, or the ISBN.', true);
          return;
        }
        showResults(results);
        setStatus(addStatus, '');
      }
    } catch (err) {
      setStatus(addStatus, err.userMessage || 'Lookup failed. Try again in a moment.', true);
    } finally {
      addBtn.disabled = false;
    }
  });

  function showResults(results) {
    resultsList.textContent = '';
    for (const info of results) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'result';

      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      if (info.cover) img.src = info.cover;

      const meta = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = info.title;
      const rest = document.createElement('span');
      rest.className = 'sub muted';
      rest.textContent = ' ' + [(info.authors || []).join(', '), info.year].filter(Boolean).join(' · ');
      meta.append(title, rest);

      const add = document.createElement('span');
      add.className = 'muted';
      add.textContent = 'Add';

      btn.append(img, meta, add);
      btn.addEventListener('click', () => {
        const added = addBook(info);
        if (!added) return;
        queryInput.value = '';
        hideResults();
        attachCover(added);
      });
      li.append(btn);
      resultsList.append(li);
    }
    resultsEl.hidden = false;
  }

  function hideResults() {
    resultsEl.hidden = true;
    resultsList.textContent = '';
  }

  document.getElementById('results-close').addEventListener('click', () => {
    hideResults();
    setStatus(addStatus, '');
  });

  /* --------------------------------------------------------------- shelves */

  const rereadYearsInput = document.getElementById('reread-years');
  rereadYearsInput.value = String(rereadYears);
  rereadYearsInput.addEventListener('change', () => {
    rereadYears = Number(rereadYearsInput.value) || 2;
    save();
    render();
  });

  const shelfNav = document.getElementById('shelves');

  shelfNav.addEventListener('click', (event) => {
    const btn = event.target.closest('.shelf');
    if (!btn) return;
    view = btn.dataset.shelf;
    syncShelfButtons();
    render();
  });

  function syncShelfButtons() {
    for (const btn of shelfNav.querySelectorAll('.shelf')) {
      btn.classList.toggle('is-active', btn.dataset.shelf === view);
    }
  }

  /* ---------------------------------------------------------------- detail */

  const dialog = document.getElementById('book-dialog');
  const dialogBody = document.getElementById('dialog-body');
  const dialogTitle = document.getElementById('dialog-title');

  /* Nothing is redrawn when the sheet closes: each control in it already
     updates what it changed — notes write straight to their own row, shelf
     changes and removal redraw the list themselves. Rebuilding every row on
     close replaced elements that nothing had touched, which is churn, and
     briefly leaves the list holding nodes that have just been thrown away. */

  function openDetail(id) {
    const book = byId(id);
    if (!book) return;
    dialogTitle.textContent = book.title;
    dialogBody.textContent = '';

    const head = document.createElement('div');
    head.className = 'detail-head';
    const img = document.createElement('img');
    img.alt = '';
    if (book.cover) img.src = book.cover;
    const facts = document.createElement('div');
    const lines = [
      (book.authors || []).join(', '),
      book.subtitle,
      [book.publisher, book.year].filter(Boolean).join(', '),
      book.pages ? `${book.pages} pages` : '',
      book.isbn ? `ISBN ${book.isbn}` : '',
      book.source ? `via ${book.source}` : '',
    ].filter(Boolean);
    for (const line of lines) {
      const p = document.createElement('p');
      p.textContent = line;
      p.className = 'sub muted';
      facts.append(p);
    }
    head.append(img, facts);

    const statusField = document.createElement('label');
    statusField.className = 'field';
    statusField.append(labelSpan('Shelf'));
    const select = document.createElement('select');
    for (const s of SHELVES) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = SHELF_LABELS[s];
      opt.selected = book.status === s;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      const wasRead = book.status === 'read';
      book.status = select.value;
      /* Each finish stamps the date, which is what restarts a reread cycle.
         Starting it again keeps the old date rather than clearing it: that is
         the record of when you last got to the end. */
      if (book.status === 'read' && !wasRead) book.finishedAt = today();
      save();
      render();
    });
    statusField.append(select);

    const notesField = document.createElement('label');
    notesField.className = 'field';
    notesField.append(labelSpan('Why this one / notes'));
    const notes = document.createElement('textarea');
    notes.rows = 3;
    notes.value = book.notes || '';
    notes.addEventListener('input', () => {
      book.notes = notes.value;
      save();
      showNote(book);  // the row behind the sheet keeps up as you type
    });
    notesField.append(notes);

    const rotation = document.createElement('div');
    rotation.className = 'field';
    const rotationLabel = document.createElement('label');
    rotationLabel.className = 'check';
    const rotationBox = document.createElement('input');
    rotationBox.type = 'checkbox';
    rotationBox.checked = !!book.reread;
    const rotationText = document.createElement('span');
    rotationText.textContent = 'Read this again every so often';
    rotationLabel.append(rotationBox, rotationText);

    const rotationWhen = document.createElement('p');
    rotationWhen.className = 'sub muted';

    const finishedAgain = document.createElement('button');
    finishedAgain.type = 'button';
    finishedAgain.className = 'ghost';
    finishedAgain.textContent = 'I finished it again today';

    const showRotation = () => {
      rotationWhen.textContent = book.reread ? describeWhen(book) : '';
      rotationWhen.hidden = !book.reread;
      finishedAgain.hidden = !book.reread;
    };

    rotationBox.addEventListener('change', () => {
      book.reread = rotationBox.checked;
      save();
      showRotation();
      render();
    });

    finishedAgain.addEventListener('click', () => {
      book.finishedAt = today();
      book.status = 'read';
      select.value = 'read';
      save();
      showRotation();
      render();
    });

    showRotation();
    rotation.append(labelSpan('Rereading'), rotationLabel, rotationWhen, finishedAgain);

    const links = document.createElement('div');
    links.className = 'field';
    links.append(labelSpan('Read more about it'));
    const linkRow = document.createElement('div');
    linkRow.className = 'links';
    for (const { label, href } of bookLinks(book)) {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'book-link';
      a.textContent = label;
      linkRow.append(a);
    }
    links.append(linkRow);

    const actions = document.createElement('div');
    actions.className = 'stack';

    const top = document.createElement('button');
    top.type = 'button';
    top.className = 'ghost';
    top.textContent = 'Move to the top of this shelf';
    top.addEventListener('click', () => { moveToTop(book.id); dialog.close(); });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Remove from list';
    remove.addEventListener('click', () => {
      if (!confirm(`Remove ${book.title}?`)) return;
      books = books.filter((b) => b.id !== book.id);
      save();
      render();
      dialog.close();
    });

    actions.append(top, remove);
    dialogBody.append(head, statusField, notesField, rotation, links, actions);
    dialog.showModal();
  }

  /* Links are built from the ISBN where there is one, since that names an
     edition exactly; a title-and-author search is the fallback. */
  function bookLinks(book) {
    const isbn = book.isbn;
    const query = encodeURIComponent(isbn || [book.title, (book.authors || [])[0]].filter(Boolean).join(' '));
    const google = book.info && book.info.includes('google')
      ? book.info
      : (isbn ? `https://books.google.com/books?vid=ISBN${isbn}` : `https://www.google.com/search?tbm=bks&q=${query}`);
    const openLibrary = book.info && book.info.includes('openlibrary')
      ? book.info
      : (isbn ? `https://openlibrary.org/isbn/${isbn}` : `https://openlibrary.org/search?q=${query}`);
    return [
      { label: 'Google Books', href: google },
      { label: 'Open Library', href: openLibrary },
      { label: 'Amazon', href: `https://www.amazon.co.uk/s?k=${query}` },
    ];
  }

  function labelSpan(text) {
    const span = document.createElement('span');
    span.textContent = text;
    return span;
  }

  /* ------------------------------------------------------------- goodreads */

  /* Goodreads closed its API in 2020, so the export file is the only way in.
     Quoted fields hold commas and whole paragraphs of review text, including
     line breaks, so this has to be a real parser rather than a split on ",". */
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c !== '"') { field += c; continue; }
        if (text[i + 1] === '"') { field += '"'; i++; continue; }  // "" is one quote
        quoted = false;
      } else if (c === '"') {
        quoted = true;
      } else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (c !== '\r') {
        field += c;
      }
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  // Goodreads writes ISBNs as ="9780571364886" so spreadsheets keep the zeroes.
  const csvIsbn = (value) => (value || '').replace(/[^0-9Xx]/g, '').toUpperCase();

  function plainText(html) {
    return (html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  }

  const GOODREADS_SHELVES = {
    'to-read': 'toread',
    'currently-reading': 'reading',
    read: 'read',
  };

  function fromGoodreadsRow(get) {
    const title = (get('Title') || '').trim();
    if (!title) return null;

    const status = GOODREADS_SHELVES[(get('Exclusive Shelf') || '').trim()];
    if (!status) return null;  // a custom shelf this app has no place for

    const authors = [get('Author'), ...(get('Additional Authors') || '').split(',')]
      .map((a) => (a || '').trim())
      .filter(Boolean);

    const isbn = csvIsbn(get('ISBN13')) || csvIsbn(get('ISBN'));
    const rating = Number(get('My Rating')) || 0;
    const pages = Number(get('Number of Pages')) || null;
    const year = (get('Year Published') || get('Original Publication Year') || '').trim();
    const read = (get('Date Read') || '').trim().replace(/\//g, '-');

    return {
      id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      isbn: isValidIsbn(isbn) ? isbn : '',
      title,
      subtitle: '',
      authors,
      publisher: (get('Publisher') || '').trim(),
      year: (year.match(/\d{4}/) || [''])[0],
      pages,
      cover: '',
      coverChecked: false,   // fetched gradually once it is on the list
      info: '',
      source: 'Goodreads',
      status,
      notes: plainText(get('My Review')),
      rating,
      addedAt: (get('Date Added') || '').trim().replace(/\//g, '-'),
      finishedAt: status === 'read' ? read : '',
    };
  }

  /* Identity for "is this already here": any of ISBN, id, or title and author.
     Goodreads rows carry no id of ours, so title and author does the work. */
  function identities(book) {
    return [
      book.isbn ? `isbn:${book.isbn}` : '',
      book.id ? `id:${book.id}` : '',
      `name:${(book.title || '').toLowerCase().trim()}|${((book.authors || [])[0] || '').toLowerCase().trim()}`,
    ].filter(Boolean);
  }

  function importGoodreads(text, { skipFinished = false } = {}) {
    const rows = parseCsv(text);
    const headers = rows.shift() || [];
    if (!headers.includes('Title') || !headers.includes('Exclusive Shelf')) {
      throw new Error('That does not look like a Goodreads export.');
    }

    const seen = new Set(books.flatMap(identities));
    const counts = { toread: 0, reading: 0, read: 0 };
    let added = 0;
    let skipped = 0;

    for (const row of rows) {
      if (!row.some((cell) => cell.trim())) continue;
      const get = (name) => row[headers.indexOf(name)];
      const book = fromGoodreadsRow(get);
      if (!book) continue;
      if (skipFinished && book.status === 'read') continue;

      const keys = identities(book);
      if (keys.some((k) => seen.has(k))) { skipped++; continue; }
      keys.forEach((k) => seen.add(k));
      books.push(book);
      counts[book.status]++;
      added++;
    }

    if (added) save();
    return { added, skipped, counts };
  }

  /* Covers are looked up one at a time with a pause between: a library of
     several hundred books arriving at once should not land on Open Library as
     several hundred simultaneous requests. */
  async function resolveCoversGradually(limit = 25) {
    const pending = books.filter((b) => !b.coverChecked && b.isbn).slice(0, limit);
    for (const book of pending) {
      if (!byId(book.id)) continue;
      await withCover(book).then((resolved) => {
        if (!byId(book.id)) return;
        const changed = resolved.cover !== book.cover;
        book.cover = resolved.cover;
        book.coverChecked = resolved.checked;
        write();
        if (changed) render();
      });
      await wait(200);
    }
  }

  /* ------------------------------------------------------------------ sync */

  const SYNC_KEY = 'reading-list.sync';
  let sync = loadSync();
  let pushTimer = null;
  let syncState = '';   // what the last exchange with the worker did

  function loadSync() {
    try {
      const raw = localStorage.getItem(SYNC_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed?.url && parsed?.key ? parsed : null;
    } catch (err) {
      return null;
    }
  }

  function saveSync(next) {
    sync = next;
    if (next) localStorage.setItem(SYNC_KEY, JSON.stringify(next));
    else localStorage.removeItem(SYNC_KEY);
  }

  /* The key is the whole security model: long enough that it cannot be guessed,
     and the only thing that says this list is yours. */
  function newKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const listUrl = () => `${sync.url.replace(/\/+$/, '')}/list/${sync.key}`;

  function setSyncState(text) {
    syncState = text;
    const el = document.getElementById('sync-state');
    if (el) el.textContent = text;
  }

  /* Changes arrive a keystroke at a time; wait for the typing to stop. */
  function pushSoon() {
    if (!sync) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 1200);
  }

  async function push() {
    if (!sync) return;
    const sentAt = changedAt;
    try {
      const res = await fetch(listUrl(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, changedAt, rereadYears, books }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Saved somewhere other than this phone, which is what a backup is — but
      // only for what was actually sent. An edit made while this was in flight
      // is not up there yet, and must not be marked as though it were.
      if (changedAt === sentAt) {
        exportedAt = Date.now();
        write();
        setSyncState('Saved to the cloud just now.');
      } else {
        setSyncState('Saved — with more to send.');
        pushSoon();
      }
    } catch (err) {
      setSyncState('Could not reach your sync address — the list is still safe on this phone, and will go up next time.');
    }
  }

  /* Last edit wins. Per-book merging would be better and is a great deal more
     code; with one person and a phone, the newer list is the right one. */
  async function pull() {
    if (!sync) return;
    try {
      const res = await fetch(listUrl(), { headers: { Accept: 'application/json' } });
      if (res.status === 404) {
        if (books.length) await push();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const remote = await res.json();
      if (!Array.isArray(remote?.books)) throw new Error('unexpected reply');

      const remoteChanged = remote.changedAt || 0;
      // A list saved before this app tracked change times has no timestamp at
      // all, so "both at zero" has to mean "take what the cloud has" whenever
      // there is nothing here to lose. Otherwise a new phone stays empty.
      const nothingHere = books.length === 0 && remote.books.length > 0;

      if (remoteChanged > changedAt || nothingHere) {
        books = remote.books.filter(isBook);
        if (remote.rereadYears) rereadYears = Number(remote.rereadYears) || rereadYears;
        changedAt = remote.changedAt || Date.now();
        exportedAt = Date.now();
        write();
        render();
        setSyncState(`Brought ${books.length} book${books.length === 1 ? '' : 's'} down from the cloud.`);
      } else if (changedAt > remoteChanged || books.length) {
        await push();
      } else {
        setSyncState('Up to date with the cloud.');
      }
    } catch (err) {
      setSyncState('Could not reach your sync address just now.');
    }
  }

  function connectSync(rawUrl, key) {
    const url = rawUrl.trim().replace(/\/+$/, '');
    if (!/^https:\/\/[^\s]+$/.test(url)) {
      setSyncState('That does not look like a web address — it should start with https://');
      return false;
    }
    saveSync({ url, key: key || sync?.key || newKey() });
    setSyncState('Connecting\u2026');
    pull();
    return true;
  }

  /* A link that sets another device up: it carries the address and the key,
     which is exactly why it should not be posted anywhere public. */
  function syncLink() {
    const here = `${location.origin}${location.pathname}`;
    return `${here}#sync=${encodeURIComponent(sync.url)}&key=${encodeURIComponent(sync.key)}`;
  }

  /* Returns true when a link was acted on, so the caller does not also pull.
     A sync link points this list at somebody's server and hands over the key,
     so arriving at one is a request to be agreed to, not an instruction: a
     link from anyone else would otherwise upload the list to them, or replace
     it with theirs. */
  function adoptLinkFromHash() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const url = hash.get('sync');
    const key = hash.get('key');
    if (!url || !key) return false;
    history.replaceState(null, '', location.pathname);  // keep it out of the address bar

    let host;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return false;
      host = parsed.host;
    } catch (err) {
      return false;
    }

    if (sync && sync.url === url && sync.key === key) return false;  // already set up

    const replacing = sync
      ? '\n\nThis replaces the sync you already have set up.'
      : '';
    const agreed = confirm(
      `Sync this reading list with ${host}?${replacing}\n\n`
      + 'Only agree if this link is yours. Whoever controls that address can read '
      + 'and change your list.');
    if (!agreed) return false;

    return connectSync(url, key);
  }

  /* ---------------------------------------------------------------- backup */

  const backupDialog = document.getElementById('backup-dialog');
  const backupStatus = document.getElementById('backup-status');
  const backupAge = document.getElementById('backup-age');

  const syncUrlInput = document.getElementById('sync-url');
  const syncConnectBtn = document.getElementById('sync-connect');
  const syncCopyBtn = document.getElementById('sync-copy');
  const syncOffBtn = document.getElementById('sync-off');

  function showSyncControls() {
    const on = !!sync;
    syncUrlInput.value = sync?.url || syncUrlInput.value;
    syncConnectBtn.textContent = on ? 'Update sync address' : 'Turn sync on';
    syncCopyBtn.hidden = !on;
    syncOffBtn.hidden = !on;
    setSyncState(syncState || (on ? 'Sync is on.' : 'Sync is off — this list is only on this device.'));
  }

  backupBtn.addEventListener('click', () => {
    setStatus(backupStatus, '');
    backupAge.textContent = describeBackupAge();
    backupAge.classList.toggle('warn', needsBackup() || !exportedAt);
    showSyncControls();
    backupDialog.showModal();
  });

  syncConnectBtn.addEventListener('click', () => {
    if (connectSync(syncUrlInput.value)) showSyncControls();
  });

  syncCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(syncLink());
      setSyncState('Link copied. Open it on the other device — and keep it to yourself, it is the key to this list.');
    } catch (err) {
      setSyncState(syncLink());
    }
  });

  syncOffBtn.addEventListener('click', () => {
    if (!confirm('Turn sync off? The list stays on this phone, but stops saving itself anywhere else.')) return;
    saveSync(null);
    syncState = '';
    showSyncControls();
  });

  document.getElementById('export-btn').addEventListener('click', async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const file = new File(
      [JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), books }, null, 2)],
      `reading-list-${stamp}.json`,
      { type: 'application/json' },
    );
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Reading list backup' });
        save({ exported: true });
        backupAge.textContent = describeBackupAge();
        backupAge.classList.remove('warn');
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    save({ exported: true });
    backupAge.textContent = describeBackupAge();
    backupAge.classList.remove('warn');
    setStatus(backupStatus, `Saved ${file.name}.`);
  });

  const goodreadsState = document.getElementById('goodreads-state');

  document.getElementById('goodreads-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setStatus(goodreadsState, `Reading ${file.name}\u2026`);
    try {
      const skipFinished = document.getElementById('goodreads-skip-read').checked;
      const { added, skipped, counts } = importGoodreads(await file.text(), { skipFinished });
      view = 'unfinished';
      syncShelfButtons();
      render();

      if (!added) {
        setStatus(goodreadsState, skipped
          ? `Nothing new — all ${skipped} of those are already on your list.`
          : 'No books found in that file.', !skipped);
      } else {
        const parts = [
          counts.toread ? `${counts.toread} to read` : '',
          counts.reading ? `${counts.reading} on the go` : '',
          counts.read ? `${counts.read} already read` : '',
        ].filter(Boolean).join(', ');
        setStatus(goodreadsState,
          `Added ${added} book${added === 1 ? '' : 's'} (${parts})`
          + `${skipped ? `, skipping ${skipped} already here` : ''}. Covers are arriving now.`);
        resolveCoversGradually(40);
      }
    } catch (err) {
      setStatus(goodreadsState, err.message || 'Could not read that file.', true);
    } finally {
      event.target.value = '';
    }
  });

  document.getElementById('import-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = (data.books || []).filter(isBook);
      if (!incoming.length) throw new Error('empty');
      const seen = new Set(books.flatMap(identities));
      let added = 0;
      for (const b of incoming) {
        const keys = identities(b);
        if (keys.some((k) => seen.has(k))) continue;
        keys.forEach((k) => seen.add(k));
        books.push({ ...b, id: b.id || `b${Math.random().toString(36).slice(2, 9)}` });
        added++;
      }
      save();
      render();
      setStatus(backupStatus, `Restored ${added} book${added === 1 ? '' : 's'} (${incoming.length - added} already here).`);
    } catch (err) {
      setStatus(backupStatus, 'That file doesn’t look like a reading-list backup.', true);
    } finally {
      event.target.value = '';
    }
  });

  /* ------------------------------------------------------------------ boot */

  syncShelfButtons();
  render();
  markBackupState();

  /* Ask the browser not to evict this list when it is short of space. It may
     refuse, and it is no protection against the site's data being cleared by
     hand, but it costs nothing to ask. */
  navigator.storage?.persist?.().catch(() => { /* not supported here */ });

  // Opening a sync link while the app is already open only changes the part
  // after the #, which is not a fresh load — so watch for that too.
  window.addEventListener('hashchange', adoptLinkFromHash);
  if (!adoptLinkFromHash()) pull();

  // Books added while offline, or imported from Goodreads, have no cover yet.
  if (navigator.onLine) resolveCoversGradually();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
    });
  }
})();
