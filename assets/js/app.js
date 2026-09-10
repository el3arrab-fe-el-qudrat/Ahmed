/**
 * العِراب في القدرات — exam portal
 *
 * Static, data-driven, no framework. State lives in one object, is mirrored to
 * the URL (so any view is shareable and the back button works), and drives a
 * single render pass. Cards are cloned from a <template> and appended in
 * batches so 300+ records never block the first paint.
 */

import { parseQuery, searchExams, highlightRanges } from './search.js';
import { store } from './store.js';

const PAGE_SIZE = 48;
const DATA_URL = new URL('../data/exams.json', import.meta.url);

/* -------------------------------------------------------------------------- */
/* Element lookup                                                              */
/* -------------------------------------------------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const el = {
  search: $('#searchInput'),
  searchForm: $('#searchForm'),
  clear: $('#searchClear'),
  grid: $('#examGrid'),
  template: $('#examCardTemplate'),
  count: $('#resultCount'),
  countLive: $('#resultCountLive'),
  empty: $('#emptyState'),
  emptyTerm: $('#emptyTerm'),
  suggestions: $('#emptySuggestions'),
  error: $('#errorState'),
  loadMore: $('#loadMore'),
  loadMoreBtn: $('#loadMoreBtn'),
  loadMoreMeta: $('#loadMoreMeta'),
  sentinel: $('#scrollSentinel'),
  rangeChips: $('#rangeChips'),
  controls: $('#filterControls'),
  controlsHome: $('#controlsHome'),
  sheet: $('#filterSheet'),
  sheetBody: $('#filterSheetBody'),
  sheetOpen: $('#filterTrigger'),
  sheetBadge: $('#filterBadge'),
  sheetClose: $('#filterSheetClose'),
  sheetApply: $('#filterSheetApply'),
  sheetReset: $('#filterSheetReset'),
  activeFilters: $('#activeFilters'),
  activeTags: $('#activeTags'),
  resetAll: $('#resetAll'),
  resetProxies: $$('[data-reset-proxy]'),
  sortSelect: $('#sortSelect'),
  statusGroup: $('#statusGroup'),
  progress: $('#progressPanel'),
  progressBar: $('#progressBar'),
  progressFill: $('#progressFill'),
  progressLabel: $('#progressLabel'),
  progressReset: $('#progressReset'),
  tileResume: $('#tileResume'),
  tileResumeLabel: $('#tileResumeLabel'),
  tileResumeMeta: $('#tileResumeMeta'),
  tileTodo: $('#tileTodo'),
  tileTodoMeta: $('#tileTodoMeta'),
  tileFav: $('#tileFav'),
  tileFavMeta: $('#tileFavMeta'),
  tileRandom: $('#tileRandom'),
  tileRandomMeta: $('#tileRandomMeta'),
  toast: $('#toast'),
  toastText: $('#toastText'),
  statTotal: $$('[data-stat="total"]'),
  statQuestions: $$('[data-stat="questions"]'),
  statUpdated: $$('[data-stat="updated"]'),
};

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

const DEFAULTS = { q: '', range: 'all', status: 'all', sort: 'number-asc' };

const state = {
  ...DEFAULTS,
  data: null,
  query: parseQuery(''),
  results: [],
  fuzzy: false,
  shown: 0,
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const arabicNumber = (n) => new Intl.NumberFormat('ar-EG-u-nu-latn').format(n);

/**
 * A numeric range must stay a single left-to-right run. Left to the bidi
 * algorithm inside an RTL paragraph, "1 - 50" is laid out with 1 on the right,
 * which reads as "50 - 1" to anyone scanning left to right. <bdi dir="ltr">
 * isolates it so the range always renders the way people write it.
 */
function rangeElement(from, to) {
  const bdi = document.createElement('bdi');
  bdi.dir = 'ltr';
  bdi.className = 'tnum';
  bdi.textContent = `${arabicNumber(from)}–${arabicNumber(to)}`;
  return bdi;
}

