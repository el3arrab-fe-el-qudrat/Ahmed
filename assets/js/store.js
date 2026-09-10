/**
 * Device-local progress store.
 *
 * The dataset carries no per-student state, so "solved", "favourite" and "last
 * opened" live only in this browser's localStorage. Everything is wrapped
 * because storage throws in private windows and when site data is blocked —
 * in that case the app degrades to a stateless (but fully working) portal.
 */

const KEY = 'arrab-qudurat:v1';

const EMPTY = { v: 1, done: {}, fav: {}, opened: {}, last: 0 };

let available = true;
let cache = null;

function read() {
  if (cache) return cache;
  if (!available) return (cache = { ...EMPTY });

  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return (cache = { ...EMPTY });
    const parsed = JSON.parse(raw);
    cache = {
      v: 1,
      done: parsed && typeof parsed.done === 'object' && parsed.done ? parsed.done : {},
      fav: parsed && typeof parsed.fav === 'object' && parsed.fav ? parsed.fav : {},
      opened: parsed && typeof parsed.opened === 'object' && parsed.opened ? parsed.opened : {},
      last: Number(parsed?.last) || 0,
    };
  } catch {
    available = false;
    cache = { ...EMPTY };
  }
  return cache;
}

let flushHandle = 0;
function write() {
  if (!available) return;
  clearTimeout(flushHandle);
  flushHandle = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(cache));
    } catch {
      available = false;
    }
  }, 120);
}

export const store = {
  get isAvailable() {
    read();
    return available;
  },

  isDone(n) {
    return Boolean(read().done[n]);
  },

  isFav(n) {
    return Boolean(read().fav[n]);
  },

  /** @returns {boolean} the new state */
  toggleDone(n) {
    const s = read();
    const next = !s.done[n];
    if (next) s.done[n] = 1;
    else delete s.done[n];
    write();
    return next;
  },

  /** @returns {boolean} the new state */
  toggleFav(n) {
    const s = read();
    const next = !s.fav[n];
    if (next) s.fav[n] = 1;
    else delete s.fav[n];
    write();
    return next;
  },

  markOpened(n) {
    const s = read();
    s.opened[n] = Date.now();
    s.last = n;
    write();
  },

  get doneCount() {
    return Object.keys(read().done).length;
  },

  get favCount() {
    return Object.keys(read().fav).length;
  },

  get lastOpened() {
    return read().last;
  },

  openedAt(n) {
    return read().opened[n] || 0;
  },

  /** Numbers ordered by most recently opened. */
  recentNumbers() {
    const { opened } = read();
    return Object.keys(opened)
      .map(Number)
      .sort((a, b) => opened[b] - opened[a]);
  },

  clear() {
    cache = { ...EMPTY };
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* nothing we can do; the in-memory cache is already reset */
    }
  },
};
