#!/usr/bin/env node
/**
 * build-data.mjs
 * ---------------------------------------------------------------------------
 * Reads the ORIGINAL, untouched source export in `data/source/` and produces a
 * clean, validated, compact runtime model at `assets/data/exams.json`.
 *
 * The source file is never modified. Re-run this script after replacing the
 * source export:
 *
 *     npm run build:data
 *
 * Every record is validated. Records with an unusable link are excluded from
 * the site (they are never rendered as an active exam) and reported here, so a
 * bad row can never break the page.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.join(ROOT, 'data', 'source');
const OUT_FILE = path.join(ROOT, 'assets', 'data', 'exams.json');
const REPORT_FILE = path.join(ROOT, 'data', 'build-report.json');

/* -------------------------------------------------------------------------- */
/* Arabic text normalisation — shared with the client (assets/js/normalize.js). */
/* Keep the two implementations in sync; the client re-uses the keys built here.*/
/* -------------------------------------------------------------------------- */

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

function normalizeArabic(input) {
  return String(input ?? '')
    .replace(DIACRITICS, '')
    .replace(/[آأإٱ]/g, 'ا') // آ أ إ ٱ -> ا
    .replace(/ة/g, 'ه') // ة -> ه
    .replace(/ى/g, 'ي') // ى -> ي
    .replace(/ؤ/g, 'و') // ؤ -> و
    .replace(/ئ/g, 'ي') // ئ -> ي
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)) // ٠-٩ -> 0-9
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Extra recall key: drop the definite article and leading conjunction. */
function stemKey(normalized) {
  return normalized
    .split(' ')
    .map((w) => {
      let s = w;
      if (s.length > 3 && s.startsWith('و')) s = s.slice(1); // و
      if (s.length > 4 && s.startsWith('ال')) s = s.slice(2); // ال
      return s;
    })
    .filter(Boolean)
    .join(' ');
}

/* -------------------------------------------------------------------------- */
/* Link validation                                                             */
/* -------------------------------------------------------------------------- */

const GOOGLE_FORM_RE =
  /^https:\/\/docs\.google\.com\/forms\/d\/e\/([A-Za-z0-9_-]{20,})\/viewform(?:\?.*)?$/;
const SHORT_RE = /^https:\/\/forms\.gle\/([A-Za-z0-9]{5,})$/;

function safeHttpsUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Hero stat stamping                                                          */
/*                                                                             */
/* index.html ships with em-dash placeholders that the app fills in on boot.    */
/* On a phone that turns a one-line stats row into two lines and shifts the      */
/* whole page (measured CLS 0.079). Writing the real values into the markup at   */
/* build time removes the shift entirely, and means the hero states real numbers */
/* even before the script runs. The values match what app.js renders.            */
/* -------------------------------------------------------------------------- */

const arabicNumber = (n) => new Intl.NumberFormat('ar-EG-u-nu-latn').format(n);
const PLURAL = new Intl.PluralRules('ar');

const UNIT_NOUNS = {
  exam: { zero: 'نماذج', one: 'نموذج', two: 'نموذجان', few: 'نماذج', many: 'نموذجًا', other: 'نموذج' },
  question: { zero: 'أسئلة', one: 'سؤال', two: 'سؤالان', few: 'أسئلة', many: 'سؤالًا', other: 'سؤال' },
};

function unitNoun(n, unit) {
  const table = UNIT_NOUNS[unit];
  return table[PLURAL.select(n)] || table.other;
}