/** Render an ISO date as Arabic prose, falling back to the raw value. */
function formatDate(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  } catch {
    return iso;
  }
}


/* -------------------------------------------------------------------------- */
/* Arabic number agreement                                                     */
/*                                                                             */
/* Counted nouns inflect by category in Arabic, so "1 نموذجًا" and "3 نموذجًا"  */
/* are both wrong. Intl.PluralRules('ar') gives the six categories; for one and */
/* two the idiomatic phrasing drops the digit entirely.                         */
/* -------------------------------------------------------------------------- */

const PLURAL = new Intl.PluralRules('ar');

const UNITS = {
  exam: {
    zero: () => 'لا نماذج',
    one: () => 'نموذج واحد',
    two: () => 'نموذجان',
    few: (n) => `${arabicNumber(n)} نماذج`,
    many: (n) => `${arabicNumber(n)} نموذجًا`,
    other: (n) => `${arabicNumber(n)} نموذج`,
  },
  question: {
    zero: () => 'لا أسئلة',
    one: () => 'سؤال واحد',
    two: () => 'سؤالان',
    few: (n) => `${arabicNumber(n)} أسئلة`,
    many: (n) => `${arabicNumber(n)} سؤالًا`,
    other: (n) => `${arabicNumber(n)} سؤال`,
  },
};

/** e.g. countPhrase(1, 'exam') -> "نموذج واحد", countPhrase(13, 'question') -> "13 سؤالًا" */
function countPhrase(n, unit) {
  const table = UNITS[unit];
  return (table[PLURAL.select(n)] || table.other)(n);
}

/** The bare noun in the form that agrees with `n`, without the numeral. */
function unitNoun(n, unit) {
  return countPhrase(n, unit).replace(/^[\d٠-٩,،.\s]+/, '');
}

function examUrl(exam) {
  if (exam.u) return exam.u;
  if (exam.f) return `https://docs.google.com/forms/d/e/${exam.f}/viewform`;
  return null;
}

function examShortUrl(exam) {
  if (exam.s) return `https://forms.gle/${exam.s}`;
  if (exam.su) return exam.su;
  return examUrl(exam);
}

/** Defence in depth: never render a link that is not a plain https URL. */
function isSafeUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function debounce(fn, wait) {
  let handle = 0;
  return (...args) => {
    clearTimeout(handle);
    handle = setTimeout(() => fn(...args), wait);
  };
}

let toastHandle = 0;
function toast(message) {
  if (!el.toast) return;
  el.toastText.textContent = message;
  el.toast.classList.add('toast--visible');
  clearTimeout(toastHandle);
  toastHandle = setTimeout(() => el.toast.classList.remove('toast--visible'), 2400);
}

function parseRange(value) {
  const match = /^(\d+)-(\d+)$/.exec(value || '');
  if (!match) return null;
  return { from: Number(match[1]), to: Number(match[2]) };
}

/* -------------------------------------------------------------------------- */
/* URL <-> state                                                               */
/* -------------------------------------------------------------------------- */

function readStateFromUrl() {
  const params = new URLSearchParams(location.search);
  state.q = params.get('q') ?? DEFAULTS.q;
  state.range = params.get('range') ?? DEFAULTS.range;
  state.status = params.get('status') ?? DEFAULTS.status;
  state.sort = params.get('sort') ?? DEFAULTS.sort;

  if (!['all', 'todo', 'done', 'fav'].includes(state.status)) state.status = 'all';
  if (!['number-asc', 'number-desc', 'title', 'recent'].includes(state.sort)) {
    state.sort = 'number-asc';
  }
  if (state.range !== 'all' && !parseRange(state.range)) state.range = 'all';
}

