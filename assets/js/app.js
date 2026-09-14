/**
 * العراب في القدرات — exam portal
 *
 * Static, data-driven, no framework. State lives in one object, is mirrored to
 * the URL (so any view is shareable and the back button works), and drives a
 * single render pass. Cards are cloned from a <template> and appended in
 * batches so 300+ records never block the first paint.
 *
 * Opening a form marks it done straight away (with an undo). Progress changes
 * never re-render the list: they repaint only the affected card, the counters
 * and the quick-access tiles, so a student deep in the grid never loses their
 * place.
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
  emptyIcon: $('#emptyIcon'),
  emptyTitle: $('#emptyTitle'),
  emptyLead: $('#emptyLead'),
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
  progressPct: $('#progressPct'),
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
  toastActions: $('#toastActions'),
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
  /** Every exam, ascending by number. */
  ordered: [],
  /** number -> exam */
  byNumber: new Map(),
  query: parseQuery(''),
  results: [],
  fuzzy: false,
  shown: 0,
  /** Result count per status tab, under the current range and search. */
  counts: { all: 0, todo: 0, done: 0, fav: 0 },
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

/**
 * Progress as a percentage that never overstates: floored, with one decimal
 * below 10 so the first finished form reads "0.3٪" rather than "0٪".
 */
function percentText(done, total) {
  if (!total || done <= 0) return '0٪';
  if (done >= total) return '100٪';
  const pct = (done / total) * 100;
  const value = pct < 10 ? Math.floor(pct * 10) / 10 : Math.floor(pct);
  return `${arabicNumber(value)}٪`;
}

const TIME_UNITS = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

let relativeFormat = null;
try {
  relativeFormat = new Intl.RelativeTimeFormat('ar-EG-u-nu-latn', { numeric: 'auto' });
} catch {
  /* very old engines: the "opened" hint simply omits the time */
}