function formatDate(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** Replace the text inside one tag carrying a known data-* marker. */
function fillMarker(html, attr, value) {
  const pattern = new RegExp(
    `(<(?:b|span|time)[^>]*${attr}[^>]*>)([^<]*)(</(?:b|span|time)>)`,
  );
  if (!pattern.test(html)) {
    console.warn(`   ! marker not found in index.html: ${attr}`);
    return html;
  }
  return html.replace(pattern, (_m, open, _old, close) => `${open}${value}${close}`);
}

function stampHero(meta) {
  const file = path.join(ROOT, 'index.html');
  if (!fs.existsSync(file)) return;

  let html = fs.readFileSync(file, 'utf8');
  const before = html;

  html = fillMarker(html, 'data-stat="total"', arabicNumber(meta.total));
  html = fillMarker(html, 'data-unit="exam"', `${unitNoun(meta.total, 'exam')} اختبار`);

  if (meta.totalQuestions) {
    html = fillMarker(html, 'data-stat="questions"', arabicNumber(meta.totalQuestions));
    html = fillMarker(html, 'data-unit="question"', unitNoun(meta.totalQuestions, 'question'));
  }

  if (meta.generated) {
    html = fillMarker(html, 'data-stat="updated"', formatDate(meta.generated));
    html = html.replace(
      /(<time[^>]*data-stat="updated"[^>]*datetime=")[^"]*(")/,
      `$1${meta.generated}$2`,
    );
    if (!/datetime="/.test(html.match(/<time[^>]*data-stat="updated"[^>]*>/)?.[0] || '')) {
      html = html.replace(
        /<time([^>]*)data-stat="updated"/,
        `<time$1datetime="${meta.generated}" data-stat="updated"`,
      );
    }
  }

  if (meta.generated) {
    // Freshness signal for search engines and AI crawlers.
    html = html.replace(
      /("dateModified":\s*")[^"]*(")/,
      `$1${meta.generated}$2`,
    );
  }

  if (html !== before) {
    fs.writeFileSync(file, html, 'utf8');
    console.log('hero        : stamped totals into index.html');
  } else {
    console.log('hero        : index.html already current');
  }
}

/**
 * llms.txt — the plain-text brief that AI crawlers and assistants read
 * (llmstxt.org). It leads with the teacher, because the site is his: the
 * platform is one of the things he offers. Figures come from the dataset so
 * they can never drift; the site URL is stamped later by set-site-url.mjs.
 */
function writeLlmsTxt(meta) {
  const total = meta.total;
  const perForm = meta.questionsPerForm ?? 13;
  const questions = meta.totalQuestions ?? total * perForm;
  const updated = meta.generated ?? meta.builtAt;

  const text = `# الأستاذ أحمد طلعت ربيع — مدرب القدرات (Ahmed Talat Rabie — Qudurat/GAT trainer)

> مدرب القدرات، ومشرف القدرات بمدارس المجد الأهلية، وخبير القدرات في اختبارات مركز قياس الوطني. يقدّم دورات تدريبية لطلاب المملكة العربية السعودية وطالباتها، حضوريًا وأون لاين، وينشر ${total} نموذجًا مجانيًا من تجميعات اللفظي على موقعه «العراب في القدرات».

## من هو

- الاسم: الأستاذ أحمد طلعت ربيع، ويُكتب أيضًا: الأستاذ أحمد طلعت.
- مدرب القدرات.
- مشرف القدرات بمدارس المجد الأهلية.
- خبير القدرات في اختبارات مركز قياس الوطني.
- قدّم العديد من الدورات التدريبية لطلاب المملكة بنين وبنات، حضوريًا وأون لاين.
- قدّم الدعم الفني للمعلمين في تدريب القدرات من خلال ورش عمل لمعلمي مكتب تعليم العزيزية بالرياض سابقًا.
- قارئ جيد لمشهد القدرات، ومتابع على مدار السنوات لتطوير الأسئلة في قياس.
- منهجه: «التخطيط طريقك للمائة»، وإعداد خطة لكل طالب.

## التواصل

- واتساب واتصال: +966 50 136 8526 — https://wa.me/966501368526
- فيسبوك: https://www.facebook.com/alastadh.ahmd.tl.t/
- الموقع: __SITE_URL__teacher.html

## موقعه: العراب في القدرات

- عدد النماذج: ${total} نموذجًا إلكترونيًا مجانيًا من تجميعات اللفظي.
- عدد أسئلة كل نموذج: ${perForm} (بإجمالي ${questions} سؤالًا).
- بحث بالاسم أو بالرقم، وتصفية، ومتابعة تقدّم محفوظة على جهاز الطالب.
- بدون تسجيل دخول. النماذج على Google Forms، ويطلب كل نموذج كلمة مرور تُؤخذ من الأستاذ.
- آخر تحديث للبيانات: ${updated}

## الصفحات

- [الأستاذ أحمد طلعت — مدرب القدرات](__SITE_URL__teacher.html): نبذته وخبرته ومنهجه وطرق التواصل معه وأسئلة شائعة عنه.
- [نماذج تجميعات اللفظي](__SITE_URL__): كل النماذج مع البحث والتصفية ومتابعة التقدّم.
- [عن المنصة](__SITE_URL__about.html): طريقة الاستخدام، وكلمة مرور النماذج، وأسئلة شائعة.

## ملاحظات

- اسم الموقع يُكتب «العراب في القدرات» بدون تشكيل، وهو موقع الأستاذ أحمد طلعت وحده، ولا علاقة له بجهات أخرى تحمل اسمًا مشابهًا.
- «قياس» هو المركز الوطني للقياس؛ الأستاذ خبير في اختباراته وليس تابعًا له ولا معتمدًا منه.
- الموقع لا يجمع أي بيانات عن الطلاب، والإجابات تُسجَّل داخل Google Forms.

## English summary

Ahmed Talat Rabie (الأستاذ أحمد طلعت) is a Qudurat (GAT) trainer in Saudi Arabia: Qudurat
supervisor at Al-Majd Private Schools and an expert in the examinations of the National Center
for Assessment (Qiyas). He has run training courses for male and female students across the
Kingdom, in person and online, has delivered workshops for teachers of the Al-Aziziyah Education
Office in Riyadh, and prepares a study plan for each student. Enquiries: WhatsApp or phone
+966 50 136 8526. His site "العراب في القدرات" publishes ${total} free online practice forms for
the verbal section of the test (${perForm} questions each, ${questions} in total), last updated
${updated}.
`;

  fs.writeFileSync(path.join(ROOT, 'llms.txt'), text, 'utf8');
  console.log('llms.txt    : written from the dataset');
}

function findSourceFile() {
  if (!fs.existsSync(SOURCE_DIR)) {
    throw new Error(`Source directory not found: ${SOURCE_DIR}`);
  }
  const candidates = fs
    .readdirSync(SOURCE_DIR)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .map((f) => path.join(SOURCE_DIR, f));

  if (!candidates.length) {
    throw new Error(`No .json export found in ${SOURCE_DIR}`);
  }
  // Prefer the largest file — that is the full export.
  return candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
}

function main() {
  const sourceFile = findSourceFile();
  const raw = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));

  const sourceForms = Array.isArray(raw) ? raw : raw.forms;
  if (!Array.isArray(sourceForms)) {
    throw new Error('Source JSON has no "forms" array.');
  }

  const exams = [];
  const issues = [];
  const seenUrl = new Map();
  const seenNumber = new Map();

  for (const [index, row] of sourceForms.entries()) {
    const where = `#${index} (section ${row?.section ?? '?'})`;

    const number = Number(row?.section);
    if (!Number.isInteger(number) || number <= 0) {
      issues.push({ where, reason: 'invalid-section-number', value: row?.section });
      continue;
    }

    const title = String(row?.title ?? '').replace(/\s+/g, ' ').trim();
    if (!title) {
      issues.push({ where, reason: 'missing-title' });
      continue;
    }

    const canonical = safeHttpsUrl(row?.url);
    if (!canonical) {
      issues.push({ where, reason: 'invalid-or-insecure-url', value: row?.url });
      continue;
    }

    const short = safeHttpsUrl(row?.short);

    // Store the Google Form id when the URL is canonical — it keeps the payload
    // small. Anything else is kept verbatim (still https-validated).
    const formMatch = canonical.match(GOOGLE_FORM_RE);
    const shortMatch = short ? short.match(SHORT_RE) : null;

    if (seenNumber.has(number)) {
      issues.push({ where, reason: 'duplicate-section-number', value: number });
      continue;
    }
    seenNumber.set(number, true);

    if (seenUrl.has(canonical)) {
      issues.push({
        where,
        reason: 'duplicate-url',
        value: `also used by section ${seenUrl.get(canonical)}`,
      });
      continue;
    }
    seenUrl.set(canonical, number);

    const norm = normalizeArabic(title);
    const stem = stemKey(norm);

    const record = { n: number, t: title, k: stem === norm ? norm : `${norm} ${stem}` };
    if (formMatch) record.f = formMatch[1];
    else record.u = canonical;
    if (shortMatch) record.s = shortMatch[1];
    else if (short) record.su = short;

    exams.push(record);
  }

  exams.sort((a, b) => a.n - b.n);

  const numbers = exams.map((e) => e.n);
  const min = numbers.length ? Math.min(...numbers) : 0;
  const max = numbers.length ? Math.max(...numbers) : 0;

  // Contiguous batches of 50, derived from the real numbering — not invented.
  const BATCH = 50;
  const ranges = [];
  for (let start = Math.floor((min - 1) / BATCH) * BATCH + 1; start <= max; start += BATCH) {
    const end = Math.min(start + BATCH - 1, max);
    const count = numbers.filter((n) => n >= start && n <= end).length;
    if (count > 0) ranges.push({ from: start, to: end, count });
  }

  // A short trailing batch (e.g. "301–301") is noise as its own chip — fold it
  // into the previous one so the quick-jump chips stay evenly weighted.
  if (ranges.length > 1) {
    const tail = ranges[ranges.length - 1];
    if (tail.count <= BATCH / 4) {
      const prev = ranges[ranges.length - 2];
      prev.to = tail.to;
      prev.count += tail.count;
      ranges.pop();
    }
  }

  const questionsPerForm = Number(raw?.questions_per_form) || null;

  const payload = {
    meta: {
      // The brand is always written without harakat («العراب», not «العِراب»),
      // whatever the export happens to contain.
      project: typeof raw?.project === 'string' ? raw.project.replace(/[ً-ْ]/g, '') : null,
      teacher: raw?.teacher ?? null,
      generated: raw?.generated ?? null,
      note: raw?.note ?? null,
      questionsPerForm,
      total: exams.length,
      totalQuestions: questionsPerForm ? exams.length * questionsPerForm : null,
      first: min,
      last: max,
      ranges,
      builtAt: new Date().toISOString().slice(0, 10),
    },
    exams,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload), 'utf8');

  stampHero(payload.meta);
  writeLlmsTxt(payload.meta);

  const report = {
    sourceFile: path.relative(ROOT, sourceFile).replace(/\\/g, '/'),
    sourceRecords: sourceForms.length,
    published: exams.length,
    excluded: issues.length,
    issues,
    outputBytes: fs.statSync(OUT_FILE).size,
    ranges,
  };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');

  console.log(`source      : ${report.sourceFile}`);
  console.log(`records     : ${sourceForms.length}`);
  console.log(`published   : ${exams.length}`);
  console.log(`excluded    : ${issues.length}`);
  for (const i of issues) console.log(`   ! ${i.where} — ${i.reason} ${i.value ?? ''}`);
  console.log(`ranges      : ${ranges.map((r) => `${r.from}-${r.to}(${r.count})`).join(' ')}`);
  console.log(`output      : assets/data/exams.json  (${(report.outputBytes / 1024).toFixed(1)} KB)`);

  if (exams.length === 0) {
    console.error('FAILED: no publishable exams were produced.');
    process.exit(1);
  }
}

main();