const syncUrl = debounce(() => {
  const params = new URLSearchParams();
  for (const key of ['q', 'range', 'status', 'sort']) {
    if (state[key] && state[key] !== DEFAULTS[key]) params.set(key, state[key]);
  }
  const search = params.toString();
  const next = `${location.pathname}${search ? `?${search}` : ''}`;
  history.replaceState(null, '', next);
}, 250);

/* -------------------------------------------------------------------------- */
/* Filtering                                                                   */
/* -------------------------------------------------------------------------- */

/** Only the controls that actually live inside the mobile sheet. */
function sheetFilterCount() {
  let n = 0;
  if (state.status !== 'all') n += 1;
  if (state.sort !== DEFAULTS.sort) n += 1;
  return n;
}

function compute() {
  const all = state.data?.exams ?? [];

  let pool = all;
  const range = parseRange(state.range);
  if (range) pool = pool.filter((e) => e.n >= range.from && e.n <= range.to);

  if (state.status === 'done') pool = pool.filter((e) => store.isDone(e.n));
  else if (state.status === 'todo') pool = pool.filter((e) => !store.isDone(e.n));
  else if (state.status === 'fav') pool = pool.filter((e) => store.isFav(e.n));

  state.query = parseQuery(state.q);
  const { results, fuzzy } = searchExams(pool, state.query);
  state.fuzzy = fuzzy;

  // A text query is already ranked by relevance; only re-sort when the user
  // explicitly picked an order or the query is empty.
  const explicitSort = state.sort !== DEFAULTS.sort;
  if (state.query.isEmpty || explicitSort) {
    const sorted = results.slice();
    if (state.sort === 'number-desc') sorted.sort((a, b) => b.n - a.n);
    else if (state.sort === 'title') sorted.sort((a, b) => a.t.localeCompare(b.t, 'ar'));
    else if (state.sort === 'recent') {
      sorted.sort((a, b) => store.openedAt(b.n) - store.openedAt(a.n) || a.n - b.n);
    } else sorted.sort((a, b) => a.n - b.n);
    state.results = sorted;
  } else {
    state.results = results;
  }

  state.shown = 0;
}

/* -------------------------------------------------------------------------- */
/* Card rendering                                                              */
/* -------------------------------------------------------------------------- */

function paintTitle(node, exam) {
  const ranges = highlightRanges(exam.t, state.query);
  if (!ranges.length) {
    node.textContent = exam.t;
    return;
  }
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) fragment.append(exam.t.slice(cursor, start));
    const mark = document.createElement('mark');
    mark.textContent = exam.t.slice(start, end);
    fragment.append(mark);
    cursor = end;
  }
  if (cursor < exam.t.length) fragment.append(exam.t.slice(cursor));
  node.replaceChildren(fragment);
}