/** "الآن", "قبل 5 دقائق", "أمس", "الأسبوع الماضي"… */
function timeAgo(timestamp) {
  const seconds = (timestamp - Date.now()) / 1000;
  if (Math.abs(seconds) < 60 || !relativeFormat) return 'الآن';
  for (const [unit, size] of TIME_UNITS) {
    if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
  }
  return 'الآن';
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

function parseRange(value) {
  const match = /^(\d+)-(\d+)$/.exec(value || '');
  if (!match) return null;
  return { from: Number(match[1]), to: Number(match[2]) };
}

/* -------------------------------------------------------------------------- */
/* Toast — a short status line with at most one action (undo, next form…)     */
/* -------------------------------------------------------------------------- */

let toastHandle = 0;

function hideToast() {
  clearTimeout(toastHandle);
  const hadFocus = el.toast.contains(document.activeElement);
  el.toast.classList.remove('toast--visible');
  el.toastActions.replaceChildren();
  el.toastActions.hidden = true;
  if (hadFocus) document.activeElement.blur();
}

function scheduleToastHide(ms) {
  clearTimeout(toastHandle);
  toastHandle = setTimeout(hideToast, ms);
}

/**
 * @param {string} message
 * @param {{ duration?: number, action?: { label: string, href?: string, onClick?: () => void } }} [options]
 * @returns {HTMLElement | null} the action element, if any
 */
function toast(message, { duration = 2600, action = null } = {}) {
  if (!el.toast) return null;
  el.toastText.textContent = message;
  el.toastActions.replaceChildren();

  let actionNode = null;
  if (action) {
    actionNode = action.href
      ? Object.assign(document.createElement('a'), {
          href: action.href,
          target: '_blank',
          rel: 'noopener noreferrer',
        })
      : Object.assign(document.createElement('button'), { type: 'button' });
    actionNode.className = 'toast__action';
    actionNode.textContent = action.label;
    actionNode.addEventListener('click', () => {
      hideToast();
      action.onClick?.();
    });
    el.toastActions.append(actionNode);
  }

  el.toastActions.hidden = !action;
  el.toast.classList.add('toast--visible');
  // Raised while the page is hidden (the form just opened in front of it):
  // hold it until the student is back, so the confirmation is actually seen.
  if (document.visibilityState === 'hidden') clearTimeout(toastHandle);
  else scheduleToastHide(duration);
  return actionNode;
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

const STATUS_FILTERS = {
  all: null,
  todo: (exam) => !store.isDone(exam.n),
  done: (exam) => store.isDone(exam.n),
  fav: (exam) => store.isFav(exam.n),
};

/** Only the controls that actually live inside the mobile sheet. */
function sheetFilterCount() {
  let n = 0;
  if (state.status !== 'all') n += 1;
  if (state.sort !== DEFAULTS.sort) n += 1;
  return n;
}

function rangePool() {
  const all = state.ordered;
  const range = parseRange(state.range);
  return range ? all.filter((e) => e.n >= range.from && e.n <= range.to) : all;
}

function searchWithin(pool, status) {
  const test = STATUS_FILTERS[status];
  return searchExams(test ? pool.filter(test) : pool, state.query);
}

/** Recount every status tab exactly as selecting it would filter. */
function countStatuses(pool = rangePool()) {
  for (const status of Object.keys(STATUS_FILTERS)) {
    state.counts[status] = searchWithin(pool, status).results.length;
  }
}

function compute() {
  const pool = rangePool();
  state.query = parseQuery(state.q);

  const { results, fuzzy } = searchWithin(pool, state.status);
  state.fuzzy = fuzzy;
  countStatuses(pool);

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

/** Everything on a card that depends on progress. Safe to call any time. */
function paintCardState(node) {
  const n = Number(node.dataset.n);
  const exam = state.byNumber.get(n);
  if (!exam) return;

  const done = store.isDone(n);
  const fav = store.isFav(n);
  const number = arabicNumber(n);

  node.classList.toggle('card--done', done);

  const toggle = $('.card__toggle', node);
  const toggleText = done ? 'إلغاء تحديد الإنجاز' : 'تحديد كمُنجز';
  toggle.setAttribute('aria-pressed', String(done));
  toggle.setAttribute('aria-label', `${toggleText} — النموذج ${number}`);
  toggle.title = toggleText;

  const favButton = $('.card__fav', node);
  const favText = fav ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة';
  favButton.setAttribute('aria-pressed', String(fav));
  favButton.setAttribute('aria-label', `${favText} — النموذج ${number}`);
  favButton.title = favText;

  // Status line: "done" wins; otherwise say when it was last opened, so a
  // form that was started but never marked is easy to spot.
  const status = $('[data-meta="status"]', node);
  const openedAt = store.openedAt(n);
  if (done || openedAt) {
    status.hidden = false;
    status.classList.toggle('card__status--done', done);
    $('use', status).setAttribute('href', done ? '#i-check' : '#i-clock');
    $('[data-field="status"]', status).textContent = done ? 'مُنجز' : `فتحته ${timeAgo(openedAt)}`;
  } else {
    status.hidden = true;
  }

  const cta = $('a.card__cta', node);
  if (cta) {
    const verb = done ? 'أعد الاختبار' : 'ابدأ الاختبار';
    $('.card__cta-label', cta).textContent = verb;
    cta.setAttribute('aria-label', `${verb} — النموذج ${number}: ${exam.t}`);
  }
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

  const copy = $('.card__copy', node);
  copy.setAttribute('aria-label', `نسخ رابط النموذج ${arabicNumber(exam.n)}`);
  copy.title = 'نسخ رابط النموذج';

  paintCardState(node);
  return node;
}

function syncCard(n) {
  const node = document.getElementById(`exam-${n}`);
  if (node) paintCardState(node);
}

function repaintCards() {
  $$('.card', el.grid).forEach(paintCardState);
}

async function copyExamLink(exam) {
  const link = examShortUrl(exam);
  if (!link || !isSafeUrl(link)) return;
  try {
    await navigator.clipboard.writeText(link);
    toast('نُسخ رابط النموذج');
  } catch {
    window.prompt('انسخ الرابط:', link);
  }
}

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
  const total = state.ordered.length;
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

/** Empty views that are about the student's own lists get their own guidance. */
const STATUS_EMPTY = {
  fav: {
    icon: 'i-heart',
    title: 'لا توجد نماذج في المفضلة',
    lead: 'اضغط على أيقونة القلب في أي بطاقة لحفظ النموذج هنا والرجوع إليه بسرعة.',
  },
  done: {
    icon: 'i-check',
    title: 'لم تُنجز أي نموذج بعد',
    lead: 'اضغط «ابدأ الاختبار» في أي نموذج، وسيُسجَّل هنا كمُنجز تلقائيًا.',
  },
  todo: {
    icon: 'i-check',
    title: 'أنجزت جميع النماذج',
    lead: 'أحسنت. يمكنك مراجعة أي نموذج من تبويب «الكل» في أي وقت.',
  },
};

function renderEmptyState() {
  const hasResults = state.results.length > 0;
  el.empty.hidden = hasResults;
  el.grid.hidden = !hasResults;

  if (hasResults) return;

  const term = state.q.trim();
  const listOnly = !term && state.range === 'all' && STATUS_EMPTY[state.status];

  const copy = listOnly || {
    icon: 'i-inbox',
    title: 'لا توجد نتائج',
    lead: term ? 'لم نجد نموذجًا مطابقًا لـ' : 'لا توجد نماذج ضمن عوامل التصفية الحالية.',
  };
  el.emptyIcon.setAttribute('href', `#${copy.icon}`);
  el.emptyTitle.textContent = copy.title;
  el.emptyLead.textContent = copy.lead;
  el.emptyTerm.textContent = term;
  el.emptyTerm.hidden = !term;

  // Suggest the closest numbers so a mistyped number is still one click away.
  el.suggestions.replaceChildren();
  const digits = state.query.digits;
  if (digits && state.data) {
    const target = Number(digits);
    const nearest = state.ordered
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

function renderStatusCounts() {
  $$('[data-status]', el.statusGroup).forEach((button) => {
    const badge = $('.segmented__count', button);
    if (badge) badge.textContent = arabicNumber(state.counts[button.dataset.status] ?? 0);
  });
}

function renderControls() {
  el.sortSelect.value = state.sort;
  $$('[data-status]', el.statusGroup).forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.status === state.status));
  });
  renderStatusCounts();
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
  if (scroll) scrollToResults();
}

/** Bring the top of the list into view — only if the student is below it. */
function keepResultsInView() {
  const section = document.getElementById('exams');
  if (section && section.getBoundingClientRect().top < 0) scrollToResults();
}

function scrollToResults() {
  document.getElementById('exams')?.scrollIntoView({ block: 'start' });
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                    */
/* -------------------------------------------------------------------------- */

/** Counted against the published dataset, so stale numbers never inflate it. */
function progressStats() {
  let done = 0;
  let fav = 0;
  for (const exam of state.ordered) {
    if (store.isDone(exam.n)) done += 1;
    if (store.isFav(exam.n)) fav += 1;
  }
  const total = state.ordered.length;
  return { total, done, fav, todo: total - done };
}

/**
 * Where "resume" should take the student:
 *  - the last form they opened, if they have not marked it done ("أكمل")
 *  - otherwise the first unfinished form after it ("تابع")
 *  - otherwise the first unfinished form at all ("ابدأ" on a fresh device)
 *  - nothing, once every form is done.
 */
function resumeTarget() {
  const exams = state.ordered;
  const last = state.byNumber.get(store.lastOpened);
  if (last && !store.isDone(last.n)) return { exam: last, mode: 'continue' };

  const after = last ? exams.find((e) => e.n > last.n && !store.isDone(e.n)) : null;
  const next = after || exams.find((e) => !store.isDone(e.n));
  if (!next) return { exam: null, mode: 'complete' };

  const started = Boolean(last) || exams.some((e) => store.isDone(e.n));
  return { exam: next, mode: started ? 'next' : 'start' };
}

/** A form not yet done (never the one just opened); any form once all are done. */
function randomTarget() {
  const exams = state.ordered;
  const last = store.lastOpened;
  const todo = exams.filter((e) => !store.isDone(e.n) && e.n !== last);
  const pool = todo.length ? todo : exams.filter((e) => e.n !== last);
  const from = pool.length ? pool : exams;
  return from.length ? from[Math.floor(Math.random() * from.length)] : null;
}

function pointTileAt(tile, exam, label) {
  if (!exam) {
    tile.removeAttribute('href');
    delete tile.dataset.target;
    return;
  }
  tile.href = examUrl(exam);
  tile.dataset.target = String(exam.n);
  tile.setAttribute('aria-label', `${label} — ${exam.t} (يفتح في تبويب جديد)`);
}

const RESUME_LABELS = {
  start: (n) => `ابدأ بالنموذج ${n}`,
  continue: (n) => `أكمل النموذج ${n}`,
  next: (n) => `تابع بالنموذج ${n}`,
};

function refreshQuickAccess() {
  if (!state.ordered.length) return;
  const stats = progressStats();

  if (store.isAvailable) {
    el.progress.hidden = stats.done === 0;
    const pct = stats.total ? (stats.done / stats.total) * 100 : 0;
    const pctText = percentText(stats.done, stats.total);
    // A tiny share of a wide track renders as nothing at all; keep a visible
    // sliver so "some progress" never looks like "no progress".
    el.progressFill.style.width = pct > 0 ? `max(${pct.toFixed(2)}%, 8px)` : '0';
    el.progressLabel.textContent = `أنجزتَ ${arabicNumber(stats.done)} من ${countPhrase(
      stats.total,
      'exam',
    )}`;
    el.progressPct.textContent = pctText;
    el.progressBar.setAttribute('aria-valuenow', pct.toFixed(1));
    el.progressBar.setAttribute(
      'aria-valuetext',
      `${arabicNumber(stats.done)} من ${arabicNumber(stats.total)} (${pctText})`,
    );
  } else {
    el.progress.hidden = true;
  }

  const resume = resumeTarget();
  if (resume.exam) {
    const label = RESUME_LABELS[resume.mode](arabicNumber(resume.exam.n));
    el.tileResumeLabel.textContent = label;
    el.tileResumeMeta.textContent = resume.exam.t;
    pointTileAt(el.tileResume, resume.exam, label);
  } else {
    const review = randomTarget();
    el.tileResumeLabel.textContent = 'أنجزت جميع النماذج';
    el.tileResumeMeta.textContent = 'راجِع نموذجًا عشوائيًا';
    pointTileAt(el.tileResume, review, 'مراجعة نموذج عشوائي');
  }

  if (stats.todo === 0) el.tileTodoMeta.textContent = 'أنجزت جميع النماذج';
  else if (stats.done === 0) el.tileTodoMeta.textContent = 'كل نموذج تبدؤه يُسجَّل كمُنجز';
  else el.tileTodoMeta.textContent = `بقي لك ${countPhrase(stats.todo, 'exam')}`;

  el.tileFavMeta.textContent = stats.fav
    ? `${countPhrase(stats.fav, 'exam')} في المفضلة`
    : 'احفظ أي نموذج بالضغط على القلب';

  el.tileRandomMeta.textContent =
    stats.done > 0 && stats.todo > 0 ? 'من النماذج التي لم تُنجزها' : 'يفتح فورًا في تبويب جديد';
  pointTileAt(el.tileRandom, randomTarget(), 'نموذج عشوائي');
}

/** Counters, tiles and tabs — everything except the list itself. */
function refreshProgress() {
  refreshQuickAccess();
  countStatuses();
  renderStatusCounts();
}

function setDone(n, on, { announce = true } = {}) {
  store.setDone(n, on);
  syncCard(n);
  refreshProgress();
  if (announce) {
    toast(on ? `سُجِّل النموذج ${arabicNumber(n)} كمُنجز` : `أُلغي تحديد النموذج ${arabicNumber(n)}`);
  }
}

function toggleFav(n) {
  const on = store.toggleFav(n);
  syncCard(n);
  refreshProgress();
  toast(on ? 'أُضيف إلى المفضلة' : 'أُزيل من المفضلة');
}

/**
 * Called from the click on any link that opens a form: the form counts as done
 * from that moment, and the toast offers an undo for a mistaken tap.
 *
 * UI updates are deferred: re-pointing a tile's href inside its own click
 * handler would make the browser open the *new* target instead of the one
 * that was clicked.
 */
function examOpened(n, { random = false } = {}) {
  const exam = state.byNumber.get(n);
  if (!exam) return;

  const newlyDone = !store.isDone(n);
  store.markOpened(n);
  if (newlyDone) store.setDone(n, true);
  store.flush(); // this tab is about to be hidden, and may be discarded

  setTimeout(() => {
    syncCard(n);
    refreshProgress();

    const number = arabicNumber(n);
    if (!newlyDone) {
      if (random) toast(`فُتح النموذج ${number}: ${exam.t}`);
      return;
    }
    toast(random ? `فُتح النموذج ${number} وسُجِّل كمُنجز` : `سُجِّل النموذج ${number} كمُنجز`, {
      duration: 6000,
      action: { label: 'تراجع', onClick: () => setDone(n, false) },
    });
  }, 0);
}

/* -------------------------------------------------------------------------- */
/* Deep links                                                                  */
/* -------------------------------------------------------------------------- */

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
  if (!state.byNumber.has(n)) return false;
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
  hideToast(); // it would sit over the sheet's own buttons
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

/** Treat a middle-click like a click: it opens the form just the same. */
function onOpenLink(node, handler) {
  node.addEventListener('click', handler);
  node.addEventListener('auxclick', (event) => {
    if (event.button === 1) handler(event);
  });
}

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
    const button = event.target.closest('[data-status]');
    if (!button || button.dataset.status === state.status) return;
    state.status = button.dataset.status;
    applyChange();
    if (el.sheet.hidden) keepResultsInView();
  });

  el.sortSelect.addEventListener('change', () => {
    state.sort = el.sortSelect.value;
    applyChange();
    if (el.sheet.hidden) keepResultsInView();
  });

  // One delegated listener for every card, however many batches are loaded.
  el.grid.addEventListener('click', (event) => {
    const node = event.target.closest('.card');
    const exam = node && state.byNumber.get(Number(node.dataset.n));
    if (!exam) return;

    if (event.target.closest('.card__toggle')) setDone(exam.n, !store.isDone(exam.n));
    else if (event.target.closest('.card__fav')) toggleFav(exam.n);
    else if (event.target.closest('.card__copy')) copyExamLink(exam);
    else if (event.target.closest('a.card__cta')) examOpened(exam.n);
  });

  el.grid.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    const cta = event.target.closest('a.card__cta');
    const n = Number(cta?.closest('.card')?.dataset.n);
    if (n) examOpened(n);
  });

  el.resetAll.addEventListener('click', resetAll);
  el.resetProxies.forEach((button) => button.addEventListener('click', resetAll));
  el.sheetReset.addEventListener('click', () => {
    resetAll();
    closeSheet();
  });

  el.loadMoreBtn.addEventListener('click', () => {
    const firstNew = state.shown;
    appendBatch();
    $$('.card', el.grid)[firstNew]?.querySelector('.card__cta')?.focus();
  });

  el.sheetOpen.addEventListener('click', openSheet);
  el.sheetClose.addEventListener('click', closeSheet);
  el.sheetApply.addEventListener('click', closeSheet);
  $('.sheet__backdrop', el.sheet).addEventListener('click', closeSheet);

  onOpenLink(el.tileResume, () => {
    const n = Number(el.tileResume.dataset.target);
    if (n) examOpened(n);
  });

  onOpenLink(el.tileRandom, () => {
    const n = Number(el.tileRandom.dataset.target);
    if (n) examOpened(n, { random: true });
  });

  el.tileTodo.addEventListener('click', () => {
    state.status = 'todo';
    state.q = '';
    el.search.value = '';
    el.clear.hidden = true;
    applyChange({ scroll: true });
  });

  el.tileFav.addEventListener('click', () => {
    state.status = 'fav';
    state.q = '';
    el.search.value = '';
    el.clear.hidden = true;
    applyChange({ scroll: true });
  });

  // Reset is immediate and undoable — a confirmation dialog protects nothing
  // that an undo does not protect better.
  el.progressReset.addEventListener('click', () => {
    const snapshot = store.snapshot();
    store.resetProgress();
    repaintCards();
    refreshProgress();
    const undo = toast('مُسح سجل الإنجاز، والمفضلة كما هي', {
      duration: 8000,
      action: {
        label: 'تراجع',
        onClick: () => {
          store.restore(snapshot);
          repaintCards();
          refreshProgress();
          toast('استُعيد سجل الإنجاز');
        },
      },
    });
    // The reset button disappears with the progress it reset; keep the
    // keyboard focus somewhere useful instead of dropping it on <body>.
    undo?.focus({ preventScroll: true });
  });

  el.toast.addEventListener('mouseenter', () => clearTimeout(toastHandle));
  el.toast.addEventListener('mouseleave', () => {
    if (el.toast.classList.contains('toast--visible')) scheduleToastHide(2500);
  });
  el.toast.addEventListener('focusin', () => clearTimeout(toastHandle));
  el.toast.addEventListener('focusout', (event) => {
    if (!el.toast.contains(event.relatedTarget) && el.toast.classList.contains('toast--visible')) {
      scheduleToastHide(2500);
    }
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

  document.addEventListener('visibilitychange', () => {
    const toastShown = el.toast.classList.contains('toast--visible');
    if (document.visibilityState === 'hidden') {
      if (toastShown) clearTimeout(toastHandle);
      return;
    }
    // Back from the form: refresh the "opened…" times, and give the held
    // confirmation (with its undo) a few seconds on screen.
    repaintCards();
    refreshProgress();
    if (toastShown) scheduleToastHide(5000);
  });

  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    // Restored from the back/forward cache: storage events were missed.
    store.reload();
    repaintCards();
    refreshProgress();
  });

  // Another tab of the portal changed progress.
  store.subscribe(() => {
    repaintCards();
    refreshProgress();
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

  // Keep the controls in the right container when the viewport crosses 900px.
  const mq = window.matchMedia('(min-width: 900px)');
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
      const url = e && examUrl(e);
      return Boolean(e && Number.isInteger(e.n) && e.t && url && isSafeUrl(url));
    });
    if (!data.exams.length) throw new Error('no usable records');

    data.meta = data.meta || {};
    data.meta.total = data.exams.length;

    state.data = data;
    state.ordered = data.exams.slice().sort((a, b) => a.n - b.n);
    state.byNumber = new Map(state.ordered.map((e) => [e.n, e]));

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
