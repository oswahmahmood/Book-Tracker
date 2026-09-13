/* Reading list — a personal to-read queue.
   Everything is stored in this browser (localStorage); nothing is sent anywhere
   except the two public book APIs used to look up covers and metadata. */
(() => {
  'use strict';

  const STORE_KEY = 'reading-list.v1';
  const SHELVES = ['toread', 'reading', 'read'];
  const SHELF_LABELS = { toread: 'To read', reading: 'Reading', read: 'Read' };
  const EMPTY_COPY = {
    toread: 'Nothing queued yet. Add a book by its ISBN — the 13 digits under the barcode.',
    reading: 'Nothing on the go. Open a book from "To read" and set it to Reading.',
    read: 'Books you finish will collect here.',
  };

  /* ---------------------------------------------------------------- state */

  let books = load();
  let shelf = 'toread';

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.books) ? parsed.books.filter(isBook) : [];
    } catch (err) {
      console.warn('Could not read saved list', err);
      return [];
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ version: 1, books }));
    } catch (err) {
      setStatus(addStatus, 'Could not save — this browser is out of storage space.', true);
    }
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

  async function getJSON(url, ms = 9000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

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
      source: 'Google Books',
    };
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

    if (errors.length === 2) throw new Error('offline');
    return null;
  }

  async function searchTitle(query) {
    const q = encodeURIComponent(query);
    try {
      const data = await getJSON(`https://openlibrary.org/search.json?q=${q}&limit=8&fields=title,subtitle,author_name,first_publish_year,number_of_pages_median,isbn,cover_i,publisher`);
      const docs = data?.docs || [];
      if (docs.length) {
        return docs.map((d) => ({
          isbn: (d.isbn || []).find((i) => i.length === 13) || (d.isbn || [])[0] || '',
          title: d.title || 'Untitled',
          subtitle: d.subtitle || '',
          authors: d.author_name || [],
          publisher: (d.publisher || [])[0] || '',
          year: d.first_publish_year ? String(d.first_publish_year) : '',
          pages: d.number_of_pages_median || null,
          cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : '',
          source: 'Open Library',
        }));
      }
    } catch (err) { /* fall through to Google */ }

    const data = await getJSON(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=8`);
    return (data?.items || []).map((item) => fromGoogle(item, ''));
  }

  /* ----------------------------------------------------------------- list */

  const listEl = document.getElementById('book-list');
  const emptyEl = document.getElementById('empty');
  const hintEl = document.getElementById('reorder-hint');
  const template = document.getElementById('book-template');

  const visible = () => books.filter((b) => b.status === shelf);

  function render() {
    const rows = visible();
    listEl.textContent = '';

    for (const book of rows) listEl.append(renderBook(book));

    emptyEl.hidden = rows.length > 0;
    emptyEl.textContent = EMPTY_COPY[shelf];
    hintEl.hidden = shelf !== 'toread' || rows.length < 2;

    for (const s of SHELVES) {
      const el = document.querySelector(`[data-count="${s}"]`);
      if (el) el.textContent = books.filter((b) => b.status === s).length;
    }
  }

  function renderBook(book) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.dataset.id = book.id;

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

    node.querySelector('.open').addEventListener('click', () => openDetail(book.id));
    node.querySelector('.up').addEventListener('click', () => nudge(book.id, -1));
    node.querySelector('.down').addEventListener('click', () => nudge(book.id, 1));
    node.querySelector('.grip').addEventListener('pointerdown', (e) => startDrag(e, node));
    return node;
  }

  function byId(id) { return books.find((b) => b.id === id); }

  /* Rewrite the global array so the books on this shelf take the order given,
     leaving books on other shelves where they are. */
  function applyOrder(ids) {
    const slots = [];
    books.forEach((b, i) => { if (b.status === shelf) slots.push(i); });
    const reordered = ids.map(byId).filter(Boolean);
    if (reordered.length !== slots.length) return;
    slots.forEach((slot, i) => { books[slot] = reordered[i]; });
    save();
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
    const ids = visible().map((b) => b.id);
    const from = ids.indexOf(id);
    if (from <= 0) return;
    ids.unshift(ids.splice(from, 1)[0]);
    applyOrder(ids);
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
      if (el.parentElement === listEl) return el;
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
    applyOrder([...listEl.children].map((el) => el.dataset.id));
    render();
  }

  /* ---------------------------------------------------------------- adding */

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
    shelf = 'toread';
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
        if (addBook(info)) queryInput.value = '';
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
      setStatus(addStatus, err.message === 'offline'
        ? 'Couldn’t reach the book databases — you may be offline.'
        : 'Lookup failed. Try again in a moment.', true);
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
        if (addBook(info)) {
          queryInput.value = '';
          hideResults();
        }
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

  const shelfNav = document.getElementById('shelves');

  shelfNav.addEventListener('click', (event) => {
    const btn = event.target.closest('.shelf');
    if (!btn) return;
    shelf = btn.dataset.shelf;
    syncShelfButtons();
    render();
  });

  function syncShelfButtons() {
    for (const btn of shelfNav.querySelectorAll('.shelf')) {
      btn.classList.toggle('is-active', btn.dataset.shelf === shelf);
    }
  }

  /* ---------------------------------------------------------------- detail */

  const dialog = document.getElementById('book-dialog');
  const dialogBody = document.getElementById('dialog-body');
  const dialogTitle = document.getElementById('dialog-title');

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
      book.status = select.value;
      if (book.status === 'read' && !book.finishedAt) book.finishedAt = new Date().toISOString().slice(0, 10);
      if (book.status !== 'read') book.finishedAt = '';
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
    notes.addEventListener('input', () => { book.notes = notes.value; save(); });
    notesField.append(notes);

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
    dialogBody.append(head, statusField, notesField, actions);
    dialog.showModal();
  }

  function labelSpan(text) {
    const span = document.createElement('span');
    span.textContent = text;
    return span;
  }

  /* ---------------------------------------------------------------- backup */

  const backupDialog = document.getElementById('backup-dialog');
  const backupStatus = document.getElementById('backup-status');

  document.getElementById('backup-btn').addEventListener('click', () => {
    setStatus(backupStatus, '');
    backupDialog.showModal();
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
    setStatus(backupStatus, `Saved ${file.name}.`);
  });

  document.getElementById('import-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = (data.books || []).filter(isBook);
      if (!incoming.length) throw new Error('empty');
      const seen = new Set(books.map((b) => b.isbn || b.id));
      let added = 0;
      for (const b of incoming) {
        const key = b.isbn || b.id;
        if (seen.has(key)) continue;
        seen.add(key);
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

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
    });
  }
})();