function buildCard(exam) {
  const node = el.template.content.firstElementChild.cloneNode(true);
  const url = examUrl(exam);

  node.dataset.n = String(exam.n);
  node.id = `exam-${exam.n}`;

  $('.card__number b', node).textContent = arabicNumber(exam.n);
  paintTitle($('.card__title', node), exam);

  const questions = state.data?.meta?.questionsPerForm;
  const questionsNode = $('[data-field="questions"]', node);
  if (questions) questionsNode.textContent = countPhrase(questions, 'question');
  else $('[data-meta="questions"]', node)?.remove();

  const cta = $('.card__cta', node);
  if (url && isSafeUrl(url)) {
    cta.href = url;
    cta.setAttribute('aria-label', `ابدأ الاختبار — النموذج ${arabicNumber(exam.n)}: ${exam.t}`);
    cta.addEventListener('click', () => {
      store.markOpened(exam.n);
      refreshQuickAccess();
    });
  } else {
    // A record with no usable link is never offered as an active exam.
    cta.replaceWith(
      Object.assign(document.createElement('span'), {
        className: 'btn btn--secondary card__cta',
        textContent: 'الرابط غير متاح',
      }),
    );
    node.dataset.broken = 'true';
  }

  const fav = $('.card__fav', node);
  fav.setAttribute('aria-pressed', String(store.isFav(exam.n)));
  const syncFavLabel = (on) => {
    const text = on ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة';
    fav.setAttribute('aria-label', `${text} — النموذج ${arabicNumber(exam.n)}`);
    fav.title = text;
  };
  syncFavLabel(store.isFav(exam.n));
  fav.addEventListener('click', () => {
    const on = store.toggleFav(exam.n);
    fav.setAttribute('aria-pressed', String(on));
    syncFavLabel(on);
    toast(on ? 'أُضيف إلى المفضلة' : 'أُزيل من المفضلة');
    refreshQuickAccess();
    if (state.status === 'fav') scheduleRerender();
  });

  const done = $('.card__toggle', node);
  done.setAttribute('aria-pressed', String(store.isDone(exam.n)));
  const syncDoneLabel = (on) => {
    const text = on ? 'إلغاء تحديد الإنجاز' : 'تحديد كمُنجز';
    done.setAttribute('aria-label', `${text} — النموذج ${arabicNumber(exam.n)}`);
    done.title = text;
  };
  syncDoneLabel(store.isDone(exam.n));
  done.addEventListener('click', () => {
    const on = store.toggleDone(exam.n);
    done.setAttribute('aria-pressed', String(on));
    syncDoneLabel(on);
    node.classList.toggle('card--done', on);
    toast(on ? 'تم تحديد النموذج كمُنجز' : 'أُلغي تحديد النموذج');
    refreshQuickAccess();
    if (state.status === 'done' || state.status === 'todo') scheduleRerender();
  });

  const copy = $('.card__copy', node);
  copy.setAttribute('aria-label', `نسخ رابط النموذج ${arabicNumber(exam.n)}`);
  copy.title = 'نسخ رابط النموذج';
  copy.addEventListener('click', async () => {
    const link = examShortUrl(exam);
    if (!link || !isSafeUrl(link)) return;
    try {
      await navigator.clipboard.writeText(link);
      toast('نُسخ رابط النموذج');
    } catch {
      window.prompt('انسخ الرابط:', link);
    }
  });

  node.classList.toggle('card--done', store.isDone(exam.n));
  return node;
}

const scheduleRerender = debounce(() => {
  compute();
  render();
}, 220);

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

function appendBatch() {
  const next = state.results.slice(state.shown, state.shown + PAGE_SIZE);
  if (!next.length) return;

  const fragment = document.createDocumentFragment();
  for (const exam of next) fragment.append(buildCard(exam));
  el.grid.append(fragment);
  state.shown += next.length;

  const remaining = state.results.length - state.shown;
  el.loadMore.hidden = remaining <= 0;
  if (remaining > 0) {
    el.loadMoreMeta.textContent = `عُرض ${arabicNumber(state.shown)} من ${countPhrase(
      state.results.length,
      'exam',
    )}`;
  }
}

function renderCount() {
  const total = state.data?.exams?.length ?? 0;
  const n = state.results.length;
  const text =
    n === total
      ? countPhrase(n, 'exam')
      : `${arabicNumber(n)} من ${countPhrase(total, 'exam')}`;
  el.count.innerHTML = '';
  el.count.append(Object.assign(document.createElement('b'), { textContent: text }));
  el.countLive.textContent = n === 0 ? 'لا توجد نتائج' : `${text} في النتائج`;
}

function renderActiveFilters() {
  const tags = [];
  if (state.q.trim()) tags.push({ key: 'q', label: `بحث: ${state.q.trim()}` });
  if (state.range !== 'all') {
    const r = parseRange(state.range);
    tags.push({ key: 'range', label: 'النماذج', range: r });
  }
  if (state.status !== 'all') {
    const labels = { todo: 'لم تُنجز بعد', done: 'المُنجزة', fav: 'المفضلة' };
    tags.push({ key: 'status', label: labels[state.status] });
  }
  if (state.sort !== DEFAULTS.sort) {
    const labels = {
      'number-desc': 'الترتيب: من الأحدث رقمًا',
      title: 'الترتيب: أبجديًا',
      recent: 'الترتيب: آخر ما فُتح',
    };
    tags.push({ key: 'sort', label: labels[state.sort] });
  }

  el.activeTags.replaceChildren();
  for (const tag of tags) {
    const wrap = document.createElement('span');
    wrap.className = 'tag';
    wrap.append(Object.assign(document.createElement('span'), { textContent: tag.label }));
    if (tag.range) wrap.append(' ', rangeElement(tag.range.from, tag.range.to));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tag__remove';
    const spoken = tag.range
      ? `${tag.label} ${arabicNumber(tag.range.from)} إلى ${arabicNumber(tag.range.to)}`
      : tag.label;
    remove.setAttribute('aria-label', `إزالة عامل التصفية: ${spoken}`);
    remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-close"/></svg>';
    remove.addEventListener('click', () => {
      state[tag.key] = DEFAULTS[tag.key];
      if (tag.key === 'q') el.search.value = '';
      applyChange();
    });
    wrap.append(remove);
    el.activeTags.append(wrap);
  }

  el.activeFilters.hidden = tags.length === 0;

  const count = sheetFilterCount();
  el.sheetBadge.hidden = count === 0;
  el.sheetBadge.textContent = arabicNumber(count);
}

function renderEmptyState() {
  const hasResults = state.results.length > 0;
  el.empty.hidden = hasResults;
  el.grid.hidden = !hasResults;

  if (hasResults) return;

  const term = state.q.trim();
  el.emptyTerm.textContent = term;
  el.emptyTerm.hidden = !term;
  $('#emptyLead').textContent = term
    ? 'لم نجد نموذجًا مطابقًا لـ'
    : 'لا توجد نماذج ضمن عوامل التصفية الحالية.';

  // Suggest the closest numbers so a mistyped number is still one click away.
  el.suggestions.replaceChildren();
  const digits = state.query.digits;
  if (digits && state.data) {
    const target = Number(digits);
    const nearest = state.data.exams
      .map((e) => ({ e, d: Math.abs(e.n - target) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);
    if (nearest.length) {
      el.suggestions.append(
        Object.assign(document.createElement('span'), {
          className: 'active-filters__label',
          textContent: 'أقرب النماذج:',
        }),
      );
      for (const { e } of nearest) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.textContent = `${arabicNumber(e.n)} · ${e.t}`;
        chip.addEventListener('click', () => {
          state.q = String(e.n);
          el.search.value = state.q;
          applyChange();
        });
        el.suggestions.append(chip);
      }
    }
  }
}

function renderChips() {
  $$('[data-range]', el.rangeChips).forEach((chip) => {
    chip.setAttribute('aria-pressed', String(chip.dataset.range === state.range));
  });
}

function renderControls() {
  el.sortSelect.value = state.sort;
  $$('[data-status]', el.statusGroup).forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.status === state.status));
  });
}

function render() {
  el.grid.replaceChildren();
  el.grid.setAttribute('aria-busy', 'false');
  el.loadMore.hidden = true;
  renderCount();
  renderActiveFilters();
  renderChips();
  renderControls();
  renderEmptyState();
  if (state.results.length) appendBatch();
}

function applyChange({ scroll = false } = {}) {
  compute();
  render();
  syncUrl();
  if (scroll) {
    document.getElementById('exams')?.scrollIntoView({ block: 'start' });
  }
}

/* -------------------------------------------------------------------------- */
/* Quick access                                                                */
/* -------------------------------------------------------------------------- */

function nextUnsolved() {
  const exams = state.data?.exams ?? [];
  const last = store.lastOpened;
  const after = exams.find((e) => e.n > last && !store.isDone(e.n));
  return after || exams.find((e) => !store.isDone(e.n)) || exams[0] || null;
}

function refreshQuickAccess() {
  const exams = state.data?.exams ?? [];
  if (!exams.length) return;

  const doneCount = store.doneCount;
  const favCount = store.favCount;
  const total = exams.length;

  if (store.isAvailable) {
    el.progress.hidden = doneCount === 0;
    const pct = total ? Math.round((doneCount / total) * 100) : 0;
    // A rounded 1% of a wide track renders as nothing at all; keep a visible
    // sliver so "some progress" never looks like "no progress".
    el.progressFill.style.width = pct > 0 ? `max(${pct}%, 8px)` : '0';
    el.progressLabel.textContent = `أنجزتَ ${arabicNumber(doneCount)} من ${countPhrase(
      total,
      'exam',
    )} (${arabicNumber(pct)}٪)`;
    el.progressBar.setAttribute('aria-valuenow', String(pct));
    el.progressBar.setAttribute(
      'aria-valuetext',
      `${arabicNumber(doneCount)} من ${arabicNumber(total)}`,
    );
  } else {
    el.progress.hidden = true;
  }

  const next = nextUnsolved();
  if (next) {
    const resuming = store.lastOpened > 0 || doneCount > 0;
    el.tileResumeLabel.textContent = resuming
      ? `تابع من النموذج ${arabicNumber(next.n)}`
      : `ابدأ من النموذج ${arabicNumber(next.n)}`;
    el.tileResumeMeta.textContent = next.t;
    el.tileResume.dataset.target = String(next.n);
  }

  const todo = total - doneCount;
  el.tileTodoMeta.textContent = todo
    ? `بقي لك ${countPhrase(todo, 'exam')}`
    : 'أنجزتَ جميع النماذج';
  el.tileFavMeta.textContent = favCount
    ? `${countPhrase(favCount, 'exam')} في المفضلة`
    : 'لم تحفظ أي نموذج بعد';
  el.tileRandomMeta.textContent = 'يفتح فورًا في تبويب جديد';
}

function flashCard(n) {
  const target = document.getElementById(`exam-${n}`);
  if (!target) return false;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.classList.remove('card--flash');
  void target.offsetWidth; // restart the animation
  target.classList.add('card--flash');
  const cta = $('.card__cta', target);
  if (cta && cta.tagName === 'A') cta.focus({ preventScroll: true });
  return true;
}

/** Reveal a specific form number, loading more batches if it is further down. */
function revealExam(n) {
  const index = state.results.findIndex((e) => e.n === n);
  if (index === -1) {
    // It is filtered out — clear filters so the user still lands on it.
    state.range = 'all';
    state.status = 'all';
    state.q = '';
    el.search.value = '';
    applyChange();
    return revealExam(n);
  }
  let guard = 0;
  while (state.shown <= index && guard < 40) {
    appendBatch();
    guard += 1;
  }
  return flashCard(n);
}

/* -------------------------------------------------------------------------- */
/* Mobile filter sheet                                                          */
/* -------------------------------------------------------------------------- */

let lastFocused = null;

function openSheet() {
  el.sheetBody.append(el.controls);
  el.sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  lastFocused = document.activeElement;
  el.sheetClose.focus();
  document.addEventListener('keydown', sheetKeydown);
}

function closeSheet() {
  el.controlsHome.append(el.controls);
  el.sheet.hidden = true;
  document.body.style.overflow = '';
  document.removeEventListener('keydown', sheetKeydown);
  if (lastFocused instanceof HTMLElement) lastFocused.focus();
}

function sheetKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSheet();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = $$(
    'a[href], button:not([disabled]), select, input, [tabindex]:not([tabindex="-1"])',
    el.sheet,
  ).filter((node) => node.offsetParent !== null);
  if (!focusable.length) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                       */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  el.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    el.search.blur();
  });

  const onInput = debounce(() => {
    state.q = el.search.value;
    el.clear.hidden = !state.q;
    applyChange();
  }, 130);

  el.search.addEventListener('input', () => {
    el.clear.hidden = !el.search.value;
    onInput();
  });

  el.clear.addEventListener('click', () => {
    el.search.value = '';
    state.q = '';
    el.clear.hidden = true;
    el.search.focus();
    applyChange();
  });

  el.rangeChips.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-range]');
    if (!chip) return;
    state.range = chip.dataset.range === state.range ? 'all' : chip.dataset.range;
    applyChange({ scroll: true });
  });

  el.statusGroup.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-status]');
    if (!btn) return;
    state.status = btn.dataset.status;
    applyChange();
  });

  el.sortSelect.addEventListener('change', () => {
    state.sort = el.sortSelect.value;
    applyChange();
  });

  el.resetAll.addEventListener('click', resetAll);
  el.resetProxies.forEach((btn) => btn.addEventListener('click', resetAll));
  el.sheetReset.addEventListener('click', () => {
    resetAll();
    closeSheet();
  });

  el.loadMoreBtn.addEventListener('click', () => {
    appendBatch();
    const cards = $$('.card', el.grid);
    cards[Math.max(0, state.shown - PAGE_SIZE)]?.focus?.();
  });

  el.sheetOpen.addEventListener('click', openSheet);
  el.sheetClose.addEventListener('click', closeSheet);
  el.sheetApply.addEventListener('click', closeSheet);
  $('.sheet__backdrop', el.sheet).addEventListener('click', closeSheet);

  el.tileResume.addEventListener('click', () => {
    const n = Number(el.tileResume.dataset.target);
    if (n) revealExam(n);
  });

  el.tileTodo.addEventListener('click', () => {
    state.status = 'todo';
    state.q = '';
    el.search.value = '';
    applyChange({ scroll: true });
  });

  el.tileFav.addEventListener('click', () => {
    state.status = 'fav';
    state.q = '';
    el.search.value = '';
    applyChange({ scroll: true });
  });

  el.tileRandom.addEventListener('click', () => {
    const pool = state.results.length ? state.results : state.data?.exams ?? [];
    if (!pool.length) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const url = examUrl(pick);
    if (!url || !isSafeUrl(url)) return;
    store.markOpened(pick.n);
    refreshQuickAccess();
    window.open(url, '_blank', 'noopener,noreferrer');
    toast(`فُتح النموذج ${arabicNumber(pick.n)}: ${pick.t}`);
  });

  el.progressReset.addEventListener('click', () => {
    if (!window.confirm('سيُحذف سجل تقدّمك المحفوظ على هذا الجهاز. هل تريد المتابعة؟')) return;
    store.clear();
    refreshQuickAccess();
    applyChange();
    toast('أُعيد ضبط سجل التقدّم');
  });

  // "/" focuses search from anywhere; Escape clears it.
  document.addEventListener('keydown', (event) => {
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      el.search.focus();
      el.search.select();
    } else if (event.key === 'Escape' && document.activeElement === el.search && el.search.value) {
      el.search.value = '';
      state.q = '';
      el.clear.hidden = true;
      applyChange();
    }
  });

  window.addEventListener('popstate', () => {
    readStateFromUrl();
    el.search.value = state.q;
    el.clear.hidden = !state.q;
    compute();
    render();
  });

  // Infinite scroll, with the button as the accessible fallback.
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !el.loadMore.hidden) appendBatch();
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(el.sentinel);
  }

  // Keep the controls in the right container when the viewport crosses 768px.
  const mq = window.matchMedia('(min-width: 768px)');
  const syncControlsHome = () => {
    if (mq.matches && !el.sheet.hidden) closeSheet();
    if (mq.matches && el.controls.parentElement !== el.controlsHome) {
      el.controlsHome.append(el.controls);
    }
  };
  mq.addEventListener('change', syncControlsHome);
}

function resetAll() {
  Object.assign(state, DEFAULTS);
  el.search.value = '';
  el.clear.hidden = true;
  applyChange();
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

function renderMeta(meta) {
  const fmt = (n) => (typeof n === 'number' ? arabicNumber(n) : '—');
  el.statTotal.forEach((n) => (n.textContent = fmt(meta.total)));
  el.statQuestions.forEach((n) => (n.textContent = fmt(meta.totalQuestions)));

  // Unit labels must agree with the number they sit beside.
  document.querySelectorAll('[data-unit="exam"]').forEach((n) => {
    n.textContent = `${unitNoun(meta.total, 'exam')} اختبار`;
  });
  document.querySelectorAll('[data-unit="question"]').forEach((n) => {
    n.textContent = unitNoun(meta.totalQuestions ?? 0, 'question');
  });
  el.statUpdated.forEach((n) => {
    if (!meta.generated) {
      n.closest('li')?.remove();
      return;
    }
    n.textContent = formatDate(meta.generated);
    n.setAttribute('datetime', meta.generated);
  });

  el.rangeChips.replaceChildren();
  const allChip = document.createElement('button');
  allChip.type = 'button';
  allChip.className = 'chip';
  allChip.dataset.range = 'all';
  allChip.append(Object.assign(document.createElement('span'), { textContent: 'كل النماذج' }));
  allChip.append(
    Object.assign(document.createElement('span'), {
      className: 'chip__count',
      textContent: arabicNumber(meta.total),
    }),
  );
  el.rangeChips.append(allChip);

  for (const range of meta.ranges ?? []) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.range = `${range.from}-${range.to}`;
    chip.append(rangeElement(range.from, range.to));
    chip.setAttribute(
      'aria-label',
      `النماذج من ${arabicNumber(range.from)} إلى ${arabicNumber(range.to)} (${countPhrase(
        range.count,
        'exam',
      )})`,
    );
    chip.append(
      Object.assign(document.createElement('span'), {
        className: 'chip__count',
        textContent: arabicNumber(range.count),
      }),
    );
    el.rangeChips.append(chip);
  }
}

function showError() {
  el.error.hidden = false;
  el.grid.hidden = true;
  el.grid.setAttribute('aria-busy', 'false');
  el.empty.hidden = true;
  el.loadMore.hidden = true;
  document.getElementById('quickAccess')?.setAttribute('hidden', '');

  // Without data these controls promise something the page cannot deliver.
  document.getElementById('heroStats')?.setAttribute('hidden', '');
  el.searchForm?.setAttribute('hidden', '');
  document.getElementById('searchHint')?.setAttribute('hidden', '');
  document.querySelector('.toolbar__controls')?.setAttribute('hidden', '');
  el.sheetOpen?.setAttribute('hidden', '');
  document.querySelector('.ranges')?.setAttribute('hidden', '');
  el.count.textContent = '';
}

async function boot() {
  document.documentElement.classList.add('has-js');

  try {
    const response = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data || !Array.isArray(data.exams) || data.exams.length === 0) {
      throw new Error('empty dataset');
    }

    // Drop anything that cannot produce a safe link before it reaches the UI.
    data.exams = data.exams.filter((e) => {
      const url = examUrl(e);
      return Boolean(e && Number.isInteger(e.n) && e.t && url && isSafeUrl(url));
    });
    if (!data.exams.length) throw new Error('no usable records');

    data.meta = data.meta || {};
    data.meta.total = data.exams.length;

    state.data = data;
    renderMeta(data.meta);
    bindEvents();
    readStateFromUrl();
    el.search.value = state.q;
    el.clear.hidden = !state.q;
    refreshQuickAccess();
    compute();
    render();

    // Deep link: #exam-47 scrolls to and highlights that form.
    const hash = /^#exam-(\d+)$/.exec(location.hash);
    if (hash) requestAnimationFrame(() => revealExam(Number(hash[1])));
  } catch (error) {
    console.error('[exams] failed to load data:', error);
    showError();
  }
}

boot();
